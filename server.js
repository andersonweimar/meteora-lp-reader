/***********************
 * HEDGE — Meteora LP (via Render) + Hyperliquid (API)
 * - Meteora LP: chama teu backend Render /lp/:positionId
 * - Hyper: api.hyperliquid.xyz/info
 ***********************/

// ===== AJUSTES FIXOS =====
const SHEET_API = "API_DATA";
const SHEET_INPUTS = "Inputs";

// teu backend Render (confere se é esse)
const LP_READER_BASE = "https://meteora-lp-reader.onrender.com";

// API_DATA cells (mantendo teu layout)
const CELL_POOL_ADDR = "B3";       // meteora pool address (opcional)
const CELL_USER_EVM  = "B4";       // hyper user 0x...
const CELL_POS_IDS   = "B7";       // positionId(s) meteora

const CELL_LAST_TS   = "B6";

const CELL_METEORA_PRICE      = "B9";
const CELL_HYPER_MID          = "B10";
const CELL_HYPER_FUNDING_RATE = "B11";
const CELL_HYPER_POS_SIZE     = "B12";
const CELL_HYPER_ENTRY        = "B13";
const CELL_HYPER_PNL          = "B14";
const CELL_HYPER_FUNDING_ACC  = "B15";

// novos outputs LP em API_DATA
const CELL_LP_TOTAL_USD = "B18";
const CELL_LP_Q_SOL     = "B19";
const CELL_LP_U_USDC    = "B20";

// Inputs cells
const INPUT_PRICE_P   = "B6";
const INPUT_LP_Q      = "B12";
const INPUT_LP_U      = "B13";
const INPUT_PERP_SIZE = "B10";
const INPUT_ENTRY     = "B16";
const INPUT_LEV_EFF   = "B17";
const INPUT_LEV_INIT  = "B9";

// Script Properties
const PROP_INIT_LEV_SOL = "INIT_LEV_SOL";

// ======================
// MENU
// ======================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("HEDGE")
    .addItem("Atualizar agora", "updateFeeds")
    .addSeparator()
    .addItem("Criar trigger 1 min", "create1minTrigger")
    .addItem("Ver triggers ativos", "listTriggers")
    .addToUi();
}

