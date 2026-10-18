// Octo Eyes: a zero-dependency MCP connector that lets Octo see pump.fun,
// DexScreener and the Solana chain. Runs on Node 22+ (built-in fetch and WebSocket).

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT) || 3000;
// Accepts a full RPC link, or just a Helius API key.
const RPC_RAW = (process.env.SOLANA_RPC_URL || "").trim();
const RPC_URL = !RPC_RAW
  ? "https://api.mainnet-beta.solana.com"
  : /^https?:\/\//i.test(RPC_RAW)
    ? RPC_RAW
    : `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(RPC_RAW)}`;
const RPC_KIND = !RPC_RAW ? "public (slow)" : RPC_URL.includes("helius") ? "helius" : "custom";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SECRET = (process.env.OCTO_SECRET || "").trim();
const MCP_PATH = SECRET ? `/mcp/${SECRET}` : "/mcp";
const STREAM_URL = "wss://pumpportal.fun/api/data";
const VERSION = "1.4.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PUMP_INITIAL_REAL_TOKENS = 793_100_000 * 1e6; // tokens sold along the curve, in base units
const round = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------- helpers
async function getJSON(url, opts = {}, timeoutMs = 9000, retries = 1) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { accept: "application/json", "user-agent": "octo-eyes/" + VERSION, ...(opts.headers || {}) },
    });
    if (res.status === 429 && retries > 0) {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
      return getJSON(url, opts, timeoutMs, retries - 1);
    }
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

