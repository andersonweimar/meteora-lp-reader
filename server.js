/* meteora-lp-reader — DLMM on-chain position amounts (debug build)
 * Endpoints:
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

// IMPORTANT: "processed" is faster and reduces Render timeouts
const connection = HELIUS_RPC ? new Connection(HELIUS_RPC, "processed") : null;

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
    } catch (_) {
      // non-json body
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${txt?.slice(0, 600)}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- DLMM loader (fix "create undefined") --------------------
function loadDLMM() {
  // CJS export variants
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
  // meta/indexer: position -> pair_address + owner
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  return fetchJson(url, {}, 20000);
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const data = await fetchJson(url, {}, 20000);

  // Meteora costuma expor current_price (tu já viu isso)
  const px = Number(data?.current_price ?? data?.price ?? data?.spot_price);
  return Number.isFinite(px) ? px : null;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/health", "/lp/:positionId"]
  });
});

app.get("/health", async (req, res) => {
  try {
    if (!HELIUS_RPC || !connection) {
      return res.json({
        ok: true,
        heliusKeyPresent: !!HELIUS_KEY,
        rpcEndpoint: "missing"
      });
    }
    const v = await connection.getVersion();
    res.json({
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: "helius",
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
    if (!HELIUS_RPC || !connection) {
      return res.status(400).json({ ok: false, error: "Missing HELIUS_API_KEY env" });
    }
    if (!DLMM) {
      return res.status(500).json({ ok: false, error: "DLMM SDK failed to load (check logs)" });
    }

    // 1) meta -> pool + owner
    const meta = await meteoraPositionMeta(positionId);
    const pool =
      meta?.pair_address || meta?.pairAddress || meta?.pool || meta?.lb_pair || null;
    const owner = meta?.owner || null;

    if (!pool) {
      return res.status(404).json({ ok: false, error: "pool not found for this positionId", meta });
    }

    // 2) DLMM create pool instance (on-chain)
    const poolPk = new PublicKey(pool);
    const positionPk = new PublicKey(positionId);

    // get spot from datapi (fast)
    const spot = await meteoraPoolSpot(pool);

    console.log("[lp] positionId=", positionId);
    console.log("[lp] pool=", pool, "owner=", owner, "spot=", spot);

    // create pool instance
    const dlmmPool = await DLMM.create(connection, poolPk);

    // token metadata
    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || null;
    const decX = Number(tokenX?.decimal ?? tokenX?.decimals ?? NaN);
    const decY = Number(tokenY?.decimal ?? tokenY?.decimals ?? NaN);

    // 3) pull position on-chain
    const pos = await dlmmPool.getPosition(positionPk);

    // DEBUG (important)
    const posKeys = pos ? Object.keys(pos) : [];
    console.log("[lp] posKeys:", posKeys);
    console.log("[lp] pos sample:", safeStringify(pos));

    // 4) Try multiple possible amount field names (SDK versions differ)
    const rawX =
      pos?.totalXAmount ??
      pos?.totalX ??
      pos?.amountX ??
      pos?.tokenXAmount ??
      null;

    const rawY =
      pos?.totalYAmount ??
      pos?.totalY ??
      pos?.amountY ??
      pos?.tokenYAmount ??
      null;

    // Convert raw -> human if possible
    let q_sol = null;
    let u_usdc = null;

    if (rawX != null && Number.isFinite(decX)) {
      const n = Number(rawX);
      if (Number.isFinite(n)) q_sol = n / Math.pow(10, decX);
    }

    if (rawY != null && Number.isFinite(decY)) {
      const n = Number(rawY);
      if (Number.isFinite(n)) u_usdc = n / Math.pow(10, decY);
    }

    // total USD
    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    // include debug to see what is missing
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
      posKeys,
      rawXType: typeof rawX,
      rawYType: typeof rawY,
      rawXPreview: rawX != null ? String(rawX).slice(0, 64) : null,
      rawYPreview: rawY != null ? String(rawY).slice(0, 64) : null
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