// ======================
// MAIN
// ======================
function updateFeeds() {
  const ss = SpreadsheetApp.getActive();
  const api = ss.getSheetByName(SHEET_API);
  const inputs = ss.getSheetByName(SHEET_INPUTS);

  if (!api || !inputs) {
    SpreadsheetApp.getUi().alert("Erro: abas 'API_DATA' e/ou 'Inputs' não encontradas.");
    return;
  }

  const now = new Date();
  api.getRange(CELL_LAST_TS).setValue(now);

  const userEvm = (api.getRange(CELL_USER_EVM).getValue() || "").toString().trim();
  const posRaw  = (api.getRange(CELL_POS_IDS).getValue() || "").toString().trim();
  const positionIds = parseIds_(posRaw);

  // ======================
  // 1) METEORA LP via Render backend
  // ======================
  const lp = fetchLpAggregateFromRender_(positionIds);

  // escreve API_DATA LP
  api.getRange(CELL_LP_TOTAL_USD).setValue(isNum_(lp.totalUsd) ? lp.totalUsd : "");
  api.getRange(CELL_LP_Q_SOL).setValue(isNum_(lp.qSol) ? lp.qSol : 0);
  api.getRange(CELL_LP_U_USDC).setValue(isNum_(lp.uUsdc) ? lp.uUsdc : 0);

  // Inputs LP
  inputs.getRange(INPUT_LP_Q).setValue(isNum_(lp.qSol) ? lp.qSol : 0);
  inputs.getRange(INPUT_LP_U).setValue(isNum_(lp.uUsdc) ? lp.uUsdc : 0);

  // preço (usa spot do backend; se não vier, cai pro Hyper mid)
  let priceFinal = isNum_(lp.spot) ? lp.spot : null;

  if (isNum_(lp.spot)) api.getRange(CELL_METEORA_PRICE).setValue(lp.spot);

  // ======================
  // 2) HYPER: mid + funding rate
  // ======================
  const hyperMid = fetchHyperMid_("SOL");
  const fundingRate = fetchHyperFundingRate_("SOL");

  if (isNum_(hyperMid)) api.getRange(CELL_HYPER_MID).setValue(hyperMid);
  if (isNum_(fundingRate)) api.getRange(CELL_HYPER_FUNDING_RATE).setValue(fundingRate);

  if (!isNum_(priceFinal) && isNum_(hyperMid)) priceFinal = hyperMid;
  if (isNum_(priceFinal)) inputs.getRange(INPUT_PRICE_P).setValue(priceFinal);

  // ======================
  // 3) HYPER: pos + entry + lev + pnl + fundingUSD
  // ======================
  const hyperState = fetchHyperPositionState_(userEvm, "SOL", hyperMid);

  api.getRange(CELL_HYPER_POS_SIZE).setValue(hyperState.posSolShort || 0);
  api.getRange(CELL_HYPER_ENTRY).setValue(hyperState.posSolShort > 0 && isNum_(hyperState.entryPxSol) ? hyperState.entryPxSol : "");
  api.getRange(CELL_HYPER_PNL).setValue(hyperState.posSolShort > 0 && isNum_(hyperState.perpPnlUsd) ? hyperState.perpPnlUsd : "");

  // funding acumulado (real se vier)
  const fundAccCell = api.getRange(CELL_HYPER_FUNDING_ACC);
  if (isNum_(hyperState.fundingUsdReal)) {
    fundAccCell.setValue(hyperState.fundingUsdReal);
  }

  // Inputs perp
  inputs.getRange(INPUT_PERP_SIZE).setValue(hyperState.posSolShort || 0);
  inputs.getRange(INPUT_ENTRY).setValue(hyperState.posSolShort > 0 && isNum_(hyperState.entryPxSol) ? hyperState.entryPxSol : "");

  // leverage efetiva + snapshot inicial (B9)
  if (hyperState.posSolShort > 0 && isNum_(hyperState.levEff)) {
    inputs.getRange(INPUT_LEV_EFF).setValue(hyperState.levEff);

    const props = PropertiesService.getScriptProperties();
    const savedInit = Number(props.getProperty(PROP_INIT_LEV_SOL) || "");
    const b9 = Number(inputs.getRange(INPUT_LEV_INIT).getValue() || "");

    if (!savedInit || Number.isNaN(savedInit)) {
      if (!b9 || Number.isNaN(b9) || b9 <= 0) inputs.getRange(INPUT_LEV_INIT).setValue(hyperState.levEff);
      props.setProperty(PROP_INIT_LEV_SOL, String(hyperState.levEff));
    }
  } else {
    inputs.getRange(INPUT_LEV_EFF).setValue("");
  }
}

// ======================
// METEORA LP (Render backend)
// ======================
function fetchLpAggregateFromRender_(positionIds) {
  let qSol = 0;
  let uUsdc = 0;
  let totalUsd = 0;
  let spot = null;

  if (!positionIds || !positionIds.length) {
    return { qSol: 0, uUsdc: 0, totalUsd: "", spot: "" };
  }

  for (const pid of positionIds) {
    const data = fetchJson_(`${LP_READER_BASE}/lp/${encodeURIComponent(pid)}`);
    if (!data || data.ok !== true) continue;

    const q = Number(data.q_sol);
    const u = Number(data.u_usdc);
    const t = Number(data.lp_total_usd);
    const s = Number(data.spot);

    if (Number.isFinite(q)) qSol += q;
    if (Number.isFinite(u)) uUsdc += u;
    if (Number.isFinite(t)) totalUsd += t;

    // pega spot do primeiro que vier válido
    if (!Number.isFinite(spot) && Number.isFinite(s)) spot = s;
  }

  return {
    qSol,
    uUsdc,
    totalUsd: Number.isFinite(totalUsd) ? totalUsd : "",
    spot: Number.isFinite(spot) ? spot : ""
  };
}

function fetchJson_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const txt = res.getContentText();
    return txt ? JSON.parse(txt) : null;
  } catch (e) {
    return null;
  }
}

function parseIds_(raw) {
  if (!raw) return [];
  return raw.split(/[\s,]+/g).map(s => s.trim()).filter(Boolean);
}

