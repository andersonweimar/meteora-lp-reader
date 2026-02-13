const express = require("express");

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;

// Se tu setar HELIUS_RPC_URL no Render, ele usa direto.
// Senão ele monta usando HELIUS_API_KEY.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC_URL =
  (process.env.HELIUS_RPC_URL || "").trim() ||
  (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}` : "");

// Mints
const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Meteora endpoints
const METEORA_POSITION = (id) => `https://dlmm-api.meteora.ag/position/${id}`;
const METEORA_POOL = (poolAddr) => `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;

// ====== UTILS ======
function isNum(x) {
  return Number.isFinite(Number(x));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Resposta não-JSON de ${url}: ${text.slice(0, 120)}...`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} em ${url}: ${text.slice(0, 200)}`);
  }
  return json;
}

async function heliusGetTokenSumByOwnerAndMint(ownerBase58, mint) {
  if (!HELIUS_RPC_URL) throw new Error("HELIUS_RPC_URL/HELIUS_API_KEY não configurado.");

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [
      ownerBase58,
      { mint },
      { encoding: "jsonParsed" }
    ]
  };

  const res = await fetch(HELIUS_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const out = await res.json();
  const arr = out?.result?.value || [];
  let sum = 0;

  for (const it of arr) {
    const uiAmt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    const n = Number(uiAmt);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-lp-reader",
    endpoints: {
      health: "/health",
      lp: "/lp/:POSITION_ID"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// principal: /lp/HBbnv...
app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();

  try {
    // 1) busca position no Meteora
    const raw = await fetchJson(METEORA_POSITION(positionId));

    const owner = raw?.owner; // <<< AQUI é a carteira que realmente tem os tokens
    const pool = raw?.pair_address;

    if (!owner) throw new Error("Meteora não retornou 'owner' para esse positionId.");
    if (!pool) throw new Error("Meteora não retornou 'pair_address' para esse positionId.");

    // 2) pega spot do pool
    let spot = null;
    try {
      const poolData = await fetchJson(METEORA_POOL(pool));
      const px = Number(poolData?.current_price);
      spot = isNum(px) ? px : null;
    } catch (e) {
      // spot é opcional, segue mesmo assim
      spot = null;
    }

    // 3) soma WSOL e USDC do owner via Helius
    const q_sol = await heliusGetTokenSumByOwnerAndMint(owner, MINT_WSOL);
    const u_usdc = await heliusGetTokenSumByOwnerAndMint(owner, MINT_USDC);

    // 4) total USD
    const lp_total_usd = isNum(spot) ? (q_sol * spot + u_usdc) : null;

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
  } catch (err) {
    res.status(500).json({
      ok: false,
      positionId,
      error: String(err?.message || err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`meteora-lp-reader listening on :${PORT}`);
});
