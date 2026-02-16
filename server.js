/* meteora-lp-reader — DLMM + Hyperliquid (stable build)
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

// "processed" = mais rápido e reduz timeout no Render
const connection = HELIUS_RPC ? new Connection(HELIUS_RPC, "processed") : null;

// Hyperliquid API (public)
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

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
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt?.slice(0, 800)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, body, timeoutMs = 25000) {
  return fetchJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    timeoutMs
  );
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
async function hlAllMids() {
  // { "SOL": "85.30", ... }
  const mids = await postJson(HL_INFO_URL, { type: "allMids" }, 20000);
  return mids || null;
}

async function hlMetaAndAssetCtxs() {
  // returns [meta, assetCtxs]
  const out = await postJson(HL_INFO_URL, { type: "metaAndAssetCtxs" }, 20000);
  return out || null;
}

async function hlClearinghouseState(user) {
  const out = await postJson(HL_INFO_URL, { type: "clearinghouseState", user }, 20000);
  return out || null;
}

function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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
    const out = { ok: true, heliusKeyPresent: !!HELIUS_KEY, rpcEndpoint: HELIUS_RPC ? "helius" : "missing" };
    if (connection) out.solanaVersion = await connection.getVersion();
    // quick HL ping
    try {
      const mids = await hlAllMids();
      out.hyperliquid = { ok: !!mids };
    } catch (e) {
      out.hyperliquid = { ok: false, error: String(e?.message || e) };
    }
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

    // 1) meta -> pool + owner + fee fields (quando existirem)
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

    const q_sol = (biX !== null && decX !== null) ? amountToNumber(biX, decX) : null;
    const u_usdc = (biY !== null && decY !== null) ? amountToNumber(biY, decY) : null;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    // ---- fee/reward fields (quando existirem no meta) ----
    const total_fee_x_claimed = numOrNull(meta?.total_fee_x_claimed);
    const total_fee_y_claimed = numOrNull(meta?.total_fee_y_claimed);
    const total_fee_usd_claimed = numOrNull(meta?.total_fee_usd_claimed);

    const total_reward_x_claimed = numOrNull(meta?.total_reward_x_claimed);
    const total_reward_y_claimed = numOrNull(meta?.total_reward_y_claimed);
    const total_reward_usd_claimed = numOrNull(meta?.total_reward_usd_claimed);

    const fee_apr_24h = numOrNull(meta?.fee_apr_24h);
    const fee_apy_24h = numOrNull(meta?.fee_apy_24h);
    const daily_fee_yield = numOrNull(meta?.daily_fee_yield);

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

      // extras p/ preencher API_DATA quando existirem
      total_fee_x_claimed,
      total_fee_y_claimed,
      total_fee_usd_claimed,
      total_reward_x_claimed,
      total_reward_y_claimed,
      total_reward_usd_claimed,
      fee_apr_24h,
      fee_apy_24h,
      daily_fee_yield,

      meta
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/hl/:wallet", async (req, res) => {
  const wallet = (req.params.wallet || "").trim();
  const coin = String(req.query.coin || "SOL").trim().toUpperCase();

  try {
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    const mids = await hlAllMids();
    const hl_price = mids && mids[coin] ? numOrNull(mids[coin]) : null;

    // funding rate: pega de metaAndAssetCtxs
    let funding_rate = null;
    try {
      const mac = await hlMetaAndAssetCtxs();
      const assetCtxs = Array.isArray(mac) ? mac[1] : null;
      if (Array.isArray(assetCtxs)) {
        // procura pelo coin
        const ctx = assetCtxs.find(x => String(x?.coin || "").toUpperCase() === coin);
        // HL costuma expor funding em campos tipo "funding" / "fundingRate" dependendo do payload
        funding_rate = numOrNull(ctx?.funding ?? ctx?.fundingRate ?? ctx?.funding_rate);
      }
    } catch (_) {}

    // posição do usuário (size, entry, pnl)
    let position_sz = 0;
    let entry_px = null;
    let pnl_usd = null;
    let funding_acc_usd = null;
    let funding_8h_usd = null;

    const st = await hlClearinghouseState(wallet);
    // st.assetPositions: [{ position: { coin, szi, entryPx, unrealizedPnl, cumFunding, ... } }, ...]
    const aps = st?.assetPositions || [];
    const found = Array.isArray(aps)
      ? aps.find(p => String(p?.position?.coin || "").toUpperCase() === coin)
      : null;

    if (found?.position) {
      const p = found.position;
      position_sz = numOrNull(p.szi) ?? 0;          // short normalmente vem negativo
      entry_px = numOrNull(p.entryPx);
      pnl_usd = numOrNull(p.unrealizedPnl ?? p.pnl ?? p.uPnL);
      funding_acc_usd = numOrNull(p.cumFunding ?? p.cumulativeFunding ?? p.funding);
      // 8h funding: HL nem sempre entrega direto. Se não tiver, fica null.
      funding_8h_usd = numOrNull(p.fundingSinceOpen8h ?? p.funding8h ?? null);
    }

    return res.json({
      ok: true,
      hl_price,
      funding_rate,
      position_sz,
      entry_px,
      pnl_usd,
      funding_acc_usd,
      funding_8h_usd,
      meta: { hl_coin: coin },
      debug: { source: "allMids + metaAndAssetCtxs + clearinghouseState" }
    });
  } catch (e) {
    console.error("[hl] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
