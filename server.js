/* meteora-lp-reader — unified build (LP + Hyperliquid)
 * Endpoints:
 *  - GET /
 *  - GET /health
 *  - GET /lp/:positionId
 *  - GET /hl/:wallet?coin=SOL
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

const connection = HELIUS_RPC ? new Connection(HELIUS_RPC, "processed") : null;

// -------------------- CONSTANTS --------------------
const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function decimalsByMint(mint) {
  if (mint === MINT_WSOL) return 9;
  if (mint === MINT_USDC) return 6;
  return null;
}

// -------------------- fetch with timeout --------------------
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
const DLMM = (() => {
  try { return loadDLMM(); }
  catch (e) { console.error("DLMM load error:", e?.message || e); return null; }
})();

// -------------------- helpers --------------------
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

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// -------------------- Meteora helpers --------------------
async function meteoraPositionMeta(positionId) {
  // retorna: owner, pair_address e também totais claimed, fee_apy_24h, daily_fee_yield, etc.
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  return fetchJson(url, {}, 20000);
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const data = await fetchJson(url, {}, 20000);
  const px = Number(data?.current_price ?? data?.price ?? data?.spot_price);
  return Number.isFinite(px) ? px : null;
}

// -------------------- Hyperliquid helpers --------------------
async function hlAllMids() {
  // Hyperliquid: info endpoint (public)
  const url = "https://api.hyperliquid.xyz/info";
  // type: "allMids" → retorna um map { "SOL": "85.30", ... }
  return fetchJson(url, {
    method: "post",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" })
  }, 20000);
}

async function hlUserState(wallet) {
  const url = "https://api.hyperliquid.xyz/info";
  return fetchJson(url, {
    method: "post",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "userState", user: wallet })
  }, 20000);
}

// tenta extrair posição perp (size e entryPx) do userState de forma tolerante
function extractPerpPosition(userState, coin) {
  const c = String(coin || "").toUpperCase();

  // vários formatos existem; a maioria vem em userState.assetPositions[]
  const arr = userState?.assetPositions || userState?.positions || [];
  for (const item of arr) {
    const pos = item?.position || item;
    const sym = String(pos?.coin || pos?.symbol || "").toUpperCase();
    if (sym !== c) continue;

    const szi = numOrNull(pos?.szi ?? pos?.size ?? pos?.positionSize ?? pos?.sz);
    const entryPx = numOrNull(pos?.entryPx ?? pos?.entryPrice ?? pos?.avgPx ?? pos?.averagePx);
    const pnlUsd = numOrNull(pos?.pnl ?? pos?.pnlUsd ?? pos?.unrealizedPnl ?? pos?.upnl);

    // funding acumulado: HL não entrega “funding_acc_usd” direto no userState público.
    // então devolvo null; o Sheets mantém teu campo estimado.
    return {
      position_sz: szi,
      entry_px: entryPx,
      pnl_usd: pnlUsd
    };
  }

  return { position_sz: 0, entry_px: null, pnl_usd: null };
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-lp-reader",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet?coin=SOL"]
  });
});

app.get("/health", async (req, res) => {
  try {
    const v = connection ? await connection.getVersion() : null;
    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: HELIUS_RPC ? "helius" : "missing",
      solanaVersion: v
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

    // 1) meta -> pool + owner + métricas (claimed/apy/yield)
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

    // 3) pool instance
    const dlmmPool = await DLMM.create(connection, poolPk);

    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;

    let decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    let decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);
    if (!Number.isFinite(decX)) decX = decimalsByMint(tokenXMint);
    if (!Number.isFinite(decY)) decY = decimalsByMint(tokenYMint);

    // 4) getPosition
    const pos = await dlmmPool.getPosition(positionPk);
    const pd = pos?.positionData || pos;

    const rawX =
      pick(pd, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]) ??
      pick(pos, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]);

    const rawY =
      pick(pd, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]) ??
      pick(pos, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]);

    // fees não-claimed (se SDK expuser)
    const rawFeeX = pick(pd, ["feeX", "feeXAmount", "feesX", "feeAmountX"]);
    const rawFeeY = pick(pd, ["feeY", "feeYAmount", "feesY", "feeAmountY"]);

    const biX = toBigIntLoose(rawX);
    const biY = toBigIntLoose(rawY);
    const biFeeX = toBigIntLoose(rawFeeX);
    const biFeeY = toBigIntLoose(rawFeeY);

    const q_sol = (biX !== null && decX !== null) ? amountToNumber(biX, decX) : null;
    const u_usdc = (biY !== null && decY !== null) ? amountToNumber(biY, decY) : null;

    const fee_x = (biFeeX !== null && decX !== null) ? amountToNumber(biFeeX, decX) : null;
    const fee_y = (biFeeY !== null && decY !== null) ? amountToNumber(biFeeY, decY) : null;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    // estima fee_usd atual (não-claimed) se conseguir fee_x/fee_y
    let fee_usd_est = null;
    if (Number.isFinite(spot)) {
      const fx = Number.isFinite(fee_x) ? (fee_x * spot) : 0;
      const fy = Number.isFinite(fee_y) ? fee_y : 0;
      const s = fx + fy;
      if (Number.isFinite(s) && s > 0) fee_usd_est = s;
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

      // fees “não-claimed” (se existirem no SDK)
      fee_x,
      fee_y,
      fee_usd_est,

      // meta da API Meteora (claimed + yield/apy)
      meta
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/hl/:wallet", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    const coin = String(req.query.coin || "SOL").toUpperCase();

    // price
    const mids = await hlAllMids();
    const hl_price = numOrNull(mids?.[coin] ?? mids?.mids?.[coin]);

    // userState (posições)
    const st = await hlUserState(wallet);
    const pos = extractPerpPosition(st, coin);

    // funding_rate: público “limpo” varia; deixo null (tua planilha pode manter estimado/último)
    // se tu quiser funding real, precisa puxar endpoints adicionais e fazer parsing (faço depois).
    return res.json({
      ok: true,
      hl_price,
      funding_rate: null,
      position_sz: pos.position_sz ?? 0,
      entry_px: pos.entry_px ?? null,
      pnl_usd: pos.pnl_usd ?? null,
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
