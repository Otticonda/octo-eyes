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
const VERSION = "3.5.0";
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
  const parsed = parseCurve(Buffer.from(v.data[0], "base64"));
  if (!parsed) return { found: false, bondingCurve: bc, note: "Unexpected bonding curve data." };
  return { found: true, bondingCurve: bc, ...parsed };
}

function parseCurve(d) {
  if (!d || d.length < 49) return null;
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

// Octo's own price readings (bonding curves from the scanner, held coins from the exit loop),
// so brand-new coins get a chart before GeckoTerminal indexes them.
const priceHistory = new Map(); // mint -> [{t, p (USD), s (SOL in curve)}]
function recordPrice(mint, priceUsd, solInCurve = null) {
  if (!(priceUsd > 0)) return;
  let h = priceHistory.get(mint);
  if (!h) priceHistory.set(mint, (h = []));
  const t = Date.now();
  if (h.length && t - h[h.length - 1].t < 5000) h[h.length - 1] = { t, p: priceUsd, s: solInCurve };
  else h.push({ t, p: priceUsd, s: solInCurve });
  if (h.length > 600) h.shift();
}
function prunePriceHistory() {
  const cut = Date.now() - 3 * 3.6e6;
  for (const [m, h] of priceHistory) if (!h.length || h[h.length - 1].t < cut) priceHistory.delete(m);
}
const TF_MS = { "1m": 60e3, "5m": 300e3, "15m": 900e3, "1h": 3.6e6, "4h": 14.4e6, "1d": 86.4e6 };
function ownCandles(ca, tf, n, solUsd) {
  const h = priceHistory.get(ca);
  if (!h || h.length < 2) return [];
  const ms = TF_MS[tf] || 60e3;
  const out = [];
  let prevS = null;
  for (const x of h) {
    const b = Math.floor(x.t / ms) * ms;
    let c = out[out.length - 1];
    if (!c || c.t !== b) {
      c = { t: b, o: c ? c.c : x.p, h: Math.max(x.p, c ? c.c : x.p), l: Math.min(x.p, c ? c.c : x.p), c: x.p, v: 0 };
      out.push(c);
    }
    c.h = Math.max(c.h, x.p);
    c.l = Math.min(c.l, x.p);
    c.c = x.p;
    if (prevS != null && x.s != null && solUsd) c.v += Math.abs(x.s - prevS) * solUsd;
    prevS = x.s;
  }
  return out.slice(-n);
}

// Price candles for a coin, oldest first: GeckoTerminal's chart of its main pool,
// or Octo's own curve readings when that has less (brand-new pump.fun coins).
const TIMEFRAMES = { "1s": ["second", 1], "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };
async function candles(ca, timeframe = "5m", limit = 120) {
  const tf = TIMEFRAMES[timeframe] ? timeframe : "5m";
  const n = Math.max(10, Math.min(300, Number(limit) || 120));
  if (tf === "1s") {
    const wasFollowing = tradeSubs.has(ca);
    followTrades(ca);
    const list = secondCandles(ca, n);
    return {
      found: list.length > 0,
      source: list.length ? "live bonding-curve updates" : null,
      timeframe: "1s",
      following: true,
      candles: list,
      note: list.length ? undefined : wasFollowing ? "No trades on this coin in the last 15 minutes." : "Started following this coin's curve; 1s candles appear as trades come in. Migrated coins have no curve to follow.",
      feed: { curveFeed: curveWsState, rpc: RPC_KIND, curveUpdates: curveTicks, following: tradeSubs.size, subscribed: subToMint.size, droppedNoSolPrice: droppedNoPrice, solUsd: solUsdNow, notes: streamNotes.slice(0, 3) },
    };
  }
  if (ca === "So11111111111111111111111111111111111111112") {
    const mins = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[tf];
    return cached(`kraken:${tf}:${n}`, 30_000, async () => {
      const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=${mins}`, {}, 10000);
      if (j.error?.length) throw new Error("Kraken: " + j.error.join(", "));
      const k = Object.keys(j.result || {}).find((x) => x !== "last");
      const list = (j.result?.[k] || []).slice(-n).map((r) => ({ t: r[0] * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]) * Number(r[4]) }));
      return { found: list.length > 0, source: "Kraken SOL/USD", timeframe: tf, candles: list };
    });
  }
  return cached(`ohlcv:${ca}:${tf}:${n}`, 20_000, async () => {
    const solUsd = await solPriceUsd().catch(() => null);
    const own = ownCandles(ca, tf, n, solUsd);
    let gecko = [];
    let pool = null;
    let geckoError = null;
    try {
      const g = await geckoTerminal(ca);
      if (g?.pairAddress) {
        pool = { name: g.pool, pairAddress: g.pairAddress };
        const [unit, agg] = TIMEFRAMES[tf];
        const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${g.pairAddress}/ohlcv/${unit}?aggregate=${agg}&limit=${n}&currency=usd&token=${ca}`);
        gecko = (j?.data?.attributes?.ohlcv_list || [])
          .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
          .sort((a, b) => a.t - b.t);
      }
    } catch (e) {
      geckoError = e.message;
    }
    const useOwn = own.length > gecko.length;
    const list = useOwn ? own : gecko;
    return {
      found: list.length > 0,
      source: list.length ? (useOwn ? "Octo's own curve readings" : "GeckoTerminal") : null,
      pool,
      timeframe: tf,
      candles: list,
      note: list.length ? undefined : "No chart for this coin yet." + (geckoError ? " GeckoTerminal: " + geckoError : ""),
    };
  });
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
      const k = await getJSON("https://api.kraken.com/0/public/Ticker?pair=SOLUSD", {}, 6000, 0);
      const key = Object.keys(k?.result || {})[0];
      const v = Number(k?.result?.[key]?.c?.[0]);
      if (v > 0) return v;
    } catch {}
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

// ---------------------------------------------------------------- rug radar
async function pmap(items, fn, limit = 5) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// All signatures for an address, newest first, up to 3 pages. complete=false if there are more.
async function allSigs(address) {
  let all = [];
  let before;
  for (let page = 0; page < 3; page++) {
    const r = await rpc("getSignaturesForAddress", [address, before ? { limit: 1000, before } : { limit: 1000 }]);
    all = all.concat(r || []);
    if (!r || r.length < 1000) return { sigs: all, complete: true };
    before = r[r.length - 1].signature;
  }
  return { sigs: all, complete: false };
}

// Who bought in the coin's first blocks: bundles (same block as creation) and snipers (first 3 blocks).
async function earlyBuyers(mint, bondingCurve, creator, supplyUi) {
  const { sigs, complete } = await allSigs(bondingCurve);
  if (!complete) return { checked: false, note: "Too many trades to look back to the very first buyers." };
  const ok = sigs.filter((x) => !x.err).reverse();
  if (!ok.length) return { checked: false, note: "No trades found." };
  const createSlot = ok[0].slot;
  const first = ok.slice(0, 25);
  const txs = await pmap(first, (x) => rpc("getTransaction", [x.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]));
  const byWallet = new Map();
  txs.forEach((tx, idx) => {
    if (!tx?.meta) return;
    const keys = tx.transaction?.message?.accountKeys || [];
    const payer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
    if (!payer) return;
    const amt = (arr) => (arr || []).filter((b) => b.mint === mint && b.owner === payer).reduce((sum, b) => sum + (Number(b.uiTokenAmount?.uiAmount) || 0), 0);
    const delta = amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances);
    if (delta <= 0) return;
    const w = byWallet.get(payer) || { wallet: payer, tokens: 0, firstSlot: first[idx].slot };
    w.tokens += delta;
    w.firstSlot = Math.min(w.firstSlot, first[idx].slot);
    byWallet.set(payer, w);
  });
  const supply = supplyUi || 1e9;
  const pct = (t) => round((t / supply) * 100, 2);
  const buyers = [...byWallet.values()].map((w) => ({ ...w, pct: pct(w.tokens), isDev: w.wallet === creator }));
  const notDev = buyers.filter((b) => !b.isDev);
  const bundled = notDev.filter((b) => b.firstSlot === createSlot);
  const snipers = notDev.filter((b) => b.firstSlot <= createSlot + 2);
  const sum = (arr) => round(arr.reduce((t, b) => t + (b.pct || 0), 0), 2);
  return {
    checked: true,
    firstTradesChecked: first.length,
    bundledWallets: bundled.length,
    bundledPct: sum(bundled),
    sniperWallets: snipers.length,
    sniperPct: sum(snipers),
    earlyWallets: buyers.sort((a, b) => b.tokens - a.tokens).slice(0, 8).map((b) => ({ wallet: b.wallet, pct: b.pct, blocksAfterLaunch: b.firstSlot - createSlot, isDev: b.isDev })),
  };
}

