// @ts-check
// 投資組合：核心–衛星架構儀表板
// 頁面順序：紀律檢查 → 幣別曝險 → IB現金流 → 交易摘要 → 持股曝險(區域) → 投資分層 → 持股佔比(圓環) → 持股表 → 願望清單 → CAPE → 投入vs市值 → 個股研究卡
import { api, view, byId, esc, moneyCur, todayStr, parseLocalDate, openForm, openInfo, openPrintWindow, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { CHART } from './theme.js';
import { icon } from './icons.js';
import { portfolioXirr } from './portfolio-calculations.js';
import { buildPortfolioModel } from './portfolio-model.js';
import { portfolioCaps, portfolioFreeze } from './portfolio-risk.js';
import { buildPortfolioReport } from './portfolio-report.js';
import {
  assetAccountDetailHtml,
  assetGoldDetailHtml,
  assetHoldingDetailHtml,
  costDetailHtml,
  tradesModalHtml
} from './portfolio-details.js';
import { incomeActivityHtml, INCOME_INFO, tradesActivityHtml } from './portfolio-activity.js';
import {
  companiesSection,
  disciplineSection,
  fxSection,
  holdingsDonut,
  layerSection,
  LAYERS,
  LAYER_ORDER,
  regionSection
} from './portfolio-visuals.js';
import { capeBodyHtml, capeInfoOf, signalsBodyHtml, SIGNALS_INFO_HTML } from './portfolio-valuation.js';
import { holdingsTableHtml, watchlistSectionHtml } from './portfolio-tables.js';
import { researchFormModel, researchSectionHtml } from './portfolio-research.js';
import {
  portfolioHeaderHtml,
  portfolioSummaryHtml,
  valuationPlaceholdersHtml,
  xirrSectionHtml,
  XIRR_INFO_HTML
} from './portfolio-overview.js';
import { investmentChartConfig } from './portfolio-chart.js';
import { portfolioQuoteSymbols, portfolioQuoteWritePlan } from './portfolio-quotes.js';
import {
  capeFormModel,
  fxBandsFormModel,
  holdingFormModel,
  holdingSubmission,
  signalsFormModel,
  watchFormModel
} from './portfolio-forms.js';

const fmtPct = (n, d = 1) => (Number(n) || 0).toFixed(d) + '%';
// 千（K）與萬：>=10 單位取整；<10 單位保留一位小數（2.4 K／6.5 萬）
const kNum = (n) => { const v = n / 1000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };
const wanNum = (n) => { const v = n / 10000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };

// 雙計價顯示：TWD（台幣計價，單位「萬」）或 USD（美元計價，單位「K」），記在 localStorage
let viewCur = localStorage.getItem('pf_viewCur') || 'TWD';
let usdRate = 32;
// 投資原則凍結名單（每次 render 重算；供「編輯持股」加碼警告用）
let FREEZE = { symbols: new Set(), regions: new Set(), equity: false };
const MONEY = (twd) => {   // 負號一律 U+2212（鐵則 5）
  const n = Number(twd || 0), sign = n < 0 ? '−' : '', v = Math.abs(n);
  return viewCur === 'USD' ? sign + kNum(v / usdRate) + ' K USD' : sign + wanNum(v) + ' 萬';
};
// app.js 與頁面模組互相 import；要到使用時才讀 esc，避免頂層循環 import 的 TDZ 白屏。
const detailFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY });
const activityOptions = () => ({ escapeHtml: esc, viewCurrency: viewCur, usdRate });
const visualFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent: fmtPct });
const tableFormatters = () => ({ escapeHtml: esc, formatMoney: MONEY, formatPercent: fmtPct });

let lineChart = null;

// 持股表排序（分組內排序，市值/損益/報酬率/佔比）
let hSortKey = localStorage.getItem('pf_hSortKey') || 'value';
let hSortDir = localStorage.getItem('pf_hSortDir') || 'desc';

