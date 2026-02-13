const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

// ====== helpers ======
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "cache-control": "no-cache",
      "pragma": "no-cache",
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}

function pickNumberDeep(obj, keys) {
  // procura número por caminhos comuns
  for (const k of keys) {
    const parts = k.split(".");
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else { ok = false; break; }
    }
    if (!ok) continue;
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sumMaybeArrayAmounts(obj) {
  // tenta somar arrays com itens contendo amount/qty/uiAmount etc
  if (!obj) return null;
  const arrCandidates = [];
  if (Array.isArray(obj)) arrCandidates.push(obj);
  if (Array.isArray(obj?.result)) arrCandidates.push(obj.result);
  if (Array.isArray(obj?.data)) arrCandidates.push(obj.data);
  if (Array.isArray(obj?.deposits)) arrCandidates.push(obj.deposits);
  if (Array.isArray(obj?.positions)) arrCandidates.push(obj.positions);

  for (const arr of arrCandidates) {
    let sum = 0;
    let hit = false;
    for (const it of arr) {
      const n =
        pickNumberDeep(it, [
          "amount", "qty", "uiAmount", "tokenAmount.uiAmount",
          "x_amount", "y_amount",
          "token_x_amount", "token_y_amount",
          "tokenXAmount", "tokenYAmount",
          "balance", "value",
        ]);
      if (Number.isFinite(Number(n))) { sum += Number(n); hit = true; }
    }
    if (hit) return sum;
  }
  return null;
}

// ====== routes ======
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * GET /lp/:positionId
 * Retorna:
 * - pool
 * - spot (preço atual do pool via datapi)
 * - q_sol / u_usdc (tenta pegar do endpoint de deposits e/ou position)
 * - lp_total_usd
 */
app.get("/lp/:positionId", async (req, res) => {
  const positionId = (req.params.positionId || "").trim();
  if (!positionId) return res.status(400).json({ ok: false, error: "missing positionId" });

  // 1) posição (sempre existe)
  const posUrl = `https://dlmm-api.meteora.ag/position/${positionId}?t=${Date.now()}`;
  const pos = await fetchJson(posUrl);
  if (!pos.ok || !pos.json) {
    return res.status(502).json({
      ok: false,
      error: "meteora position fetch failed",
      status: pos.status,
      body: pos.text?.slice(0, 500),
      positionId
    });
  }

  const rawPosition = pos.json;
  const poolAddr =
    rawPosition?.pair_address ||
    rawPosition?.pairAddress ||
    rawPosition?.pool ||
    rawPosition?.pool_address ||
    null;

  // 2) spot price (se tiver pool)
  let spot = null;
  if (poolAddr) {
    const poolUrl = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}?t=${Date.now()}`;
    const pool = await fetchJson(poolUrl);
    spot = pickNumberDeep(pool.json, ["current_price", "currentPrice", "price"]) ?? null;
  }

  // 3) tentar pegar Q/U (o endpoint /position/:id sozinho geralmente não entrega)
  //    a rota /deposits existe (aparece até em issue do dlmm-sdk)
  const depUrl = `https://dlmm-api.meteora.ag/position/${positionId}/deposits?t=${Date.now()}`;
  const dep = await fetchJson(depUrl);

  // tentativa A: campos “diretos”
  let q_sol =
    pickNumberDeep(dep.json, [
      "q_sol", "qSol",
      "token_x_amount", "tokenXAmount",
      "amount_x", "amountX",
      "x_amount", "xAmount",
      "base_amount", "baseAmount"
    ]) ??
    pickNumberDeep(rawPosition, [
      "q_sol", "qSol",
      "token_x_amount", "tokenXAmount",
      "amount_x", "amountX",
      "x_amount", "xAmount",
      "base_amount", "baseAmount"
    ]) ??
    null;

  let u_usdc =
    pickNumberDeep(dep.json, [
      "u_usdc", "uUsdc",
      "token_y_amount", "tokenYAmount",
      "amount_y", "amountY",
      "y_amount", "yAmount",
      "quote_amount", "quoteAmount"
    ]) ??
    pickNumberDeep(rawPosition, [
      "u_usdc", "uUsdc",
      "token_y_amount", "tokenYAmount",
      "amount_y", "amountY",
      "y_amount", "yAmount",
      "quote_amount", "quoteAmount"
    ]) ??
    null;

  // tentativa B: se vierem listas, tenta somar algo (fallback)
  // (isso não garante separar X/Y; então só usa se A falhar)
  if (q_sol === null && u_usdc === null && dep.ok && dep.json) {
    // não dá pra separar X/Y sem schema; melhor não inventar
    // então mantém null aqui
  }

  // 4) total USD
  let lp_total_usd = null;
  if (Number.isFinite(Number(q_sol)) && Number.isFinite(Number(u_usdc)) && Number.isFinite(Number(spot))) {
    lp_total_usd = (Number(q_sol) * Number(spot)) + Number(u_usdc);
  } else if (Number.isFinite(Number(u_usdc)) && (q_sol === 0 || q_sol === "0")) {
    lp_total_usd = Number(u_usdc); // fora do range pode virar 100% USDC
  }

  // resposta
  return res.json({
    ok: true,
    positionId,
    pool: poolAddr,
    spot,
    q_sol,
    u_usdc,
    lp_total_usd,
    raw: rawPosition
  });
});

app.listen(PORT, () => {
  console.log(`meteora-lp-reader listening on :${PORT}`);
});