async function devCheck(creator) {
  const [sigs, bal] = await Promise.all([rpc("getSignaturesForAddress", [creator, { limit: 1000 }]), rpc("getBalance", [creator]).catch(() => null)]);
  const n = sigs?.length || 0;
  const oldest = n ? sigs[n - 1].blockTime : null;
  const ageDays = oldest ? (Date.now() / 1000 - oldest) / 86400 : null;
  const seen = launches.filter((l) => l.creator === creator);
  return {
    wallet: creator,
    txCount: n >= 1000 ? "1000+" : n,
    walletAgeDays: ageDays != null ? round(ageDays, 1) : null,
    walletAgeIsMinimum: n >= 1000,
    solBalance: bal?.value != null ? round(bal.value / 1e9, 3) : null,
    otherLaunchesSeenRecently: seen.length,
    recentLaunchNames: seen.slice(0, 5).map((l) => `${l.name} (${l.symbol})`),
  };
}

// Top holders whose wallets are brand new: a classic sign of insiders splitting supply.
async function freshHolders(topHolders) {
  const real = (topHolders || []).filter((h) => h.owner && h.label !== "pump.fun bonding curve" && h.label !== "liquidity pool").slice(0, 10);
  const checks = await pmap(real, (h) => rpc("getSignaturesForAddress", [h.owner, { limit: 20 }]).then((r) => ({ ...h, txs: r?.length ?? 0 })));
  const fresh = checks.filter((h) => h && h.txs < 12);
  return { checked: real.length, freshWallets: fresh.length, freshPct: round(fresh.reduce((t, h) => t + (h.pct || 0), 0), 2), list: fresh.map((h) => ({ wallet: h.owner, pct: h.pct, txs: h.txs })) };
}

async function rugRadar(ca, pump, safety) {
  return cached("radar:" + ca, 60_000, async () => {
    const out = { riskScore: 0, risk: "low", reasons: [] };
    const add = (pts, why) => {
      out.riskScore += pts;
      out.reasons.push(why);
    };
    const [early, dev, fresh] = await Promise.all([
      pump?.bondingCurve ? earlyBuyers(ca, pump.bondingCurve, pump.creator, safety?.supply).catch((e) => ({ checked: false, note: e.message })) : Promise.resolve({ checked: false, note: "Not a pump.fun coin, so first-block buyers weren't checked." }),
      pump?.creator ? devCheck(pump.creator).catch((e) => ({ error: e.message })) : Promise.resolve(null),
      safety?.topHolders ? freshHolders(safety.topHolders).catch((e) => ({ error: e.message })) : Promise.resolve(null),
    ]);
    out.earlyBuyers = early;
    out.dev = dev;
    out.freshHolders = fresh;

    if (safety?.mintAuthority) add(40, "mint authority on");
    if (safety?.freezeAuthority) add(40, "freeze authority on");
    if (early?.checked) {
      if (early.bundledPct > 25) add(30, `${early.bundledWallets} wallets bundled ${early.bundledPct}% in the launch block`);
      else if (early.bundledPct > 10) add(20, `${early.bundledWallets} wallets bundled ${early.bundledPct}% in the launch block`);
      if (early.sniperPct > 20) add(15, `snipers took ${early.sniperPct}% in the first 3 blocks`);
    }
    if (fresh?.freshPct > 15) add(20, `${fresh.freshWallets} brand-new wallets hold ${fresh.freshPct}% among the top holders`);
    else if (fresh?.freshPct > 7) add(10, `fresh wallets hold ${fresh.freshPct}% among the top holders`);
    if (safety?.devHoldingPct > 5) add(10, `dev holds ${safety.devHoldingPct}%`);
    if (safety?.top10HoldersPct > 30) add(15, `top 10 hold ${safety.top10HoldersPct}%`);
    if (dev && !dev.error) {
      if (dev.otherLaunchesSeenRecently >= 3) add(15, `dev launched ${dev.otherLaunchesSeenRecently} coins recently (serial launcher)`);
      if (dev.walletAgeDays != null && dev.walletAgeDays < 1 && !dev.walletAgeIsMinimum && Number(dev.txCount) < 30) add(10, "dev wallet is less than a day old");
    }
    out.riskScore = Math.min(100, out.riskScore);
    out.risk = out.riskScore >= 50 ? "high" : out.riskScore >= 25 ? "medium" : "low";
    if (!out.reasons.length) out.reasons.push("no red flags found in what was checked");
    return out;
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
  // Label the DEX pool among holders so it doesn't count as concentration.
  const pair = mkt.status === "fulfilled" ? mkt.value?.pairAddress : null;
  if (pair && safety?.topHolders) {
    let changed = false;
    safety.topHolders.forEach((h) => {
      if (h.owner === pair && h.label !== "liquidity pool") {
        h.label = "liquidity pool";
        changed = true;
      }
    });
    if (changed) {
      const real = safety.topHolders.filter((h) => !h.label || h.label === "creator (dev)");
      safety.top10HoldersPct = round(real.slice(0, 10).reduce((t, h) => t + (h.pct || 0), 0), 2);
      safety.flags = (safety.flags || []).filter((f) => !f.startsWith("Top 10 holders"));
      if (safety.top10HoldersPct > 30) safety.flags.push(`Top 10 holders own ${safety.top10HoldersPct}% (excluding the bonding curve and pool): concentrated.`);
    }
  }
  let radar;
  try {
    radar = await rugRadar(ca, pumpVal?.found ? pumpVal : null, safety?.found ? safety : null);
  } catch (e) {
    radar = { error: e.message };
  }
  return {
    ca,
    checkedAt: new Date().toISOString(),
    market: mkt.status === "fulfilled" ? mkt.value : { error: mkt.reason?.message },
    pumpfun: pumpVal || { error: pump.reason?.message },
    safety,
    rugRadar: radar,
  };
}

// ---------------------------------------------------------------- live trades (1-second candles)
// Octo follows every trade on a few coins at a time (what it holds and the scanner's top picks),
// straight from PumpPortal's stream, and builds 1-second candles from them.
const MAX_TRADE_SUBS = 12;
const tradeSubs = new Map(); // mint -> last time something asked for it
const tradeBuf = new Map(); // mint -> [{t, p (USD), v (USD)}]
const streamNotes = []; // PumpPortal's own replies (subscribe confirmations, errors)
let tradeMsgs = 0;
let followedTradeMsgs = 0;
let droppedNoPrice = 0;
let solUsdNow = null;
setInterval(() => solPriceUsd().then((v) => v && (solUsdNow = v)).catch(() => {}), 60_000);
solPriceUsd().then((v) => v && (solUsdNow = v)).catch(() => {});

function followTrades(mint, keep = false) {
  if (!mint) return;
  const was = tradeSubs.has(mint);
  tradeSubs.set(mint, keep ? Infinity : Date.now());
  if (was) return;
  if (tradeSubs.size > MAX_TRADE_SUBS) {
    const oldest = [...tradeSubs.entries()].filter(([, at]) => at !== Infinity).sort((a, b) => a[1] - b[1])[0];
    if (oldest) {
      tradeSubs.delete(oldest[0]);
      tradeBuf.delete(oldest[0]);
      unsubscribeCurve(oldest[0]);
    }
  }
  subscribeCurve(mint);
}
// One price point per curve change (every trade moves the curve). volSol = SOL that moved.
function recordTick(mint, priceSol, volSol) {
  if (!(priceSol > 0) || !solUsdNow) {
    droppedNoPrice++;
    return;
  }
  let b = tradeBuf.get(mint);
  if (!b) tradeBuf.set(mint, (b = []));
  b.push({ t: Date.now(), p: priceSol * solUsdNow, v: (volSol || 0) * solUsdNow });
  const cut = Date.now() - 15 * 60_000;
  while (b.length && (b[0].t < cut || b.length > 6000)) b.shift();
}

// ---- live curve feed: the RPC's websocket pushes every change to a coin's bonding curve.
// Free (no PumpPortal key needed). Works while a coin is still on its pump.fun curve.
const RPC_WS = RPC_URL.replace(/^http/i, "ws");
let curveWs = null;
let curveWsState = "off";
let curveTicks = 0;
let rpcMsgId = 1;
const curveSubs = new Map(); // mint -> { curve, subId, lastRealSol }
const subToMint = new Map();
const pendingSubs = new Map(); // request id -> mint
const curveOpen = () => curveWs && curveWs.readyState === 1;

function connectCurveWs() {
  if (typeof WebSocket === "undefined") {
    curveWsState = "unavailable (needs Node 22+)";
    return;
  }
  try {
    curveWs = new WebSocket(RPC_WS);
  } catch (e) {
    curveWsState = "error: " + e.message;
    setTimeout(connectCurveWs, 10_000);
    return;
  }
  curveWsState = "connecting";
  curveWs.addEventListener("open", () => {
    curveWsState = "live";
    subToMint.clear();
    pendingSubs.clear();
    for (const c of curveSubs.values()) c.subId = null;
    for (const mint of tradeSubs.keys()) subscribeCurve(mint, true);
  });
  curveWs.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (m.id != null && pendingSubs.has(m.id)) {
      const mint = pendingSubs.get(m.id);
      pendingSubs.delete(m.id);
      if (m.error) {
        streamNotes.unshift({ at: new Date().toISOString(), message: "RPC: " + String(m.error.message || JSON.stringify(m.error)).slice(0, 180) });
        if (streamNotes.length > 8) streamNotes.pop();
        return;
      }
      const c = curveSubs.get(mint);
      if (c && tradeSubs.has(mint)) {
        c.subId = m.result;
        subToMint.set(m.result, mint);
      } else if (curveOpen()) curveWs.send(JSON.stringify({ jsonrpc: "2.0", id: rpcMsgId++, method: "accountUnsubscribe", params: [m.result] }));
      return;
    }
    if (m.method === "accountNotification") {
      const mint = subToMint.get(m.params?.subscription);
      const v = m.params?.result?.value;
      if (!mint || !v?.data?.[0]) return;
      const d = Buffer.from(v.data[0], "base64");
      if (d.length < 49) return;
      const vTok = Number(d.readBigUInt64LE(8));
      const vSol = Number(d.readBigUInt64LE(16));
      const rSol = Number(d.readBigUInt64LE(32));
      if (!(vTok > 0)) return;
      const c = curveSubs.get(mint);
      const moved = c?.lastRealSol != null ? Math.abs(rSol - c.lastRealSol) / 1e9 : 0;
      if (c) c.lastRealSol = rSol;
      curveTicks++;
      recordTick(mint, vSol / 1e9 / (vTok / 1e6), moved);
    }
  });
  curveWs.addEventListener("close", () => {
    curveWsState = "reconnecting";
    setTimeout(connectCurveWs, 5000);
  });
  curveWs.addEventListener("error", () => {
    curveWsState = "reconnecting";
  });
}
function subscribeCurve(mint, resend = false) {
  let c = curveSubs.get(mint);
  if (!c) {
    try {
      c = { curve: findPDA([Buffer.from("bonding-curve"), pubkeyBytes(mint)], PUMP_PROGRAM), subId: null, lastRealSol: null };
    } catch {
      return;
    }
    curveSubs.set(mint, c);
  } else if (!resend && c.subId != null) return;
  if (!curveOpen()) return; // subscribed when the socket opens
  const id = rpcMsgId++;
  pendingSubs.set(id, mint);
  curveWs.send(JSON.stringify({ jsonrpc: "2.0", id, method: "accountSubscribe", params: [c.curve, { encoding: "base64", commitment: "confirmed" }] }));
}
function unsubscribeCurve(mint) {
  const c = curveSubs.get(mint);
  if (!c) return;
  curveSubs.delete(mint);
  if (c.subId != null) {
    subToMint.delete(c.subId);
    if (curveOpen()) curveWs.send(JSON.stringify({ jsonrpc: "2.0", id: rpcMsgId++, method: "accountUnsubscribe", params: [c.subId] }));
  }
}

