const express = require("express");
const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
app.use(express.json());

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "";

// ---- DLMM SDK load (robusto p/ CommonJS) ----
const dlmmPkg = require("@meteora-ag/dlmm");
// o SDK às vezes exporta como { DLMM }, às vezes default
const DLMM = dlmmPkg?.DLMM || dlmmPkg?.default || dlmmPkg;

function assertDlmmLoaded_() {
  if (!DLMM || typeof DLMM.create !== "function") {
    throw new Error(
      "DLMM SDK not loaded (DLMM.create missing). Check @meteora-ag/dlmm export / Node version."
    );
  }
}

// ---- helpers ----
async function fetchJson(url, opts = {}, retries = 2, timeoutMs = 20000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const txt = await res.text();
      clearTimeout(t);

      let json = null;
      try {
        json = txt ? JSON.parse(txt) : null;
      } catch (_) {
        // se vier texto não-json, cai aqui
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${txt}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

async function meteoraPositionMeta(positionId) {
  // meta pública (descobre pool + owner)
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  return fetchJson(url, {}, 2);
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const data = await fetchJson(url, {}, 2);
  // meteora usa current_price
  const px = Number(data?.current_price ?? data?.price ?? NaN);
  return Number.isFinite(px) ? px : null;
}

function bnLikeToNumber_(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof x === "object") {
    if (typeof x.toNumber === "function") return x.toNumber();
    if (typeof x.toString === "function") {
      const n = Number(x.toString());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function scaleByDecimals_(raw, decimals) {
  const n = bnLikeToNumber_(raw);
  if (n === null) return null;
  const d = Number(decimals ?? 0);
  return n / Math.pow(10, d);
}

// ---- routes ----
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/health", "/lp/:positionId"],
  });
});

app.get("/health", async (req, res) => {
  try {
    const out = {
      ok: true,
      heliusKeyPresent: !!HELIUS_KEY,
      rpcEndpoint: HELIUS_RPC ? "helius" : "missing",
    };

    if (HELIUS_RPC) {
      const conn = new Connection(HELIUS_RPC, "confirmed");
      const v = await conn.getVersion();
      out.solanaVersion = v;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();
  if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

  try {
    if (!HELIUS_RPC) {
      return res.status(500).json({ ok: false, error: "Missing HELIUS_API_KEY in Render env vars" });
    }

    assertDlmmLoaded_();

    // 1) Descobre pool/owner via API pública
    const meta = await meteoraPositionMeta(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool || null;
    const owner = meta?.owner || null;

    if (!pool) {
      return res.status(404).json({ ok: false, error: "Could not resolve pool (pair_address) for this positionId" });
    }

    // 2) Spot
    const spot = await meteoraPoolSpot(pool);

    // 3) On-chain calc via SDK (bins)
    const conn = new Connection(HELIUS_RPC, "confirmed");
    const lbPairPubkey = new PublicKey(pool);
    const positionPubkey = new PublicKey(positionId);

    const dlmmPool = await DLMM.create(conn, lbPairPubkey);

    // OBS: alguns builds chamam getPosition, outros getPositionsByUser;
    // aqui queremos pelo ID da position.
    if (typeof dlmmPool.getPosition !== "function") {
      throw new Error("DLMM instance missing getPosition(). SDK version mismatch.");
    }

    const pos = await dlmmPool.getPosition(positionPubkey);

    // tokenX/tokenY do pool
    const tokenX = dlmmPool?.tokenX;
    const tokenY = dlmmPool?.tokenY;

    const tokenXMint = tokenX?.publicKey?.toBase58?.() || tokenX?.mint?.toBase58?.() || null;
    const tokenYMint = tokenY?.publicKey?.toBase58?.() || tokenY?.mint?.toBase58?.() || null;

    const decX = tokenX?.decimal ?? tokenX?.decimals ?? 0;
    const decY = tokenY?.decimal ?? tokenY?.decimals ?? 0;

    // valores RAW -> humanos
    // (o SDK geralmente expõe totalXAmount/totalYAmount)
    const rawX = pos?.totalXAmount ?? pos?.totalX ?? pos?.xAmount ?? null;
    const rawY = pos?.totalYAmount ?? pos?.totalY ?? pos?.yAmount ?? null;

    const q_sol = scaleByDecimals_(rawX, decX);
    const u_usdc = scaleByDecimals_(rawY, decY);

    let lp_total_usd = null;
    if (Number.isFinite(spot) && q_sol !== null && u_usdc !== null) {
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
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-dlmm-backend listening on :${port}`));
