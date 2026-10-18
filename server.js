// Octo Eyes: a zero-dependency MCP connector that lets Octo see pump.fun,
// DexScreener and the Solana chain. Runs on Node 22+ (built-in fetch and WebSocket).

import http from "node:http";

const PORT = Number(process.env.PORT) || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SECRET = (process.env.OCTO_SECRET || "").trim();
const MCP_PATH = SECRET ? `/mcp/${SECRET}` : "/mcp";
const STREAM_URL = "wss://pumpportal.fun/api/data";
const VERSION = "1.0.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP_INITIAL_REAL_TOKENS = 793_100_000 * 1e6; // tokens sold along the curve, in base units
const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------- helpers
async function getJSON(url, opts = {}, timeoutMs = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { accept: "application/json", "user-agent": "octo-eyes/" + VERSION, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${new URL(url).host} timed out`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method, params) {
  const j = await getJSON(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message}`);
  return j.result;
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

function needCA(ca) {
  const s = String(ca || "").trim();
  if (!CA_RE.test(s)) throw new Error("That doesn't look like a Solana contract address (32-44 base58 characters).");
  return s;
}

// ---------------------------------------------------------------- DexScreener
async function marketData(ca) {
  return cached("mkt:" + ca, 20_000, async () => {
    const j = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
    const pairs = (j.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return { found: false, note: "No trading pairs on DexScreener yet. A brand-new pump.fun coin may not be indexed yet." };
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    return {
      found: true,
      name: p.baseToken?.name ?? null,
      symbol: p.baseToken?.symbol ?? null,
      dex: p.dexId ?? null,
      pairAddress: p.pairAddress ?? null,
      url: p.url ?? null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      marketCapUsd: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      volumeUsd: p.volume ?? null,
      priceChangePct: p.priceChange ?? null,
      txns: p.txns ?? null,
      pairAgeHours: p.pairCreatedAt ? round((Date.now() - p.pairCreatedAt) / 3.6e6, 1) : null,
      paidBoostsActive: p.boosts?.active ?? 0,
      websites: (p.info?.websites || []).map((w) => w.url),
      socials: (p.info?.socials || []).map((s) => `${s.type}: ${s.url}`),
      otherPairs: pairs.length - 1,
    };
  });
}

// ---------------------------------------------------------------- pump.fun
// pump.fun has no official public API; these are the endpoints its own site uses.
async function pumpInfo(ca) {
  return cached("pump:" + ca, 30_000, async () => {
    const bases = ["https://frontend-api-v3.pump.fun", "https://frontend-api-v2.pump.fun", "https://frontend-api.pump.fun"];
    let c = null;
    let lastErr = null;
    for (const b of bases) {
      try {
        c = await getJSON(`${b}/coins/${ca}`);
        if (c && c.mint) break;
        c = null;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!c) {
      return { found: false, note: "pump.fun didn't return this coin. It may not be a pump.fun coin, or pump.fun is blocking requests right now." + (lastErr ? ` (${lastErr.message})` : "") };
    }
    const real = Number(c.real_token_reserves);
    const progress = c.complete ? 100 : Number.isFinite(real) && real > 0 ? round((1 - real / PUMP_INITIAL_REAL_TOKENS) * 100, 1) : null;
    return {
      found: true,
      name: c.name ?? null,
      symbol: c.symbol ?? null,
      creator: c.creator ?? null,
      createdAt: c.created_timestamp ? new Date(c.created_timestamp).toISOString() : null,
      marketCapUsd: c.usd_market_cap ?? null,
      marketCapSol: c.market_cap ?? null,
      migrated: !!c.complete,
      bondingCurveProgressPct: progress,
      bondingCurve: c.bonding_curve ?? null,
      kingOfTheHillAt: c.king_of_the_hill_timestamp ? new Date(c.king_of_the_hill_timestamp).toISOString() : null,
      replies: c.reply_count ?? null,
      twitter: c.twitter || null,
      telegram: c.telegram || null,
      website: c.website || null,
      description: (c.description || "").slice(0, 300),
      pool: c.pump_swap_pool || c.raydium_pool || null,
    };
  });
}

// ---------------------------------------------------------------- on-chain safety
async function safetyCheck(ca, hints = {}) {
  return cached("safe:" + ca, 45_000, async () => {
    const [mintAcc, supply, largest] = await Promise.all([
      rpc("getAccountInfo", [ca, { encoding: "jsonParsed" }]),
      rpc("getTokenSupply", [ca]),
      rpc("getTokenLargestAccounts", [ca]),
    ]);
    const info = mintAcc?.value?.data?.parsed?.info;
    if (!info) return { found: false, note: "This address isn't a token mint." };

    const total = Number(supply?.value?.uiAmount) || 0;
    const top = (largest?.value || []).slice(0, 20);
    let owners = [];
    if (top.length) {
      const accs = await rpc("getMultipleAccounts", [top.map((a) => a.address), { encoding: "jsonParsed" }]);
      owners = (accs?.value || []).map((a) => a?.data?.parsed?.info?.owner || null);
    }
    const holders = top.map((a, i) => {
      const owner = owners[i] || null;
      let label = null;
      if (owner && hints.bondingCurve && owner === hints.bondingCurve) label = "pump.fun bonding curve";
      if (owner && hints.creator && owner === hints.creator) label = "creator (dev)";
      return { owner, pct: total ? round((Number(a.uiAmount) / total) * 100, 2) : null, label };
    });

    const real = holders.filter((h) => h.label !== "pump.fun bonding curve");
    const top10 = round(real.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0), 2);

    let devPct = null;
    if (hints.creator) {
      try {
        const r = await rpc("getTokenAccountsByOwner", [hints.creator, { mint: ca }, { encoding: "jsonParsed" }]);
        const amt = (r?.value || []).reduce((s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0);
        devPct = total ? round((amt / total) * 100, 2) : null;
      } catch {
        devPct = null;
      }
    }

    const flags = [];
    if (info.mintAuthority) flags.push("Mint authority is ON: more tokens can be printed.");
    if (info.freezeAuthority) flags.push("Freeze authority is ON: holders' tokens can be frozen (honeypot risk).");
    if (top10 != null && top10 > 30) flags.push(`Top 10 holders own ${top10}% (excluding the bonding curve): concentrated.`);
    if (devPct != null && devPct > 5) flags.push(`Dev still holds ${devPct}%.`);
    const whale = real.find((h) => (h.pct || 0) > 10 && !h.label);
    if (whale) flags.push(`One wallet holds ${whale.pct}%. Could be a pool, an exchange, or a whale: check it.`);

    return {
      found: true,
      tokenProgram: mintAcc.value.owner === TOKEN_2022 ? "Token-2022" : "SPL Token",
      decimals: info.decimals,
      supply: total,
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      top10HoldersPct: top10,
      devHoldingPct: devPct,
      topHolders: holders.slice(0, 12),
      flags,
      note: "Pools and the bonding curve often appear as top holders; labels mark the ones that could be identified.",
    };
  });
}

async function tokenReport(ca) {
  const [mkt, pump] = await Promise.allSettled([marketData(ca), pumpInfo(ca)]);
  const pumpVal = pump.status === "fulfilled" ? pump.value : null;
  const hints = pumpVal?.found ? { creator: pumpVal.creator, bondingCurve: pumpVal.bondingCurve } : {};
  let safety;
  try {
    safety = await safetyCheck(ca, hints);
  } catch (e) {
    safety = { error: e.message };
  }
  return {
    ca,
    checkedAt: new Date().toISOString(),
    market: mkt.status === "fulfilled" ? mkt.value : { error: mkt.reason?.message },
    pumpfun: pumpVal || { error: pump.reason?.message },
    safety,
  };
}

// ---------------------------------------------------------------- live stream (PumpPortal)
const launches = [];
const walletTrades = [];
const watched = new Set((process.env.WATCH_WALLETS || "").split(",").map((s) => s.trim()).filter((s) => CA_RE.test(s)));
let ws = null;
let streamState = "starting";
let streamSince = null;

function connectStream() {
  if (typeof WebSocket === "undefined") {
    streamState = "unavailable (needs Node 22+)";
    return;
  }
  try {
    ws = new WebSocket(STREAM_URL);
  } catch (e) {
    streamState = "error: " + e.message;
    setTimeout(connectStream, 10_000);
    return;
  }
  ws.addEventListener("open", () => {
    streamState = "live";
    streamSince = new Date().toISOString();
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    if (watched.size) ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: [...watched] }));
  });
  ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (m.txType === "create" && m.mint) {
      launches.unshift({
        mint: m.mint,
        name: m.name ?? null,
        symbol: m.symbol ?? null,
        creator: m.traderPublicKey ?? null,
        devInitialBuySol: m.solAmount ?? null,
        marketCapSol: m.marketCapSol ?? null,
        at: new Date().toISOString(),
      });
      if (launches.length > 300) launches.pop();
    } else if ((m.txType === "buy" || m.txType === "sell") && watched.has(m.traderPublicKey)) {
      walletTrades.unshift({
        wallet: m.traderPublicKey,
        side: m.txType,
        mint: m.mint ?? null,
        sol: m.solAmount ?? null,
        marketCapSol: m.marketCapSol ?? null,
        at: new Date().toISOString(),
      });
      if (walletTrades.length > 300) walletTrades.pop();
    }
  });
  ws.addEventListener("close", () => {
    streamState = "reconnecting";
    setTimeout(connectStream, 4000);
  });
  ws.addEventListener("error", () => {
    streamState = "reconnecting";
  });
}