// 1-second candles; seconds with no trade carry the last close so time stays even.
function secondCandles(mint, n) {
  const b = tradeBuf.get(mint);
  if (!b || !b.length) return [];
  const end = Math.floor(Date.now() / 1000) * 1000;
  const start = Math.max(Math.floor(b[0].t / 1000) * 1000, end - (n - 1) * 1000);
  const by = new Map();
  let before = null;
  for (const x of b) {
    const k = Math.floor(x.t / 1000) * 1000;
    if (k < start) { before = x.p; continue; }
    const c = by.get(k);
    if (!c) by.set(k, { t: k, o: x.p, h: x.p, l: x.p, c: x.p, v: x.v });
    else { c.h = Math.max(c.h, x.p); c.l = Math.min(c.l, x.p); c.c = x.p; c.v += x.v; }
  }
  const out = [];
  let last = before;
  for (let k = start; k <= end; k += 1000) {
    const c = by.get(k);
    if (c) { if (last != null) { c.o = last; c.h = Math.max(c.h, last); c.l = Math.min(c.l, last); } out.push(c); last = c.c; }
    else if (last != null) out.push({ t: k, o: last, h: last, l: last, c: last, v: 0 });
  }
  return out;
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
    if (!m.txType) {
      streamNotes.unshift({ at: new Date().toISOString(), message: String(m.message || m.error || JSON.stringify(m)).slice(0, 200) });
      if (streamNotes.length > 8) streamNotes.pop();
      return;
    }
    if (m.txType === "buy" || m.txType === "sell") {
      tradeMsgs++;
      if (m.mint && tradeSubs.has(m.mint)) followedTradeMsgs++;
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
    } else if (m.txType === "buy" || m.txType === "sell") {
      if (!watched.has(m.traderPublicKey)) return;
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

// ---------------------------------------------------------------- trading (Octo's own wallet)
// Every limit is enforced here, on the server, so nothing said in chat can exceed it.
const numEnv = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const LIMITS = {
  maxBuySol: numEnv("MAX_BUY_SOL", 0.05),
  dailyBudgetSol: numEnv("DAILY_BUDGET_SOL", 0.25),
  maxOpenPositions: numEnv("MAX_OPEN_POSITIONS", 3),
  reserveSol: numEnv("RESERVE_SOL", 0.02), // always left in the wallet for fees
  slippagePct: numEnv("SLIPPAGE_PCT", 15),
  priorityFeeSol: numEnv("PRIORITY_FEE_SOL", 0.0005),
  takeProfit1X: numEnv("TAKE_PROFIT_1_X", 2), // sell half here
  takeProfit2X: numEnv("TAKE_PROFIT_2_X", 3.5), // sell the rest here
  stopLossPct: numEnv("STOP_LOSS_PCT", 35),
  maxHoldHours: numEnv("MAX_HOLD_HOURS", 12),
};
// Paper mode is the default: real fills only with PAPER_MODE=false AND a wallet AND trading on.
const PAPER = !/^(0|false|off|no)$/i.test(process.env.PAPER_MODE || "");
const PAPER_START_SOL = numEnv("PAPER_START_SOL", 1);
const PAPER_COST = numEnv("PAPER_COST_PCT", 3) / 100; // fee + slippage charged on each side of a paper fill
const AUTO_PAPER = PAPER && !/^(0|false|off|no)$/i.test(process.env.AUTO_PAPER || "");
const RULES = {
  standDownBelow: 0.5, // meme dial under this: no buys today
  maxPoolSharePct: numEnv("MAX_POOL_SHARE_PCT", 2), // never more than this % of the pool, or you are the exit
  minTicketSol: numEnv("MIN_TICKET_SOL", 0.005),
  maxDailyLossSol: numEnv("MAX_DAILY_LOSS_SOL", 0.1), // realized loss that makes the desk flat until tomorrow (UTC)
  volumeDeadRatio: numEnv("VOLUME_DEAD_RATIO", 0.2), // last hour's volume vs the coin's average hour
};
const paper = { cashSol: PAPER_START_SOL, startedAt: new Date().toISOString() };
const offWords = /^(0|false|off|no)$/i;
let tradingOn = PAPER ? !offWords.test(process.env.TRADING_ENABLED || "") : /^(1|true|on|yes)$/i.test(process.env.TRADING_ENABLED || "");
const positions = new Map(); // mint -> position
const tradeLog = [];
const closedTrades = []; // the journal Octo learns from
const rejections = []; // every buy that was refused and why: data for checking the rules
let spentDay = new Date().toISOString().slice(0, 10);
let spentToday = 0;
let realizedToday = 0;
let tradeLock = Promise.resolve();

function loadWallet() {
  const raw = (process.env.OCTO_WALLET_KEY || "").trim();
  if (!raw) return null;
  let bytes = raw.startsWith("[") ? Buffer.from(JSON.parse(raw)) : b58decode(raw);
  if (bytes.length < 64 && bytes.length > 32) bytes = Buffer.concat([Buffer.alloc(64 - bytes.length), bytes]);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("OCTO_WALLET_KEY is not a Solana private key");
  const seed = bytes.subarray(0, 32);
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  if (bytes.length === 64 && !pub.equals(bytes.subarray(32))) throw new Error("OCTO_WALLET_KEY doesn't match its own public key");
  return { key, publicKey: b58encode(pub), pubBytes: pub };
}
let wallet = null;
let walletError = null;
try {
  wallet = loadWallet();
} catch (e) {
  walletError = e.message;
}

function readCompactU16(buf, off) {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = buf[off + size];
    len |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
  }
  return [len, size];
}
// Signs a serialized Solana transaction whose fee payer (first signer) is Octo's wallet.
function signTx(txBytes, w) {
  const [n, sz] = readCompactU16(txBytes, 0);
  const msg = txBytes.subarray(sz + 64 * n);
  let o = msg[0] & 0x80 ? 1 : 0;
  o += 3;
  const [, s2] = readCompactU16(msg, o);
  o += s2;
  const payer = msg.subarray(o, o + 32);
  if (!Buffer.from(payer).equals(w.pubBytes)) throw new Error("Refusing to sign: the transaction's payer isn't Octo's wallet");
  const sig = crypto.sign(null, msg, w.key);
  const out = Buffer.from(txBytes);
  sig.copy(out, sz);
  return { tx: out, signature: b58encode(sig) };
}

async function solBalance() {
  if (PAPER) return paper.cashSol;
  const r = await rpc("getBalance", [wallet.publicKey]);
  return (r?.value ?? 0) / 1e9;
}
async function tokenBalance(mint) {
  const r = await rpc("getTokenAccountsByOwner", [wallet.publicKey, { mint }, { encoding: "jsonParsed" }]);
  let ui = 0;
  let raw = 0n;
  for (const a of r?.value || []) {
    const t = a?.account?.data?.parsed?.info?.tokenAmount;
    ui += Number(t?.uiAmount) || 0;
    raw += BigInt(t?.amount || "0");
  }
  return { ui, raw };
}

// Price of one token in SOL: from the bonding curve while on pump.fun, otherwise from Jupiter.
async function priceInSol(mint) {
  try {
    const c = await chainPump(mint);
    if (c.found && !c.migrated && c.marketCapSol != null) return c.marketCapSol / 1e9;
  } catch {}
  const [j, sol] = await Promise.all([jupiter(mint).catch(() => null), solPriceUsd()]);
  if (j?.priceUsd && sol) return j.priceUsd / sol;
  return null;
}

async function confirmSig(sig, ms = 45_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
      const st = r?.value?.[0];
      if (st?.err) throw new Error("Transaction failed on-chain: " + JSON.stringify(st.err));
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true;
    } catch (e) {
      if (String(e.message).startsWith("Transaction failed")) throw e;
    }
  }
  throw new Error("Not confirmed in time. Check the signature on Solscan before retrying.");
}

