/* meteora-lp-reader — DLMM + Hyperliquid (stable)
 * Endpoints:
 *  - GET /
 *  - GET /health
 *  - GET /lp/:positionId
 *  - GET /hl/:wallet/:coin?
 */

const express = require("express");
const cors = require("cors");
const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
app.use(cors());
app.use(express.json());

// -------------------- ENV --------------------
const HELIUS_KEY = (process.env.HELIUS_API_KEY || "").trim();
const HELIUS_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "";

// "processed" = mais rápido e reduz timeout no Render
const connection = HELIUS_RPC ? new Connection(HELIUS_RPC, "processed") : null;

// -------------------- CONSTANTS --------------------
const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// fallback de decimais por mint
function decimalsByMint(mint) {
  if (mint === MINT_WSOL) return 9;
  if (mint === MINT_USDC) return 6;
  return null;
}

// -------------------- FETCH with timeout --------------------
async function fetchJson(url, opts = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt?.slice(0, 600)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- DLMM loader --------------------
function loadDLMM() {
  const pkg = require("@meteora-ag/dlmm");
  const DLMM = pkg?.DLMM || pkg?.default || pkg;
  if (!DLMM || typeof DLMM.create !== "function") {
    const keys = pkg ? Object.keys(pkg) : [];
    throw new Error(`DLMM SDK not loaded (DLMM.create missing). exports keys=${keys.join(",")}`);
  }
  return DLMM;
}

let DLMM = null;
try {
  DLMM = loadDLMM();
} catch (e) {
  console.error("DLMM load error:", e?.message || e);
  DLMM = null;
}

// -------------------- Meteora helpers --------------------
async function meteoraPositionMeta(positionId) {
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  return fetchJson(url, {}, 20000);
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const data = await fetchJson(url, {}, 20000);
  const px = Number(data?.current_price ?? data?.price ?? data?.spot_price);
  return Number.isFinite(px) ? px : null;
}

// -------------------- Big number helpers --------------------
function toBigIntLoose(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return BigInt(s);
    return null;
  }
  try {
    const s = v.toString?.();
    if (typeof s === "string" && /^\d+$/.test(s.trim())) return BigInt(s.trim());
  } catch (_) {}
  return null;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function amountToNumber(bi, decimals) {
  if (bi === null || decimals === null || decimals === undefined) return null;
  const n = Number(bi);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, decimals);
}

// -------------------- Hyperliquid helpers --------------------
const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlPost(body, timeoutMs = 15000) {
  return fetchJson(HL_INFO, {
    method: "post",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
}

async function hlGetMid(coin = "SOL") {
  // allMids -> { SOL: "85.3065", ... }
  const mids = await hlPost({ type: "allMids" });
  const px = Number(mids?.[coin]);
  return Number.isFinite(px) ? px : null;
}

async function hlUserState(wallet) {
  // userState -> posições
  return hlPost({ type: "userState", user: wallet });
}

// tenta achar funding rate via metaAndAssetCtxs (nem sempre vem)
async function hlFundingRate(coin = "SOL") {
  try {
    const data = await hlPost({ type: "metaAndAssetCtxs" });
    const meta = data?.[0];
    const ctxs = data?.[1];
    const universe = meta?.universe || [];
    const idx = universe.findIndex(x => x?.name === coin);
    if (idx >= 0 && Array.isArray(ctxs) && ctxs[idx]) {
      const fr = Number(ctxs[idx]?.funding);
      return Number.isFinite(fr) ? fr : null;
    }
  } catch (_) {}
  return null;
}

function findCoinPos(userState, coin = "SOL") {
  // estrutura típica: assetPositions: [{ position: { coin, szi, entryPx, unrealizedPnl, ... }}, ...]
  const aps = userState?.assetPositions || [];
  for (const a of aps) {
    const p = a?.position || a;
    if (p?.coin === coin) return p;
  }
  return null;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-lp-reader",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet/:coin?"]
  });
});

app.get("/health", async (req, res) => {
  try {
    // checa DLMM + HELIUS (se tiver)
    let solanaVersion = null;
    let rpcEndpoint = "missing";

    if (HELIUS_RPC && connection) {
      const v = await connection.getVersion();
      solanaVersion = v;
      rpcEndpoint = "helius";
    }

    // checa Hyperliquid (sempre)
    let hl_ok = false;
    try {
      const mid = await hlGetMid("SOL");
      hl_ok = Number.isFinite(mid);
    } catch (_) {}

    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint,
      solanaVersion,
      dlmmLoaded: !!DLMM,
      hl_ok
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();

  try {
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });
    if (!HELIUS_RPC || !connection) return res.status(400).json({ ok: false, error: "Missing HELIUS_API_KEY env" });
    if (!DLMM) return res.status(500).json({ ok: false, error: "DLMM SDK failed to load (check logs)" });

    // meta -> pool + owner
    const meta = await meteoraPositionMeta(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool || meta?.lb_pair || null;
    const owner = meta?.owner || null;

    if (!pool) {
      return res.status(404).json({ ok: false, error: "pool not found for this positionId", meta });
    }

    const poolPk = new PublicKey(pool);
    const positionPk = new PublicKey(positionId);

    // spot
    const spot = await meteoraPoolSpot(pool);

    // cria pool instance
    const dlmmPool = await DLMM.create(connection, poolPk);

    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;

    let decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    let decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);

    if (!Number.isFinite(decX)) decX = decimalsByMint(tokenXMint);
    if (!Number.isFinite(decY)) decY = decimalsByMint(tokenYMint);

    // posição
    const pos = await dlmmPool.getPosition(positionPk);
    const pd = pos?.positionData || pos;

    const rawX =
      pick(pd, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]) ??
      pick(pos, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]);

    const rawY =
      pick(pd, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]) ??
      pick(pos, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]);

    const biX = toBigIntLoose(rawX);
    const biY = toBigIntLoose(rawY);

    const q_sol = (biX !== null && decX !== null) ? amountToNumber(biX, decX) : null;
    const u_usdc = (biY !== null && decY !== null) ? amountToNumber(biY, decY) : null;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    return res.json({
      ok: true,
      positionId,
      pool,
      owner,
      tokenXMint,
      tokenYMint,
      spot,
      q_sol,
      u_usdc,
      lp_total_usd,
      meta
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// HL: wallet + coin
app.get("/hl/:wallet/:coin?", async (req, res) => {
  const wallet = String(req.params.wallet || "").trim();
  const coin = String(req.params.coin || "SOL").trim().toUpperCase();

  try {
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    const [hl_price, funding_rate, userState] = await Promise.all([
      hlGetMid(coin),
      hlFundingRate(coin),
      hlUserState(wallet)
    ]);

    const p = findCoinPos(userState, coin);

    // szi: no HL short é negativo (normalmente), mas tu quer “short +” na planilha.
    const position_sz = p?.szi != null ? Number(p.szi) : null;
    const entry_px = p?.entryPx != null ? Number(p.entryPx) : null;

    // unrealizedPnl pode vir em string
    const pnl_usd = p?.unrealizedPnl != null ? Number(p.unrealizedPnl) : null;

    return res.json({
      ok: true,
      hl_price,
      funding_rate,
      position_sz: Number.isFinite(position_sz) ? position_sz : null,
      entry_px: Number.isFinite(entry_px) ? entry_px : null,
      pnl_usd: Number.isFinite(pnl_usd) ? pnl_usd : null,
      funding_acc_usd: null,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: "allMids+userState" }
    });
  } catch (e) {
    console.error("[hl] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