// ---------------------------------------------------------------- tools
const caSchema = { type: "object", properties: { ca: { type: "string", description: "The token's Solana contract address (mint)." } }, required: ["ca"] };

const TOOLS = [
  {
    name: "token_report",
    description: "Full report on a Solana token in one call: DexScreener market data (price, market cap, liquidity, volume, price changes, buys and sells), pump.fun details (creator, bonding curve progress, migrated or not, socials) and an on-chain safety check (mint and freeze authority, top holders, dev holding, red flags). Use this first whenever someone shares a CA.",
    inputSchema: caSchema,
    run: async ({ ca }) => tokenReport(needCA(ca)),
  },
  {
    name: "market_data",
    description: "DexScreener market data for a Solana token: price, market cap, liquidity, volume and price change over 5m/1h/6h/24h, buy and sell counts, pair age, socials.",
    inputSchema: caSchema,
    run: async ({ ca }) => marketData(needCA(ca)),
  },
  {
    name: "pumpfun_info",
    description: "pump.fun details for a coin: name, ticker, creator wallet, created time, market cap, bonding curve progress %, whether it migrated, reply count, socials and description.",
    inputSchema: caSchema,
    run: async ({ ca }) => pumpInfo(needCA(ca)),
  },
  {
    name: "safety_check",
    description: "On-chain safety check for a Solana token: mint and freeze authority, top holders with %, top 10 concentration, dev holding % (when the creator is known), and red flags.",
    inputSchema: caSchema,
    run: async ({ ca }) => {
      const c = needCA(ca);
      let hints = {};
      try {
        const p = await pumpInfo(c);
        if (p.found) hints = { creator: p.creator, bondingCurve: p.bondingCurve };
      } catch {}
      return safetyCheck(c, hints);
    },
  },
  {
    name: "new_launches",
    description: "The newest coins launched on pump.fun, newest first, seen live since this server started: mint, name, ticker, creator, dev's initial buy in SOL, market cap in SOL, time. Optionally only those whose dev bought at least min_dev_buy_sol.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many to return (default 20)." },
        min_dev_buy_sol: { type: "number", minimum: 0, description: "Only coins whose dev's first buy was at least this many SOL." },
      },
    },
    run: async ({ limit = 20, min_dev_buy_sol = 0 } = {}) => {
      const n = Math.max(1, Math.min(100, Number(limit) || 20));
      const min = Number(min_dev_buy_sol) || 0;
      return {
        stream: streamState,
        watchingSince: streamSince,
        launches: launches.filter((l) => (l.devInitialBuySol || 0) >= min).slice(0, n),
      };
    },
  },
  {
    name: "watch_wallet",
    description: "Start watching a Solana wallet's pump.fun buys and sells live (for smart money or a dev you want to follow). Watching lasts until the server restarts; add permanent ones in the WATCH_WALLETS setting.",
    inputSchema: { type: "object", properties: { wallet: { type: "string", description: "Wallet address to watch." } }, required: ["wallet"] },
    run: async ({ wallet }) => {
      const w = needCA(wallet);
      const isNew = !watched.has(w);
      watched.add(w);
      if (isNew && ws && ws.readyState === 1) ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: [w] }));
      return { watching: [...watched], added: isNew };
    },
  },
  {
    name: "watched_wallet_trades",
    description: "Recent pump.fun buys and sells by the wallets being watched, newest first: wallet, buy or sell, token mint, SOL amount, market cap in SOL, time.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "How many to return (default 30)." } } },
    run: async ({ limit = 30 } = {}) => ({
      stream: streamState,
      watching: [...watched],
      trades: walletTrades.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))),
    }),
  },
];

// ---------------------------------------------------------------- MCP over HTTP (stateless JSON-RPC)
async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid request");

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "octo-eyes", title: "Octo Eyes", version: VERSION },
        instructions: "Octo Eyes reads live Solana token data. When someone shares a contract address, call token_report first.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await tool.run(params?.arguments || {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: "Error: " + (e?.message || String(e)) }], isError: true });
      }
    }
    default:
      if (method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" || url.pathname === "/health") {
    return send(res, 200, { name: "Octo Eyes", ok: true, stream: streamState, launchesSeen: launches.length, watching: watched.size });
  }
  if (url.pathname !== MCP_PATH) return send(res, 404, { error: "Not found" });
  if (req.method === "GET" || req.method === "DELETE") return send(res, 405, { error: "Method not allowed" }, { allow: "POST" });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" }, { allow: "POST" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map(handleRpc))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202);
  }
  const out = await handleRpc(payload);
  return out ? send(res, 200, out) : send(res, 202);
});

server.listen(PORT, () => {
  console.log(`Octo Eyes listening on :${PORT}, MCP endpoint ${SECRET ? "/mcp/<secret>" : "/mcp"}`);
  if (process.env.OCTO_NO_STREAM !== "1") connectStream();
  else streamState = "off";
});