async function swap(action, mint, amount) {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: wallet.publicKey,
      action,
      mint,
      amount,
      denominatedInSol: action === "buy" ? "true" : "false",
      slippage: LIMITS.slippagePct,
      priorityFee: LIMITS.priorityFeeSol,
      pool: "auto",
    }),
  });
  if (res.status !== 200) throw new Error("PumpPortal refused the trade: " + (await res.text()).slice(0, 200));
  const { tx, signature } = signTx(Buffer.from(await res.arrayBuffer()), wallet);
  await rpc("sendTransaction", [tx.toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 3 }]);
  await confirmSig(signature);
  return signature;
}

function logTrade(t) {
  tradeLog.unshift({ ...t, at: new Date().toISOString() });
  if (tradeLog.length > 100) tradeLog.pop();
}
function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== spentDay) {
    spentDay = d;
    spentToday = 0;
    realizedToday = 0;
  }
}
function logReject(mint, reason, extra = {}) {
  rejections.unshift({ at: new Date().toISOString(), mint, reason, ...extra });
  if (rejections.length > 200) rejections.pop();
}
const withLock = (fn) => {
  const p = tradeLock.then(fn, fn);
  tradeLock = p.catch(() => {});
  return p;
};

function needWallet() {
  if (PAPER) return;
  if (!wallet) throw new Error(walletError || "No trading wallet set. Add OCTO_WALLET_KEY in Render's Environment settings.");
}

function compactSignals(r) {
  if (!r) return null;
  const m = r.market || {};
  const h1 = m.stats1h || {};
  return {
    marketCapUsd: m.marketCapUsd ?? r.pumpfun?.marketCapUsd ?? null,
    liquidityUsd: m.liquidityUsd ?? null,
    holders: m.holders ?? null,
    organicScore: m.organicScore != null ? round(m.organicScore, 0) : null,
    buySellRatio1h: h1.buyVolumeUsd && h1.sellVolumeUsd ? round(h1.buyVolumeUsd / h1.sellVolumeUsd, 2) : null,
    netBuyers1h: h1.netBuyers ?? null,
    priceChange1h: h1.priceChangePct ?? null,
    bondingCurveProgressPct: r.pumpfun?.bondingCurveProgressPct ?? null,
    migrated: r.pumpfun?.migrated ?? null,
    top10HoldersPct: r.safety?.top10HoldersPct ?? null,
    devHoldingPct: r.safety?.devHoldingPct ?? null,
    riskScore: r.rugRadar?.riskScore ?? null,
    risk: r.rugRadar?.risk ?? null,
    bundledPct: r.rugRadar?.earlyBuyers?.bundledPct ?? null,
    sniperPct: r.rugRadar?.earlyBuyers?.sniperPct ?? null,
    freshHolderPct: r.rugRadar?.freshHolders?.freshPct ?? null,
  };
}

// SOL in the coin's pool: the bonding curve's SOL while on pump.fun, otherwise the DEX pool's liquidity in SOL.
async function poolSol(mint) {
  try {
    const c = await chainPump(mint);
    if (c.found && !c.migrated && c.solInCurve != null) return c.solInCurve;
  } catch {}
  const [m, sol] = await Promise.all([marketData(mint).catch(() => null), solPriceUsd()]);
  if (m?.liquidityUsd && sol) return m.liquidityUsd / sol;
  return null;
}

// Every refused buy lands in the rejection log, so the rules themselves can be checked later.
async function buy(mint, sol, reason, score, source = "chat") {
  try {
    return await buyInner(mint, sol, reason, score, source);
  } catch (e) {
    logReject(mint, e.message, { source });
    throw e;
  }
}

