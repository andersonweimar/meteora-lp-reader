const express = require("express");
const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");
const DLMM = require("@meteora-ag/dlmm").default; // Forçando o .default para CommonJS

const app = express();
app.use(express.json());

const HELIUS_KEY = "395619ba-76c1-46fe-ab8e-d38a2fd8a455"; 
const RPC_ENDPOINT = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Helper para converter BigInt/BN para Number real considerando decimais
function toUiAmount(amount, decimals) {
    if (!amount) return 0;
    const amtStr = amount.toString();
    return Number(amtStr) / Math.pow(10, decimals);
}

app.get("/lp/:positionId", async (req, res) => {
    const { positionId } = req.params;
    
    try {
        // 1. Pegar meta via API (necessário para achar o par)
        const metaUrl = `https://dlmm-api.meteora.ag/position/${positionId}`;
        const { data: meta } = await axios.get(metaUrl);
        const poolAddr = meta.pair_address;

        // 2. Criar instância da Pool e da Posição
        const poolPk = new PublicKey(poolAddr);
        const posPk = new PublicKey(positionId);
        
        // Carrega a pool e os dados on-chain (incluindo bin arrays)
        const dlmmPool = await DLMM.create(connection, poolPk);
        const positionData = await dlmmPool.getPosition(posPk);

        if (!positionData) {
            throw new Error("Não foi possível carregar os dados da posição on-chain.");
        }

        // 3. Pegar Preço Spot (API ou On-chain)
        const spotPrice = Number(dlmmPool.getRealTimePrice());

        // 4. CÁLCULO DOS SALDOS (O segredo está aqui)
        // O SDK preenche positionData.position com os saldos calculados após ler os bins
        const rawX = positionData.position.totalXAmount;
        const rawY = positionData.position.totalYAmount;

        const q_sol = toUiAmount(rawX, dlmmPool.tokenX.decimal);
        const u_usdc = toUiAmount(rawY, dlmmPool.tokenY.decimal);

        // 5. Net Worth
        const lp_total_usd = (q_sol * spotPrice) + u_usdc;

        return res.json({
            ok: true,
            positionId,
            pool: poolAddr,
            tokenXMint: dlmmPool.tokenX.publicKey.toBase58(),
            tokenYMint: dlmmPool.tokenY.publicKey.toBase58(),
            spot: spotPrice,
            q_sol,
            u_usdc,
            lp_total_usd,
            // Debug para saber se a posição está fora de range
            activeBinId: dlmmPool.activeBinId,
            positionRange: `${positionData.position.lowerBinId} -> ${positionData.position.upperBinId}`
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Meteora Backend Online na porta ${port}`));
