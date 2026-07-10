// 投資組合：核心–衛星架構儀表板
// ② 穿透式區域曝險 → ① 分層配置＋上限 → 持股表 → ④ 願望清單 → ③ CAPE → ⑥ 投入vs市值 → ⑤ 研究卡
import { api, view, esc, todayStr, openForm, openInfo, confirmDelete, toast } from '../app.js';
import { CHART, AXIS, GRID } from './theme.js';
import { icon } from './icons.js';

const fmtPct = (n, d = 1) => (Number(n) || 0).toFixed(d) + '%';
const fmtPrice = (p, cur) => Number(p || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + (cur || '');
// 表格用價格：整數；單價 <10 保留一位小數（例：5.4 USD）
const fmtPrice0 = (p, cur) => {
  const n = Number(p || 0);
  const s = Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US');
  return s + ' ' + (cur || '');
};
// 千（K）與萬：>=10 單位取整；<10 單位保留一位小數（2.4 K／6.5 萬）
const kNum = (n) => { const v = n / 1000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };
const wanNum = (n) => { const v = n / 10000; return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1); };

// ---- 幣別 ----
const CURRENCIES = ['USD', 'TWD', 'GBP', 'JPY'];
const CUR_COLOR = { USD: CHART.blue, TWD: CHART.green, GBP: CHART.brown, JPY: CHART.yellow };
const fxTable = (settings) => ({
  TWD: 1,
  USD: Number(settings.usdTwd || 32),
  GBP: Number(settings.fxTwd?.GBP || 40.8),
  JPY: Number(settings.fxTwd?.JPY || 0.215)
});
// 成本＝均價 × 股數（舊資料退回總成本欄位）
const holdingCost = (h) => (h.avgCost != null && h.avgCost !== '') ? Number(h.avgCost) * Number(h.quantity || 0) : Number(h.cost || 0);

// 雙計價顯示：TWD（台幣計價，單位「萬」）或 USD（美元計價，單位「K」），記在 localStorage
let viewCur = localStorage.getItem('pf_viewCur') || 'TWD';
let usdRate = 32;
// 投資原則凍結名單（每次 render 重算；供「編輯持股」加碼警告用）
let FREEZE = { symbols: new Set(), regions: new Set(), equity: false };
const MONEY = (twd) => viewCur === 'USD'
  ? kNum(Number(twd || 0) / usdRate) + ' K USD'
  : wanNum(Number(twd || 0)) + ' 萬';

// ---- 分層（核心–衛星）與目標區間 ----
const LAYERS = {
  core:      { label: '核心（美股）', color: CHART.blue,   min: 45, max: 65 },
  satellite: { label: '衛星',         color: CHART.yellow, min: 8,  max: 20 },
  bond:      { label: '債券',         color: CHART.green,  min: 15, max: 30 },
  gold:      { label: '黃金',         color: CHART.brown,  min: 0,  max: 10 },
  stock:     { label: '個股',         color: CHART.orange, min: 0,  max: 20 }
};
const LAYER_ORDER = ['core', 'satellite', 'stock', 'bond', 'gold'];

// ---- ETF 成分穿透（近似權重；可隨基金年報更新）----
const REGION_COLOR = { '美國': CHART.blue, '中國': CHART.red, '日本': CHART.yellow, '韓國': CHART.brown, '台灣': CHART.green, '印度': CHART.orange, '其他': CHART.gray };
const COMPOSITION = {
  CSPX:   { type: 'equity', regions: { 美國: 1 } },
  QQQM:   { type: 'equity', regions: { 美國: 1 } },
  GOOGL:  { type: 'equity', regions: { 美國: 1 } },
  AAPL:   { type: 'equity', regions: { 美國: 1 } },
  TSLA:   { type: 'equity', regions: { 美國: 1 } },
  SPACEX: { type: 'equity', regions: { 美國: 1 } },
  EIMI:   { type: 'equity', regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 } },
  XUSE:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  ICHN:   { type: 'equity', regions: { 中國: 1 } },
  KWEB:   { type: 'equity', regions: { 中國: 1 } },
  CSKR:   { type: 'equity', regions: { 韓國: 1 } },
  SJPA:   { type: 'equity', regions: { 日本: 1 } },
  '0050':   { type: 'equity', regions: { 台灣: 1 } },
  '006208': { type: 'equity', regions: { 台灣: 1 } },
  SMH:      { type: 'equity', regions: { 美國: 1 } },
  SPCX:     { type: 'equity', regions: { 美國: 1 } },
  SGLD:     { type: 'gold', regions: {} },
  '00719B': { type: 'bond', regions: {} },
  '00720B': { type: 'bond', regions: {} }
};
const compOf = (h) => COMPOSITION[(h.symbol || '').toUpperCase()]
  || { type: h.layer === 'bond' ? 'bond' : h.layer === 'gold' ? 'gold' : 'equity', regions: { 其他: 1 } };

// ---- CAPE 歷史分位（1881 起月資料的近似分位數）與規則帶 ----
const CAPE_PCT = [[4.8, 0], [9.6, 10], [11.6, 20], [13.7, 30], [15.5, 40], [16.9, 50], [18.9, 60], [21.2, 70], [24.4, 80], [28.4, 90], [32, 95], [44.2, 100]];
function capePercentile(v) {
  if (v <= CAPE_PCT[0][0]) return 0;
  for (let i = 1; i < CAPE_PCT.length; i++) {
    if (v <= CAPE_PCT[i][0]) {
      const [x0, y0] = CAPE_PCT[i - 1], [x1, y1] = CAPE_PCT[i];
      return y0 + (v - x0) / (x1 - x0) * (y1 - y0);
    }
  }
  return 100;
}
const CAPE_MIN = 5, CAPE_MAX = 45;
const CAPE_BANDS = [
  { from: CAPE_MIN, to: 20, color: CHART.green, label: '偏低—可依紀律加碼 QQQM' },
  { from: 20, to: 28, color: CHART.yellow, label: '中性—定期定額為主' },
  { from: 28, to: 33, color: CHART.orange, label: '偏高—節制 QQQM，新資金以 CSPX／債券為主' },
  { from: 33, to: CAPE_MAX, color: CHART.red, label: '歷史高檔—不加碼 QQQM' }
];

let lineChart = null;

// 持股表排序（分組內排序，市值/損益/報酬率/佔比）
let hSortKey = localStorage.getItem('pf_hSortKey') || 'value';
let hSortDir = localStorage.getItem('pf_hSortDir') || 'desc';
const H_SORTERS = {
  value: (a, b) => a.valueTwd - b.valueTwd,
  pnl: (a, b) => a.pnlTwd - b.pnlTwd,
  ret: (a, b) => (a.costTwd ? a.pnlTwd / a.costTwd : 0) - (b.costTwd ? b.pnlTwd / b.costTwd : 0),
  weight: (a, b) => a.valueTwd - b.valueTwd
};
function hTri(key) {
  if (hSortKey === key) return `<span class="sort-tri active">${hSortDir === 'asc' ? '▲' : '▼'}</span>`;
  return `<span class="sort-tri">▾</span>`;
}