export async function renderPortfolio() {
  const seq = currentRouteSeq();
  const [holdings, watchlist, research, settings, psnaps, accounts, ibTrades, summary] = await Promise.all([
    api('/holdings'), api('/watchlist'), api('/research'), api('/settings'), api('/portfolioSnapshots'), api('/accounts'), api('/ibTrades'), api('/summary')
  ]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別動 DOM/圖表（Codex r10#6）——初次渲染以前沒守，只有背景 ibSync 有守
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  const {
    fx, rows, total, totalCost, totalPnl,
    bondV, goldV, eqV, ibValTwd, loanTwd, netEquity, leverage,
    goldAll, cashV, allBase, stockRows, bondRows, goldRows,
    cashAccounts, goldAccounts, regionMap
  } = buildPortfolioModel(holdings, accounts, settings);
  usdRate = fx.USD;
  // 分層
  /** @type {Record<string, number>} */
  const layerV = {};
  rows.forEach(r => { const l = r.layer && LAYERS[r.layer] ? r.layer : 'satellite'; layerV[l] = (layerV[l] || 0) + r.valueTwd; });

  // QQQM 佔美股核心
  const vOf = (sym) => rows.filter(r => (r.symbol || '').toUpperCase() === sym).reduce((s, r) => s + r.valueTwd, 0);
  const qqqm = vOf('QQQM'), cspx = vOf('CSPX');
  const qqqmShare = (qqqm + cspx) > 0 ? qqqm / (qqqm + cspx) * 100 : 0;
  const qqqmMax = Number(settings.qqqmMaxPct || 30);

  // 投資原則（口徑 % 淨資產、穿透；軟上限）：上限值與凍結名單
  const netWorth = Number(summary?.netWorth || 0);
  const CAPS = portfolioCaps(settings);
  FREEZE = portfolioFreeze(rows, regionMap, eqV, netWorth, CAPS);

  // 資金加權年化報酬（XIRR）——資料齊了在此同步計算，直接嵌進模板
  const xr = portfolioXirr(psnaps, totalCost, total, ibTrades, fx.USD, parseLocalDate, settings);

  view().innerHTML = `
    ${portfolioHeaderHtml(viewCur)}
    ${portfolioSummaryHtml({ total, totalCost, totalPnl, eqV, bondV, cashV, goldAll, allBase, leverage, netEquity, loanTwd, levCap: CAPS.lev }, { formatMoney: MONEY })}

    ${disciplineSection(rows, regionMap, eqV, netWorth, leverage, CAPS, ibValTwd, loanTwd, visualFormatters())}
    ${fxSection(rows, accounts, fx, visualFormatters())}
    ${incomeActivityHtml(settings, activityOptions())}
    ${tradesActivityHtml(ibTrades, settings, activityOptions())}
    ${regionSection(regionMap, eqV, visualFormatters())}
    ${companiesSection(rows, eqV, visualFormatters())}
    ${layerSection(layerV, total, visualFormatters())}
    ${holdingsDonut(rows, total, visualFormatters())}
    ${holdingsTableHtml(rows, total, { sortKey: hSortKey, sortDir: hSortDir, formatters: tableFormatters() })}
    ${watchlistSectionHtml(watchlist, tableFormatters())}

    ${valuationPlaceholdersHtml()}
    ${xirrSectionHtml(xr, { escapeHtml: esc })}

    ${researchSectionHtml(rows, research, { escapeHtml: esc, formatPercent: fmtPct })}
  `;

  // ---- handlers ----
  byId('addHolding').onclick = () => openHoldingForm(null);
  byId('refreshQuotes').onclick = (e) => refreshQuotes(e.currentTarget, holdings, watchlist, settings);   // currentTarget＝按鈕本身（e.target 可能是內層圖示，disabled 會設錯對象，自主體檢）
  byId('printPortfolio').onclick = () => printPortfolioReport({
    rows, accounts, fx, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll,
    loanTwd, netEquity, leverage
  });
  byId('ibSync').onclick = async (/** @type {any} */ e) => {
    const seqAtStart = currentRouteSeq();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'IBKR 同步中…（最多約 15 秒）';
    try {
      const r = await api('/ib/sync', { method: 'POST' });
      const cashTxt = r.cash && Object.keys(r.cash).length
        ? '；現金 ' + Object.entries(r.cash).map(([c, v]) => moneyCur(v, c)).join('、') : '';
      toast(`IBKR 同步完成：更新 ${r.updated} 檔、新增 ${r.created} 檔${cashTxt}`);
      // 未支援幣別被跳過（系統僅支援 TWD/USD/GBP/JPY）→ 明確告知，不默默吞掉（看得見的退化）
      if (r.skippedCurrencies && r.skippedCurrencies.length) {
        toast(`注意：這些項目因幣別尚未支援而跳過：${r.skippedCurrencies.join('、')}`, true);
      }
      // 現金資料異常（Codex r5#7）：後端保留舊值/歸零時本來只寫 server console，前端卻無條件
      // 報「同步完成」＝使用者不知道淨值裡的 IB 現金可能是過期的。三種情況都要說出來：
      if (r.cashReportMissing) {
        toast('注意：這份報表沒有 Cash Report 區塊——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Flex Query 有勾 Cash Report。', true);
      }
      if (r.cashDetailMissing) {
        toast('注意：Cash Report 只有彙總列、且無法判定基準幣別——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 的 Flex Query 勾選 Account Information。', true);
      }
      if (r.cashFromSummary) {
        toast('說明：這份報表的現金只有彙總列——已用基準幣別總額入帳' + (r.cashCollapsed ? `（${r.cashCollapsed} 個其他幣別帳戶已併入彙總顯示）` : '') + '。');
      }
      if (r.cashBaseUnsupported) {
        toast(`注意：報表現金只有彙總列、且基準幣別 ${r.cashBaseUnsupported} 尚未支援——IB 現金沿用上次的舊值（可能過期）。`, true);
      }
      if (r.cashDetailIncomplete) {
        toast('注意：部分幣別的現金金額讀不到——讀得到的已更新，讀不到的沿用舊值（不歸零）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。', true);
      }
      if (r.cashSummaryMissing) {
        toast('注意：報表現金只有彙總列、且彙總列沒有可用金額——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。', true);
      }
      if (r.cashZeroed) {
        toast(`提醒：${r.cashZeroed} 個 IB 現金帳戶這次報表已無該幣別，餘額已歸零（現金提領/轉走後的正常結果）。`);
      }
      // IBKR 報表中已消失的持股（可能已出清）→ 確認後移除
      if (r.missing && r.missing.length) {
        const names = r.missing.map(m => m.symbol).join('、');
        if (confirm(`這些持股在 IBKR 報表中已找不到（可能已出清）：\n\n${names}\n\n要從投資組合移除嗎？`)) {
          for (const m of r.missing) await api('/holdings/' + m.id, { method: 'DELETE' });
          toast(`已移除 ${r.missing.length} 檔已出清持股`);
        }
      }
      if (seqAtStart === currentRouteSeq()) renderPortfolio();   // 同步期間可能切走了頁（自主體檢）
    } catch (err) {
      toast('IBKR 同步失敗：' + err.message, true);
      btn.disabled = false; btn.innerHTML = icon('download', 16) + 'IBKR 同步';
    }
  };
  view().querySelectorAll('.fee-tog[data-cur]').forEach(t => t.onclick = () => {
    if (viewCur !== t.dataset.cur) { viewCur = t.dataset.cur; try { localStorage.setItem('pf_viewCur', viewCur); } catch {} renderPortfolio(); }
  });
  view().querySelectorAll('th[data-hsort]').forEach(th => th.onclick = () => {
    const k = th.dataset.hsort;
    if (hSortKey === k) hSortDir = hSortDir === 'asc' ? 'desc' : 'asc';
    else { hSortKey = k; hSortDir = 'desc'; }
    try { localStorage.setItem('pf_hSortKey', hSortKey); localStorage.setItem('pf_hSortDir', hSortDir); } catch {}
    renderPortfolio();
  });
  // ⏸ 休眠中：#fxBandEdit 只有在 fxGaugeSection（目前停放、未插入頁面）渲染時才存在；
  //   等匯率儀表決定放回頁面時，這段與 openFxBands() 一起恢復作用。
  //   註：fxHigh/fxLow 的「調整入口」現已改由設定頁「提醒門檻」管理（換匯提醒即時生效），
  //   停放的 openFxBands 若日後恢復，屬儀表上的便捷入口、非唯一調整途徑。
  const fxEdit = byId('fxBandEdit');
  if (fxEdit) fxEdit.onclick = () => openFxBands(settings);
  view().querySelectorAll('.info-link[data-info]').forEach(b => b.onclick = () => {
    const info = INCOME_INFO[b.dataset.info];
    if (info) openInfo(info[0], info[1]);
  });
  const tradesFullBtn = byId('tradesFull');
  if (tradesFullBtn) tradesFullBtn.onclick = () => openInfo('完整交易明細', tradesModalHtml(ibTrades, { escapeHtml: esc }), { size: 'xl' });
  const totalValueInfo = byId('totalValueInfo');
  if (totalValueInfo) totalValueInfo.onclick = () => openInfo('總市值', `
    <p><b>總市值 ＝ 股票市值 + 債券市值 + 黃金市值</b></p>
    <p style="font-family:var(--serif);font-size:20px;margin-top:10px">${MONEY(total)} ＝ 股票 ${MONEY(eqV)} + 債券 ${MONEY(bondV)} + 黃金 ${MONEY(goldV)}</p>
    <p class="muted small" style="margin-top:10px">這裡只計算投資持股市值，不包含現金，也不扣除融資。</p>
  `, { size: 'md' });
  const totalCostInfo = byId('totalCostInfo');
  if (totalCostInfo) totalCostInfo.onclick = () => openInfo('成本', costDetailHtml(rows, totalCost, detailFormatters()), { size: 'sm' });
  const assetStockInfo = byId('assetStockInfo');
  if (assetStockInfo) assetStockInfo.onclick = () => openInfo('股票', assetHoldingDetailHtml('股票', stockRows, eqV, allBase, detailFormatters()), { size: 'sm' });
  const assetBondInfo = byId('assetBondInfo');
  if (assetBondInfo) assetBondInfo.onclick = () => openInfo('債券', assetHoldingDetailHtml('債券', bondRows, bondV, allBase, detailFormatters()), { size: 'sm' });
  const assetCashInfo = byId('assetCashInfo');
  if (assetCashInfo) assetCashInfo.onclick = () => openInfo('現金', assetAccountDetailHtml('現金', cashAccounts, cashV, detailFormatters()), { size: 'sm' });
  const assetGoldInfo = byId('assetGoldInfo');
  if (assetGoldInfo) assetGoldInfo.onclick = () => openInfo('黃金', assetGoldDetailHtml(goldRows, goldAccounts, goldAll, allBase, detailFormatters()), { size: 'sm' });
  const xInfo = byId('xirrInfo');
  if (xInfo) xInfo.onclick = () => openInfo('年化報酬（XIRR）', XIRR_INFO_HTML, { size: 'md' });
  const dInfo = byId('disciplineInfo');
  if (dInfo) dInfo.onclick = () => openInfo('紀律檢查', `
    <p><b>口徑</b>：所有上限以「<b>% 淨資產</b>」衡量（不是投組市值——有融資時淨資產較小，規則自動更嚴格）。國家曝險採<b>穿透</b>計算：ETF 內含成分（如 EIMI 裡的中國、台灣）都拆進對應國家一起計。</p>
    <p><b>軟上限</b>：超標＝<b>凍結加碼</b>（禁止再買進），但不強制賣出，讓部位隨時間自然稀釋。在「編輯持股」把凍結中的標的加碼時，會跳出確認提醒。</p>
    <p><b>怎麼看圖</b>：黑色刻度＝上限位置；長條＝目前部位，<span style="color:var(--pos)">綠色</span>＝上限內、<span style="color:var(--neg)">紅色</span>＝超出上限的部分。</p>
    <p><b>目前上限</b>：單一個股 ${CAPS.stock}%・股票總曝險 ${CAPS.equity}%・單一國家 ${CAPS.country}%（中國 ${CAPS.china}%）・IB 融資槓桿 ${CAPS.lev}x（<b>任何時期適用</b>；估值訊號期加碼只用新資金與現金，不舉新債）。到「設定 → 投資原則」即可調整。</p>
    <p><b>斷頭距離</b>：市場跌時借款不會跟著縮水，跌到「淨值 ÷ 持倉」低於 IB 維持保證金率（${CAPS.maint}%，設定頁可調）的那一刻，IB 會<b>即時自動強制平倉，不打電話、無寬限期</b>。這個數字＝從現在起市場還能跌多少。它是假設全部持倉維持率一致的近似值；IB 在危機時會調高維持率（2020 年 3 月發生過），所以旁邊附了壓力情境。最高指導原則：<b>要一個在所有環境都活著的系統，而不是在多數環境賺更多的系統</b>。</p>`);
  view().querySelectorAll('[data-edit-h]').forEach(b => b.onclick = () => openHoldingForm(holdings.find(h => h.id === b.dataset.editH)));
  view().querySelectorAll('[data-del-h]').forEach(b => b.onclick = () => {
    const h = holdings.find(x => x.id === b.dataset.delH);
    confirmDelete(h.symbol, () => api('/holdings/' + h.id, { method: 'DELETE' }));
  });
  const addW = byId('addWatch');
  if (addW) addW.onclick = () => openWatchForm(null);
  view().querySelectorAll('[data-edit-w]').forEach(b => b.onclick = () => openWatchForm(watchlist.find(w => w.id === b.dataset.editW)));
  view().querySelectorAll('[data-del-w]').forEach(b => b.onclick = () => {
    const w = watchlist.find(x => x.id === b.dataset.delW);
    confirmDelete(w.symbol, () => api('/watchlist/' + w.id, { method: 'DELETE' }));
  });
  view().querySelectorAll('[data-edit-r]').forEach(b => b.onclick = () => openResearchForm(b.dataset.editR, research));
  view().querySelectorAll('[data-add-cp]').forEach(b => b.onclick = () => addCheckpoint(b.dataset.addCp, research));

  drawInvestChart(psnaps, totalCost, total);
  loadCape(settings, qqqmShare, qqqmMax);
  loadSignals(settings);
  const sInfo = byId('signalsInfo');
  if (sInfo) sInfo.onclick = () => openInfo('估值訊號儀表', SIGNALS_INFO_HTML, { size: 'md' });
  const sEdit = byId('signalsEdit');
  if (sEdit) sEdit.onclick = () => openSignalsForm(settings);
}

// ---- 美元/台幣匯率儀表（暫時從頁面移除，之後再決定位置；要放回頁面時把 ${fxGaugeSection(fx, settings)} 插進 render 即可）----
// eslint-disable-next-line no-unused-vars -- 刻意停放（見上行註解），要恢復時插回 render 即可
function fxGaugeSection(fx, settings) {
  const lo = Number(settings.fxLow || 28), hi = Number(settings.fxHigh || 32);
  const MIN = 26, MAX = 34;
  const rate = fx.USD;
  const marker = Math.min(Math.max(rate, MIN), MAX);
  const seg = (a, b) => ((b - a) / (MAX - MIN) * 100).toFixed(1);
  const pos = (x) => ((x - MIN) / (MAX - MIN) * 100).toFixed(1);   // 匯率值 → 軸上百分比位置
  return `<div class="chart-card" style="margin-bottom:16px">
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <span class="muted" style="font-size:12.5px">美元／台幣</span>
      <span class="stat sm">${rate.toFixed(2)}</span>
      <button class="btn-link btn-sm" id="fxBandEdit">區間調整</button>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">
        <div style="width:${seg(MIN, lo)}%;background:${CHART.blue};opacity:.55"></div>
        <div style="width:${seg(lo, hi)}%;background:#bdb8ab;opacity:.55"></div>
        <div style="width:${seg(hi, MAX)}%;background:${CHART.green};opacity:.55"></div>
        <div class="gauge-marker" style="left:${((marker - MIN) / (MAX - MIN) * 100).toFixed(1)}%"></div>
      </div>
      <div class="fx-scale">
        <span class="fx-num fx-end-l">${MIN}</span>
        <span class="fx-num" style="left:${pos(lo)}%">${lo}</span>
        <span class="fx-num" style="left:${pos(hi)}%">${hi}</span>
        <span class="fx-num fx-end-r">${MAX}</span>
        <span class="fx-zone" style="left:${pos((MIN + lo) / 2)}%">（換美元區）</span>
        <span class="fx-zone" style="left:${pos((hi + MAX) / 2)}%">（換台幣區）</span>
      </div>
    </div>
  </div>`;
}

// ⏸ 休眠中：只被停放的 fxGaugeSection 的「區間調整」鈕呼叫；隨儀表一起恢復。
function openFxBands(settings) {
  const form = fxBandsFormModel(settings);
  openForm({
    ...form,
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { fxLow: Number(data.fxLow), fxHigh: Number(data.fxHigh) } });
      toast('已更新換匯區間'); renderPortfolio();
    }
  });
}

