const express = require("express");
const cors = require("cors");

const { Connection, PublicKey } = require("@solana/web3.js");
const DLMM = require("@meteora-ag/dlmm").default;

// =============================
// CONFIG
// =============================
const PORT = process.env.PORT || 3000;

// Render: define no painel como ENV VAR
// Opção 1 (recomendado): HELIUS_RPC_URL = https://mainnet.helius-rpc.com/?api-key=XXXX
// Opção 2: HELIUS_API_KEY = XXXX
function getRpcUrl() {
  const rpc = (process.env.HELIUS_RPC_URL || "").trim();
  if (rpc) return rpc;

  const key = (process.env.HELIUS_API_KEY || "").trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;

  // fallback (não recomendado; pode rate-limit)
  return "https://api.mainnet-beta.solana.com";
}

const app = express();
app.use(cors());
app.use(express.json());

// =============================
// HELPERS
// =============================
function num(x) {
  if (x === null || x === undefined) return null;

  // BN-like / BigInt-like
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "object" && x !== null) {
    if (typeof x.toNumber === "function") return x.toNumber();
    if (typeof x.toString === "function") {
      const n = Number(x.toString());
      return Number.isFinite(n) ? n : null;
    }
  }

  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchMeteoraSpot(poolAddr) {
  // o endpoint "datapi" costuma funcionar pro spot/estado do pool
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora datapi pools failed: ${res.status}`);
  const data = await res.json();
  const spot = num(data.current_price);
  return spot;
}

async function fetchDlmmRawPosition(positionId) {
  // esse endpoint tu confirmou que abre
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dlmm-api position failed: ${res.status}`);
  return await res.json();
}

async function getPositionAmountsViaSdk({ rpcUrl, poolAddr, positionId }) {
  const connection = new Connection(rpcUrl, "confirmed");

  const poolPk = new PublicKey(poolAddr);
  const posPk = new PublicKey(positionId);

  const dlmmPool = await DLMM.create(connection, poolPk);
  const position = await dlmmPool.getPosition(posPk);

  // SDK costuma expor positionXAmount / positionYAmount
  // mas deixo tolerante a mudanças
  const qSol =
    num(position.positionXAmount) ??
    num(position.position_x_amount) ??
    num(position.xAmount) ??
    num(position.amountX);

  const uUsdc =
    num(position.positionYAmount) ??
    num(position.position_y_amount) ??
    num(position.yAmount) ??
    num(position.amountY);

  return { qSol, uUsdc, position };
}

// =============================
// ROUTES
// =============================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * GET /dlmm/position/:positionId
 * Query:
 *   pool=BGm1...
 *
 * Response:
 *  { ok, positionId, pool, spot, q_sol, u_usdc, lp_total_usd, raw }
 */
app.get("/dlmm/position/:positionId", async (req, res) => {
  try {
    const positionId = (req.params.positionId || "").trim();
    const poolAddr = (req.query.pool || "").toString().trim();

    if (!positionId) return res.status(400).json({ ok: false, error: "Missing positionId" });
    if (!poolAddr) return res.status(400).json({ ok: false, error: "Missing ?pool=POOL_ADDRESS" });

    const rpcUrl = getRpcUrl();

    const [raw, spot] = await Promise.all([
      fetchDlmmRawPosition(positionId),
      fetchMeteoraSpot(poolAddr),
    ]);

    const { qSol, uUsdc } = await getPositionAmountsViaSdk({
      rpcUrl,
      poolAddr,
      positionId,
    });

    const lpTotalUsd =
      (num(qSol) !== null && num(spot) !== null ? qSol * spot : null) +
      (num(uUsdc) !== null ? uUsdc : 0);

    res.json({
      ok: true,
      positionId,
      pool: poolAddr,
      spot,
      q_sol: qSol,
      u_usdc: uUsdc,
      lp_total_usd: Number.isFinite(lpTotalUsd) ? lpTotalUsd : null,
      raw,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

app.listen(PORT, () => {
  console.log(`meteora-lp-reader listening on :${PORT}`);
});
