// ===== HL helpers (Hyperliquid /info) =====
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
  // 1) tenta allMids (mais simples)
  try {
    const mids = await hlInfo({ type: "allMids" }); // { SOL: "123.45", ... }
    const v = mids?.[coin];
    const n = Number(v);
    if (Number.isFinite(n)) return { mid: n, mark: n, source: "allMids" };
  } catch (_) {}

  // 2) fallback: metaAndAssetCtxs
  const metaCtx = await hlInfo({ type: "metaAndAssetCtxs" });
  const meta = metaCtx?.[0];
  const ctxs = metaCtx?.[1];

  const uni = meta?.universe || [];
  const idx = uni.findIndex(u => String(u?.name || "").toUpperCase() === String(coin).toUpperCase());
  if (idx < 0 || !Array.isArray(ctxs) || !ctxs[idx]) return { mid: null, mark: null, source: "metaAndAssetCtxs" };

  const ctx = ctxs[idx];
  const mid = Number(ctx?.midPx);
  const mark = Number(ctx?.markPx);

  return {
    mid: Number.isFinite(mid) ? mid : null,
    mark: Number.isFinite(mark) ? mark : null,
    source: "metaAndAssetCtxs",
  };
}

async function hlGetPosition(wallet, coin) {
  const st = await hlInfo({ type: "clearinghouseState", user: wallet });
  const aps = st?.assetPositions || [];
  const p = aps
    .map(x => x?.position || x)
    .find(pos => String(pos?.coin || "").toUpperCase() === String(coin).toUpperCase());

  if (!p) return { posQty: 0, entryPx: null, pnlUsd: null, fundingAccUsd: null };

  // HL costuma ter szi com sinal (short negativo). A planilha quer "short+" => abs()
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

// ===== HL route: /hl/:wallet/:coin =====
// Retorna exatamente o formato que o Apps Script espera
app.get("/hl/:wallet/:coin", async (req, res) => {
  try {
    const wallet = String(req.params.wallet || "").trim();
    const coin = String(req.params.coin || "SOL").trim().toUpperCase();
    if (!wallet) return res.status(400).json({ ok: false, error: "wallet vazio" });

    const px = await hlGetMidOrMark(coin);
    const pos = await hlGetPosition(wallet, coin);

    // funding_rate: a HL expõe vários campos dependendo do payload; aqui deixo null
    // (se tu quiser, eu ajusto depois olhando teu JSON real)
    const payload = {
      ok: true,
      hl_price: px.mid ?? px.mark,
      funding_rate: null,
      position_sz: pos.posQty,
      entry_px: pos.entryPx,
      pnl_usd: pos.pnlUsd,
      funding_acc_usd: pos.fundingAccUsd,
      funding_8h_usd: null,
      meta: {
        hl_coin: coin,
        // Se tu quiser auto-preencher o HUB, tu pode mandar essas chaves daqui também:
        // feeCoef_24h_feeTVL: 0.0031,
        // atr_1h_usd: 4.0,
        // k_range_mode: "AUTO",
        // k_range_manual: 2,
        // resetCost_usdc: 2,
        // fundingCost_usdc_day: 0,
        // atr_ref_pct: 0.04,
        // range_ref_pct: 0.10,
        // atr_to_sigma_factor: 1.25,
        // cooldown_min: 10,
        // targetReset_min: 90,
        // feeCapture_boost: 1.0
      },
      debug: { source: px.source }
    };

    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