function isNum_(x) {
  return x !== null && x !== "" && Number.isFinite(Number(x));
}

// ======================
// TRIGGERS
// ======================
function create1minTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "updateFeeds") ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger("updateFeeds")
    .timeBased()
    .everyMinutes(1)
    .create();

  SpreadsheetApp.getUi().alert("Trigger de 1 min criado para updateFeeds.");
}

function listTriggers() {
  const ts = ScriptApp.getProjectTriggers();
  SpreadsheetApp.getUi().alert(
    ts.length
      ? "Triggers ativos:\n" + ts.map(t => t.getHandlerFunction()).join("\n")
      : "Nenhum trigger ativo."
  );
}

// ======================
// HYPERLIQUID
// ======================
function fetchHyperMid_(coin) {
  try {
    const url = "https://api.hyperliquid.xyz/info";
    const body = { type: "allMids" };
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const data = JSON.parse(res.getContentText());
    const px = Number(data[coin]);
    return Number.isFinite(px) ? px : null;
  } catch (e) {
    return null;
  }
}

function fetchHyperFundingRate_(coin) {
  try {
    const url = "https://api.hyperliquid.xyz/info";
    const body = { type: "metaAndAssetCtxs" };
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const data = JSON.parse(res.getContentText());
    const meta = data[0];
    const ctxs = data[1];

    const idx = meta.universe.findIndex(u => u.name === coin);
    if (idx < 0) return null;

    const fr = Number(ctxs[idx].funding ?? ctxs[idx].fundingRate ?? 0);
    return Number.isFinite(fr) ? fr : null;
  } catch (e) {
    return null;
  }
}

function fetchHyperPositionState_(userEvm, coin, hyperMid) {
  let posSolShort = 0;
  let entryPxSol = null;
  let levEff = null;
  let perpPnlUsd = null;
  let fundingUsdReal = null;

  if (!(userEvm && userEvm.startsWith("0x") && userEvm.length === 42)) {
    return { posSolShort, entryPxSol, levEff, perpPnlUsd, fundingUsdReal };
  }

  try {
    const url = "https://api.hyperliquid.xyz/info";
    const body = { type: "clearinghouseState", user: userEvm };
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const data = JSON.parse(res.getContentText());
    const positions = (data.assetPositions || []).map(x => x.position || x);
    const p = positions.find(x => x.coin === coin);

    if (!p) return { posSolShort, entryPxSol, levEff, perpPnlUsd, fundingUsdReal };

    const rawSize = Number(p.szi ?? p.size ?? p.positionSize ?? 0);
    const rawEntry = Number(p.entryPx ?? p.entry_px ?? p.entry ?? p.avgPx ?? NaN);

    posSolShort = Math.abs(rawSize);
    if (Number.isFinite(rawEntry) && rawEntry !== 0) entryPxSol = rawEntry;

    const rawLev = Number(p.leverage ?? p.lev ?? NaN);
    if (Number.isFinite(rawLev) && rawLev !== 0) {
      levEff = rawLev;
    } else {
      const notional = Number(p.positionValue ?? p.notional ?? p.notionalUsd ?? NaN);
      const margin = Number(p.marginUsed ?? p.margin ?? p.isolatedMargin ?? NaN);
      if (Number.isFinite(notional) && Number.isFinite(margin) && margin !== 0) {
        levEff = Math.abs(notional / margin);
      }
    }

    const pnlFromApi = Number(p.unrealizedPnl ?? p.pnl ?? p.upnl ?? p.unrealized ?? NaN);
    if (Number.isFinite(pnlFromApi)) {
      perpPnlUsd = pnlFromApi;
    } else if (posSolShort > 0 && entryPxSol !== null && Number.isFinite(hyperMid)) {
      perpPnlUsd = (entryPxSol - hyperMid) * posSolShort; // short
    }

    const fApi = Number(p.cumFunding ?? p.funding ?? p.unrealizedFunding ?? NaN);
    if (Number.isFinite(fApi)) fundingUsdReal = fApi;

  } catch (e) {}

  return { posSolShort, entryPxSol, levEff, perpPnlUsd, fundingUsdReal };
}
