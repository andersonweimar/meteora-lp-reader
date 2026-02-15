const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ============================
// HEALTH
// ============================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "meteora-lp-reader", ts: new Date().toISOString() });
});

// ============================
// METEORA LP (placeholder)
// ============================
// ⚠️ IMPORTANTE:
// Aqui tu deve colar a tua implementação que já funcionava.
// Se tu já tem /lp/:positionId funcionando, mantém a tua e IGNORA esta.
app.get("/lp/:positionId", async (req, res) => {
  try {
    const positionId = String(req.params.positionId || "").trim();
    if (!positionId) return res.status(400).json({ ok: false, error: "positionId vazio" });

    // TODO: SUBSTITUIR pela tua lógica Meteora real (a que já funcionava)
    // Retorno mínimo esperado pelo Apps Script:
    // { ok:true, positionId, spot, q_sol, u_usdc, lp_total_usd, meta?: {...} }

    return res.status(501).json({
      ok: false,
      error: "Implementa aqui tua lógica Meteora (cola a versão que já funcionava)."
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============================
// HYPERLIQUID HELPERS
// ============================
async function hlInfo(body) {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HL HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function hlGetMidOrMark(coin) {
  // 1) allMids (mais simples)
  try {
    const mids = await hlInfo({ type: "allMids" }); // { SOL:"123.4", ... }
    const v = mids?.[coin];
    const n = Number(v);
    if (Number.isFinite(n)) return { px: n, source: "allMids" };
  } catch (_) {}

  // 2) fallback: metaAndAssetCtxs
  const metaCtx = await hlInfo({ type: "metaAndAssetCtxs" });
  const meta = metaCtx?.[0];
  const ctxs = metaCtx?.[1];
  const uni = meta?.universe || [];

  const idx = uni.findIndex(u => String(u?.name || "").toUpperCase() === String(coin).toUpperCase());
  if (idx < 0 || !Array.isArray(ctxs) || !ctxs[idx]) return { px: null, source: "metaAndAssetCtxs" };

  const ctx = ctxs[idx];
  const mid = Number(ctx?.midPx);
  if (Number.isFinite(mid)) return { px: mid, source: "metaAndAssetCtxs.midPx" };

  const mark = Number(ctx?.markPx);
  if (Number.isFinite(mark)) return { px: mark, source: "metaAndAssetCtxs.markPx" };

  return { px: null, source: "metaAndAssetCtxs.none" };
}

async function hlGetPosition(wallet, coin) {
  const st = await hlInfo({ type: "clearinghouseState", user: wallet });
  const aps = st?.assetPositions || [];
  const p = aps
    .map(x => x?.position || x)
    .find(pos => String(pos?.coin || "").toUpperCase() === String(coin).toUpperCase());

  if (!p) return { posQty: 0, entryPx: null, pnlUsd: null, fundingAccUsd: null };

  const szi = Number(p?.szi ?? p?.size ?? p?.positionSize);
  const entry = Number(p?.entryPx ?? p?.avgPx ?? p?.averageEntryPrice);
  const pnl = Number(p?.unrealizedPnl ?? p?.pnl);
  const fund = Number(p?.cumFunding?.allTime ?? p?.cumFunding ?? p?.funding);

  return {
    posQty: Number.isFinite(szi) ? Math.abs(szi) : 0,
    entryPx: Number.isFinite(entry) ? entry : null,
    pnlUsd: Number.isFinite(pnl) ? pnl : null,
    fundingAccUsd: Number.isFinite(fund) ? fund : null,
  };
}

// ============================
// HL ROUTES
// ============================

// /hl/:wallet (default SOL)
app.get("/hl/:wallet", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    if (!wallet) return res.status(400).json({ ok: false, error: "wallet vazio" });

    const coin = "SOL";
    const px = await hlGetMidOrMark(coin);
    const pos = await hlGetPosition(wallet, coin);

    return res.json({
      ok: true,
      hl_price: px.px,
      funding_rate: null,
      position_sz: pos.posQty,
      entry_px: pos.entryPx,
      pnl_usd: pos.pnlUsd,
      funding_acc_usd: pos.fundingAccUsd,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: px.source }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// /hl/:wallet/:coin (coin explícito)
app.get("/hl/:wallet/:coin", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    const coin = String(req.params.coin || "SOL").trim().toUpperCase();
    if (!wallet) return res.status(400).json({ ok: false, error: "wallet vazio" });

    const px = await hlGetMidOrMark(coin);
    const pos = await hlGetPosition(wallet, coin);

    return res.json({
      ok: true,
      hl_price: px.px,
      funding_rate: null,
      position_sz: pos.posQty,
      entry_px: pos.entryPx,
      pnl_usd: pos.pnlUsd,
      funding_acc_usd: pos.fundingAccUsd,
      funding_8h_usd: null,
      meta: { hl_coin: coin },
      debug: { source: px.source }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============================
// START
// ============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`listening on :${PORT}`));
