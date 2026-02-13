const express = require("express");
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");
require("dotenv").config();

const app = express();
app.use(express.json());

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const RPC_ENDPOINT = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : null;

const PORT = process.env.PORT || 10000;

// conexão RPC (Helius)
const connection = RPC_ENDPOINT ? new Connection(RPC_ENDPOINT, "confirmed") : null;

// helper: pega pool address via API
async function meteoraPosition(positionId) {
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

// helper: pega preço spot
async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  // já vimos que esse endpoint retorna current_price
  const px = Number(data?.current_price);
  return Number.isFinite(px) ? px : null;
}

// ✅ Import dinâmico do DLMM (resolve CommonJS vs ESM)
async function getDLMM() {
  const mod = await import("@meteora-ag/dlmm");
  // alguns builds expõem default, outros expõem DLMM direto
  return mod?.default || mod?.DLMM || mod;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/lp/:positionId"]
  });
});

app.get("/lp/:positionId", async (req, res) => {
  try {
    const positionId = (req.params.positionId || "").trim();
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });
    if (!connection) return res.status(500).json({ ok: false, error: "Missing HELIUS_API_KEY (Render env var)" });

    // 1) Descobre a pool (LB Pair) via API
    const raw = await meteoraPosition(positionId);
    const pool = raw?.pair_address || raw?.pairAddress || raw?.pool || null;
    if (!pool) return res.status(404).json({ ok: false, error: "Pool não encontrada para essa positionId", raw });

    // 2) SDK DLMM: carrega pool e calcula amounts ON-CHAIN
    const DLMM = await getDLMM();

    const lbPairPubkey = new PublicKey(pool);
    const positionPubkey = new PublicKey(positionId);

    // create(connection, poolAddress)
    const dlmmPool = await DLMM.create(connection, lbPairPubkey);

    // getPosition(positionPubkey) -> puxa bins/binArrays necessários
    const position = await dlmmPool.getPosition(positionPubkey);
    if (!position) return res.status(404).json({ ok: false, error: "Posição não encontrada on-chain (SDK)", pool, positionId });

    // 3) preço spot
    const spot = await meteoraPoolSpot(pool);

    // 4) converte amounts (SDK geralmente retorna BN/bigint/string)
    const tokenX = dlmmPool.tokenX;
    const tokenY = dlmmPool.tokenY;

    const totalXRaw = Number(position.totalXAmount ?? 0);
    const totalYRaw = Number(position.totalYAmount ?? 0);

    const q_x = Number.isFinite(totalXRaw) ? totalXRaw / Math.pow(10, tokenX.decimal) : null;
    const u_y = Number.isFinite(totalYRaw) ? totalYRaw / Math.pow(10, tokenY.decimal) : null;

    // dependendo da pool, X pode ser SOL e Y USDC (ou inverso). Vamos devolver genérico + também SOL/USDC quando bater.
    let q_sol = null, u_usdc = null;

    const mintX = tokenX.publicKey.toBase58();
    const mintY = tokenY.publicKey.toBase58();

    const MINT_WSOL = "So11111111111111111111111111111111111111112";
    const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    if (mintX === MINT_WSOL) q_sol = q_x;
    if (mintY === MINT_WSOL) q_sol = u_y;

    if (mintX === MINT_USDC) u_usdc = q_x;
    if (mintY === MINT_USDC) u_usdc = u_y;

    let lp_total_usd = null;
    if (Number.isFinite(spot) && Number.isFinite(q_sol) && Number.isFinite(u_usdc)) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    res.json({
      ok: true,
      positionId,
      pool,
      spot,
      tokenX: { mint: mintX, decimals: tokenX.decimal },
      tokenY: { mint: mintY, decimals: tokenY.decimal },
      q_x,
      u_y,
      q_sol,
      u_usdc,
      lp_total_usd,
      raw
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`meteora-lp-reader listening on :${PORT}`));
