const express = require("express");

const app = express();
app.use(express.json());

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "";

const MINT_WSOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------- helpers ----------
async function fetchJson(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      const txt = await res.text();
      const json = txt ? JSON.parse(txt) : null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${txt}`);
      return json;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

async function meteoraPosition(positionId) {
  // endpoint que tu achou e funciona:
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  return fetchJson(url, {}, 2);
}

async function meteoraPoolPrice(poolAddr) {
  // preço spot do pool
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const data = await fetchJson(url, {}, 2);
  const px = Number(data?.current_price);
  return Number.isFinite(px) ? px : null;
}

async function rpc(method, params) {
  if (!HELIUS_RPC) throw new Error("Missing HELIUS_API_KEY");
  const body = { jsonrpc: "2.0", id: 1, method, params };
  return fetchJson(
    HELIUS_RPC,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    2
  );
}

async function getTokenByOwnerAndMint(owner, mint) {
  const out = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed" }
  ]);
  const arr = out?.result?.value || [];
  let sum = 0;
  for (const it of arr) {
    const uiAmt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    const n = Number(uiAmt);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

async function getNativeSol(owner) {
  // SOL nativo (lamports) do owner
  const out = await rpc("getBalance", [owner]);
  const lamports = Number(out?.result?.value ?? 0);
  if (!Number.isFinite(lamports)) return 0;
  return lamports / 1e9;
}

// ---------- route ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "meteora-lp-reader", endpoints: ["/lp/:positionId"] });
});

app.get("/lp/:positionId", async (req, res) => {
  try {
    const positionId = (req.params.positionId || "").trim();
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

    const raw = await meteoraPosition(positionId);

    const pool = raw?.pair_address || raw?.pairAddress || raw?.pool || null;
    const owner = raw?.owner || null;

    const spot = pool ? await meteoraPoolPrice(pool) : null;

    let q_sol = null;
    let u_usdc = null;
    let lp_total_usd = null;

    if (owner && HELIUS_RPC) {
      // WSOL + SOL nativo
      const wsol = await getTokenByOwnerAndMint(owner, MINT_WSOL);
      const native = await getNativeSol(owner);
      q_sol = (wsol || 0) + (native || 0);

      u_usdc = await getTokenByOwnerAndMint(owner, MINT_USDC);

      if (Number.isFinite(spot)) {
        lp_total_usd = (q_sol * spot) + u_usdc;
      }
    }

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

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
