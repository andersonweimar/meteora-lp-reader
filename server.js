const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 10000;

// === Mints (mainnet) ===
const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// === Helius ===
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "";

// ===== util =====
function isFiniteNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function meteoraGetPosition(positionId) {
  // Esse é o endpoint que tu achou funcionando:
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora position HTTP ${res.status}`);
  return res.json();
}

async function meteoraGetPool(poolAddress) {
  // spot atual do pool
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora pool HTTP ${res.status}`);
  return res.json();
}

async function rpcGetTokenSumByOwnerMint(owner, mint) {
  if (!HELIUS_RPC) return 0;

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [owner, { mint }, { encoding: "jsonParsed" }]
  };

  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const out = await res.json();
  const arr = out?.result?.value || [];

  let sum = 0;
  for (const it of arr) {
    const uiAmt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    const n = isFiniteNum(uiAmt);
    if (n !== null) sum += n;
  }
  return sum;
}

// ===== routes =====
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// GET /lp/<POSITION_ID>
app.get("/lp/:positionId", async (req, res) => {
  try {
    const positionId = (req.params.positionId || "").trim();
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

    const raw = await meteoraGetPosition(positionId);

    // o JSON da Meteora vem com: address, pair_address, owner, etc.
    const owner = raw.owner;
    const pool = raw.pair_address;

    let spot = null;
    try {
      const poolData = await meteoraGetPool(pool);
      spot = isFiniteNum(poolData.current_price);
    } catch (e) {
      spot = null;
    }

    // saldos reais via owner (carteira dona da posição)
    const q_sol = await rpcGetTokenSumByOwnerMint(owner, MINT_WSOL);
    const u_usdc = await rpcGetTokenSumByOwnerMint(owner, MINT_USDC);

    const lp_total_usd = spot !== null ? (q_sol * spot + u_usdc) : null;

    res.json({
      ok: true,
      positionId,
      pool,
      owner,
      spot,
      q_sol,
      u_usdc,
      lp_total_usd,
      raw
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`meteora-lp-reader listening on :${PORT}`);
});