export async function renderPortfolio() {
  const [holdings, watchlist, research, settings, psnaps, accounts, ibTrades, summary] = await Promise.all([
    api('/holdings'), api('/watchlist'), api('/research'), api('/settings'), api('/portfolioSnapshots'), api('/accounts'), api('/ibTrades'), api('/summary')
  ]);
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  const fx = fxTable(settings);
  usdRate = fx.USD;

  const rows = holdings.map(h => {
    const r = fx[h.currency || 'USD'] || fx.USD;
    const valueTwd = Number(h.price || 0) * Number(h.quantity || 0) * r;
    const costTwd = holdingCost(h) * r;
    return { ...h, valueTwd, costTwd, pnlTwd: valueTwd - costTwd };
  });
  const total = rows.reduce((s, r) => s + r.valueTwd, 0);
  const totalCost = rows.reduce((s, r) => s + r.costTwd, 0);
  const totalPnl = total - totalCost;

  // 股/債/現/金（持股依成分表；現金與黃金存摺來自帳戶）
  const bondV = rows.filter(r => compOf(r).type === 'bond').reduce((s, r) => s + r.valueTwd, 0);
  const goldV = rows.filter(r => compOf(r).type === 'gold').reduce((s, r) => s + r.valueTwd, 0);
  const eqV = total - bondV - goldV;
  const accTwd = (a) => Number(a.balance || 0) * (fx[a.currency || 'TWD'] || 1);
  // 融資槓桿只看 IBKR：IB 持倉 ÷ IB 淨值；融資＝IB 現金帳戶(ibCashCur)負餘額。
  // 排除台新現金存款與台新證券的台股，避免灌大或稀釋槓桿。
  const ibValTwd = rows.filter(r => r.source === 'ib').reduce((s, r) => s + r.valueTwd, 0);
  const negCashTwd = (accounts || []).filter(a => a.ibCashCur).reduce((s, a) => { const v = accTwd(a); return v < 0 ? s + v : s; }, 0);
  const loanTwd = -negCashTwd;
  const netEquity = ibValTwd + negCashTwd;
  const leverage = loanTwd > 0 && netEquity > 0 ? ibValTwd / netEquity : 1;
  const goldAccV = (accounts || []).filter(a => Number(a.balance) > 0 && a.class === '黃金').reduce((s, a) => s + accTwd(a), 0);
  const goldAll = goldV + goldAccV;
  // 現金：正餘額的現金帳戶（type=cash 或 class=現金，排除黃金；融資負餘額不計）
  const cashV = (accounts || []).filter(a => Number(a.balance) > 0 && a.class !== '黃金' && (a.type === 'cash' || a.class === '現金')).reduce((s, a) => s + accTwd(a), 0);
  const allBase = eqV + bondV + cashV + goldAll;   // 股 / 債 / 現金 / 黃金
  const shr = (v) => allBase ? Math.round(v / allBase * 100) : 0;
  const stockRows = rows.filter(r => compOf(r).type === 'equity');
  const bondRows = rows.filter(r => compOf(r).type === 'bond');
  const goldRows = rows.filter(r => compOf(r).type === 'gold');
  const cashAccounts = (accounts || [])
    .filter(a => Number(a.balance) > 0 && a.class !== '黃金' && (a.type === 'cash' || a.class === '現金'))
    .map(a => ({ ...a, valueTwd: accTwd(a) }));
  const goldAccounts = (accounts || [])
    .filter(a => Number(a.balance) > 0 && a.class === '黃金')
    .map(a => ({ ...a, valueTwd: accTwd(a) }));

  // 穿透式區域曝險（僅股票部位）
  const regionMap = {};
  rows.forEach(r => {
    const c = compOf(r);
    if (c.type !== 'equity') return;
    for (const [reg, w] of Object.entries(c.regions)) regionMap[reg] = (regionMap[reg] || 0) + r.valueTwd * w;
  });

  // 分層
  const layerV = {};
  rows.forEach(r => { const l = LAYERS[r.layer] ? r.layer : 'satellite'; layerV[l] = (layerV[l] || 0) + r.valueTwd; });

  // QQQM 佔美股核心
  const vOf = (sym) => rows.filter(r => (r.symbol || '').toUpperCase() === sym).reduce((s, r) => s + r.valueTwd, 0);
  const qqqm = vOf('QQQM'), cspx = vOf('CSPX');
  const qqqmShare = (qqqm + cspx) > 0 ? qqqm / (qqqm + cspx) * 100 : 0;
  const qqqmMax = Number(settings.qqqmMaxPct || 30);

  // 投資原則（口徑 % 淨資產、穿透；軟上限）：上限值與凍結名單
  const netWorth = Number(summary?.netWorth || 0);
  const CAPS = {
    stock: Number(settings.ibConcentrationPct ?? 5),
    equity: Number(settings.equityCapPct ?? 90),
    country: Number(settings.countryCapPct ?? 15),
    china: Number(settings.chinaCapPct ?? settings.countryCapPct ?? 15),
    lev: Number(settings.levCapPct ?? 1.3),
    levSig: Number(settings.levCapSignalPct ?? 1.6)
  };
  const capForRegion = (rg) => rg === '中國' ? CAPS.china : CAPS.country;
  FREEZE = { symbols: new Set(), regions: new Set(), equity: false };
  if (netWorth > 0) {
    rows.filter(r => r.layer === 'stock' && r.valueTwd / netWorth * 100 > CAPS.stock)
      .forEach(r => FREEZE.symbols.add(String(r.symbol || '').toUpperCase()));
    for (const [rg, v] of Object.entries(regionMap)) {
      if (rg === '美國' || rg === '其他') continue;
      if (v / netWorth * 100 > capForRegion(rg)) FREEZE.regions.add(rg);
    }
    FREEZE.equity = eqV / netWorth * 100 > CAPS.equity;
  }

  view().innerHTML = `
    <div class="page-head">
      <div><h1>投資組合</h1><p>核心–衛星架構：掌握配置、留意風險、等待機會。</p></div>
      <div class="page-actions">
        <span class="muted" style="font-size:12px">計價
          <span class="fee-tog ${viewCur === 'TWD' ? 'on' : ''}" data-cur="TWD">NT</span><span class="muted">/</span><span class="fee-tog ${viewCur === 'USD' ? 'on' : ''}" data-cur="USD">US</span>
        </span>
        <button class="btn-ghost icon-btn" id="printPortfolio" title="列印 / 匯出 PDF（依目前計價輸出）" aria-label="列印 / 匯出 PDF">${icon('print', 16)}</button>
        <button class="btn-ghost" id="ibSync" title="從 IBKR Flex Query 同步持倉與現金（唯讀）">${icon('download', 16)}IBKR 同步</button>
        <button class="btn-ghost" id="refreshQuotes">${icon('refresh', 16)}更新報價</button>
        <button class="btn" id="addHolding">${icon('plus', 16)}新增持股</button>
      </div>
    </div>

    <div class="cards" style="margin-bottom:18px">
      <div class="card"><h3><button type="button" class="info-link" id="totalValueInfo">總市值</button></h3><div class="stat sm">${MONEY(total)}</div><div class="stat-sub"><button type="button" class="info-link" id="totalCostInfo">成本</button> ${MONEY(totalCost)}｜<span class="${totalPnl >= 0 ? 'pos' : 'neg'}" style="font-weight:700">未實現損益 ${totalPnl >= 0 ? '+' : ''}${MONEY(totalPnl)}</span></div></div>
      <div class="card"><h3><button type="button" class="info-link" id="assetStockInfo">股票</button> / <button type="button" class="info-link" id="assetBondInfo">債券</button> / <button type="button" class="info-link" id="assetCashInfo">現金</button> / <button type="button" class="info-link" id="assetGoldInfo">黃金</button></h3><div class="stat sm">${shr(eqV)} / ${shr(bondV)} / ${shr(cashV)} / ${shr(goldAll)}</div>
        <div class="stat-sub">含黃金存摺與現金</div>
        <div class="split-bar"><div style="width:${allBase ? eqV / allBase * 100 : 0}%;background:${CHART.blue}"></div><div style="width:${allBase ? bondV / allBase * 100 : 0}%;background:${CHART.green}"></div><div style="width:${allBase ? cashV / allBase * 100 : 0}%;background:${CHART.gray}"></div><div style="flex:1;background:${CHART.brown}"></div></div></div>
      <div class="card"><h3>IB 融資槓桿</h3><div class="stat sm ${leverage >= 1.6 ? 'neg' : ''}">${leverage.toFixed(2)} 倍</div>
        <div class="stat-sub">IB 淨值 ${MONEY(netEquity)}｜<span class="neg" style="font-weight:700">IB 融資 ${MONEY(loanTwd)}</span></div>
        <div class="mini-bar"><div style="width:${Math.min((leverage - 1) * 100, 100)}%;background:${leverage > CAPS.levSig ? CHART.red : leverage > CAPS.lev ? CHART.orange : CHART.green}"></div></div></div>
    </div>

    ${disciplineSection(rows, regionMap, eqV, netWorth, leverage, CAPS)}
    ${fxSection(rows, accounts, fx)}
    ${incomeSection(settings)}
    ${tradesSection(ibTrades, settings)}
    ${regionSection(regionMap, eqV)}
    ${layerSection(layerV, total)}
    ${holdingsDonut(rows, total)}
    ${holdingsTable(rows, total)}
    ${watchlistSection(watchlist)}

    <div class="chart-card" style="margin-bottom:16px" id="capeCard">
      <h3>Shiller PE（CAPE）估值儀表 <span class="stat-sub" style="font-weight:400;margin:0">（CSPX ⇄ QQQM 輪動的紀律閘門）</span></h3>
      <div id="capeBody"><p class="muted small" style="margin-top:8px">讀取中…</p></div>
    </div>

    <div class="chart-card" style="margin-bottom:16px">
      <h3>投入 vs 市值 <span class="stat-sub" style="font-weight:400;margin:0">（每月快照，按左下「記錄本月快照」累積）</span></h3>
      <div class="chart-box" style="height:240px"><canvas id="investChart"></canvas></div>
      <p class="muted small" style="margin-top:8px">兩線的差距＝未實現損益。市值線的波動是市場的事；投入線持續墊高，才是你能控制的事。（精確 XIRR 需逐筆交易紀錄，之後接 IB 匯入再補上）</p>
    </div>

    <div class="section-title">個股研究卡</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr));margin-bottom:8px">
      ${rows.filter(r => r.layer === 'stock').map(r => researchCard(r, research)).join('') || '<div class="empty">尚無個股研究卡——把持股的「層」設為「個股」即可出現。</div>'}
    </div>
  `;

  // ---- handlers ----
  document.getElementById('addHolding').onclick = () => openHoldingForm(null);
  document.getElementById('refreshQuotes').onclick = (e) => refreshQuotes(e.target, holdings, watchlist, settings);
  document.getElementById('printPortfolio').onclick = () => printPortfolioReport({
    rows, accounts, fx, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll,
    loanTwd, netEquity, leverage
  });
  document.getElementById('ibSync').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'IBKR 同步中…（最多約 15 秒）';
    try {
      const r = await api('/ib/sync', { method: 'POST' });
      const cashTxt = r.cash && Object.keys(r.cash).length
        ? '；現金 ' + Object.entries(r.cash).map(([c, v]) => `${Math.round(v).toLocaleString('en-US')} ${c}`).join('、') : '';
      toast(`IBKR 同步完成：更新 ${r.updated} 檔、新增 ${r.created} 檔${cashTxt}`);
      // IBKR 報表中已消失的持股（可能已出清）→ 確認後移除
      if (r.missing && r.missing.length) {
        const names = r.missing.map(m => m.symbol).join('、');
        if (confirm(`這些持股在 IBKR 報表中已找不到（可能已出清）：\n\n${names}\n\n要從投資組合移除嗎？`)) {
          for (const m of r.missing) await api('/holdings/' + m.id, { method: 'DELETE' });
          toast(`已移除 ${r.missing.length} 檔已出清持股`);
        }
      }
      renderPortfolio();
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
  const fxEdit = document.getElementById('fxBandEdit');
  if (fxEdit) fxEdit.onclick = () => openFxBands(settings);
  view().querySelectorAll('.info-link[data-info]').forEach(b => b.onclick = () => {
    const info = INCOME_INFO[b.dataset.info];
    if (info) openInfo(info[0], info[1]);
  });
  const tradesFullBtn = document.getElementById('tradesFull');
  if (tradesFullBtn) tradesFullBtn.onclick = () => openInfo('完整交易明細', tradesModalHtml(ibTrades), { size: 'xl' });
  const totalValueInfo = document.getElementById('totalValueInfo');
  if (totalValueInfo) totalValueInfo.onclick = () => openInfo('總市值', `
    <p><b>總市值 ＝ 股票市值 + 債券市值 + 黃金市值</b></p>
    <p style="font-family:var(--serif);font-size:20px;margin-top:10px">${MONEY(total)} ＝ 股票 ${MONEY(eqV)} + 債券 ${MONEY(bondV)} + 黃金 ${MONEY(goldV)}</p>
    <p class="muted small" style="margin-top:10px">這裡只計算投資持股市值，不包含現金，也不扣除融資。</p>
  `, { size: 'md' });
  const totalCostInfo = document.getElementById('totalCostInfo');
  if (totalCostInfo) totalCostInfo.onclick = () => openInfo('成本', costDetailHtml(rows, totalCost), { size: 'sm' });
  const assetStockInfo = document.getElementById('assetStockInfo');
  if (assetStockInfo) assetStockInfo.onclick = () => openInfo('股票', assetHoldingDetailHtml('股票', stockRows, eqV, allBase), { size: 'sm' });
  const assetBondInfo = document.getElementById('assetBondInfo');
  if (assetBondInfo) assetBondInfo.onclick = () => openInfo('債券', assetHoldingDetailHtml('債券', bondRows, bondV, allBase), { size: 'sm' });
  const assetCashInfo = document.getElementById('assetCashInfo');
  if (assetCashInfo) assetCashInfo.onclick = () => openInfo('現金', assetAccountDetailHtml('現金', cashAccounts, cashV), { size: 'sm' });
  const assetGoldInfo = document.getElementById('assetGoldInfo');
  if (assetGoldInfo) assetGoldInfo.onclick = () => openInfo('黃金', assetGoldDetailHtml(goldRows, goldAccounts, goldAll, allBase), { size: 'sm' });
  const dInfo = document.getElementById('disciplineInfo');
  if (dInfo) dInfo.onclick = () => openInfo('紀律檢查', `
    <p><b>口徑</b>：所有上限以「<b>% 淨資產</b>」衡量（不是投組市值——有融資時淨資產較小，規則自動更嚴格）。國家曝險採<b>穿透</b>計算：ETF 內含成分（如 EIMI 裡的中國、台灣）都拆進對應國家一起計。</p>
    <p><b>軟上限</b>：超標＝<b>凍結加碼</b>（禁止再買進），但不強制賣出，讓部位隨時間自然稀釋。在「編輯持股」把凍結中的標的加碼時，會跳出確認提醒。</p>
    <p><b>怎麼看圖</b>：黑色刻度＝上限位置；長條＝目前部位，<span style="color:var(--pos)">綠色</span>＝上限內、<span style="color:var(--neg)">紅色</span>＝超出上限的部分。</p>
    <p><b>目前上限</b>：單一個股 ${CAPS.stock}%・股票總曝險 ${CAPS.equity}%・單一國家 ${CAPS.country}%（中國 ${CAPS.china}%）・IB 融資槓桿平時 ${CAPS.lev}x／估值訊號期 ${CAPS.levSig}x。到「設定 → 投資原則」即可調整。</p>`);
  view().querySelectorAll('[data-edit-h]').forEach(b => b.onclick = () => openHoldingForm(holdings.find(h => h.id === b.dataset.editH)));
  view().querySelectorAll('[data-del-h]').forEach(b => b.onclick = () => {
    const h = holdings.find(x => x.id === b.dataset.delH);
    confirmDelete(h.symbol, () => api('/holdings/' + h.id, { method: 'DELETE' }));
  });
  const addW = document.getElementById('addWatch');
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
}

// ---- 投資原則：紀律檢查卡（唯讀；口徑 % 淨資產、穿透；黑刻度＝上限、紅＝超出）----
function capBar(value, cap) {
  const scale = Math.max(value, cap) * 1.12 || 1;
  const okW = (Math.min(value, cap) / scale * 100).toFixed(1);
  const overW = Math.max(0, value - cap) / scale * 100;
  const markL = (cap / scale * 100).toFixed(1);
  return `<div class="cap-bar"><div class="cb-ok" style="width:${okW}%"></div>${overW > 0 ? `<div class="cb-over" style="width:${overW.toFixed(1)}%"></div>` : ''}<div class="cb-mark" style="left:${markL}%"></div></div>`;
}
function disciplineSection(rows, regionMap, eqV, netWorth, leverage, CAPS) {
  if (!(netWorth > 0)) return '';
  const pn = (v) => v / netWorth * 100;
  const row = (label, value, cap, unit = '%', overLabel = '🔒 凍結') => {
    const over = value > cap;
    const valTxt = unit === 'x' ? value.toFixed(2) + 'x' : fmtPct(value);
    const capTxt = unit === 'x' ? cap + 'x' : cap + '%';
    return `<div class="rrow cap-row">
      <span class="nowrap">${label}</span>
      ${capBar(value, cap)}
      <span class="rval">${valTxt} / ${capTxt}　${over ? `<b class="neg">${overLabel}</b>` : '<span class="pos">✓</span>'}</span>
    </div>`;
  };
  const items = [];
  items.push(row('股票總曝險', pn(eqV), CAPS.equity));
  rows.filter(r => r.layer === 'stock').sort((a, b) => b.valueTwd - a.valueTwd)
    .forEach(r => items.push(row(esc(r.symbol), pn(r.valueTwd), CAPS.stock)));
  Object.entries(regionMap).filter(([rg]) => rg !== '美國' && rg !== '其他')
    .sort((a, b) => b[1] - a[1])
    .forEach(([rg, v]) => items.push(row(`${esc(rg)}（穿透）`, pn(v), rg === '中國' ? CAPS.china : CAPS.country)));
  items.push(row('IB 融資槓桿', leverage, CAPS.lev, 'x', '🔒 停借'));
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3><button type="button" class="info-link" id="disciplineInfo">紀律檢查</button></h3>
    <div class="region-rows" style="margin-top:12px">${items.join('')}</div>
  </div>`;
}

// ---- 幣別曝險（各幣別淨曝險＝股票＋債券＋黃金＋現金，折台幣）----
function fxSection(rows, accounts, fx) {
  const exposureCurrency = (r) => {
    const sym = String(r.symbol || '').toUpperCase();
    if (compOf(r).type === 'gold') return '黃金';
    if (sym === '00719B' || sym === '00720B') return 'USD';   // 台幣交易的美元債 ETF，曝險歸美元
    return r.currency || 'USD';
  };
  const byCur = {};
  const bucket = (cur) => byCur[cur] = byCur[cur] || { stockTwd: 0, bondTwd: 0, goldTwd: 0, cashTwd: 0 };
  const addHolding = (r) => {
    const c = bucket(exposureCurrency(r));
    const type = compOf(r).type;
    if (type === 'bond') c.bondTwd += r.valueTwd;
    else if (type === 'gold') c.goldTwd += r.valueTwd;
    else c.stockTwd += r.valueTwd;
  };
  const addCash = (cur, twd) => {
    bucket(cur).cashTwd += twd;
  };
  const partsText = (v) => [
    ['股票', v.stockTwd],
    ['債券', v.bondTwd],
    ['黃金', v.goldTwd],
    ['現金', v.cashTwd]
  ].filter(([, val]) => Math.round(Math.abs(val)) > 0)
    .map(([label, val]) => `${label} ${MONEY(val)}`)
    .join(' ＋ ');
  rows.forEach(addHolding);
  (accounts || []).forEach(a => {
    const bal = Number(a.balance || 0);
    if (!bal) return;
    const cur = a.currency || 'TWD';
    addCash(cur, bal * (fx[cur] || 1));
  });
  for (const c of Object.values(byCur)) c.netTwd = c.stockTwd + c.bondTwd + c.goldTwd + c.cashTwd;
  const totalTwd = Object.values(byCur).reduce((s, c) => s + c.netTwd, 0);
  const curs = Object.entries(byCur).sort((a, b) => b[1].netTwd - a[1].netTwd);
  const maxTwd = Math.max(...curs.map(([, c]) => Math.abs(c.netTwd)), 1);

  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>幣別曝險 <span class="stat-sub" style="font-weight:400;margin:0">（依底層曝險＋現金帳戶）</span></h3>
    <div class="region-rows">
      ${curs.map(([cur, v]) => {
        const parts = partsText(v);
        return `<div class="rrow fx-row">
        <span class="rlabel"><span class="cat-dot" style="background:${cur === '黃金' ? CHART.brown : (CUR_COLOR[cur] || CHART.gray)}"></span>${esc(cur)}</span>
        <div>
          <div class="rbar"><div style="width:${(Math.abs(v.netTwd) / maxTwd * 100).toFixed(1)}%;background:${v.netTwd < 0 ? CHART.red : (cur === '黃金' ? CHART.brown : (CUR_COLOR[cur] || CHART.gray))}"></div></div>
          <div class="fx-amt muted">${MONEY(v.netTwd)}${parts ? ` ＝ ${parts}` : ''}</div>
        </div>
        <span class="rval ${v.netTwd < 0 ? 'neg' : ''}">${fmtPct(totalTwd ? v.netTwd / totalTwd * 100 : 0)}</span>
      </div>`;
      }).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">註解：換算匯率來自 Yahoo Finance</p>
  </div>`;
}

// ---- 美元/台幣匯率儀表（暫時從頁面移除，之後再決定位置；要放回頁面時把 ${fxGaugeSection(fx, settings)} 插進 render 即可）----
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
  openForm({
    title: '調整換匯分批區間',
    fields: [
      { key: 'fxLow', label: '低於此值＝台幣→美元 分批區', type: 'number', required: true, step: '0.1' },
      { key: 'fxHigh', label: '高於此值＝美元→台幣 分批區', type: 'number', required: true, step: '0.1' }
    ],
    values: { fxLow: settings.fxLow || 28, fxHigh: settings.fxHigh || 32 },
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { fxLow: Number(data.fxLow), fxHigh: Number(data.fxHigh) } });
      toast('已更新換匯區間'); renderPortfolio();
    }
  });
}