async function buyInner(mint, sol, reason, score, source) {
  needWallet();
  if (!tradingOn) throw new Error("Trading is paused. Turn it on with set_trading, or set TRADING_ENABLED on Render.");
  const dial = await riskDial();
  if (!(dial.memeDial >= RULES.standDownBelow)) {
    throw new Error(`Stand-down day: the meme dial is ${dial.memeDial} (buys need ${RULES.standDownBelow}+). Red: ${dial.red.join(", ") || "none"}.`);
  }
  return withLock(async () => {
    rollDay();
    if (realizedToday <= -RULES.maxDailyLossSol) {
      throw new Error(`Flat until tomorrow (UTC): today's realized loss is ${round(-realizedToday, 4)} SOL, the limit is ${RULES.maxDailyLossSol} SOL.`);
    }
    const asked = Math.min(Number(sol) || LIMITS.maxBuySol, LIMITS.maxBuySol);
    if (!(asked > 0)) throw new Error("Buy amount must be above 0.");
    if (positions.has(mint)) throw new Error("Octo already holds this coin.");
    if (positions.size >= LIMITS.maxOpenPositions) throw new Error(`Already at the limit of ${LIMITS.maxOpenPositions} open positions.`);

    // Size: the request, times the dial, capped at a slice of the pool so Octo is never the exit.
    const pool = await poolSol(mint).catch(() => null);
    const poolCap = pool != null ? (pool * RULES.maxPoolSharePct) / 100 : null;
    let amt = asked * dial.memeDial;
    if (poolCap != null) amt = Math.min(amt, poolCap);
    amt = Math.floor(amt * 1e4) / 1e4;
    if (amt < RULES.minTicketSol) {
      throw new Error(`Ticket too small: ${amt} SOL after the dial (${dial.memeDial}) and the ${RULES.maxPoolSharePct}% pool cap (pool ${round(pool, 2)} SOL). Minimum is ${RULES.minTicketSol}.`);
    }
    if (spentToday + amt > LIMITS.dailyBudgetSol + 1e-9) throw new Error(`Daily budget reached (${round(spentToday, 3)} of ${LIMITS.dailyBudgetSol} SOL spent today).`);
    const bal = await solBalance();
    if (bal - amt - LIMITS.priorityFeeSol < LIMITS.reserveSol) throw new Error(`Not enough SOL: wallet has ${round(bal, 4)} SOL and keeps ${LIMITS.reserveSol} SOL for fees.`);
    const safety = await safetyCheck(mint, {}).catch(() => null);
    if (safety?.found === false) throw new Error("That address isn't a token.");
    if (safety?.mintAuthority) throw new Error("Refused: mint authority is still on (more tokens can be printed).");
    if (safety?.freezeAuthority) throw new Error("Refused: freeze authority is on (honeypot risk).");

    let sig;
    let tokens;
    let costSol = amt;
    if (PAPER) {
      const price = await priceInSol(mint);
      if (!(price > 0)) throw new Error("Couldn't price this coin for a paper fill.");
      tokens = (amt * (1 - PAPER_COST)) / price;
      costSol = round(amt + LIMITS.priorityFeeSol, 6);
      paper.cashSol = round(paper.cashSol - costSol, 6);
      sig = "paper-" + crypto.randomUUID().slice(0, 8);
    } else {
      const before = await tokenBalance(mint);
      sig = await swap("buy", mint, amt);
      let after = await tokenBalance(mint);
      for (let i = 0; i < 4 && after.ui <= before.ui; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        after = await tokenBalance(mint);
      }
      tokens = after.ui - before.ui;
    }
    spentToday += amt;
    const pos = {
      mint,
      name: null,
      symbol: null,
      mode: PAPER ? "paper" : "live",
      source,
      tokens,
      costSol,
      soldSol: 0,
      entryPriceSol: tokens > 0 ? costSol / tokens : null,
      soldHalf: false,
      openedAt: new Date().toISOString(),
      reason: String(reason || "").slice(0, 200),
      sendScore: Number.isFinite(Number(score)) ? Number(score) : null,
      dialAtEntry: dial.memeDial,
      sizing: { askedSol: asked, dial: dial.memeDial, poolSol: round(pool, 3), poolCapSol: round(poolCap, 4), finalSol: amt },
      entrySignals: null,
    };
    positions.set(mint, pos);
    // Snapshot what the coin looked like at entry, for the journal (runs in the background).
    tokenReport(mint)
      .then((r) => {
        pos.entrySignals = compactSignals(r);
        pos.name = r?.market?.name || r?.pumpfun?.name || null;
        pos.symbol = r?.market?.symbol || r?.pumpfun?.symbol || null;
      })
      .catch(() => {});
    logTrade({ side: "buy", mode: pos.mode, mint, sol: amt, tokens, signature: sig, reason: pos.reason });
    return {
      ok: true,
      mode: pos.mode,
      signature: sig,
      solscan: PAPER ? null : `https://solscan.io/tx/${sig}`,
      position: pos,
      spentToday: round(spentToday, 3),
      ...(PAPER ? { paperCashSol: paper.cashSol } : {}),
    };
  });
}

async function sell(mint, percent, why) {
  needWallet();
  return withLock(async () => {
    rollDay();
    const pct = Math.max(1, Math.min(100, Math.round(Number(percent) || 100)));
    const pos = positions.get(mint);
    let sig;
    let received;
    if (PAPER) {
      if (!pos || !(pos.tokens > 0)) {
        positions.delete(mint);
        throw new Error("Octo's paper wallet holds none of this coin.");
      }
      const price = await priceInSol(mint).catch(() => null);
      const ageH = (Date.now() - Date.parse(pos.openedAt)) / 3.6e6;
      if (!(price > 0)) {
        // A coin that can't be priced after the max hold is treated as dead: written off at zero.
        if (ageH < LIMITS.maxHoldHours) throw new Error("Couldn't price this coin for a paper sell right now.");
        received = 0;
      } else {
        const qty = (pos.tokens * pct) / 100;
        received = Math.max(0, round(qty * price * (1 - PAPER_COST) - LIMITS.priorityFeeSol, 6));
      }
      paper.cashSol = round(paper.cashSol + received, 6);
      sig = "paper-" + crypto.randomUUID().slice(0, 8);
    } else {
      const bal = await tokenBalance(mint);
      if (!(bal.ui > 0)) {
        positions.delete(mint);
        throw new Error("Octo's wallet holds none of this coin.");
      }
      const solBefore = await solBalance();
      sig = await swap("sell", mint, `${pct}%`);
      const solAfter = await solBalance().catch(() => null);
      received = solAfter != null ? round(solAfter - solBefore, 4) : null;
    }
    if (pos) {
      pos.soldSol = round((pos.soldSol || 0) + (received || 0), 6);
      if (pct >= 100) {
        positions.delete(mint);
        if (tradeSubs.get(mint) === Infinity) tradeSubs.set(mint, Date.now());
        const pnlSol = round(pos.soldSol - pos.costSol, 6);
        realizedToday += pnlSol;
        closedTrades.unshift({
          mint,
          name: pos.name,
          symbol: pos.symbol,
          mode: pos.mode || (PAPER ? "paper" : "live"),
          source: pos.source || null,
          openedAt: pos.openedAt,
          closedAt: new Date().toISOString(),
          holdHours: round((Date.now() - Date.parse(pos.openedAt)) / 3.6e6, 2),
          costSol: pos.costSol,
          returnedSol: pos.soldSol,
          pnlSol,
          multiple: pos.costSol ? round(pos.soldSol / pos.costSol, 2) : null,
          won: pos.soldSol > pos.costSol,
          exitReason: why || "manual",
          buyReason: pos.reason,
          sendScore: pos.sendScore,
          dialAtEntry: pos.dialAtEntry ?? null,
          sizing: pos.sizing ?? null,
          entrySignals: pos.entrySignals,
        });
        if (closedTrades.length > 200) closedTrades.pop();
      } else pos.tokens = Math.max(0, pos.tokens * (1 - pct / 100));
    }
    logTrade({ side: "sell", mode: PAPER ? "paper" : "live", mint, percent: pct, solReceived: received, signature: sig, reason: why || "manual" });
    return {
      ok: true,
      mode: PAPER ? "paper" : "live",
      signature: sig,
      solscan: PAPER ? null : `https://solscan.io/tx/${sig}`,
      percentSold: pct,
      solReceived: received,
      ...(PAPER ? { paperCashSol: paper.cashSol } : {}),
    };
  });
}