// ---------------------------------------------------------------- Solana address math (no libraries)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.push(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch === "1") out.push(0);
    else break;
  }
  return Buffer.from(out.reverse());
}
function b58encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
function pubkeyBytes(s) {
  const b = b58decode(s);
  if (b.length > 32) throw new Error("bad address");
  return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
}
// ed25519 "is this point on the curve" check, needed to derive program addresses
const P = 2n ** 255n - 19n;
const modp = (a) => ((a % P) + P) % P;
function powmod(b, e) {
  let r = 1n;
  b = modp(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const ED_D = modp(-121665n * powmod(121666n, P - 2n));
function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = (modp(y2 - 1n) * powmod(modp(ED_D * y2 + 1n), P - 2n)) % P;
  if (x2 === 0n) return true;
  const x = powmod(x2, (P + 3n) / 8n);
  const xx = (x * x) % P;
  return xx === x2 || xx === modp(-x2);
}
function findPDA(seeds, programId) {
  const pid = pubkeyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(pid);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const out = h.digest();
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error("could not derive address");
}

// Reads a pump.fun coin's bonding curve straight from the chain (pump.fun can't block this).
async function chainPump(ca) {
  const bc = findPDA([Buffer.from("bonding-curve"), pubkeyBytes(ca)], PUMP_PROGRAM);
  const acc = await rpc("getAccountInfo", [bc, { encoding: "base64" }]);
  const v = acc?.value;
  if (!v || v.owner !== PUMP_PROGRAM) return { found: false, bondingCurve: bc, note: "No pump.fun bonding curve for this token, so it's probably not a pump.fun coin." };
  const d = Buffer.from(v.data[0], "base64");
  if (d.length < 49) return { found: false, bondingCurve: bc, note: "Unexpected bonding curve data." };
  const vTok = Number(d.readBigUInt64LE(8));
  const vSol = Number(d.readBigUInt64LE(16));
  const rTok = Number(d.readBigUInt64LE(24));
  const rSol = Number(d.readBigUInt64LE(32));
  const supply = Number(d.readBigUInt64LE(40));
  const complete = d[48] === 1;
  let creator = null;
  if (d.length >= 81) {
    const c = d.subarray(49, 81);
    if (c.some((x) => x !== 0)) creator = b58encode(c);
  }
  const priceSol = vTok > 0 ? vSol / 1e9 / (vTok / 1e6) : null;
  return {
    found: true,
    bondingCurve: bc,
    creator,
    migrated: complete,
    bondingCurveProgressPct: complete ? 100 : rTok > 0 ? round((1 - rTok / PUMP_INITIAL_REAL_TOKENS) * 100, 1) : null,
    marketCapSol: !complete && priceSol != null ? round((priceSol * supply) / 1e6, 2) : null,
    solInCurve: complete ? null : round(rSol / 1e9, 3),
  };
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
async function dexScreener(ca) {
  const j = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
  const pairs = (j.pairs || []).filter((p) => p.chainId === "solana");
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];
  return {
    found: true,
    source: "DexScreener",
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
}

// Main source: Jupiter's token API (rich data, rarely blocks servers).
// Tries the free lite host first, then api.jup.ag (with JUP_API_KEY if set).
async function jupiter(ca) {
  const key = (process.env.JUP_API_KEY || "").trim();
  const urls = [
    [`https://lite-api.jup.ag/tokens/v2/search?query=${ca}`, {}],
    [`https://api.jup.ag/tokens/v2/search?query=${ca}`, key ? { headers: { "x-api-key": key } } : {}],
  ];
  let lastErr = null;
  for (const [u, o] of urls) {
    try {
      const j = await getJSON(u, o, 8000, 0);
      const t = (Array.isArray(j) ? j : []).find((x) => x && x.id === ca);
      if (!t) return null;
      const st = (s) =>
        s
          ? {
              priceChangePct: round(s.priceChange, 2),
              buyVolumeUsd: round(s.buyVolume, 0),
              sellVolumeUsd: round(s.sellVolume, 0),
              buys: s.numBuys ?? null,
              sells: s.numSells ?? null,
              traders: s.numTraders ?? null,
              netBuyers: s.numNetBuyers ?? null,
              organicBuyers: s.numOrganicBuyers ?? null,
              liquidityChangePct: round(s.liquidityChange, 2),
            }
          : null;
      return {
        found: true,
        source: "Jupiter",
        name: t.name ?? null,
        symbol: t.symbol ?? null,
        priceUsd: t.usdPrice ?? null,
        marketCapUsd: t.mcap ?? t.fdv ?? null,
        fdvUsd: t.fdv ?? null,
        liquidityUsd: t.liquidity ?? null,
        holders: t.holderCount ?? null,
        organicScore: t.organicScore ?? null,
        organicScoreLabel: t.organicScoreLabel ?? null,
        verified: t.isVerified ?? null,
        tags: t.tags ?? [],
        firstPoolCreatedAt: t.firstPool?.createdAt ?? null,
        ageHours: t.firstPool?.createdAt ? round((Date.now() - Date.parse(t.firstPool.createdAt)) / 3.6e6, 1) : null,
        audit: t.audit ?? null,
        stats5m: st(t.stats5m),
        stats1h: st(t.stats1h),
        stats6h: st(t.stats6h),
        stats24h: st(t.stats24h),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Jupiter unavailable");
}

// Backup source when DexScreener rate-limits the server.
async function geckoTerminal(ca) {
  const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${ca}/pools?page=1`);
  const pools = (j.data || []).map((d) => d.attributes || {}).filter(Boolean);
  if (!pools.length) return null;
  pools.sort((a, b) => Number(b.reserve_in_usd || 0) - Number(a.reserve_in_usd || 0));
  const a = pools[0];
  const num = (v) => (v == null || v === "" ? null : Number(v));
  const pick = (o, f) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) : null);
  return {
    found: true,
    source: "GeckoTerminal",
    pool: a.name ?? null,
    pairAddress: a.address ?? null,
    url: a.address ? `https://www.geckoterminal.com/solana/pools/${a.address}` : null,
    priceUsd: num(a.base_token_price_usd),
    marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
    liquidityUsd: num(a.reserve_in_usd),
    volumeUsd: pick(a.volume_usd, num),
    priceChangePct: pick(a.price_change_percentage, num),
    txns: a.transactions ?? null,
    pairAgeHours: a.pool_created_at ? round((Date.now() - Date.parse(a.pool_created_at)) / 3.6e6, 1) : null,
    otherPairs: pools.length - 1,
  };
}

async function marketData(ca) {
  return cached("mkt:" + ca, 20_000, async () => {
    const errors = [];
    let jup = null;
    try {
      jup = await jupiter(ca);
    } catch (e) {
      errors.push("Jupiter: " + e.message);
    }
    // Jupiter has the numbers; DexScreener adds socials and a chart link when it isn't rate-limited.
    let dex = null;
    try {
      dex = await dexScreener(ca);
    } catch (e) {
      errors.push("DexScreener: " + e.message);
    }
    if (jup) {
      if (dex) Object.assign(jup, { dex: dex.dex, chartUrl: dex.url, websites: dex.websites, socials: dex.socials, paidBoostsActive: dex.paidBoostsActive });
      return jup;
    }
    if (dex) return dex;
    try {
      const g = await geckoTerminal(ca);
      if (g) return g;
    } catch (e) {
      errors.push("GeckoTerminal: " + e.message);
    }
    if (errors.length === 3) return { found: false, error: errors.join("; ") };
    return { found: false, note: "No trading pools yet. A pump.fun coin still on its bonding curve has no DEX pool until it migrates.", errors: errors.length ? errors : undefined };
  });
}

async function solPriceUsd() {
  return cached("solusd", 60_000, async () => {
    const SOL = "So11111111111111111111111111111111111111112";
    try {
      const j = await getJSON(`https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${SOL}`);
      const v = Number(j?.data?.attributes?.token_prices?.[SOL]);
      if (v > 0) return v;
    } catch {}
    try {
      const jp = await jupiter(SOL);
      if (jp?.priceUsd > 0) return jp.priceUsd;
    } catch {}
    try {
      const d = await dexScreener(SOL);
      if (d?.priceUsd > 0) return d.priceUsd;
    } catch {}
    return null;
  });
}

// ---------------------------------------------------------------- pump.fun
// pump.fun has no official public API; these are the endpoints its own site uses.
async function pumpInfo(ca) {
  return cached("pump:" + ca, 20_000, async () => {
    // 1) pump.fun's own website API (often blocks cloud servers), 2) the chain itself (always works)
    let web = null;
    let webErr = null;
    try {
      const c = await getJSON(`https://frontend-api-v3.pump.fun/coins/${ca}`, {}, 5000, 0);
      if (c && c.mint) web = c;
    } catch (e) {
      webErr = e.message;
    }
    let chain = null;
    let chainErr = null;
    try {
      chain = await chainPump(ca);
    } catch (e) {
      chainErr = e.message;
    }
    if (!web && !chain?.found) {
      return { found: false, note: chain?.note || "Couldn't read this coin from pump.fun or the chain.", errors: { website: webErr, chain: chainErr } };
    }
    const seen = launches.find((l) => l.mint === ca);
    let name = web?.name ?? seen?.name ?? null;
    let symbol = web?.symbol ?? seen?.symbol ?? null;
    // Lore and socials: from pump.fun when it answers, otherwise from the coin's own metadata file.
    let meta = null;
    if (!web) {
      try {
        const a = await rpc("getAsset", { id: ca });
        name = name || a?.content?.metadata?.name || null;
        symbol = symbol || a?.content?.metadata?.symbol || null;
        meta = { description: a?.content?.metadata?.description || null };
        const uri = a?.content?.json_uri;
        if (uri) {
          try {
            const u = uri.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + uri.slice(7) : uri;
            const m = await getJSON(u, {}, 5000, 0);
            if (m && typeof m === "object") meta = { ...meta, ...m, description: m.description || meta.description };
          } catch {}
        }
      } catch {}
    }
    const webReal = Number(web?.real_token_reserves);
    return {
      found: true,
      source: web ? "pump.fun + on-chain" : "on-chain (pump.fun's website API is blocking this server)",
      name,
      symbol,
      creator: chain?.creator ?? web?.creator ?? seen?.creator ?? null,
      createdAt: web?.created_timestamp ? new Date(web.created_timestamp).toISOString() : seen?.at ?? null,
      migrated: chain?.found ? chain.migrated : !!web?.complete,
      bondingCurveProgressPct: chain?.found
        ? chain.bondingCurveProgressPct
        : web?.complete
          ? 100
          : Number.isFinite(webReal) && webReal > 0
            ? round((1 - webReal / PUMP_INITIAL_REAL_TOKENS) * 100, 1)
            : null,
      marketCapSol: chain?.marketCapSol ?? web?.market_cap ?? null,
      marketCapUsd: web?.usd_market_cap ?? (chain?.marketCapSol != null ? await solPriceUsd().then((p) => (p ? round(chain.marketCapSol * p, 0) : null)).catch(() => null) : null),
      solInCurve: chain?.solInCurve ?? null,
      bondingCurve: chain?.bondingCurve ?? web?.bonding_curve ?? null,
      replies: web?.reply_count ?? null,
      twitter: web?.twitter || meta?.twitter || null,
      telegram: web?.telegram || meta?.telegram || null,
      website: web?.website || meta?.website || null,
      lore: String((web ? web.description : meta?.description) || "").slice(0, 500) || null,
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
        bondingCurve: m.bondingCurveKey ?? null,
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
    description: "Market data for a Solana token (Jupiter, with DexScreener and GeckoTerminal as backups): price, market cap, liquidity, holder count, buy and sell volume, buys, sells, traders and price change over 5m/1h/6h/24h, organic score, audit info, age, socials.",
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
    return send(res, 200, { name: "Octo Eyes", version: VERSION, ok: true, rpc: RPC_KIND, stream: streamState, launchesSeen: launches.length, watching: watched.size });
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
