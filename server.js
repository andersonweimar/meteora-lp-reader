/* meteora-lp-reader — Meteora DLMM + Hyperliquid (stable build)
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

// "processed" = mais rápido no Render
const connection = HELIUS_RPC ? new Connection(HELIUS_RPC, "processed") : null;

// -------------------- CONSTANTS --------------------
const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Hyperliquid info endpoint
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

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
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (_) {}
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

// -------------------- Hyperliquid helpers --------------------
async function hlPost(payload, timeoutMs = 12000) {
  return fetchJson(
    HL_INFO_URL,
    {
      method: "post",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs
  );
}

async function hlAllMids() {
  // retorna objeto { "SOL": "85.30", ... }
  return hlPost({ type: "allMids" });
}

async function hlUserState(wallet) {
  // tenta o shape mais comum; se a HL mudar, a gente ajusta
  // docs antigas usavam {type:"userState", user:"0x..."}
  return hlPost({ type: "userState", user: wallet });
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora+hyperliquid-backend",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet?coin=SOL"],
  });
});

app.get("/health", async (req, res) => {
  try {
    let sol = null;
    if (HELIUS_RPC && connection) {
      const v = await connection.getVersion();
      sol = v;
    }
    // HL ping
    let hl = null;
    try {
      const mids = await hlAllMids();
      hl = { ok: true, hasSOL: mids?.SOL != null };
    } catch (e) {
      hl = { ok: false, error: String(e?.message || e) };
    }

    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: HELIUS_RPC ? "helius" : "missing",
      solanaVersion: sol,
      hyperliquid: hl,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/hl/:wallet", async (req, res) => {
  const wallet = String(req.params.wallet || "").trim();
  const coin = String(req.query.coin || "SOL").trim().toUpperCase();

  try {
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    // 1) price
    const mids = await hlAllMids();
    const hl_price = numOrNull(mids?.[coin]);

    // 2) state (positions/funding)
    let funding_rate = null;
    let position_sz = null; // SOL (short +)
    let entry_px = null;
    let pnl_usd = null;

    // extras (se disponível)
    let funding_acc_usd = null;
    let funding_8h_usd = null;

    try {
      const st = await hlUserState(wallet);

      // A HL costuma retornar um array de posições em assetPositions.
      // A gente caça o coin. Se não achar, devolve nulls sem quebrar.
      const assetPositions = st?.assetPositions || st?.state?.assetPositions || [];

      const p = Array.isArray(assetPositions)
        ? assetPositions.find((x) => {
            const sym =
              x?.position?.coin ||
              x?.position?.symbol ||
              x?.coin ||
              x?.symbol ||
              "";
            return String(sym).toUpperCase() === coin;
          })
        : null;

      const posObj = p?.position || p || null;

      // size: em HL geralmente é string
      // regra: "short +" no teu sheet => se size < 0 (short), converte pra positivo
      const sz = numOrNull(posObj?.szi ?? posObj?.sz ?? posObj?.size);
      if (sz !== null) position_sz = sz < 0 ? Math.abs(sz) : sz;

      entry_px = numOrNull(posObj?.entryPx ?? posObj?.entry_px ?? posObj?.entryPrice);
      pnl_usd = numOrNull(posObj?.unrealizedPnl ?? posObj?.pnl ?? posObj?.pnlUsd);

      // funding: dependendo do tipo, pode vir em outro campo/endpoint
      funding_rate = numOrNull(posObj?.funding ?? posObj?.fundingRate ?? null);

      // se vier acumulado
      funding_acc_usd = numOrNull(posObj?.fundingAccrued ?? posObj?.fundingAccUsd ?? null);
      funding_8h_usd = numOrNull(posObj?.funding8h ?? posObj?.funding8hUsd ?? null);
    } catch (e) {
      // não derruba o endpoint; só loga e segue com preço
      console.error("[hl] userState error:", e?.message || e);
    }

    res.json({
      ok: true,
      hl_price,
      funding_rate,
      position_sz,
      entry_px,
      pnl_usd,
      funding_acc_usd,
      funding_8h_usd,
      meta: { hl_coin: coin },
      debug: { source: "allMids+userState" },
    });
  } catch (e) {
    console.error("[hl] error:", e);
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

    // 1) meta -> pool + owner + claimed totals
    const meta = await meteoraPositionMeta(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool || meta?.lb_pair || null;
    const owner = meta?.owner || null;

    if (!pool) {
      return res.status(404).json({ ok: false, error: "pool not found for this positionId", meta });
    }

    const poolPk = new PublicKey(pool);
    const positionPk = new PublicKey(positionId);

    // 2) spot
    const spot = await meteoraPoolSpot(pool);

    // 3) cria pool instance
    const dlmmPool = await DLMM.create(connection, poolPk);

    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;

    let decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    let decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);

    if (!Number.isFinite(decX)) decX = decimalsByMint(tokenXMint);
    if (!Number.isFinite(decY)) decY = decimalsByMint(tokenYMint);

    // 4) posição
    const pos = await dlmmPool.getPosition(positionPk);
    const pd = pos?.positionData || pos;

    // amounts
    const rawX =
      pick(pd, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]) ??
      pick(pos, ["totalXAmount", "totalX", "amountX", "tokenXAmount"]);

    const rawY =
      pick(pd, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]) ??
      pick(pos, ["totalYAmount", "totalY", "amountY", "tokenYAmount"]);

    const biX = toBigIntLoose(rawX);
    const biY = toBigIntLoose(rawY);

    const amtX = (biX !== null && decX !== null) ? amountToNumber(biX, decX) : null;
    const amtY = (biY !== null && decY !== null) ? amountToNumber(biY, decY) : null;

    // Heurística: tu quer SOL/USDC, então X ou Y vai ser SOL.
    // A gente devolve q_sol e u_usdc coerentes por mint.
    let q_sol = null;
    let u_usdc = null;

    if (tokenXMint === MINT_WSOL) q_sol = amtX;
    if (tokenYMint === MINT_WSOL) q_sol = amtY;

    if (tokenXMint === MINT_USDC) u_usdc = amtX;
    if (tokenYMint === MINT_USDC) u_usdc = amtY;

    // fallback se não bateu mint (deixa como X/Y)
    if (q_sol === null) q_sol = amtX;
    if (u_usdc === null) u_usdc = amtY;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    // ---- fees (unclaimed/accum) se o SDK expuser ----
    const rawFeeX =
      pick(pd, ["feeX", "feeXAmount", "accFeeX", "accumulatedFeeX"]) ??
      pick(pos, ["feeX", "feeXAmount", "accFeeX", "accumulatedFeeX"]);

    const rawFeeY =
      pick(pd, ["feeY", "feeYAmount", "accFeeY", "accumulatedFeeY"]) ??
      pick(pos, ["feeY", "feeYAmount", "accFeeY", "accumulatedFeeY"]);

    const biFeeX = toBigIntLoose(rawFeeX);
    const biFeeY = toBigIntLoose(rawFeeY);

    const feeX = (biFeeX !== null && decX !== null) ? amountToNumber(biFeeX, decX) : null;
    const feeY = (biFeeY !== null && decY !== null) ? amountToNumber(biFeeY, decY) : null;

    // fee_usd_est: converte tokenX/tokenY em USD (assumindo SOL+USDC)
    let fee_usd_est = null;
    if (Number.isFinite(spot)) {
      const feeUsdFromX =
        tokenXMint === MINT_WSOL ? (Number(feeX || 0) * spot) :
        tokenXMint === MINT_USDC ? Number(feeX || 0) : 0;

      const feeUsdFromY =
        tokenYMint === MINT_WSOL ? (Number(feeY || 0) * spot) :
        tokenYMint === MINT_USDC ? Number(feeY || 0) : 0;

      const s = feeUsdFromX + feeUsdFromY;
      if (Number.isFinite(s)) fee_usd_est = s;
    }

    const debug = {
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: "helius",
      pool,
      owner,
      spot,
      tokenXMint,
      tokenYMint,
      decX,
      decY,
      hasPos: !!pos,
      posKeys: pos ? Object.keys(pos) : [],
      posDataKeys: pd ? Object.keys(pd) : [],
    };

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
      feeX,
      feeY,
      fee_usd_est,
      meta,   // aqui ainda tem total_fee_*_claimed etc (quando a API fornece)
      debug
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