async function positionView(p) {
  const price = await priceInSol(p.mint).catch(() => null);
  if (price != null) solPriceUsd().then((u) => u && recordPrice(p.mint, price * u)).catch(() => {});
  const value = price != null ? price * p.tokens : null;
  const multiple = p.entryPriceSol && price ? price / p.entryPriceSol : null;
  return { ...p, priceSol: price, valueSol: value != null ? round(value, 4) : null, multiple: multiple != null ? round(multiple, 2) : null, pnlPct: multiple != null ? round((multiple - 1) * 100, 1) : null };
}

async function walletStatus() {
  needWallet();
  rollDay();
  const [bal, views] = await Promise.all([solBalance(), Promise.all([...positions.values()].map(positionView))]);
  const held = views.reduce((s, v) => s + (v.valueSol || 0), 0);
  return {
    mode: PAPER ? "paper (simulated fills, no real SOL)" : "live",
    address: PAPER ? null : wallet.publicKey,
    solBalance: round(bal, 4),
    ...(PAPER
      ? {
          paperStartSol: PAPER_START_SOL,
          paperEquitySol: round(bal + held, 4),
          paperReturnPct: round(((bal + held) / PAPER_START_SOL - 1) * 100, 2),
          paperSince: paper.startedAt,
          paperCostPctPerSide: PAPER_COST * 100,
          autoPaper: AUTO_PAPER ? "on" : "off",
        }
      : {}),
    trading: tradingOn ? "on" : "paused",
    spentToday: round(spentToday, 3),
    realizedTodaySol: round(realizedToday, 4),
    limits: LIMITS,
    rules: RULES,
    openPositions: views,
    recentTrades: tradeLog.slice(0, 15),
  };
}

// Is the coin's trading drying up? Last hour's volume against its average hour (over up to 6h).
async function volumeDying(mint) {
  const m = await marketData(mint).catch(() => null);
  const h1 = m?.stats1h;
  const h6 = m?.stats6h;
  if (!h1 || !h6) return null;
  const v1 = (h1.buyVolumeUsd || 0) + (h1.sellVolumeUsd || 0);
  const v6 = (h6.buyVolumeUsd || 0) + (h6.sellVolumeUsd || 0);
  const hours = Math.min(6, Math.max(1, Number(m.ageHours) || 6));
  if (!(v6 > 0) || hours < 2) return null; // too young to have a normal pace
  const ratio = v1 / (v6 / hours);
  return { ratio: round(ratio, 2), dying: ratio < RULES.volumeDeadRatio };
}

// Automatic exits: stop loss, take profit, volume dying, max hold time. Runs every 20 seconds.
async function exitLoop() {
  if ((!wallet && !PAPER) || !positions.size) return;
  for (const p of [...positions.values()]) {
    try {
      const v = await positionView(p);
      const ageH = (Date.now() - Date.parse(p.openedAt)) / 3.6e6;
      if (v.multiple == null) {
        if (ageH >= LIMITS.maxHoldHours) await sell(p.mint, 100, `held ${round(ageH, 1)}h and can't be priced, closing`);
        continue;
      }
      if (v.multiple <= 1 - LIMITS.stopLossPct / 100) await sell(p.mint, 100, `stop loss at ${v.pnlPct}%`);
      else if (v.multiple >= LIMITS.takeProfit2X) await sell(p.mint, 100, `take profit at ${v.multiple}x`);
      else if (!p.soldHalf && v.multiple >= LIMITS.takeProfit1X) {
        await sell(p.mint, 50, `first take profit at ${v.multiple}x`);
        const still = positions.get(p.mint);
        if (still) still.soldHalf = true;
      } else if (ageH >= LIMITS.maxHoldHours) await sell(p.mint, 100, `held ${round(ageH, 1)}h, closing`);
      else if (!p.lastVolumeCheck || Date.now() - p.lastVolumeCheck > 5 * 60_000) {
        p.lastVolumeCheck = Date.now();
        const vol = await volumeDying(p.mint);
        if (vol?.dying) await sell(p.mint, 100, `volume dried up (last hour ${vol.ratio}x its normal pace)`);
      }
    } catch (e) {
      logTrade({ side: "error", mint: p.mint, error: e.message });
    }
  }
}

// ---------------------------------------------------------------- risk dial
// One number for how hard Octo may push today, from the market around the coins, not the coins.
// Inputs (green or red): BTC above its 200-day average, SOL above its 50-day, VIX under 22,
// and US net liquidity (Fed balance sheet minus TGA minus reverse repo) rising over 4 weeks.
// Dial = share of greens. Anything that can't be read or is stale counts as red, never green.
async function getText(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "octo-eyes/" + VERSION } });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${new URL(url).host} timed out`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Completed daily closes, oldest first, with the date of the last one.
async function dailyCloses(asset) {
  const kraken = { BTC: "XBTUSD", SOL: "SOLUSD" }[asset];
  const gecko = { BTC: "bitcoin", SOL: "solana" }[asset];
  try {
    const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${kraken}&interval=1440`, {}, 10000);
    if (j.error?.length) throw new Error(j.error.join(", "));
    const k = Object.keys(j.result || {}).find((x) => x !== "last");
    const rows = (j.result?.[k] || []).slice(0, -1); // the last candle is today's, still open
    if (rows.length < 210) throw new Error("not enough history");
    return { source: "Kraken", closes: rows.map((r) => Number(r[4])), lastDate: new Date(rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10) };
  } catch (e) {
    const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${gecko}/market_chart?vs_currency=usd&days=260&interval=daily`, {}, 10000);
    const rows = (j.prices || []).slice(0, -1);
    if (rows.length < 210) throw new Error(`${asset} price history unavailable (Kraken: ${e.message})`);
    return { source: "CoinGecko", closes: rows.map((r) => Number(r[1])), lastDate: new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10) };
  }
}

async function fredSeries(id, sinceDays = 120) {
  const start = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`);
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(","))
    .filter(([d, v]) => d && v && v !== "." && Number.isFinite(Number(v)))
    .map(([d, v]) => ({ date: d, value: Number(v) }));
}

const ageDays = (date) => (Date.now() - Date.parse(date + "T00:00:00Z")) / 864e5;
const sma = (arr, n) => arr.slice(-n).reduce((s, x) => s + x, 0) / n;

async function computeDial() {
  const inputs = {};
  const check = async (name, fn) => {
    try {
      inputs[name] = await fn();
    } catch (e) {
      inputs[name] = { green: false, degraded: true, error: e.message };
    }
  };
  await Promise.all([
    check("btc_above_200d", async () => {
      const d = await dailyCloses("BTC");
      const last = d.closes.at(-1);
      const avg = sma(d.closes, 200);
      const stale = ageDays(d.lastDate) > 3;
      return { green: !stale && last > avg, degraded: stale, close: round(last, 0), avg200: round(avg, 0), vsAvgPct: round((last / avg - 1) * 100, 2), asOf: d.lastDate, source: d.source };
    }),
    check("sol_above_50d", async () => {
      const d = await dailyCloses("SOL");
      const last = d.closes.at(-1);
      const avg = sma(d.closes, 50);
      const stale = ageDays(d.lastDate) > 3;
      return { green: !stale && last > avg, degraded: stale, close: round(last, 2), avg50: round(avg, 2), vsAvgPct: round((last / avg - 1) * 100, 2), asOf: d.lastDate, source: d.source };
    }),
    check("vix_under_22", async () => {
      const s = await fredSeries("VIXCLS", 30);
      const last = s.at(-1);
      if (!last) throw new Error("no VIX data");
      const stale = ageDays(last.date) > 5; // weekends and holidays
      return { green: !stale && last.value < 22, degraded: stale, vix: last.value, asOf: last.date };
    }),
    check("net_liquidity_rising", async () => {
      const [walcl, tga, rrp] = await Promise.all([fredSeries("WALCL", 90), fredSeries("WTREGEN", 90), fredSeries("RRPONTSYD", 90)]);
      if (walcl.length < 5) throw new Error("not enough Fed balance sheet data");
      const onOrBefore = (s, date) => [...s].reverse().find((x) => x.date <= date)?.value;
      const net = (date) => {
        const w = walcl.find((x) => x.date === date)?.value;
        const t = onOrBefore(tga, date);
        const r = onOrBefore(rrp, date);
        return w == null || t == null || r == null ? null : w / 1000 - t / 1000 - r; // WALCL and WTREGEN are millions, RRPONTSYD billions
      };
      const lastDate = walcl.at(-1).date;
      const prevDate = walcl.at(-5).date;
      const now = net(lastDate);
      const then = net(prevDate);
      if (now == null || then == null) throw new Error("couldn't line up the liquidity series");
      const stale = ageDays(lastDate) > 12; // weekly series, published with a lag
      return { green: !stale && now - then > 0, degraded: stale, netLiquidityBn: round(now, 1), change4wBn: round(now - then, 1), asOf: lastDate };
    }),
  ]);
  const names = Object.keys(inputs);
  const greens = names.filter((n) => inputs[n].green);
  return {
    computedAt: new Date().toISOString(),
    memeDial: greens.length / names.length, // never rounded up
    standDown: greens.length / names.length < RULES.standDownBelow,
    green: greens,
    red: names.filter((n) => !inputs[n].green),
    inputs,
  };
}

