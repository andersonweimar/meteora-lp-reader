const express = require("express");
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");
const DLMM = require("@meteora-ag/dlmm").default;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const RPC_ENDPOINT = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_ENDPOINT, "confirmed");

// ---------- helpers ----------
function toBigIntSafe(x) {
  // aceita BN, BigInt, number, string
  try {
    if (x === null || x === undefined) return null;
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(Math.trunc(x));
    if (typeof x === "string") {
      if (!x.length) return null;
      // pode vir "123.45" (não deveria) — nesse caso falha e retorna null
      if (x.includes(".")) return null;
      return BigInt(x);
    }
    // BN.js tem toString()
    if (typeof x.toString === "function") {
      const s = x.toString();
      if (!s || s.includes(".")) return null;
      return BigInt(s);
    }
    return null;
  } catch {
    return null;
  }
}

function toDecimalString(amountBigInt, decimals) {
  // retorna string decimal exata (sem perder precisão)
  if (amountBigInt === null) return null;
  const d = Number(decimals || 0);
  const sign = amountBigInt < 0n ? "-" : "";
  const a = amountBigInt < 0n ? -amountBigInt : amountBigInt;

  const base = 10n ** BigInt(d);
  const intPart = a / base;
  const fracPart = a % base;

  if (d === 0) return sign + intPart.toString();
  const frac = fracPart.toString().padStart(d, "0").replace(/0+$/, "");
  return sign + intPart.toString() + (frac ? "." + frac : "");
}

function toNumberApprox(amountBigInt, decimals) {
  // número aproximado (serve pra cálculo de USD no dashboard)
  const s = toDecimalString(amountBigInt, decimals);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function meteoraPosition(positionId) {
  // endpoint que tu validou
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const px = Number(data?.current_price);
  return Number.isFinite(px) ? px : null;
}

// ---------- routes ----------
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

    const positionPubkey = new PublicKey(positionId);

    // 1) Descobre a pool (lbPair) pela API da Meteora
    const raw = await meteoraPosition(positionId);
    const lbPairAddr = raw?.pair_address || raw?.pairAddress || null;
    if (!lbPairAddr) {
      return res.status(404).json({ ok: false, error: "pair_address não encontrado para essa posição" });
    }

    const lbPairPubkey = new PublicKey(lbPairAddr);

    // 2) SDK DLMM: lê bins on-chain e calcula amounts da POSIÇÃO (não da carteira)
    const dlmmPool = await DLMM.create(connection, lbPairPubkey);

    // OBS: dependendo da versão do SDK, pode ser getPosition() ou getPositionByPublicKey().
    // Aqui tentamos getPosition primeiro e fazemos fallback.
    let position;
    if (typeof dlmmPool.getPosition === "function") {
      position = await dlmmPool.getPosition(positionPubkey);
    } else if (typeof dlmmPool.getPositionByPublicKey === "function") {
      position = await dlmmPool.getPositionByPublicKey(positionPubkey);
    } else {
      return res.status(500).json({ ok: false, error: "SDK DLMM não tem método getPosition()" });
    }

    if (!position) {
      return res.status(404).json({ ok: false, error: "posição não encontrada on-chain via SDK" });
    }

    // 3) Spot
    const spot = await meteoraPoolSpot(lbPairAddr);

    // 4) Token metadata (mints/decimals)
    const tokenX = dlmmPool.tokenX;
    const tokenY = dlmmPool.tokenY;

    const dx = tokenX?.decimals ?? tokenX?.decimal ?? 0;
    const dy = tokenY?.decimals ?? tokenY?.decimal ?? 0;

    // 5) Amounts (RAW) -> decimal
    const rawX = toBigIntSafe(position.totalXAmount ?? position.total_x_amount ?? position.totalX ?? null);
    const rawY = toBigIntSafe(position.totalYAmount ?? position.total_y_amount ?? position.totalY ?? null);

    const qX_str = toDecimalString(rawX, dx);
    const uY_str = toDecimalString(rawY, dy);

    // como tu quer SOL/USDC: precisamos mapear qual lado é SOL e qual é USDC
    const mintX = tokenX?.publicKey?.toBase58?.() || tokenX?.mint?.toBase58?.() || null;
    const mintY = tokenY?.publicKey?.toBase58?.() || tokenY?.mint?.toBase58?.() || null;

    // mints oficiais
    const MINT_WSOL = "So11111111111111111111111111111111111111112";
    const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    let q_sol = null;
    let u_usdc = null;

    // se tokenX é SOL, tokenY é USDC (ou vice-versa)
    if (mintX === MINT_WSOL) q_sol = qX_str;
    if (mintY === MINT_WSOL) q_sol = qY_str;

    if (mintX === MINT_USDC) u_usdc = qX_str;
    if (mintY === MINT_USDC) u_usdc = qY_str;

    // 6) total USD (aprox, pra dashboard)
    let lp_total_usd = null;
    const q_sol_num = q_sol ? Number(q_sol) : null;
    const u_usdc_num = u_usdc ? Number(u_usdc) : null;

    if (Number.isFinite(spot) && Number.isFinite(q_sol_num) && Number.isFinite(u_usdc_num)) {
      lp_total_usd = (q_sol_num * spot) + u_usdc_num;
    }

    return res.json({
      ok: true,
      positionId,
      pool: lbPairAddr,
      spot,
      tokenXMint: mintX,
      tokenYMint: mintY,
      tokenXDecimals: dx,
      tokenYDecimals: dy,

      // valores “mastigados”
      q_sol,
      u_usdc,
      lp_total_usd,

      // raw meteora (pra debug)
      raw_position_meta: raw
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`meteora-dlmm-backend listening on :${PORT}`));
