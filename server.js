const express = require("express");
const { Connection, PublicKey } = require("@solana/web3.js");
const axios = require("axios");

// Importação robusta para evitar o erro de ".create is not a function"
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default || dlmmPkg;

const app = express();
app.use(express.json());

// Usando sua chave diretamente para garantir performance
const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=395619ba-76c1-46fe-ab8e-d38a2fd8a455";
const connection = new Connection(HELIUS_RPC, "confirmed");

// Helper para converter BigInt para Number com decimais
function toUiAmount(raw, decimals) {
  if (raw === undefined || raw === null) return 0;
  return Number(raw.toString()) / Math.pow(10, decimals);
}

app.get("/lp/:positionId", async (req, res) => {
  const { positionId } = req.params;
  
  try {
    // 1. Descobrir a Pool via API da Meteora
    const metaRes = await axios.get(`https://dlmm-api.meteora.ag/position/${positionId}`);
    const poolAddr = metaRes.data.pair_address;
    
    if (!poolAddr) throw new Error("Pool address não encontrado");

    // 2. Carregar DLMM e Posição
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddr));
    
    // IMPORTANTE: getPosition carrega os BinArrays necessários
    const posData = await dlmmPool.getPosition(new PublicKey(positionId));

    if (!posData) throw new Error("Dados da posição não encontrados on-chain");

    // O SDK da Meteora encapsula os valores em campos específicos. 
    // Vamos usar as propriedades calculadas da instância da posição.
    const q_sol = toUiAmount(posData.positionData.totalXAmount, dlmmPool.tokenX.decimal);
    const u_usdc = toUiAmount(posData.positionData.totalYAmount, dlmmPool.tokenY.decimal);

    // 3. Preço Spot (usando o preço real da pool que acabamos de ler)
    const spot = Number(dlmmPool.getRealTimePrice());
    const lp_total_usd = (q_sol * spot) + u_usdc;

    return res.json({
      ok: true,
      positionId,
      pool: poolAddr,
      owner: metaRes.data.owner,
      tokenXMint: dlmmPool.tokenX.publicKey.toBase58(),
      tokenYMint: dlmmPool.tokenY.publicKey.toBase58(),
      spot,
      q_sol, // Agora deve vir os ~26 SOL
      u_usdc,
      lp_total_usd,
      lastUpdate: new Date().toISOString()
    });

  } catch (e) {
    console.error("ERRO CRÍTICO:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Rodando na porta ${port}`));