let dialCache = null;
async function riskDial(fresh = false) {
  if (!fresh && dialCache && Date.now() - Date.parse(dialCache.computedAt) < 3 * 3.6e6) return dialCache;
  dialCache = await computeDial();
  return dialCache;
}

// ---------------------------------------------------------------- auto paper trader
// Paper only. Every 5 minutes: the scanner's top picks, a full token report on the best,
// and a paper buy if it passes plain rules. It is the baseline Octo's own calls have to beat.
let autoState = { lastRun: null, lastResult: null };
async function autoPaperTick() {
  if (!AUTO_PAPER || !tradingOn) return;
  rollDay();
  autoState.lastRun = new Date().toISOString();
  if (positions.size >= LIMITS.maxOpenPositions) return (autoState.lastResult = "positions full");
  if (spentToday + RULES.minTicketSol > LIMITS.dailyBudgetSol) return (autoState.lastResult = "daily budget used");
  const dial = await riskDial().catch(() => null);
  if (!dial || dial.standDown) return (autoState.lastResult = `stand-down (dial ${dial?.memeDial ?? "unreadable"})`);
  const { picks } = await scannerPicks(5);
  const fresh = picks.filter((p) => !positions.has(p.mint) && !closedTrades.some((t) => t.mint === p.mint) && !rejections.some((r) => r.mint === p.mint));
  for (const pick of fresh.slice(0, 2)) {
    const r = await tokenReport(pick.mint).catch(() => null);
    const s = compactSignals(r);
    const why = [];
    if (!s) why.push("no report");
    else {
      if (s.risk !== "low") why.push(`rug radar ${s.risk} (${s.riskScore})`);
      if (s.top10HoldersPct != null && s.top10HoldersPct > 30) why.push(`top 10 hold ${s.top10HoldersPct}%`);
      if (s.devHoldingPct != null && s.devHoldingPct > 5) why.push(`dev holds ${s.devHoldingPct}%`);
      if (s.bundledPct != null && s.bundledPct > 10) why.push(`bundled ${s.bundledPct}%`);
    }
    if (why.length) {
      logReject(pick.mint, "auto: " + why.join("; "), { source: "auto", momentumScore: pick.momentumScore });
      continue;
    }
    try {
      await buy(pick.mint, LIMITS.maxBuySol, `auto: scanner momentum ${pick.momentumScore}, rug radar low`, null, "auto");
      return (autoState.lastResult = `bought ${pick.symbol || pick.mint}`);
    } catch (e) {
      return (autoState.lastResult = "buy refused: " + e.message);
    }
  }
  autoState.lastResult = fresh.length ? "no pick passed the rules" : "no new picks";
}

// After a restart, rebuild positions from the coins actually in the wallet.
// Entry prices are lost on restart, so recovered positions start from today's price.
async function recoverPositions() {
  if (!wallet) return;
  try {
    const progs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022];
    for (const programId of progs) {
      const r = await rpc("getTokenAccountsByOwner", [wallet.publicKey, { programId }, { encoding: "jsonParsed" }]);
      for (const a of r?.value || []) {
        const info = a?.account?.data?.parsed?.info;
        const ui = Number(info?.tokenAmount?.uiAmount) || 0;
        if (ui <= 0 || positions.has(info.mint)) continue;
        const price = await priceInSol(info.mint).catch(() => null);
        if (price == null || price * ui < 0.001) continue; // ignore dust
        positions.set(info.mint, { mint: info.mint, tokens: ui, costSol: round(price * ui, 4), entryPriceSol: price, soldHalf: false, openedAt: new Date().toISOString(), reason: "recovered after restart (entry reset to current price)" });
      }
    }
  } catch (e) {
    logTrade({ side: "error", error: "recover: " + e.message });
  }
}

// ---------------------------------------------------------------- coin scanner
// Every 20s, reads the bonding curve of each coin launched in the last 40 minutes and tracks its momentum.
const scan = new Map();
async function scanTick() {
  const now = Date.now();
  const live = launches.filter((l) => {
    const age = now - Date.parse(l.at);
    return age > 20_000 && age < 40 * 60_000;
  }).slice(0, 100);
  if (!live.length) return;
  const keys = live.map((l) => l.bondingCurve || findPDA([Buffer.from("bonding-curve"), pubkeyBytes(l.mint)], PUMP_PROGRAM));
  const [r, solUsd] = await Promise.all([rpc("getMultipleAccounts", [keys, { encoding: "base64" }]), solPriceUsd().catch(() => null)]);
  (r?.value || []).forEach((acc, i) => {
    if (!acc?.data) return;
    const p = parseCurve(Buffer.from(acc.data[0], "base64"));
    if (!p) return;
    const l = live[i];
    if (solUsd && p.marketCapSol != null && !p.migrated) recordPrice(l.mint, (p.marketCapSol / 1e9) * solUsd, p.solInCurve);
    const prev = scan.get(l.mint);
    scan.set(l.mint, {
      mint: l.mint,
      name: l.name,
      symbol: l.symbol,
      creator: l.creator,
      devInitialBuySol: l.devInitialBuySol,
      launchedAt: l.at,
      firstAt: prev?.firstAt ?? now,
      firstProgress: prev?.firstProgress ?? (p.bondingCurveProgressPct || 0),
      lastAt: now,
      ...p,
    });
  });
  for (const [m, e] of scan) if (now - Date.parse(e.launchedAt) > 60 * 60_000) scan.delete(m);
  prunePriceHistory();
  for (const m of positions.keys()) followTrades(m, true);
  scannerPicks(3).then((r) => r.picks.forEach((p) => followTrades(p.mint))).catch(() => {});
}

async function scannerPicks(limit = 5) {
  const now = Date.now();
  const sol = await solPriceUsd().catch(() => null);
  const rows = [...scan.values()].map((e) => {
    const ageMin = Math.max(0.5, (now - Date.parse(e.launchedAt)) / 60000);
    const watchedMin = Math.max(0.5, (e.lastAt - e.firstAt) / 60000);
    const progress = e.migrated ? 100 : e.bondingCurveProgressPct || 0;
    const speed = progress / ageMin; // % of the curve filled per minute since launch
    const recent = e.lastAt > e.firstAt ? (progress - e.firstProgress) / watchedMin : 0; // since Octo started watching
    const score = progress * 0.5 + Math.min(speed, 15) * 3 + Math.max(-10, Math.min(recent, 10)) * 2 - (e.devInitialBuySol > 3 ? 10 : 0);
    return {
      mint: e.mint,
      name: e.name,
      symbol: e.symbol,
      ageMinutes: round(ageMin, 1),
      bondingCurveProgressPct: round(progress, 1),
      migrated: e.migrated,
      fillSpeedPctPerMin: round(speed, 2),
      recentMomentumPctPerMin: round(recent, 2),
      marketCapSol: e.marketCapSol,
      marketCapUsd: sol && e.marketCapSol ? round(e.marketCapSol * sol, 0) : null,
      devInitialBuySol: e.devInitialBuySol,
      creator: e.creator,
      momentumScore: round(score, 1),
    };
  });
  return {
    stream: streamState,
    coinsTracked: scan.size,
    note: "Momentum only. Run token_report on a pick before buying: it adds the rug radar and holder checks.",
    picks: rows.filter((r) => r.bondingCurveProgressPct >= 8).sort((a, b) => b.momentumScore - a.momentumScore).slice(0, Math.max(1, Math.min(20, limit))),
  };
}

