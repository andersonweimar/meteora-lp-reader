/* meteora-lp-reader — DLMM on-chain position amounts (stable build)
 * Endpoints:
 *  - GET /
 *  - GET /health
 *  - GET /lp/:positionId
 */

const express = require("express");
const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
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

// -------------------- SAFE JSON --------------------
function safeStringify(obj, limit = 4000) {
  const s = JSON.stringify(
    obj,
    (k, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );
  return s.length > limit ? s.slice(0, limit) + "\n...<truncated>" : s;
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
    throw new Error(`DLMM SDK not loaded (DLMM.create missing). exports keys=${keys.join(",")}`);
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
  // aceita bigint, number, string, BN-like (toString), object
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return BigInt(s);
    return null;
  }
  // BN / anchor BN / object com toString()
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
  // pra teus tamanhos (26 SOL etc.), Number é ok
  const n = Number(bi);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, decimals);
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "meteora-dlmm-backend", endpoints: ["/health", "/lp/:positionId"] });
});

app.get("/health", async (req, res) => {
  try {
    if (!HELIUS_RPC || !connection) {
      return res.json({ ok: true, heliusKeyPresent: !!HELIUS_KEY, rpcEndpoint: "missing" });
    }
    const v = await connection.getVersion();
    res.json({ ok: true, heliusKeyPresent: !!HELIUS_KEY, rpcEndpoint: "helius", solanaVersion: v });
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

    // Alguns SDKs retornam { publicKey, positionData, version }
    const pd = pos?.positionData || pos;

    // tenta vários nomes possíveis, inclusive dentro de positionData
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
      rawXType: typeof rawX,
      rawYType: typeof rawY,
      rawXPreview: rawX != null ? String(rawX).slice(0, 120) : null,
      rawYPreview: rawY != null ? String(rawY).slice(0, 120) : null,
      biXPreview: biX != null ? biX.toString().slice(0, 120) : null,
      biYPreview: biY != null ? biY.toString().slice(0, 120) : null
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
      debug,
      meta
    });
  } catch (e) {
    console.error("[lp] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- Listen --------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));

