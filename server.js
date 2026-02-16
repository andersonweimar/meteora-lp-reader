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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt?.slice(0, 800)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, bodyObj, timeoutMs = 25000) {
  return fetchJson(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyObj),
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
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

/**
 * HL: all mids => { "SOL": "86.12", ... }
 */
async function hlAllMids() {
  return postJson(HL_INFO_URL, { type: "allMids" }, 20000);
}

/**
 * HL: clearinghouseState => positions, margin, etc.
 */
async function hlClearinghouseState(wallet) {
  // IMPORTANT: type é "clearinghouseState" (camelCase)
  return postJson(HL_INFO_URL, { type: "clearinghouseState", user: wallet }, 20000);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function findCoinPosition(userState, coinUpper) {
  const aps = userState?.assetPositions || [];
  for (const ap of aps) {
    const p = ap?.position;
    if (!p) continue;
    const c = String(p.coin || "").toUpperCase();
    if (c === coinUpper) return p;
  }
  return null;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/health", "/lp/:positionId", "/hl/:wallet?coin=SOL"],
  });
});

app.get("/health", async (req, res) => {
  try {
    if (!HELIUS_RPC || !connection) {
      return res.json({
        ok: true,
        heliusKeyPresent: !!HELIUS_KEY,
        rpcEndpoint: "missing",
      });
    }
    const v = await connection.getVersion();
    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: "helius",
      solanaVersion: v,
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

    // 1) meta -> pool + owner + fees claimed (se vier)
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

    // ---- meta fields úteis p/ planilha (se existirem no retorno do meteora)
    const metaOut = {
      // estes nomes batem com o que tu criou na API_DATA A34+
      total_fee_x_claimed: meta?.total_fee_x_claimed ?? null,
      total_fee_y_claimed: meta?.total_fee_y_claimed ?? null,
      total_fee_usd_claimed: meta?.total_fee_usd_claimed ?? null,
      total_reward_usd_claimed: meta?.total_reward_usd_claimed ?? null,
      fee_apy_24h: meta?.fee_apy_24h ?? null,
      fee_apr_24h: meta?.fee_apr_24h ?? null,
      daily_fee_yield: meta?.daily_fee_yield ?? null,
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
      meta: metaOut,
      raw_meta: meta
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/hl/:wallet", async (req, res) => {
  const wallet = (req.params.wallet || "").trim();
  const coin = String(req.query.coin || "SOL").toUpperCase();

  try {
    if (!wallet) return res.status(400).json({ ok: false, error: "missing wallet" });

    // 1) preço
    const mids = await hlAllMids();
    const hl_price = toNum(mids?.[coin]);

    // 2) estado do usuário
    const userState = await hlClearinghouseState(wallet);

    // pega posição do coin (se existir)
    const p = findCoinPosition(userState, coin);

    // campos normalizados
    const funding_rate = toNum(p?.cumFunding?.sinceOpen); // cuidado: pode não ser "rate"; é cum funding
    const position_sz = toNum(p?.szi);                   // size (signed)
    const entry_px = toNum(p?.entryPx);
    const pnl_usd = toNum(p?.unrealizedPnl);

    // funding acumulado em USD (se quiser mais “certo”, dá pra trocar depois por histórico userFunding)
    // aqui uso cumFunding.sinceOpen (string) como proxy; tu pode evoluir isso depois.
    const funding_acc_usd = null;
    const funding_8h_usd = null;

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
      debug: { source: "allMids+clearinghouseState" }
    });
  } catch (e) {
    console.error("[hl] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`server listening on :${port}`));