function journalStats(t = closedTrades) {
  if (!t.length) return { trades: 0 };
  const wins = t.filter((x) => x.won).length;
  return {
    trades: t.length,
    wins,
    winRatePct: round((wins / t.length) * 100, 1),
    totalPnlSol: round(t.reduce((s2, x) => s2 + (x.pnlSol || 0), 0), 4),
    avgMultiple: round(t.reduce((s2, x) => s2 + (x.multiple || 0), 0) / t.length, 2),
  };
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
  {
    name: "wallet_status",
    description: "Octo's trading wallet: address, SOL balance, whether trading is on, today's spend, the hard limits, open positions with entry, current value, multiple and P&L, and recent trades.",
    inputSchema: { type: "object", properties: {} },
    run: async () => walletStatus(),
  },
  {
    name: "buy",
    description: "Buy a Solana token with Octo's wallet (simulated fills while the server is in paper mode). Refused on a stand-down day (risk dial under 0.5) or after the daily loss limit. Size = requested SOL (capped at the per-buy limit) x the risk dial, capped at 2% of the coin's pool. Also capped by the daily budget and max open positions; refuses tokens with mint or freeze authority on. Exits (stop loss, take profit, volume dying, max hold) then run automatically. Every refusal is logged in the trade journal.",
    inputSchema: {
      type: "object",
      properties: {
        ca: { type: "string", description: "Token mint address." },
        sol: { type: "number", description: "SOL to spend; anything above the per-buy limit is cut down to it." },
        reason: { type: "string", description: "Why Octo is buying, in a few words." },
        score: { type: "number", description: "Octo's send score for this coin, 0-10, saved to the trade journal." },
      },
      required: ["ca"],
    },
    run: async ({ ca, sol, reason, score }) => buy(needCA(ca), sol, reason, score),
  },
  {
    name: "sell",
    description: "Sell some or all of a token Octo holds. percent from 1 to 100 (default 100).",
    inputSchema: {
      type: "object",
      properties: { ca: { type: "string", description: "Token mint address." }, percent: { type: "number", description: "Percent of the holding to sell (default 100)." } },
      required: ["ca"],
    },
    run: async ({ ca, percent }) => sell(needCA(ca), percent ?? 100, "manual"),
  },
  {
    name: "scanner",
    description: "Octo's coin scanner: the pump.fun coins launched in the last 40 minutes with the strongest bonding-curve momentum (how fast the curve is filling, progress, market cap, dev's first buy). Momentum only: run token_report on a pick before buying.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20, description: "How many picks (default 5)." } } },
    run: async ({ limit = 5 } = {}) => scannerPicks(Number(limit) || 5),
  },
  {
    name: "trade_journal",
    description: "Octo's trade journal: every closed trade with cost, return, multiple, exit reason, send score and the coin's signals at entry, plus win rate and total P&L. Use it to learn which signals actually led to wins.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "How many closed trades (default 50)." } } },
    run: async ({ limit = 50 } = {}) => {
      const n = Math.max(1, Math.min(200, Number(limit) || 50));
      const by = (src) => journalStats(closedTrades.filter((t) => (t.source || "chat") === src));
      return {
        mode: PAPER ? "paper" : "live",
        stats: journalStats(),
        statsBySource: { chat: by("chat"), auto: by("auto") },
        ...(PAPER ? { paperCashSol: paper.cashSol, paperStartSol: PAPER_START_SOL, paperSince: paper.startedAt, autoPaper: { on: AUTO_PAPER, ...autoState } } : {}),
        closedTrades: closedTrades.slice(0, n),
        openPositions: [...positions.values()],
        rejections: rejections.slice(0, Math.min(n, 50)),
      };
    },
  },
  {
    name: "candles",
    description: "Price candles (open, high, low, close, volume in USD) for a Solana token, oldest first. Timeframes: 1s (built live from every change to the coin's pump.fun bonding curve, last 15 minutes, while it is still on the curve), 1m, 5m, 15m, 1h, 4h, 1d (GeckoTerminal, or Octo's own curve readings for brand-new coins).",
    inputSchema: {
      type: "object",
      properties: {
        ca: { type: "string", description: "The token's contract address (mint)." },
        timeframe: { type: "string", enum: Object.keys(TIMEFRAMES), description: "Candle size (default 5m)." },
        limit: { type: "integer", minimum: 10, maximum: 300, description: "How many candles (default 120)." },
      },
      required: ["ca"],
    },
    run: async ({ ca, timeframe, limit }) => candles(needCA(ca), timeframe, limit),
  },
  {
    name: "risk_dial",
    description: "Today's meme risk dial (0 to 1): the share of green market conditions — BTC above its 200-day average, SOL above its 50-day, VIX under 22, US net liquidity rising over 4 weeks. Under 0.5 is a stand-down day and buys are refused; otherwise buy size is multiplied by the dial. Unreadable or stale inputs count as red. Recomputed every 3 hours.",
    inputSchema: { type: "object", properties: { fresh: { type: "boolean", description: "Recompute now instead of using the last reading." } } },
    run: async ({ fresh = false } = {}) => riskDial(!!fresh),
  },
  {
    name: "set_trading",
    description: "Turn Octo's trading on or off (the kill switch). Exits on open positions keep running either way.",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean", description: "true to allow buys, false to pause them." } }, required: ["enabled"] },
    run: async ({ enabled }) => {
      tradingOn = !!enabled;
      return { trading: tradingOn ? "on" : "paused" };
    },
  },
];

const WRITE_TOOLS = new Set(["buy", "sell", "set_trading", "watch_wallet"]);

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
      return ok({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          annotations: WRITE_TOOLS.has(name) ? { readOnlyHint: false, destructiveHint: name === "sell" } : { readOnlyHint: true },
        })),
      });
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
    return send(res, 200, { name: "Octo Eyes", version: VERSION, ok: true, rpc: RPC_KIND, stream: streamState, curveFeed: curveWsState, curveUpdates: curveTicks, followingCurves: subToMint.size, feedNotes: streamNotes.slice(0, 3), launchesSeen: launches.length, watching: watched.size, mode: PAPER ? "paper" : "live", wallet: PAPER ? "paper" : wallet ? wallet.publicKey : walletError ? "error: " + walletError : "not set", trading: PAPER || wallet ? (tradingOn ? "on" : "paused") : "off", autoPaper: AUTO_PAPER ? "on" : "off", memeDial: dialCache?.memeDial ?? null, openPositions: positions.size, scannerTracking: scan.size, journalTrades: closedTrades.length });
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
  if (process.env.OCTO_NO_STREAM !== "1") {
    connectStream();
    connectCurveWs();
    setInterval(() => scanTick().catch(() => {}), 20_000);
  } else streamState = "off";
  if (PAPER) {
    console.log(`Paper mode: ${PAPER_START_SOL} SOL simulated bank, trading ${tradingOn ? "on" : "paused"}, auto paper ${AUTO_PAPER ? "on" : "off"}`);
    if (AUTO_PAPER && process.env.OCTO_NO_STREAM !== "1") setInterval(() => autoPaperTick().catch((e) => (autoState.lastResult = "error: " + e.message)), 5 * 60_000);
  } else if (wallet) {
    console.log(`Trading wallet ${wallet.publicKey}, trading ${tradingOn ? "on" : "paused"}`);
    recoverPositions();
  } else if (walletError) console.log("Trading wallet error: " + walletError);
  if (PAPER || wallet) {
    riskDial().catch(() => {});
    setInterval(() => exitLoop().catch(() => {}), 20_000);
    // Keep the free Render plan awake so exits keep running (and paper positions aren't lost to a sleep).
    const self = process.env.RENDER_EXTERNAL_URL;
    if (self) setInterval(() => fetch(self + "/health").catch(() => {}), 10 * 60_000);
  }
});
