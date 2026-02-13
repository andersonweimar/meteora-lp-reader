const express = require("express");
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");

// DLMM SDK (CommonJS compat)
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default || dlmmPkg;

const app = express();
app.use(express.json());

// ===== ENV =====
const HELIUS_KEY = (process.env.HELIUS_API_KEY || "").trim();

// Se não tiver Helius, cai no RPC público (pode ser mais lento / rate limit)
const RPC_ENDPOINT = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_ENDPOINT, "confirmed");

// ===== Helpers =====
async function meteoraPositionMeta(positionId) {
  // retorna { address, pair_address, owner, ... }
  const url = `https://dlmm-api.meteora.ag/position/${positionId}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

async function meteoraPoolSpot(poolAddr) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const px = Number(data?.current_price ?? data?.price ?? NaN);
  return Number.isFinite(px) ? px : null;
}

function toNumberAmount(raw, decimals) {
  // SDK pode devolver bigint, string, BN-like, number
  if (raw === null || raw === undefined) return null;

  try {
    // BN-like
    if (typeof raw === "object" && raw.toString) raw = raw.toString();
    if (typeof raw === "string") {
      if (!raw.length) return null;
      const bi = BigInt(raw);
      const div = 10n ** BigInt(decimals);
      const intPart = bi / div;
      const fracPart = bi % div;

      // converte pra Number com segurança “boa o bastante” p/ dashboard
      const frac = Number(fracPart) / Number(div);
      return Number(intPart) + frac;
    }
    if (typeof raw === "bigint") {
      const div = 10n ** BigInt(decimals);
      const intPart = raw / div;
      const fracPart = raw % div;
      const frac = Number(fracPart) / Number(div);
      return Number(intPart) + frac;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n / Math.pow(10, decimals);
  } catch {
    return null;
  }
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "meteora-dlmm-backend",
    endpoints: ["/debug", "/lp/:positionId"],
  });
});

app.get("/debug", async (req, res) => {
  // pra tu saber se o Render tá passando env e se RPC tá respondendo
  try {
    const version = await connection.getVersion();
    res.json({
      ok: true,
      heliusKeyPresent: HELIUS_KEY.length > 0,
      rpcEndpoint: RPC_ENDPOINT.includes("helius") ? "helius" : "public",
      solanaVersion: version,
    });
  } catch (e) {
    res.json({
      ok: false,
      heliusKeyPresent: HELIUS_KEY.length > 0,
      rpcEndpoint: RPC_ENDPOINT.includes("helius") ? "helius" : "public",
      error: String(e?.message || e),
    });
  }
});

app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();
  if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

  try {
    // 1) meta (pool + owner)
    const meta = await meteoraPositionMeta(positionId);
    const poolAddr = meta?.pair_address;
    if (!poolAddr) return res.status(404).json({ ok: false, error: "pool not found for position", meta });

    // 2) spot
    const spot = await meteoraPoolSpot(poolAddr);

    // 3) SDK on-chain calc
    const poolPk = new PublicKey(poolAddr);
    const posPk = new PublicKey(positionId);

    const dlmmPool = await DLMM.create(connection, poolPk);
    const position = await dlmmPool.getPosition(posPk);

    // token info
    const tokenX = dlmmPool.tokenX;
    const tokenY = dlmmPool.tokenY;

    // totalXAmount / totalYAmount (raw base units)
    const q_sol = toNumberAmount(position?.totalXAmount, tokenX?.decimal ?? 9);
    const u_usdc = toNumberAmount(position?.totalYAmount, tokenY?.decimal ?? 6);

    let lp_total_usd = null;
    if (Number.isFinite(spot) && q_sol !== null && u_usdc !== null) {
      lp_total_usd = (q_sol * spot) + u_usdc;
    }

    return res.json({
      ok: true,
      positionId,
      pool: poolAddr,
      owner: meta?.owner ?? null,
      rpc: RPC_ENDPOINT.includes("helius") ? "helius" : "public",
      heliusKeyPresent: HELIUS_KEY.length > 0,

      tokenXMint: tokenX?.publicKey?.toBase58?.() ?? tokenX?.mint?.toBase58?.() ?? null,
      tokenYMint: tokenY?.publicKey?.toBase58?.() ?? tokenY?.mint?.toBase58?.() ?? null,

      spot,
      q_sol,
      u_usdc,
      lp_total_usd,

      meta
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`meteora-lp-reader listening on :${port}`));