// ---- IBKR 現金流（股息 vs 融資利息，近一年）----
function incomeSection(settings) {
  const inc = settings.ib?.income;
  if (!inc) return '';
  const divTotal = (inc.dividends || 0) + (inc.paymentInLieu || 0);
  const net = divTotal + (inc.withholdingTax || 0) + (inc.interestPaid || 0) + (inc.interestReceived || 0);
  // 現金流卡：兩位小數，跟著計價切換（USD→K、TWD→萬）
  const usd = (n) => {
    const sign = n < 0 ? '−' : '+';
    return viewCur === 'USD'
      ? sign + (Math.abs(n) / 1000).toFixed(2) + ' K USD'
      : sign + (Math.abs(n) * usdRate / 10000).toFixed(2) + ' 萬';
  };
  const fmtD = (d) => d ? `${d.slice(0, 4)}/${d.slice(4, 6)}` : '';
  const item = (label, val, cls) => `<div style="min-width:150px">
    <div class="muted" style="font-size:11.5px">${label}</div>
    <div class="${cls}" style="font-family:var(--serif);font-size:19px;font-variant-numeric:tabular-nums">${usd(val)}</div>
  </div>`;
  const infoBtn = (key, text) => `<button type="button" class="info-link" data-info="${key}">${text}</button>`;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>IB 現金流 <span class="stat-sub" style="font-weight:400;margin:0">（${fmtD(inc.from)}–${fmtD(inc.to)}）</span></h3>
    <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:12px">
      ${item(`股息（含${infoBtn('pil', '替代股息')}）`, divTotal, 'pos')}
      ${item(infoBtn('interestPaid', '融資利息'), inc.interestPaid, 'neg')}
      ${item(infoBtn('interestReceived', '利息收入'), inc.interestReceived, 'pos')}
      ${item('淨現金流', net, net >= 0 ? 'pos' : 'neg')}
    </div>
  </div>`;
}

// 現金流名詞說明（點擊 .info-link 時跳出）
const INCOME_INFO = {
  pil: ['替代股息（Payment in Lieu）',
    '<p>當你持有的股票被券商的融資／借券機制借出時，你不會直接收到公司發的股息，而是收到一筆<b>等額的現金給付</b>來替代，這就是「替代股息」。</p><p>金額上與原本的股息相同，但<b>稅務處理可能不同</b>（例如不適用某些股利優惠稅率），報稅時要留意。</p>'],
  interestPaid: ['融資利息',
    '<p>你借入資金（融資）維持槓桿部位時，IBKR 按日計收的<b>利息成本</b>。</p><p>這是持有槓桿的固定開銷——當你的股息收入<b>蓋不過</b>融資利息時，該槓桿部位就是「負現金流」持倉，長期會侵蝕報酬。</p>'],
  interestReceived: ['利息收入',
    '<p>IBKR 對你帳戶中<b>閒置現金餘額</b>支付的利息（通常要超過一定門檻才有，且分幣別計算）。</p><p>與融資利息方向相反：這是錢放著自動產生的收入。</p>']
};

// 交易摘要計算（頁面與列印共用）：已實現損益換成基準幣別(USD)、獲利/虧損前三
function tradeSummary(trades, settings = {}) {
  const fxToBase = (cur) => {
    const c = String(cur || 'USD').toUpperCase();
    if (c === 'USD') return 1;
    const usdTwd = Number(settings.usdTwd || 32);
    const curTwd = c === 'TWD' ? 1 : Number(settings.fxTwd?.[c] || 0);
    return curTwd > 0 && usdTwd > 0 ? curTwd / usdTwd : null;
  };
  const ibkr = new Set();
  const estimated = new Set();
  const missing = new Set();
  const pnlBase = (t) => {
    const pnl = Number(t.pnl) || 0;
    const cur = String(t.currency || 'USD').toUpperCase();
    if (t.pnlBase != null && t.pnlBase !== '' && Number.isFinite(Number(t.pnlBase))) {
      if (cur !== 'USD') ibkr.add(cur);
      return Number(t.pnlBase);
    }
    if (t.fxRateToBase != null && t.fxRateToBase !== '' && Number.isFinite(Number(t.fxRateToBase)) && Number(t.fxRateToBase) > 0) {
      if (cur !== 'USD') ibkr.add(cur);
      return pnl * Number(t.fxRateToBase);
    }
    if (cur === 'USD') return pnl;
    const fallback = fxToBase(cur);
    if (fallback) {
      estimated.add(cur);
      return pnl * fallback;
    }
    missing.add(cur);
    return 0;
  };
  const realized = trades.reduce((s, t) => s + pnlBase(t), 0);
  const bySym = {};
  trades.forEach(t => { const p = pnlBase(t); if (p) bySym[t.symbol] = (bySym[t.symbol] || 0) + p; });
  const sorted = Object.entries(bySym).sort((a, b) => b[1] - a[1]);
  return {
    realized,
    winners: sorted.filter(x => x[1] > 0).slice(0, 3),
    losers: sorted.filter(x => x[1] < 0).slice(-3).reverse(),
    ibkrCurrencies: [...ibkr],
    estimatedCurrencies: [...estimated],
    missingCurrencies: [...missing]
  };
}

// ---- 交易摘要：已實現損益（FIFO，來自 IBKR 成交紀錄）----
function tradesSection(trades, settings) {
  if (!trades || !trades.length) return '';
  const inc = settings.ib?.income || {};
  const fmtD = (d) => d ? `${d.slice(0, 4)}/${d.slice(4, 6)}` : '';
  const { realized, winners, losers, ibkrCurrencies, estimatedCurrencies, missingCurrencies } = tradeSummary(trades, settings);
  // 跟著計價切換（USD→K、TWD→萬）
  const usd = (n) => {
    const sign = n < 0 ? '−' : '+';
    return viewCur === 'USD'
      ? sign + kNum(Math.abs(n)) + ' K USD'
      : sign + wanNum(Math.abs(n) * usdRate) + ' 萬';
  };
  const li = (arr) => arr.length
    ? arr.map(([s, p]) => `<div style="display:flex;justify-content:space-between;gap:14px"><span>${esc(s)}</span><b class="${p >= 0 ? 'pos' : 'neg'}">${usd(p)}</b></div>`).join('')
    : '<span class="muted">—</span>';
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>交易摘要 <span class="stat-sub" style="font-weight:400;margin:0">（${fmtD(inc.from)}–${fmtD(inc.to)}）</span> <button type="button" class="btn-link btn-sm" id="tradesFull">完整交易</button></h3>
    <div style="display:flex;gap:40px;flex-wrap:wrap;margin-top:12px;align-items:flex-start">
      <div style="min-width:150px">
        <div class="muted" style="font-size:11.5px">已實現損益（FIFO）</div>
        <div class="${realized >= 0 ? 'pos' : 'neg'}" style="font-family:var(--serif);font-size:22px;font-variant-numeric:tabular-nums">${usd(realized)}</div>
      </div>
      <div style="min-width:180px;font-size:12.5px"><div class="muted" style="font-size:11.5px;margin-bottom:5px">已實現獲利 前三</div>${li(winners)}</div>
      <div style="min-width:180px;font-size:12.5px"><div class="muted" style="font-size:11.5px;margin-bottom:5px">已實現虧損 前三</div>${li(losers)}</div>
    </div>
    ${ibkrCurrencies.length ? `<p class="muted small" style="margin-top:10px">註解：換算匯率來自 IBKR</p>` : ''}
    ${estimatedCurrencies.length ? `<p class="muted small" style="margin-top:10px">提醒：${estimatedCurrencies.map(esc).join('、')} 舊交易缺少 IBKR 匯率欄位，已先用目前設定匯率估算；下次 IBKR 同步若有勾選 FX Rate to Base，會改用 IBKR 匯率。</p>` : ''}
    ${missingCurrencies.length ? `<p class="neg small" style="margin-top:10px">提醒：${missingCurrencies.map(esc).join('、')} 交易缺少可用匯率，暫未計入已實現損益。</p>` : ''}
    <p class="muted small" style="margin-top:10px">已實現＋未實現＋股息－利息，才是完整的投資成績。</p>
  </div>`;
}

