/* meteora-lp-reader — DLMM on-chain position amounts + Hyperliquid (stable build)
 * Endpoints:
 *  - GET /
 *  - GET /health
 *  - GET /lp/:positionId
 *  - GET /hl/:wallet
 *  - GET /hl/:wallet/:coin
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
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt?.slice(0, 600)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- DLMM loader (fix create undefined) --------------------
function loadDLMM() {
  const pkg = require("@meteora-ag/dlmm");
  const DLMM = pkg?.DLMM || pkg?.default || pkg;
  if (!DLMM || typeof DLMM.create !== "function") {
    const keys = pkg ? Object.keys(pkg) : [];
    throw new Error(
      `DLMM SDK not loaded (DLMM.create missing). exports keys=${keys.join(",")}`
    );
  }
  return DLMM;
}

const DLMM = (() => {
  try {
    return loadDLMM();
  } catch (e) {
    console.error("DLMM load error:", e?.message || e);
    return null;
  }
})();

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

// ============================
// Hyperliquid helpers + routes
// ============================
async function hlInfo(body) {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HL HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function hlGetMidOrMark(coin) {
  // 1) allMids
  try {
    const mids = await hlInfo({ type: "allMids" });
    const v = mids?.[coin];
    const n = Number(v);
    if (Number.isFinite(n)) return { px: n, source: "allMids" };
  } catch (_) {}

  // 2) metaAndAssetCtxs fallback
  const metaCtx = await hlInfo({ type: "metaAndAssetCtxs" });
  const meta = metaCtx?.[0];
  const ctxs = metaCtx?.[1];
  const uni = meta?.universe || [];

  const idx = uni.findIndex((u) => String(u?.name || "").toUpperCase() === String(coin).toUpperCase());
  if (idx < 0 || !Array.isArray(ctxs) || !ctxs[idx]) return { px: null, source: "metaAndAssetCtxs" };

  const ctx = ctxs[idx];
  const mid = Number(ctx?.midPx);
  if (Number.isFinite(mid)) return { px: mid, source: "metaAndAssetCtxs.midPx" };

  const mark = Number(ctx?.markPx);
  if (Number.isFinite(mark)) return { px: mark, source: "metaAndAssetCtxs.markPx" };

  return { px: null, source: "metaAndAssetCtxs.none" };
}

async function hlGetPosition(wallet, coin) {
  const st = await hlInfo({ type: "clearinghouseState", user: wallet });
  const aps = st?.assetPositions || [];

  const p = aps
    .map((x) => x?.position || x)
    .find((pos) => String(pos?.coin || "").toUpperCase() === String(coin).toUpperCase());

  if (!p) return { posQty: 0, entryPx: null, pnlUsd: null, fundingAccUsd: null };

  const szi = Number(p?.szi ?? p?.size ?? p?.positionSize);
  const entry = Number(p?.entryPx ?? p?.avgPx ?? p?.averageEntryPrice);
  const pnl = Number(p?.unrealizedPnl ?? p?.pnl);
  const fund = Number(p?.cumFunding?.allTime ?? p?.cumFunding ?? p?.funding);

  return {
    posQty: Number.isFinite(szi) ? Math.abs(szi) : 0, // tamanho absoluto
    entryPx: Number.isFinite(entry) ? entry : null,
    pnlUsd: Number.isFinite(pnl) ? pnl : null,
    fundingAccUsd: Number.isFinite(fund) ? fund : null,
  };
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet", "/hl/:wallet/:coin"],
  });
});

app.get("/health", async (req, res) => {
  try {
    let solanaVersion = null;
    if (connection) {
      try {
        solanaVersion = await connection.getVersion();
      } catch (_) {}
    }

    let hl_ok = false;
    try {
      const px = await hlGetMidOrMark("SOL");
      hl_ok = Number.isFinite(px?.px);
    } catch (_) {}

    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: connection ? "helius" : "missing",
      solanaVersion,
      dlmmLoaded: !!DLMM,
      hl_ok,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();

  try {
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });
    if (!HELIUS_RPC || !connection)
      return res.status(400).json({ ok: false, error: "Missing HELIUS_API_KEY env" });
    if (!DLMM) return res.status(500).json({ ok: false, error: "DLMM SDK failed to load (check logs)" });

    // 1) meta -> pool + owner
    const meta = await meteoraPositionMeta(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool || meta?.lb_pair || null;
    const owner = meta?.owner || null;

    if (!pool) {
      return res.status(404).json({ ok: false, error: "pool not found for this positionId", meta });
    }

    const poolPk = new PublicKey(pool);
    const positionPk = new PublicKey(positionId);

    // 2) spot rápido
    const spot = await meteoraPoolSpot(pool);

    // 3) cria pool instance
    const dlmmPool = await DLMM.create(connection, poolPk);

    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;

    // tenta decimals do SDK, senão fallback por mint
    let decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    let decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);

    if (!Number.isFinite(decX)) decX = decimalsByMint(tokenXMint);
    if (!Number.isFinite(decY)) decY = decimalsByMint(tokenYMint);

    // 4) pega posição
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

    const q_sol = biX !== null && decX !== null ? amountToNumber(biX, decX) : null;
    const u_usdc = biY !== null && decY !== null ? amountToNumber(biY, decY) : null;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = q_sol * spot + u_usdc;
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
      meta,
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// HL default SOL
app.get("/hl/:wallet", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    if (!wallet) return res.status(400).json({ ok: false, error: "wallet vazio" });

    const coin = "SOL";
    const px = await hlGetMidOrMark(coin);
    const pos = await hlGetPosition(wallet, coin);

    return res.json({
      ok: true,
      hl_price: px.px,
      funding_rate: null,
      position_sz: pos.posQty,
      entry_px: pos.entryPx,
      pnl_usd: pos.pnlUsd,
      funding_acc_usd: pos.fundingAccUsd,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: px.source },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// HL coin explícito
app.get("/hl/:wallet/:coin", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    const coin = String(req.params.coin || "SOL").trim().toUpperCase();
    if (!wallet) return res.status(400).json({ ok: false, error: "wallet vazio" });

    const px = await hlGetMidOrMark(coin);
    const pos = await hlGetPosition(wallet, coin);

    return res.json({
      ok: true,
      hl_price: px.px,
      funding_rate: null,
      position_sz: pos.posQty,
      entry_px: pos.entryPx,
      pnl_usd: pos.pnlUsd,
      funding_acc_usd: pos.fundingAccUsd,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: px.source },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
