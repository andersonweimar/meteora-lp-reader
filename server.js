import express from "express";
import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";

// ⚠️ IMPORT DO SDK (CORRETO EM ESM)
import DLMM from "@meteora-ag/dlmm";

const app = express();
app.use(express.json());

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const RPC_ENDPOINT = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`
  : "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_ENDPOINT, "confirmed");

app.get("/", (req, res) => {
  res.json({ ok: true, service: "meteora-dlmm-backend", endpoints: ["/lp/:positionId"] });
});

app.get("/lp/:positionId", async (req, res) => {
  try {
    const positionId = (req.params.positionId || "").trim();
    if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

    // 1) Descobre o pool (lbPair) via API da Meteora (funciona bem)
    const metaResp = await axios.get(`https://dlmm-api.meteora.ag/position/${positionId}`);
    const pairAddr = metaResp.data?.pair_address;

    if (!pairAddr) {
      return res.status(404).json({ ok: false, error: "Pool não encontrada para este positionId" });
    }

    const poolPk = new PublicKey(pairAddr);
    const posPk = new PublicKey(positionId);

    // 2) Instancia a pool via SDK
    // Se DLMM estiver undefined, aqui quebraria antes — mas com import acima fica ok.
    const dlmmPool = await DLMM.create(connection, poolPk);

    // 3) Pega a posição on-chain (SDK faz a parte pesada dos bins)
    const position = await dlmmPool.getPosition(posPk);
    if (!position) {
      return res.status(404).json({ ok: false, error: "Posição não encontrada on-chain" });
    }

    // 4) Spot price via Data API
    const spotResp = await axios.get(`https://dlmm.datapi.meteora.ag/pools/${pairAddr}`);
    const spot = Number(spotResp.data?.current_price);
    const spotPrice = Number.isFinite(spot) ? spot : null;

    // 5) Decimais / amounts
    // (o SDK expõe tokenX/tokenY; o totalXAmount/totalYAmount vem em base units)
    const tokenX = dlmmPool.tokenX;
    const tokenY = dlmmPool.tokenY;

    const dx = Number(tokenX?.decimal ?? tokenX?.decimals ?? 9);
    const dy = Number(tokenY?.decimal ?? tokenY?.decimals ?? 6);

    // Algumas versões retornam bigint/string. Converte de forma tolerante:
    const rawX = Number(position.totalXAmount ?? position.totalX ?? 0);
    const rawY = Number(position.totalYAmount ?? position.totalY ?? 0);

    const q_sol = Number.isFinite(rawX) ? rawX / Math.pow(10, dx) : null;
    const u_usdc = Number.isFinite(rawY) ? rawY / Math.pow(10, dy) : null;

    let lp_total_usd = null;
    if (spotPrice !== null && q_sol !== null && u_usdc !== null) {
      lp_total_usd = (q_sol * spotPrice) + u_usdc;
    }

    return res.json({
      ok: true,
      positionId,
      pool: pairAddr,
      spot: spotPrice,
      q_sol,
      u_usdc,
      lp_total_usd
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`server listening on :${port}`));