// 完整交易明細（彈窗內容）：全部成交逐筆，依日期新→舊
function tradesModalHtml(trades) {
  const buys = trades.filter(t => t.buySell === 'BUY').length;
  const sells = trades.length - buys;
  const fmtDate = (d) => (d && d.length === 8) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || '');
  const n = (x, dec = 0) => Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const rows = trades.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(t => {
    const p = Number(t.pnl) || 0;
    return `<tr>
      <td class="nowrap">${esc(fmtDate(t.date))}</td>
      <td class="nowrap"><b>${esc(t.symbol)}</b></td>
      <td><span class="tag ${t.buySell === 'BUY' ? 'blue' : 'amber'}">${t.buySell === 'BUY' ? '買' : '賣'}</span></td>
      <td class="num">${n(Math.abs(t.quantity))}</td>
      <td class="num">${n(t.price, 2)}</td>
      <td class="num">${n(t.netCash, 2)}</td>
      <td class="num ${p > 0 ? 'pos' : p < 0 ? 'neg' : ''}">${p ? n(p, 2) : '—'}</td>
      <td class="muted nowrap">${esc(t.currency || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="cost-detail-total"><span>買 ${buys}／賣 ${sells}</span><b>共 ${trades.length} 筆</b></div>
    <div class="cost-detail-table-wrap" style="max-height:58vh;overflow:auto">
      <table class="cost-detail-table">
        <thead><tr><th>日期</th><th>代號</th><th>買賣</th><th class="num">股數</th><th class="num">價格</th><th class="num">淨現金</th><th class="num">已實現損益</th><th>幣別</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function costDetailHtml(rows, totalCost) {
  const body = rows.slice().sort((a, b) => b.costTwd - a.costTwd).map(r => `<tr>
    <td class="nowrap"><b>${esc(r.symbol)}</b></td>
    <td class="num">${MONEY(r.costTwd)}</td>
  </tr>`).join('');
  return `<div class="cost-detail-total compact-summary">
      <span></span>
      <b>合計：${MONEY(totalCost)}</b>
    </div>
    <div class="cost-detail-table-wrap compact" style="max-height:52vh;overflow-y:auto">
      <table class="cost-detail-table compact">
        <thead><tr><th>標的</th><th class="num">成本</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function assetHoldingDetailHtml(label, rows, totalValue, baseValue) {
  const body = rows.length ? rows.slice().sort((a, b) => b.valueTwd - a.valueTwd).map(r => `<tr>
    <td class="nowrap"><b>${esc(r.symbol)}</b></td>
    <td class="num">${MONEY(r.valueTwd)}</td>
    <td class="num">${baseValue ? Math.round(r.valueTwd / baseValue * 100) : 0}%</td>
  </tr>`).join('') : `<tr><td colspan="3" class="muted" style="text-align:center;padding:22px">目前沒有${esc(label)}部位</td></tr>`;
  return `<div class="cost-detail-total compact-summary three-col">
      <span></span>
      <b>合計：${MONEY(totalValue)}</b>
      <b>合計：${baseValue ? Math.round(totalValue / baseValue * 100) : 0}%</b>
    </div>
    <div class="cost-detail-table-wrap compact" style="max-height:52vh;overflow-y:auto">
      <table class="cost-detail-table compact three-col">
        <thead><tr><th>標的</th><th class="num">市值</th><th class="num">佔比</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function assetAccountDetailHtml(label, accounts, totalValue) {
  const body = accounts.length ? accounts.slice().sort((a, b) => b.valueTwd - a.valueTwd).map(a => `<tr>
    <td><b>${esc(a.name || '未命名帳戶')}</b></td>
    <td class="num">${MONEY(a.valueTwd)}</td>
  </tr>`).join('') : `<tr><td colspan="2" class="muted" style="text-align:center;padding:22px">目前沒有${esc(label)}帳戶</td></tr>`;
  return `<div class="cost-detail-total compact-summary">
      <span></span>
      <b>合計：${MONEY(totalValue)}</b>
    </div>
    <div class="cost-detail-table-wrap compact" style="max-height:52vh;overflow-y:auto">
      <table class="cost-detail-table compact">
        <thead><tr><th>帳戶</th><th class="num">金額</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function assetGoldDetailHtml(rows, accounts, totalValue, baseValue) {
  const holdingRows = rows.map(r => ({
    item: r.symbol,
    valueTwd: r.valueTwd
  }));
  const accountRows = accounts.map(a => ({
    item: a.name || '黃金帳戶',
    valueTwd: a.valueTwd
  }));
  const items = holdingRows.concat(accountRows).sort((a, b) => b.valueTwd - a.valueTwd);
  const body = items.length ? items.map(item => `<tr>
    <td><b>${esc(item.item)}</b></td>
    <td class="num">${MONEY(item.valueTwd)}</td>
    <td class="num">${baseValue ? Math.round(item.valueTwd / baseValue * 100) : 0}%</td>
  </tr>`).join('') : `<tr><td colspan="3" class="muted" style="text-align:center;padding:22px">目前沒有黃金部位</td></tr>`;
  return `<div class="cost-detail-total compact-summary three-col">
      <span></span>
      <b>合計：${MONEY(totalValue)}</b>
      <b>合計：${baseValue ? Math.round(totalValue / baseValue * 100) : 0}%</b>
    </div>
    <div class="cost-detail-table-wrap compact" style="max-height:52vh;overflow-y:auto">
      <table class="cost-detail-table compact three-col">
        <thead><tr><th>項目</th><th class="num">市值</th><th class="num">佔比</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// ---- ② 穿透式區域曝險 ----
function regionSection(regionMap, eqV) {
  const regs = Object.entries(regionMap).sort((a, b) => b[1] - a[1]);
  const maxV = regs[0]?.[1] || 1;
  const india = eqV > 0 ? (regionMap['印度'] || 0) / eqV * 100 : 0;
  const china = eqV > 0 ? (regionMap['中國'] || 0) / eqV * 100 : 0;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>持股曝險 <span class="stat-sub" style="font-weight:400;margin:0">（已合併 ETF 內含成分，佔股票部位 %）</span></h3>
    <div class="region-rows">
      ${regs.map(([reg, v]) => `<div class="rrow">
        <span class="rlabel"><span class="cat-dot" style="background:${REGION_COLOR[reg] || CHART.gray}"></span>${esc(reg)}</span>
        <div class="rbar"><div style="width:${(v / maxV * 100).toFixed(1)}%;background:${REGION_COLOR[reg] || CHART.gray}"></div></div>
        <span class="rval">${fmtPct(eqV > 0 ? v / eqV * 100 : 0)} <span class="muted">${MONEY(v)}</span></span>
      </div>`).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">EIMI 內含的中國／印度／台灣／韓國權重已拆入各區域（近似值，可隨年報更新）。
    你真實的中國曝險 ${fmtPct(china)}＝ICHN＋KWEB＋EIMI 的中國成分；不看好的印度目前實佔 ${fmtPct(india)}。</p>
  </div>`;
}

// ---- ① 分層配置 vs 目標 ----
function layerSection(layerV, total) {
  const rowsHtml = LAYER_ORDER.map(k => {
    const cfg = LAYERS[k];
    const v = layerV[k] || 0;
    const pct = total > 0 ? v / total * 100 : 0;
    let tag;
    if (pct > cfg.max) tag = '<span class="tag amber">偏高</span>';
    else if (pct < cfg.min) tag = '<span class="tag amber">偏低</span>';
    else tag = '<span class="tag green">符合</span>';
    return `<tr>
      <td class="nowrap"><span class="cat-dot" style="background:${cfg.color}"></span>${cfg.label}</td>
      <td class="nowrap">${MONEY(v)}</td>
      <td class="nowrap">${fmtPct(pct)}</td>
      <td class="nowrap muted">${cfg.min}–${cfg.max}%</td>
      <td>${tag}</td>
    </tr>`;
  }).join('');
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>投資分層 vs 目標 <span class="stat-sub" style="font-weight:400;margin:0">（投資組合內部：核心–衛星／債／金／個股）</span></h3>
    <div class="tbl-wrap" style="box-shadow:none;border:none;margin-top:6px"><table>
      <thead><tr><th>層</th><th>金額</th><th>佔比</th><th>目標區間</th><th>狀態</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>
    <p class="muted small">目標區間可依你的規劃調整（跟我說一聲即可改）。</p>
  </div>`;
}

// ---- 持股佔比圓環圖（單色珊瑚漸層：身分由標籤直接標示，顏色只表大小順序）----
function holdingsDonut(rows, total) {
  if (!(total > 0)) return '';
  // 全部持股各自成片（依市值排序）；漸層由深到淺內插
  const sorted = rows.filter(r => r.valueTwd > 0).slice().sort((a, b) => b.valueTwd - a.valueTwd);
  const items = sorted.map(r => ({ label: r.symbol, v: r.valueTwd }));
  const mix = (h1, h2, t) => {
    const c1 = [1, 3, 5].map(i => parseInt(h1.slice(i, i + 2), 16));
    const c2 = [1, 3, 5].map(i => parseInt(h2.slice(i, i + 2), 16));
    return '#' + c1.map((x, j) => Math.round(x + (c2[j] - x) * t).toString(16).padStart(2, '0')).join('');
  };
  const rampAt = (i, n) => mix('#C96442', '#FBEAE1', n <= 1 ? 0 : i / (n - 1));

  const W = 780, H = 400, cx = 390, cy = 200, r = 118, sw = 26;
  const polar = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const gap = 2.5 / r;   // 片與片之間 ~2.5px 縫
  let a = -Math.PI / 2;
  const slices = items.map((it, i) => {
    const span = it.v / total * Math.PI * 2;
    const s = { ...it, i, a0: a, a1: a + span, mid: a + span / 2, pct: it.v / total * 100 };
    a += span;
    return s;
  });

  // 弧線（每片都有原生 title 提示，標籤被省略的小部位滑鼠移上仍可見明細）
  const arcs = slices.map(s => {
    const g = Math.min(gap, (s.a1 - s.a0) / 4);
    const [x0, y0] = polar(r, s.a0 + g), [x1, y1] = polar(r, s.a1 - g);
    const large = (s.a1 - s.a0 - g * 2) > Math.PI ? 1 : 0;
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"
      fill="none" stroke="${rampAt(s.i, slices.length)}" stroke-width="${sw}"
      ><title>${esc(s.label)}　${MONEY(s.v)}（${s.pct.toFixed(1)}%）</title></path>`;
  }).join('');

  // 外圈標籤：左右分側；「大部位優先」佔位，放不下的省略（塞不下就不顯示）
  const GAPY = 18;
  const sides = { L: [], R: [] };
  slices.forEach(s => sides[Math.cos(s.mid) >= 0 ? 'R' : 'L'].push({ ...s, ty: cy + Math.sin(s.mid) * (r + 34) }));
  const labels = [];
  for (const side of ['L', 'R']) {
    const placed = [];
    for (const s of sides[side].sort((x, y) => y.v - x.v)) {
      const base = Math.min(Math.max(s.ty, 16), H - 8);
      let y = null;
      for (const off of [0, -7, 7, -14, 14, -21, 21, -28, 28, -35, 35, -42, 42, -49, 49, -56, 56, -63, 63]) {   // 允許上下挪動找空位
        const cand = base + off;
        if (cand < 16 || cand > H - 8) continue;
        if (placed.every(p => Math.abs(p - cand) >= GAPY)) { y = cand; break; }
      }
      if (y == null) continue;   // 真的塞不下 → 省略標籤（title 提示仍在）
      placed.push(y);
      const [px, py] = polar(r + sw / 2 + 4, s.mid);
      const tx = side === 'R' ? cx + r + 76 : cx - r - 76;
      const lineEnd = side === 'R' ? tx - 6 : tx + 6;
      // 小部位（<2.5%）只放代號，省空間讓更多名稱擠得進來
      const detail = s.pct < 2.5 ? '' : `<tspan fill="var(--text-dim)"> ${MONEY(s.v)}（${s.pct.toFixed(1)}%）</tspan>`;
      labels.push(`<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${lineEnd}" y2="${(y - 4).toFixed(1)}" stroke="var(--line-2)" stroke-width="1"/>
        <text x="${tx}" y="${y.toFixed(1)}" text-anchor="${side === 'R' ? 'start' : 'end'}" font-size="12.5">
          <tspan fill="var(--text)" font-weight="600">${esc(s.label)}</tspan>${detail}
        </text>`);
    }
  }

  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>持股佔比 <span class="stat-sub" style="font-weight:400;margin:0">（全部持股依市值；標籤放不下的小部位省略，滑鼠移上色塊可見明細）</span></h3>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:820px;display:block;margin:0 auto" role="img" aria-label="持股佔比圓環圖">
      ${arcs}
      ${labels.join('')}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="30" font-weight="500" style="font-family:var(--serif)" fill="var(--text)">${MONEY(total)}</text>
      <text x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="12.5" fill="var(--text-dim)">總市值</text>
    </svg>
  </div>`;
}

// ---- 持股表（依層分組）----
function holdingsTable(rows, total) {
  const cmp = H_SORTERS[hSortKey] || H_SORTERS.value;
  const groups = LAYER_ORDER.map(k => {
    const list = rows.filter(r => (LAYERS[r.layer] ? r.layer : 'satellite') === k).sort(cmp);
    if (hSortDir === 'desc') list.reverse();
    if (!list.length) return '';
    return `<tr class="group-row"><td colspan="9"><span class="cat-dot" style="background:${LAYERS[k].color}"></span>${LAYERS[k].label}</td></tr>`
      + list.map(r => `<tr>
        <td class="nowrap"><b>${esc(r.symbol)}</b>${r.quoteSymbol ? '' : ' <span class="tag" style="font-size:9px">手動</span>'}</td>
        <td class="muted nowrap" style="max-width:190px;overflow:hidden;text-overflow:ellipsis">${esc(r.name || '')}</td>
        <td class="nowrap muted">${fmtPrice0((r.avgCost != null && r.avgCost !== '') ? r.avgCost : (Number(r.quantity) ? Number(r.cost || 0) / Number(r.quantity) : 0), r.currency)}</td>
        <td class="nowrap">${fmtPrice0(r.price, r.currency)}</td>
        <td class="num">${MONEY(r.valueTwd)}</td>
        <td class="num ${r.pnlTwd >= 0 ? 'pos' : 'neg'}">${r.pnlTwd >= 0 ? '+' : ''}${MONEY(r.pnlTwd)}</td>
        <td class="num ${r.pnlTwd >= 0 ? 'pos' : 'neg'}">${r.costTwd ? fmtPct(r.pnlTwd / r.costTwd * 100) : '—'}</td>
        <td class="num">${fmtPct(total > 0 ? r.valueTwd / total * 100 : 0)}</td>
        <td><div class="row-actions">
          <button class="btn-link btn-sm" data-edit-h="${r.id}" title="編輯">${icon('edit', 15)}</button>
          <button class="btn-danger btn-sm" data-del-h="${r.id}" title="刪除">${icon('trash', 15)}</button>
        </div></td>
      </tr>`).join('');
  }).join('');
  return `<div class="tbl-wrap" style="margin-bottom:16px"><table class="subs-table">
    <thead><tr><th>代號</th><th>說明</th><th>均價</th><th>現價</th>
      <th class="sortable" data-hsort="value">市值 ${hTri('value')}</th>
      <th class="sortable" data-hsort="pnl">損益 ${hTri('pnl')}</th>
      <th class="sortable" data-hsort="ret">報酬率 ${hTri('ret')}</th>
      <th class="sortable" data-hsort="weight">佔比 ${hTri('weight')}</th>
      <th></th></tr></thead>
    <tbody>${groups || '<tr><td colspan="9" class="empty">尚無持股，點右上角新增。</td></tr>'}</tbody>
  </table></div>`;
}

// ---- ④ 回檔買進願望清單 ----
function watchlistSection(watchlist) {
  const rowsHtml = watchlist.map(w => {
    const last = Number(w.lastPrice || 0);
    const target = Number(w.targetPrice || 0);
    let status = '<span class="muted">—</span>';
    if (last && target) {
      const diff = (last - target) / target * 100;
      status = last <= target
        ? '<span class="tag green">到價！可依紀律買進</span>'
        : `<span class="muted">還差 ${fmtPct(diff)}</span>`;
    }
    return `<tr>
      <td class="nowrap"><b>${esc(w.symbol)}</b></td>
      <td class="muted nowrap">${esc(w.name || '')}</td>
      <td class="nowrap">${fmtPrice(w.targetPrice, w.currency || 'USD')}</td>
      <td class="nowrap">${last ? fmtPrice(last, w.currency || 'USD') : '<span class="muted">按「更新報價」</span>'}</td>
      <td>${status}</td>
      <td class="muted" style="font-size:12px">${esc(w.note || '')}</td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-edit-w="${w.id}" title="編輯">${icon('edit', 15)}</button>
        <button class="btn-danger btn-sm" data-del-w="${w.id}" title="刪除">${icon('trash', 15)}</button>
      </div></td>
    </tr>`;
  }).join('');
  return `<div class="chart-card" style="margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">回檔買進願望清單 <span class="stat-sub" style="font-weight:400;margin:0">（到價提示，把「等回檔」變成紀律）</span></h3>
      <button class="btn-ghost btn-sm" id="addWatch">${icon('plus', 14)}新增</button>
    </div>
    <div class="tbl-wrap" style="box-shadow:none;border:none;margin-top:8px"><table>
      <thead><tr><th>代號</th><th>名稱</th><th>目標買價</th><th>現價</th><th>狀態</th><th>備註</th><th></th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="7" class="empty">尚無項目</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

// ---- ③ CAPE 儀表 ----
async function loadCape(settings, qqqmShare, qqqmMax) {
  let cape = null;
  try { cape = await api('/cape'); } catch {}
  const body = document.getElementById('capeBody');
  if (!body) return;
  const v = cape && cape.value ? Number(cape.value) : null;
  if (!v) {
    body.innerHTML = `<p class="muted" style="margin-top:8px">無法自動取得 CAPE。<button class="btn-link btn-sm" id="capeManualBtn">手動設定</button></p>`;
    const b = document.getElementById('capeManualBtn');
    if (b) b.onclick = () => openCapeManual(settings);
    return;
  }
  const pct = capePercentile(v);
  const band = CAPE_BANDS.find(b => v < b.to) || CAPE_BANDS[CAPE_BANDS.length - 1];
  const clamped = Math.min(Math.max(v, CAPE_MIN), CAPE_MAX);
  const markerLeft = (clamped - CAPE_MIN) / (CAPE_MAX - CAPE_MIN) * 100;
  const qqqmOk = qqqmShare <= qqqmMax;
  body.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-top:6px">
      <span class="stat sm">${v.toFixed(2)}</span>
      <span class="muted" style="font-size:12.5px">歷史分位 ~${pct.toFixed(0)}%・來源 ${esc(cape.source)}
        <button class="btn-link btn-sm" id="capeManualBtn">手動設定</button></span>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">
        ${CAPE_BANDS.map(b => `<div style="width:${((b.to - b.from) / (CAPE_MAX - CAPE_MIN) * 100).toFixed(1)}%;background:${b.color};opacity:.55"></div>`).join('')}
        <div class="gauge-marker" style="left:${markerLeft.toFixed(1)}%"></div>
      </div>
      <div class="gauge-scale"><span>5</span><span>20</span><span>28</span><span>33</span><span>45</span></div>
    </div>
    <p style="font-size:13px;margin-top:4px"><b style="color:${band.color}">目前規則帶：</b>${band.label}</p>
    <p class="muted small" style="margin-top:6px">QQQM 佔美股核心 <b style="color:${qqqmOk ? 'var(--pos)' : 'var(--neg)'}">${fmtPct(qqqmShare)}</b>（上限 ${qqqmMax}%）${qqqmOk ? '——在限內。' : '——已超限，漲勢中依紀律轉回 CSPX。'}
    提醒：CAPE 是 S&P 500 的估值指標，當「紀律閘門」用，不當精準擇時訊號；它可以在高檔停留很多年。</p>
  `;
  const b = document.getElementById('capeManualBtn');
  if (b) b.onclick = () => openCapeManual(settings);
}

function openCapeManual(settings) {
  openForm({
    title: '手動設定 Shiller PE',
    fields: [{ key: 'capeManual', label: '目前 CAPE 值（multpl.com 可查）', type: 'number', required: true }],
    values: { capeManual: settings.capeManual || '' },
    onSubmit: async (data) => {
      await api('/settings', { method: 'PUT', body: { capeManual: data.capeManual } });
      toast('已更新 CAPE 手動值'); renderPortfolio();
    }
  });
}

// ---- ⑥ 投入 vs 市值 ----
function drawInvestChart(psnaps, curCost, curValue) {
  const ctx = document.getElementById('investChart');
  if (!ctx) return;
  const conv = (twd) => viewCur === 'USD' ? Math.round(twd / usdRate) : Math.round(twd);
  const labels = [...psnaps.map(s => s.month), '本月（現在）'];
  const costs = [...psnaps.map(s => conv(s.cost)), conv(curCost)];
  const values = [...psnaps.map(s => conv(s.value)), conv(curValue)];
  const yTick = (v) => viewCur === 'USD' ? (v / 1000).toFixed(0) + ' K' : (v / 10000).toFixed(0) + ' 萬';
  const tipVal = (v) => viewCur === 'USD' ? kNum(v) + ' K USD' : wanNum(v) + ' 萬';
  lineChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: '投入成本', data: costs, borderColor: '#8a887f', backgroundColor: '#8a887f', borderDash: [5, 4], borderWidth: 2, pointRadius: 3, fill: false, tension: .25 },
      { label: '市值', data: values, borderColor: '#c96442', backgroundColor: 'rgba(201,100,66,.10)', borderWidth: 2, pointRadius: 3, fill: true, tension: .25 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { color: AXIS, boxWidth: 14, padding: 12 } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${tipVal(c.parsed.y)}` } } },
      scales: { x: { ticks: { color: AXIS }, grid: { color: GRID } },
        y: { ticks: { color: AXIS, callback: yTick }, grid: { color: GRID } } } }
  });
}