async function loadSignals(settings) {
  const body = byId('signalsBody');
  if (!body) return;
  let cape = null, ry = null;
  try { [cape, ry] = await Promise.all([api('/cape'), api('/realyield')]); } catch {}
  body.innerHTML = signalsBodyHtml(settings, cape, ry, { escapeHtml: esc });
}

function openSignalsForm(settings) {
  const form = signalsFormModel(settings);
  openForm({
    ...form,
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { signals: { ...form.values, ...data } } });
      toast('估值訊號已更新'); renderPortfolio();
    }
  });
}

// ---- ③ CAPE 儀表 ----
async function loadCape(settings, qqqmShare, qqqmMax) {
  let cape = null;
  try { cape = await api('/cape'); } catch {}
  const body = byId('capeBody');
  if (!body) return;
  body.innerHTML = capeBodyHtml(cape, qqqmShare, qqqmMax, { escapeHtml: esc, formatPercent: fmtPct });
  const b = byId('capeManualBtn');
  if (b) b.onclick = () => openCapeManual(settings);
}

function openCapeManual(settings) {
  const form = capeFormModel(settings);
  openForm({
    ...form,
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { capeManual: data.capeManual } });
      toast('已更新 CAPE 手動值'); renderPortfolio();
    }
  });
}

