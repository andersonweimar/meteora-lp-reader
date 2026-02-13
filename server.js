const express = require("express");
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");

// ✅ Import robusto (funciona em CJS mesmo quando o pacote exporta diferente)
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg?.DLMM || dlmmPkg?.default || dlmmPkg;

const app = express();
app.use(express.json());

// ===== Config =====
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const RPC_URL = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "";

// ⚠️ "confirmed" costuma ser mais rápido/estável que "finalized"
const connection = RPC_URL ? new Connection(RPC_URL, "confirmed") : null;

// ===== Cache simples (memória) =====
const CACHE_TTL_MS = 15_000; // 15s
const cache = new Map();
function cacheGet(key) {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) { cache.delete(key); return null; }
  return it.val;
}
function cacheSet(key, val, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

// ===== Helpers =====
async function getMeteoraPosition(positionId) {
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const { data } = await axios.get(url, { timeout: 20_000 });
  return data;
}

async function getMeteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const { data } = await axios.get(url, { timeout: 20_000 });

  // na tua planilha tu tava usando current_price
  const px = Number(data?.current_price ?? data?.price ?? data?.spot_price);
  return Number.isFinite(px) ? px : null;
}

function toNumberSafe(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ===== Rotas =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/lp/:positionId"]
  });
});

/**
 * Retorna o saldo REAL da posição DLMM (pool),
 * calculado via SDK (on-chain bins).
 */
app.get("/lp/:positionId", async (req, res) => {
  // aumenta timeout do response (evita cortar cedo do lado do node)
  req.setTimeout(60_000);
  res.setTimeout(60_000);

  const positionId = (req.params.positionId || "").trim();
  if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

  if (!HELIUS_KEY || !connection) {
    return res.status(500).json({ ok: false, error: "Missing HELIUS_API_KEY in Render Environment" });
  }

  const cacheKey = `lp:${positionId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // 1) Descobrir pool (lbPair) pela API pública
    const meta = await getMeteoraPosition(positionId);
    const pool = meta?.pair_address || meta?.pairAddress || meta?.pool;
    if (!pool) return res.status(404).json({ ok: false, error: "Pool não encontrada para esta posição." });

    // 2) Spot do pool
    const spot = await getMeteoraPoolSpot(pool);

    // 3) SDK DLMM: carrega pool e posição (faz a matemática dos bins)
    if (!DLMM || typeof DLMM.create !== "function") {
      return res.status(500).json({
        ok: false,
        error: "DLMM SDK not loaded (DLMM.create missing). Check @meteora-ag/dlmm import."
      });
    }

    const poolPk = new PublicKey(pool);
    const posPk = new PublicKey(positionId);

    const dlmmPool = await DLMM.create(connection, poolPk);

    // ✅ este é o ponto: pega a posição ON-CHAIN e calcula totalX/totalY
    const position = await dlmmPool.getPosition(posPk);

    if (!position) {
      return res.status(404).json({ ok: false, error: "Posição não encontrada on-chain via SDK." });
    }

    // tokenX/tokenY vêm do pool (decimals corretos)
    const tokenX = dlmmPool.tokenX;
    const tokenY = dlmmPool.tokenY;

    // o SDK geralmente entrega totalXAmount/totalYAmount em unidade "raw"
    const xRaw = toNumberSafe(position.totalXAmount);
    const yRaw = toNumberSafe(position.totalYAmount);

    const q_x = xRaw !== null ? xRaw / Math.pow(10, tokenX.decimal) : null;
    const u_y = yRaw !== null ? yRaw / Math.pow(10, tokenY.decimal) : null;

    // Atenção: na SOL/USDC, normalmente X = SOL e Y = USDC (mas pode inverter).
    // Vamos expor também os mints pra tu validar.
    let q_sol = null;
    let u_usdc = null;

    if (tokenX?.publicKey?.toBase58() === "So11111111111111111111111111111111111111112") {
      q_sol = q_x;
      u_usdc = u_y;
    } else {
      // invertido
      q_sol = u_y;
      u_usdc = q_x;
    }

    const lp_total_usd =
      Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)
        ? (q_sol * spot) + u_usdc
        : null;

    const out = {
      ok: true,
      positionId,
      pool,
      tokenXMint: tokenX.publicKey.toBase58(),
      tokenYMint: tokenY.publicKey.toBase58(),
      spot,
      q_sol,
      u_usdc,
      lp_total_usd,
      // mantém raw/meta pra debug
      meta
    };

    cacheSet(cacheKey, out);
    return res.json(out);

  } catch (e) {
    const msg = String(e?.message || e);

    // Se o SDK demorar demais ou RPC oscilar, tu vai ver isso aqui
    return res.status(500).json({
      ok: false,
      error: msg,
      hint:
        "Se for timeout: Render free + RPC pesado. Tenta novamente, ou sobe TTL do cache, ou usa instância paga/mais rápida."
    });
  }
});

// Render injeta PORT automaticamente
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
