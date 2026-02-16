/* meteora-lp-reader — Meteora + Hyperliquid (stable)
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

// -------------------- Hyperliquid helpers --------------------
const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlPost(body) {
  return fetchJson(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 20000);
}

async function hlGetMid(coin) {
  const mids = await hlPost({ type: "allMids" });
  const px = Number(mids?.[coin]);
  return Number.isFinite(px) ? px : null;
}

async function hlUserState(wallet) {
  return hlPost({ type: "userState", user: wallet });
}

function findCoinPosition(userState, coin) {
  const arr = userState?.assetPositions || [];
  for (const it of arr) {
    const p = it?.position;
    if (!p) continue;
    if (String(p.coin || "").toUpperCase() === String(coin).toUpperCase()) return p;
  }
  return null;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora+hyperliquid-backend",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet?coin=SOL"]
  });
});

app.get("/health", async (req, res) => {
  try {
    const out = { ok: true, heliusKeyPresent: !!HELIUS_KEY, rpcEndpoint: HELIUS_RPC ? "helius" : "missing" };
    if (connection) out.solanaVersion = await connection.getVersion();
    // HL quick ping
    const mid = await hlGetMid("SOL");
    out.hl_ok = mid !== null;
    res.json(out);
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

    const meta = await meteoraPositionMeta(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool || meta?.lb_pair || null;
    const owner = meta?.owner || null;
    if (!pool) return res.status(404).json({ ok: false, error: "pool not found for this positionId", meta });

    const poolPk = new PublicKey(pool);
    const positionPk = new PublicKey(positionId);

    const spot = await meteoraPoolSpot(pool);

    const dlmmPool = await DLMM.create(connection, poolPk);
    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;

    let decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    let decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);
    if (!Number.isFinite(decX)) decX = decimalsByMint(tokenXMint);
    if (!Number.isFinite(decY)) decY = decimalsByMint(tokenYMint);

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

    // fees (se o SDK expuser feeX/feeY em positionData)
    const feeX_raw = pick(pd, ["feeX", "fee_x", "feesX", "fee_x_amount"]);
    const feeY_raw = pick(pd, ["feeY", "fee_y", "feesY", "fee_y_amount"]);
    const feeX_bi = toBigIntLoose(feeX_raw);
    const feeY_bi = toBigIntLoose(feeY_raw);
    const fee_x = (feeX_bi !== null && decX !== null) ? amountToNumber(feeX_bi, decX) : null;
    const fee_y = (feeY_bi !== null && decY !== null) ? amountToNumber(feeY_bi, decY) : null;

    let fee_usd_est = null;
    if (Number.isFinite(spot) && Number.isFinite(fee_x) && Number.isFinite(fee_y)) {
      // assumindo tokenX=SOL e tokenY=USDC (teu caso)
      fee_usd_est = fee_x * spot + fee_y;
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

      // novas métricas
      fee_x,
      fee_y,
      fee_usd_est,

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
    const coin = String(req.query.coin || "SOL").toUpperCase().trim();
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    const hl_price = await hlGetMid(coin);
    const us = await hlUserState(wallet);
    const p = findCoinPosition(us, coin);

    // position_sz: manter sinal do HL (positivo=LONG, negativo=SHORT)
    const position_sz = p?.szi != null ? Number(p.szi) : null;
    const entry_px = p?.entryPx != null ? Number(p.entryPx) : null;
    const pnl_usd = p?.unrealizedPnl != null ? Number(p.unrealizedPnl) : null;

    return res.json({
      ok: true,
      hl_price,
      funding_rate: null,
      position_sz,
      entry_px,
      pnl_usd,
      funding_acc_usd: null,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: "allMids+userState" }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`server listening on :${port}`));