// ---- ⑤ 研究卡 ----
function researchCard(holding, research) {
  const r = research.find(x => (x.symbol || '').toUpperCase() === (holding.symbol || '').toUpperCase());
  const cps = (r?.checkpoints || []).slice().reverse().slice(0, 4);
  const block = (title, txt) => txt ? `<div class="rc-block"><b>${title}</b>${esc(txt)}</div>` : '';
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div class="item-title">${esc(holding.symbol)} <span class="muted" style="font-weight:400;font-size:12px">${esc(holding.name || '')}</span></div>
      <span class="tag ${holding.pnlTwd >= 0 ? 'green' : 'amber'}">${holding.pnlTwd >= 0 ? '+' : ''}${fmtPct(holding.costTwd ? holding.pnlTwd / holding.costTwd * 100 : 0)}</span>
    </div>
    <div style="margin-top:11px;display:flex;flex-direction:column;gap:8px;font-size:12.5px">
      ${block('投資論點：', r?.thesis) || '<div class="rc-block muted">還沒寫投資論點——寫下「為什麼買」，之後漲跌都能對照檢驗。</div>'}
      ${block('關鍵指標：', r?.metrics)}
      ${block('風險：', r?.risks)}
    </div>
    ${cps.length ? `<div style="margin-top:10px"><b style="font-size:12px">檢查點</b>
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
        ${cps.map(c => `<div class="muted" style="font-size:12px"><span style="color:var(--text)">${esc(c.date)}</span>　${esc(c.note)}</div>`).join('')}
      </div></div>` : ''}
    <div style="display:flex;gap:6px;margin-top:12px;align-items:center">
      <input type="text" id="cp_${esc(holding.symbol)}" placeholder="新增檢查點筆記…" style="flex:1;font-size:12px;padding:6px 9px">
      <button class="btn-ghost btn-sm" data-add-cp="${esc(holding.symbol)}">記一筆</button>
      <button class="btn-link btn-sm" data-edit-r="${esc(holding.symbol)}" title="編輯研究卡">${icon('edit', 15)}</button>
    </div>
  </div>`;
}

async function addCheckpoint(symbol, research) {
  const input = document.getElementById('cp_' + symbol);
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
  const r = research.find(x => (x.symbol || '').toUpperCase() === symbol.toUpperCase());
  openForm({
    title: `${symbol} 研究卡`,
    fields: [
      { key: 'thesis', label: '投資論點（為什麼買？想驗證什麼？）', type: 'textarea', full: true },
      { key: 'metrics', label: '關鍵指標（每季對照）', type: 'textarea', full: true },
      { key: 'risks', label: '風險清單', type: 'textarea', full: true }
    ],
    values: r || {},
    onSubmit: async (data) => {
      if (r) await api('/research/' + r.id, { method: 'PUT', body: data });
      else await api('/research', { method: 'POST', body: { symbol, ...data, checkpoints: [] } });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 表單：持股 / 願望清單 ----
function openHoldingForm(h) {
  openForm({
    title: h ? '編輯持股' : '新增持股',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true, placeholder: '例：CSPX' },
      { key: 'name', label: '說明（一眼看懂持有什麼）', type: 'text', placeholder: '例：美國指數' },
      { key: 'layer', label: '層（核心–衛星）', type: 'select', options: LAYER_ORDER.map(k => ({ value: k, label: LAYERS[k].label })) },
      { key: 'currency', label: '計價幣別', type: 'select', options: CURRENCIES },
      { key: 'quantity', label: '股數', type: 'number', required: true },
      { key: 'avgCost', label: '購買均價（原幣，自動算投入成本）', type: 'number', step: '0.01' },
      { key: 'price', label: '現價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號（留空＝手動報價）', type: 'text', placeholder: '例：CSPX.L、00719B.TWO、QQQM' }
    ],
    values: h ? { ...h, avgCost: h.avgCost != null ? Math.round(Number(h.avgCost) * 100) / 100 : (Number(h.quantity) ? Math.round(Number(h.cost || 0) / Number(h.quantity) * 100) / 100 : '') } : { currency: 'USD', layer: 'core' },
    onSubmit: async (data) => {
      // 投資原則：凍結名單加碼警告（軟上限——確認後仍可儲存；減碼/改備註不受影響）
      const oldQty = h ? Number(h.quantity || 0) : 0;
      const newQty = Number(data.quantity || 0);
      if (newQty > oldQty) {
        const sym = String(data.symbol || '').toUpperCase().trim();
        const comp = compOf({ symbol: sym, layer: data.layer });
        const reasons = [];
        if (FREEZE.symbols.has(sym)) reasons.push('單一個股上限');
        for (const rg of Object.keys(comp.regions || {})) if (FREEZE.regions.has(rg)) reasons.push(`${rg}上限`);
        if (comp.type === 'equity' && FREEZE.equity) reasons.push('股票總曝險上限');
        if (reasons.length && !window.confirm(`⚠️ ${sym} 目前凍結加碼（超過：${reasons.join('、')}）。\n依投資原則不應加碼，確定仍要儲存？`)) {
          throw new Error('已取消：該標的凍結加碼中');
        }
      }
      data.avgCost = Math.round(Number(data.avgCost || 0) * 100) / 100;   // 均價統一兩位小數
      data.price = Math.round(Number(data.price || 0) * 100) / 100;
      data.cost = Math.round((data.avgCost * Number(data.quantity || 0)) * 100) / 100;  // 投入成本＝均價×股數
      if (h) await api('/holdings/' + h.id, { method: 'PUT', body: data });
      else await api('/holdings', { method: 'POST', body: data });
      toast('已儲存'); renderPortfolio();
    }
  });
}

function openWatchForm(w) {
  openForm({
    title: w ? '編輯願望清單' : '新增願望清單',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true },
      { key: 'name', label: '說明', type: 'text', placeholder: '例：中國網路' },
      { key: 'targetPrice', label: '目標買價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'currency', label: '幣別', type: 'select', options: CURRENCIES },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號', type: 'text', placeholder: '例：KWEB、ICHN.L' },
      { key: 'note', label: '備註（為什麼等這個價位）', type: 'text', full: true }
    ],
    values: w || { currency: 'USD' },
    onSubmit: async (data) => {
      if (w) await api('/watchlist/' + w.id, { method: 'PUT', body: data });
      else await api('/watchlist', { method: 'POST', body: data });
      toast('已儲存'); renderPortfolio();
    }
  });
}

// ---- 更新報價（持股＋願望清單共用）----
async function refreshQuotes(btn, holdings, watchlist, settings) {
  const FX_SYMS = { 'TWD=X': 'USD', 'GBPTWD=X': 'GBP', 'JPYTWD=X': 'JPY' };   // Yahoo 匯率代號 → 幣別
  const syms = [...new Set([
    ...holdings.map(h => h.quoteSymbol).filter(Boolean),
    ...watchlist.map(w => w.quoteSymbol).filter(Boolean),
    ...Object.keys(FX_SYMS)
  ])];
  if (!syms.length) return toast('沒有可更新的報價代號', true);
  btn.disabled = true; btn.textContent = '更新中…';
  try {
    const quotes = await api('/quotes?symbols=' + encodeURIComponent(syms.join(',')));
    // 匯率自動更新（美元/英鎊/日幣 兌台幣）
    const fxBody = {};
    if (quotes['TWD=X']?.price) fxBody.usdTwd = Math.round(quotes['TWD=X'].price * 1000) / 1000;
    const fxTwd = { ...(settings.fxTwd || {}) };
    if (quotes['GBPTWD=X']?.price) fxTwd.GBP = Math.round(quotes['GBPTWD=X'].price * 1000) / 1000;
    if (quotes['JPYTWD=X']?.price) fxTwd.JPY = Math.round(quotes['JPYTWD=X'].price * 10000) / 10000;
    fxBody.fxTwd = fxTwd;
    if (fxBody.usdTwd || quotes['GBPTWD=X'] || quotes['JPYTWD=X']) await api('/settings', { method: 'PUT', body: fxBody });
    let ok = 0, skip = 0;
    for (const h of holdings) {
      const q = h.quoteSymbol && quotes[h.quoteSymbol];
      if (!q || q.price == null) { if (h.quoteSymbol) skip++; continue; }
      // 防呆：報價幣別與持股幣別不符（例如 GBp）就跳過
      if (q.currency && q.currency.toUpperCase() !== (h.currency || 'USD').toUpperCase()) { skip++; continue; }
      await api('/holdings/' + h.id, { method: 'PUT', body: { price: Math.round(q.price * 100) / 100 } });
      ok++;
    }
    for (const w of watchlist) {
      const q = w.quoteSymbol && quotes[w.quoteSymbol];
      if (!q || q.price == null) continue;
      await api('/watchlist/' + w.id, { method: 'PUT', body: { lastPrice: Math.round(q.price * 100) / 100, lastAt: todayStr() } });
    }
    toast(`已更新 ${ok} 檔報價與匯率${skip ? `，${skip} 檔略過（無資料或幣別不符）` : ''}`);
    renderPortfolio();
  } catch (e) {
    toast('更新失敗：' + e.message, true);
    btn.disabled = false; btn.innerHTML = icon('refresh', 16) + '更新報價';
  }
}

// ---- 列印報表：投資組合（跟隨目前計價：台幣→元/萬、美元→USD/K，A4）----
async function printPortfolioReport(d) {
  const { rows, accounts, fx, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll, loanTwd, netEquity, leverage } = d;
  const rate = fx.USD;
  const isUS = viewCur === 'USD';
  const val = (twd) => isUS
    ? Math.round(Number(twd || 0) / rate).toLocaleString('en-US') + ' USD'
    : Math.round(Number(twd || 0)).toLocaleString('en-US') + ' 元';
  const big = (twd) => MONEY(twd);   // 摘要：萬 / K USD（隨計價）
  const pctf = (n, dd = 1) => (Number(n) || 0).toFixed(dd) + '%';
  const generated = todayStr();

  let cape = null;
  try { cape = await api('/cape'); } catch {}

  // 分層配置表
  const layerRows = LAYER_ORDER.map(k => {
    const cfg = LAYERS[k];
    const v = layerV[k] || 0;
    const pct = total > 0 ? v / total * 100 : 0;
    const status = pct > cfg.max ? '偏高' : pct < cfg.min ? '偏低' : '符合';
    return `<tr><td>${cfg.label}</td><td class="num">${val(v)}</td><td class="num">${pctf(pct)}</td>
      <td class="center">${cfg.min}–${cfg.max}%</td><td class="center">${status}</td></tr>`;
  }).join('');

  // 持股明細（依層分組，沿用頁面排序）
  const cmp = H_SORTERS[hSortKey] || H_SORTERS.value;
  const holdingRows = LAYER_ORDER.map(k => {
    const list = rows.filter(r => (LAYERS[r.layer] ? r.layer : 'satellite') === k).sort(cmp);
    if (hSortDir === 'desc') list.reverse();
    if (!list.length) return '';
    return `<tr><td colspan="8" class="group">${LAYERS[k].label}</td></tr>` + list.map(r => {
      const avg = (r.avgCost != null && r.avgCost !== '') ? r.avgCost : (Number(r.quantity) ? Number(r.cost || 0) / Number(r.quantity) : 0);
      return `<tr>
        <td><b>${esc(r.symbol)}</b></td><td>${esc(r.name || '')}</td>
        <td class="num">${fmtPrice0(avg, r.currency)}</td><td class="num">${fmtPrice0(r.price, r.currency)}</td>
        <td class="num">${val(r.valueTwd)}</td>
        <td class="num">${r.pnlTwd >= 0 ? '+' : ''}${val(r.pnlTwd)}</td>
        <td class="num">${r.costTwd ? pctf(r.pnlTwd / r.costTwd * 100) : '—'}</td>
        <td class="num">${pctf(total > 0 ? r.valueTwd / total * 100 : 0)}</td>
      </tr>`;
    }).join('');
  }).join('');

  // 幣別淨曝險
  const byCur = {};
  const addCur = (cur, orig, twd) => {
    const c = byCur[cur] = byCur[cur] || { orig: 0, twd: 0, debtOrig: 0, debtTwd: 0 };
    if (twd >= 0) { c.orig += orig; c.twd += twd; } else { c.debtOrig += orig; c.debtTwd += twd; }
  };
  rows.forEach(r => addCur(r.currency || 'USD', Number(r.price || 0) * Number(r.quantity || 0), r.valueTwd));
  (accounts || []).forEach(a => { const bal = Number(a.balance || 0); if (!bal) return; const cur = a.currency || 'TWD'; addCur(cur, bal, bal * (fx[cur] || 1)); });
  const curTotal = Object.values(byCur).reduce((s, c) => s + c.twd + c.debtTwd, 0);
  const curRows = Object.entries(byCur).sort((a, b) => (b[1].twd + b[1].debtTwd) - (a[1].twd + a[1].debtTwd)).map(([cur, v]) => {
    const net = v.twd + v.debtTwd, netOrig = v.orig + v.debtOrig;
    return `<tr><td>${esc(cur)}</td>
      <td class="num">${Math.round(netOrig).toLocaleString('en-US')} ${esc(cur)}</td>
      <td class="num">${val(net)}</td>
      <td class="num">${pctf(curTotal ? net / curTotal * 100 : 0)}</td>
      <td>${v.debtTwd < 0 ? `已扣融資 ${Math.round(Math.abs(v.debtOrig)).toLocaleString('en-US')} ${esc(cur)}` : ''}</td></tr>`;
  }).join('');
  const lo = Number(settings.fxLow || 28), hi = Number(settings.fxHigh || 32);
  const fxZone = fx.USD >= hi ? `已進入「美元→台幣」分批區（≥${hi}）` : fx.USD <= lo ? `已進入「台幣→美元」分批區（≤${lo}）` : `中間區（${lo}–${hi}），不動作`;

  // 區域曝險
  const regionRows = Object.entries(regionMap).sort((a, b) => b[1] - a[1]).map(([reg, v]) =>
    `<tr><td>${esc(reg)}</td><td class="num">${val(v)}</td><td class="num">${pctf(eqV > 0 ? v / eqV * 100 : 0)}</td></tr>`).join('');

  // IBKR 現金流與交易摘要（原始為美元，統一轉台幣基準再依計價輸出）
  const inc = settings.ib?.income;
  const fmtD = (x) => x ? `${x.slice(0, 4)}/${x.slice(4, 6)}` : '';
  const divTotal = inc ? (inc.dividends || 0) + (inc.paymentInLieu || 0) : 0;
  const netFlow = inc ? divTotal + (inc.withholdingTax || 0) + (inc.interestPaid || 0) + (inc.interestReceived || 0) : 0;
  const incomeHtml = inc ? `<section><h2>IBKR 現金流 <span>${fmtD(inc.from)}–${fmtD(inc.to)}</span></h2>
    <table><thead><tr><th class="num">股息（含替代股息）</th><th class="num">融資利息</th><th class="num">利息收入</th><th class="num">淨現金流</th></tr></thead>
    <tbody><tr><td class="num">+${val(divTotal * rate)}</td><td class="num">−${val(Math.abs(inc.interestPaid || 0) * rate)}</td>
    <td class="num">+${val((inc.interestReceived || 0) * rate)}</td><td class="num">${netFlow >= 0 ? '+' : '−'}${val(Math.abs(netFlow) * rate)}</td></tr></tbody></table></section>` : '';

  let tradesHtml = '';
  if (ibTrades && ibTrades.length) {
    const { realized, winners, losers, ibkrCurrencies, estimatedCurrencies, missingCurrencies } = tradeSummary(ibTrades, settings);
    const buys = ibTrades.filter(t => t.buySell === 'BUY').length;
    const li = (arr) => arr.map(([s, p]) => `${esc(s)} ${p >= 0 ? '+' : '−'}${val(Math.abs(p) * rate)}`).join('、') || '—';
    const note = ibkrCurrencies.length || estimatedCurrencies.length || missingCurrencies.length
      ? `<p class="muted">${ibkrCurrencies.length ? '註解：換算匯率來自 IBKR。' : ''}${estimatedCurrencies.length ? `${estimatedCurrencies.map(esc).join('、')} 舊交易以目前設定匯率估算。` : ''}${missingCurrencies.length ? `${missingCurrencies.map(esc).join('、')} 交易因缺少匯率暫未計入。` : ''}</p>` : '';
    tradesHtml = `<section><h2>交易摘要 <span>共 ${ibTrades.length} 筆（買 ${buys}／賣 ${ibTrades.length - buys}）</span></h2>
      <table><thead><tr><th>已實現損益（FIFO）</th><th>獲利前三</th><th>虧損前三</th></tr></thead>
      <tbody><tr><td class="num"><b>${realized >= 0 ? '+' : '−'}${val(Math.abs(realized) * rate)}</b></td>
      <td>${li(winners)}</td>
      <td>${li(losers)}</td></tr></tbody></table>${note}</section>`;
  }

  const capeHtml = (cape && cape.value)
    ? `<p class="muted">Shiller PE（CAPE）：<b>${Number(cape.value).toFixed(2)}</b>（歷史分位 ~${capePercentile(Number(cape.value)).toFixed(0)}%，${(CAPE_BANDS.find(b => Number(cape.value) < b.to) || CAPE_BANDS[CAPE_BANDS.length - 1]).label}）</p>` : '';

  const base3 = eqV + bondV + goldAll;
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>投資組合報表 ${generated}</title>
    <style>
      @page { size: A4; margin: 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #2f2b27; background: #ebe6dc; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans TC", "PingFang TC", sans-serif; font-size: 12px; }
      .preview-bar { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(47,43,39,.92); color: #fff; box-shadow: 0 8px 24px rgba(47,43,39,.18); }
      .preview-bar strong { font-size: 14px; }
      .preview-bar button { border: 1px solid rgba(255,255,255,.28); background: #fff; color: #2f2b27; border-radius: 8px; padding: 8px 13px; font: inherit; cursor: pointer; }
      .preview-shell { min-height: 100vh; padding: 24px 18px 42px; }
      .paper { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm; background: #fff; box-shadow: 0 18px 60px rgba(47,43,39,.24); }
      h1, h2 { margin: 0; font-weight: 600; }
      h1 { font-size: 26px; letter-spacing: .02em; }
      h2 { font-size: 16px; margin: 0 0 10px; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ded8cc; padding-bottom: 8px; }
      h2 span { font-size: 13px; color: #c96442; font-weight: 500; }
      .cover { display: flex; justify-content: space-between; gap: 20px; align-items: flex-end; border-bottom: 2px solid #2f2b27; padding-bottom: 16px; margin-bottom: 16px; }
      .muted { color: #8a887f; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
      .metric { border: 1px solid #ded8cc; border-radius: 8px; padding: 12px; }
      .metric span { color: #8a887f; display: block; margin-bottom: 6px; }
      .metric b { font-size: 19px; font-family: Georgia, "Times New Roman", serif; font-weight: 500; }
      .metric small { display: block; color: #8a887f; margin-top: 4px; }
      section { break-inside: avoid; margin: 0 0 18px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
      th, td { text-align: left; border-bottom: 1px solid #ebe6dc; padding: 6px 8px; vertical-align: top; }
      th { color: #777167; background: #f5f1e8; font-size: 11px; font-weight: 600; }
      td.num, th.num, .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .center { text-align: center; }
      td.group { background: #faf7f0; font-weight: 600; }
      footer { margin-top: 14px; border-top: 1px solid #ded8cc; padding-top: 10px; font-size: 10.5px; color: #8a887f; line-height: 1.6; }
      @media (max-width: 900px) { .paper { width: 100%; min-height: auto; } .preview-shell { padding: 14px; } }
      @media print {
        body { background: #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        .preview-bar { display: none; }
        .preview-shell { padding: 0; }
        .paper { width: auto; min-height: auto; margin: 0; padding: 0; box-shadow: none; }
      }
    </style></head><body>
    <div class="preview-bar"><div><strong>投資組合報表預覽</strong></div><button onclick="window.print()">列印 / 另存</button></div>
    <main class="preview-shell"><article class="paper">
      <header class="cover">
        <div><h1>「投資組合」報表</h1>
        <p class="muted">產生日期：${esc(generated)}｜計價：${isUS ? '美元（USD）' : '台幣'}（美元/台幣 ${rate.toFixed(2)}）</p></div>
      </header>
      <div class="summary">
        <div class="metric"><span>總市值</span><b>${big(total)}</b><small>投入成本 ${big(totalCost)}</small></div>
        <div class="metric"><span>損益</span><b>${totalPnl >= 0 ? '+' : ''}${big(totalPnl)}</b><small>累積報酬率 ${totalCost ? pctf(totalPnl / totalCost * 100) : '—'}</small></div>
        <div class="metric"><span>IB 淨值</span><b>${big(netEquity)}</b><small>IB 融資 ${big(loanTwd)}・IB 融資槓桿 ${leverage.toFixed(2)}x</small></div>
        <div class="metric"><span>股 / 債 / 金</span><b>${[eqV, bondV, goldAll].map(v => base3 ? Math.round(v / base3 * 100) : 0).join(' / ')}</b><small>含黃金存摺，不含現金</small></div>
      </div>
      <section><h2>分層配置 vs 目標</h2>
        <table><thead><tr><th>層</th><th class="num">金額</th><th class="num">佔比</th><th class="center">目標區間</th><th class="center">狀態</th></tr></thead>
        <tbody>${layerRows}</tbody></table></section>
      <section><h2>持股明細 <span>共 ${rows.length} 檔</span></h2>
        <table><thead><tr><th>代號</th><th>說明</th><th class="num">均價</th><th class="num">現價</th><th class="num">市值</th><th class="num">損益</th><th class="num">報酬率</th><th class="num">佔比</th></tr></thead>
        <tbody>${holdingRows}</tbody></table></section>
      <section><h2>幣別淨曝險與匯率 <span>${esc(fxZone)}</span></h2>
        <table><thead><tr><th>幣別</th><th class="num">淨曝險（原幣）</th><th class="num">折${isUS ? '美元' : '台幣'}</th><th class="num">佔比</th><th>備註</th></tr></thead>
        <tbody>${curRows}</tbody></table></section>
      <section><h2>持股曝險 <span>佔股票部位 %（已合併 ETF 內含成分）</span></h2>
        <table><thead><tr><th>區域</th><th class="num">金額</th><th class="num">佔股票部位</th></tr></thead>
        <tbody>${regionRows}</tbody></table></section>
      ${incomeHtml}
      ${tradesHtml}
      ${capeHtml}
      <footer>口徑說明：持股成本為 FIFO 成本基礎（與 IBKR 一致，含手續費）；IBKR 部位與現金來自 Flex Query（前一交易日）；報價來自 Yahoo Finance（可能延遲 15–20 分鐘）；融資借款列為負債，淨值＝總部位−融資；區域權重為近似值。本報表僅供個人記錄，非投資建議。</footer>
    </article></main></body></html>`;
  const win = window.open('', '_blank');
  if (!win) return toast('瀏覽器阻擋了列印視窗，請允許彈出視窗後再試一次。', true);
  win.document.open();
  win.document.write(html);
  win.document.close();
}