// ---- ⑥ 投入 vs 市值 ----
function drawInvestChart(psnaps, curCost, curValue) {
  const ctx = byId('investChart');
  if (!ctx) return;
  lineChart = new Chart(ctx, investmentChartConfig(psnaps, curCost, curValue, {
    viewCurrency: viewCur,
    usdRate,
    formatK: kNum,
    formatWan: wanNum
  }));
}

async function addCheckpoint(symbol, research) {
  const input = byId('cp_' + symbol);
  const note = (input?.value || '').trim();
  if (!note) return toast('先輸入筆記內容', true);
  const r = research.find(x => (x.symbol || '').toUpperCase() === symbol.toUpperCase());
  const cp = { date: todayStr(), note };
  try {
    if (r) await api('/research/' + r.id, { method: 'PUT', body: { checkpoints: [...(r.checkpoints || []), cp] } });
    else await api('/research', { method: 'POST', body: { symbol, thesis: '', metrics: '', risks: '', checkpoints: [cp] } });
    toast('已記錄檢查點'); renderPortfolio();
  } catch (e) { toast(e.message, true); }
}

function openResearchForm(symbol, research) {
  const form = researchFormModel(symbol, research);
  openForm({
    title: form.title,
    fields: form.fields,
    values: form.values,
    onSubmit: async (data) => {
      if (form.existing) await api('/research/' + form.existing.id, { method: 'PUT', body: data });
      else await api('/research', { method: 'POST', body: { symbol, ...data, checkpoints: [] } });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 表單：持股 / 願望清單 ----
function openHoldingForm(h) {
  const form = holdingFormModel(h, LAYERS, LAYER_ORDER);
  openForm({
    ...form,
    onSubmit: async (data) => {
      // 投資原則：凍結名單加碼警告（軟上限——確認後仍可儲存；減碼/改備註不受影響）
      const submission = holdingSubmission(h, data, FREEZE);
      if (submission.freezeReasons.length && !window.confirm(`⚠️ ${submission.symbol} 目前凍結加碼（超過：${submission.freezeReasons.join('、')}）。\n依投資原則不應加碼，確定仍要儲存？`)) {
        throw new Error('已取消：該標的凍結加碼中');
      }
      if (h) await api('/holdings/' + h.id, { method: 'PUT', body: submission.body });
      else await api('/holdings', { method: 'POST', body: submission.body });
      toast('已儲存'); renderPortfolio();
    }
  });
}

function openWatchForm(w) {
  const form = watchFormModel(w);
  openForm({
    ...form,
    onSubmit: async (data) => {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: data });
      else await api('/watchlist', { method: 'POST', body: data });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 更新報價（持股＋願望清單共用）----
async function refreshQuotes(btn, holdings, watchlist, settings) {
  const seqAtStart = currentRouteSeq();
  const syms = portfolioQuoteSymbols(holdings, watchlist);
  if (!syms.length) return toast('沒有可更新的報價代號', true);
  btn.disabled = true; btn.textContent = '更新中…';
  try {
    const quotes = await api('/quotes?symbols=' + encodeURIComponent(syms.join(',')));
    const plan = portfolioQuoteWritePlan(holdings, watchlist, settings, quotes);
    if (plan.saveFx) await api('/settings', { method: 'PUT', body: plan.fxBody });
    for (const write of plan.holdingWrites) await api('/holdings/' + write.id, { method: 'PUT', body: write.body });
    for (const write of plan.watchWrites) await api('/watchlist/' + write.id, { method: 'PUT', body: { ...write.body, lastAt: todayStr() } });
    toast(`已更新 ${plan.updatedHoldings} 檔報價與匯率${plan.skippedHoldings ? `，${plan.skippedHoldings} 檔略過（無資料或幣別不符）` : ''}`);
    if (seqAtStart === currentRouteSeq()) renderPortfolio();   // 更新期間可能切走了頁（自主體檢）
  } catch (e) {
    toast('更新失敗：' + e.message, true);
    btn.disabled = false; btn.innerHTML = icon('refresh', 16) + '更新報價';
  }
}

// ---- 列印報表：投資組合（跟隨目前計價：台幣→元/萬、美元→USD/K，A4）----
async function printPortfolioReport(data) {
  let cape = null;
  try { cape = await api('/cape'); } catch {}
  const capeInfo = capeInfoOf(cape);
  const report = buildPortfolioReport({ ...data, capeInfo }, {
    viewCurrency: viewCur,
    generated: todayStr(),
    sortKey: hSortKey,
    sortDir: hSortDir,
    layers: LAYERS,
    layerOrder: LAYER_ORDER,
    escapeHtml: esc
  });
  openPrintWindow(report.title, report.extraCss, report.html);
}
