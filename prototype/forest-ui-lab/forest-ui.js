// @ts-check
/* global document, getComputedStyle */
// @ts-ignore Browser-root import is served by the prototype's static server.
import { hydrateIcons } from '/modules/icons.js';
import {
  MONTHLY_FOREST_DATA,
  netWorthChangeAt,
  netWorthTrendFor
} from './forest-ui-model.js';

const EXCHANGE_RATE = 32.6;

/** @param {string} selector */
function htmlElement(selector) {
  return /** @type {HTMLElement|null} */ (document.querySelector(selector));
}

/** @param {string} selector */
function imageElement(selector) {
  return /** @type {HTMLImageElement|null} */ (document.querySelector(selector));
}

/** @param {string} selector @param {string} value */
function setText(selector, value) {
  const element = htmlElement(selector);
  if (element) element.textContent = value;
}

/** @param {number} value @param {boolean=} signed */
function formatWan(value, signed = false) {
  const absolute = Math.abs(value).toLocaleString('zh-TW', { maximumFractionDigits: 1 });
  if (!signed || value === 0) return `${value < 0 ? '−' : ''}${absolute} 萬`;
  return `${value > 0 ? '+' : '−'}${absolute} 萬`;
}

/** @param {number} value @param {boolean=} signed */
function formatUsdK(value, signed = false) {
  const converted = Math.abs(value) * 10 / EXCHANGE_RATE;
  const number = converted.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (!signed || value === 0) return `${value < 0 ? '−' : ''}${number}K`;
  return `${value > 0 ? '+' : '−'}${number}K`;
}

/** @param {number|null} value */
function formatSignedPct(value) {
  if (value === null || !Number.isFinite(value)) return '無法計算比例';
  if (value < 0) return `−${Math.abs(value).toFixed(1)}%`;
  if (value > 0) return `+${value.toFixed(1)}%`;
  return '0.0%';
}

/** @param {number} amount */
function changePhrase(amount) {
  if (amount > 0) return `增加 ${formatWan(amount)}`;
  if (amount < 0) return `減少 ${formatWan(Math.abs(amount))}`;
  return '沒有變動';
}

/** @param {string} selector @param {number} value @param {boolean=} signed */
function setCurrencyValue(selector, value, signed = false) {
  const element = htmlElement(selector);
  if (!element) return;
  element.dataset.twd = formatWan(value, signed);
  element.dataset.usd = formatUsdK(value, signed);
}

let selectedCurrency = 'TWD';
/** @type {any} */
let cashflowChart;
/** @type {any} */
let netWorthChart;

function renderCurrencyValues() {
  document.querySelectorAll('[data-currency]').forEach((item) => {
    const button = /** @type {HTMLButtonElement} */ (item);
    const isActive = button.dataset.currency === selectedCurrency;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  document.querySelectorAll('.js-value').forEach((item) => {
    const element = /** @type {HTMLElement} */ (item);
    element.textContent = selectedCurrency === 'USD' ? element.dataset.usd || '' : element.dataset.twd || '';
  });
}

function renderCurrentMonth() {
  const selectedMonthIndex = MONTHLY_FOREST_DATA.length - 1;
  const month = MONTHLY_FOREST_DATA[selectedMonthIndex];
  if (!month) return;
  const change = netWorthChangeAt(MONTHLY_FOREST_DATA, selectedMonthIndex);
  const amount = change?.amount ?? 0;
  const pct = change?.pct ?? null;
  const hasComparablePct = Boolean(change && pct !== null);
  const cashflowNet = month.income - month.expense;
  const periodMonths = MONTHLY_FOREST_DATA.slice(-12);
  const averageCashflow = periodMonths.reduce((total, item) => total + item.income - item.expense, 0) / periodMonths.length;
  const trend = netWorthTrendFor(periodMonths);

  setText('#currentMonthLabel', month.yearLabel);
  setText('#scene-title', !change
    ? '從這個月開始記錄淨資產'
    : `本月淨資產${changePhrase(amount)}`);
  setText('#sceneSummary', !change
    ? '這是時間軸中的第一筆資料，尚無上月底資料可比較。'
    : hasComparablePct
      ? `較上月底${changePhrase(amount)}。這是整體淨資產變動，不等於投資報酬率。`
      : `較上月底${changePhrase(amount)}。上月底淨資產為 0，無法計算變動比例；這不等於投資報酬率。`);
  setText('#monthChangeAmount', change ? formatWan(amount, true) : '尚無比較');
  setText('#monthChangePct', !change ? '首筆資料' : formatSignedPct(pct));
  setCurrencyValue('#netWorthValue', month.netWorth);
  setCurrencyValue('#netWorthTrendValue', month.netWorth);
  setCurrencyValue('#cashflowNetValue', cashflowNet, true);
  setCurrencyValue('#cashflowAverageValue', averageCashflow);
  if (trend) {
    const trendText = trend.pct === null
      ? `12 個月${changePhrase(trend.amount)}`
      : `12 個月${changePhrase(trend.amount)}（${formatSignedPct(trend.pct)}）`;
    setText('#netWorthTrendChange', trendText);
    const trendChange = htmlElement('#netWorthTrendChange');
    if (trendChange) {
      trendChange.classList.toggle('positive', trend.amount > 0);
      trendChange.classList.toggle('negative', trend.amount < 0);
    }
  }
  setText('#netWorthDeltaText', change ? `比上月底${changePhrase(amount)}` : '尚無上月底資料');
  const deltaText = htmlElement('#netWorthDeltaText');
  if (deltaText) {
    deltaText.classList.toggle('positive', amount > 0);
    deltaText.classList.toggle('negative', amount < 0);
  }
  setText('#cashflowIncomeText', `收入 ${formatWan(month.income)}・支出 ${formatWan(month.expense)}`);
  setText('#emergencyFundValue', `${month.emergencyMonths.toFixed(1)} 個月`);
  const emergencyText = htmlElement('#emergencyFundText');
  if (emergencyText) {
    const emergencyHealthy = month.emergencyMonths >= 6;
    emergencyText.textContent = emergencyHealthy ? '高於 6 個月目標' : '低於 6 個月目標';
    emergencyText.classList.toggle('positive', emergencyHealthy);
    emergencyText.classList.toggle('negative', !emergencyHealthy);
  }
  setText('#disciplineValue', `${month.discipline} / 5`);
  setText('#disciplineText', month.discipline >= 5 ? '所有檢查均在範圍內' : month.discipline === 4 ? '一項接近上限' : '兩項需要複查');
  const disciplineText = htmlElement('#disciplineText');
  if (disciplineText) {
    disciplineText.classList.remove('positive', 'warning', 'negative');
    disciplineText.classList.add(month.discipline >= 5 ? 'positive' : month.discipline === 4 ? 'warning' : 'negative');
  }
  const statusMark = htmlElement('#returnStatusMark');
  if (statusMark) statusMark.className = `status-mark ${amount > 0 ? 'good' : amount < 0 ? 'watch' : 'calm'}`;
  setText('#returnStatusTitle', change ? `本月淨資產${changePhrase(amount)}` : '本月為第一筆淨資產資料');
  setText('#returnStatusDetail', !change
    ? '下個月起才能與上月底比較；目前先建立基準。'
    : hasComparablePct
      ? '包含收支、投資市值、匯率與負債變化，不等於投資報酬率。'
      : '金額變動仍有意義；但上月底淨資產為 0，因此不顯示變動比例。');
  setText('#guideDialogMonth', month.yearLabel);
  setText('#guideDialogChange', !change
    ? '第一筆淨資產基準'
    : `淨資產${changePhrase(amount)}（${formatSignedPct(pct)}）`);
  setText('#guideDialogText', !change
    ? '這個月先建立淨資產基準；下一筆月資料建立後，才能形成可比較的月變動。'
    : hasComparablePct
      ? '這是整體淨資產變動，包含收支、投資市值、匯率與負債變化，不等於投資報酬率。'
      : '這個月仍可顯示淨資產金額變動；但上月底淨資產為 0，無法計算有意義的變動比例。');
  renderCurrencyValues();
  drawCharts();
}

/** @type {Record<string, {name:string,sector:string,eps:number,price:number,growth:number,terminalPe:number}>} */
const valuationStocks = {
  AAPL: { name: 'Apple Inc.', sector: '美國・消費科技', eps: 6.43, price: 214.29, growth: 8, terminalPe: 24 },
  GOOGL: { name: 'Alphabet Inc.', sector: '美國・數位廣告與雲端', eps: 8.1, price: 191.2, growth: 12, terminalPe: 22 },
  TSM: { name: 'TSMC (ADR)', sector: '台灣・半導體', eps: 6.72, price: 205.5, growth: 15, terminalPe: 20 }
};

let selectedValuationStock = 'TSM';

/** @param {number} value @param {number} decimals */
function formatUsd(value, decimals = 0) {
  return `US$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** @param {HTMLInputElement} input */
function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const fill = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--range-fill', `${fill}%`);
}

/** @param {string} selector @param {number} value @param {number} max */
function setBarWidth(selector, value, max) {
  const bar = htmlElement(selector);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, value / max * 100))}%`;
}

function renderValuation() {
  const stock = valuationStocks[selectedValuationStock];
  const growthInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#growthRange'));
  const terminalPeInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#terminalPeRange'));
  const discountInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#discountRange'));
  if (!stock || !growthInput || !terminalPeInput || !discountInput) return;

  const growth = Number(growthInput.value);
  const terminalPe = Number(terminalPeInput.value);
  const discount = Number(discountInput.value);
  const futureEps = stock.eps * Math.pow(1 + growth / 100, 5);
  const fairValue = futureEps * terminalPe / Math.pow(1 + discount / 100, 5);
  const premium = stock.price / fairValue - 1;
  const axisMax = Math.ceil(Math.max(fairValue, stock.price) * 1.12 / 10) * 10;
  const fairText = formatUsd(fairValue);
  const priceText = formatUsd(stock.price, 2);

  setText('#valuationTicker', selectedValuationStock);
  setText('#valuationCompany', stock.name);
  setText('#valuationSector', stock.sector);
  setText('#growthValue', `${growth}%`);
  setText('#terminalPeValue', `${terminalPe}×`);
  setText('#discountValue', `${discount}%`);
  growthInput.setAttribute('aria-valuetext', `${growth}%`);
  terminalPeInput.setAttribute('aria-valuetext', `${terminalPe} 倍`);
  discountInput.setAttribute('aria-valuetext', `${discount}%`);
  ['#fairValue', '#fairBarValue'].forEach((selector) => setText(selector, fairText));
  ['#marketPrice', '#priceBarValue'].forEach((selector) => setText(selector, priceText));
  setText('#valueAxisMax', formatUsd(axisMax));
  setBarWidth('#fairBar', fairValue, axisMax);
  setBarWidth('#priceBar', stock.price, axisMax);

  const verdict = htmlElement('#valuationVerdict');
  const guide = imageElement('#valuationGuide');
  if (premium > .1) {
    if (verdict) verdict.dataset.tone = 'watch';
    if (guide) {
      guide.src = 'assets/guide-return-negative.webp';
      guide.alt = '審慎提醒的小森森';
    }
    setText('#verdictText', '高於估算值，先保留安全邊際');
    setText('#premiumText', `目前價格較估算合理價高 ${Math.round(premium * 100)}%`);
    setText('#valuationNote', '請再用較保守的成長率與終值倍數試算，確認結論不依賴單一樂觀假設。');
  } else if (premium < -.15) {
    if (verdict) verdict.dataset.tone = 'good';
    if (guide) {
      guide.src = 'assets/guide-return-positive.webp';
      guide.alt = '微笑提醒的小森森';
    }
    setText('#verdictText', '低於估算值，仍須確認基本面');
    setText('#premiumText', `目前價格較估算合理價低 ${Math.round(Math.abs(premium) * 100)}%`);
    setText('#valuationNote', '估值折價只是研究起點；請先確認競爭優勢與財務體質沒有明顯惡化。');
  } else {
    if (verdict) verdict.dataset.tone = 'calm';
    if (guide) {
      guide.src = 'assets/guide-return-neutral.webp';
      guide.alt = '平靜提醒的小森森';
    }
    setText('#verdictText', '接近估算區間，適合分批評估');
    setText('#premiumText', `目前價格與估算合理價相差約 ${Math.round(Math.abs(premium) * 100)}%`);
    setText('#valuationNote', '估值是一個區間，不是單一答案。請用保守、基準與樂觀三組假設交叉檢查。');
  }
  [growthInput, terminalPeInput, discountInput].forEach(updateRangeFill);
}

function drawCharts() {
  const cashflowCanvas = /** @type {HTMLCanvasElement|null} */ (document.querySelector('#cashflowChart'));
  const netWorthCanvas = /** @type {HTMLCanvasElement|null} */ (document.querySelector('#netWorthChart'));
  const ChartCtor = /** @type {any} */ (globalThis).Chart;
  if (!cashflowCanvas || !netWorthCanvas || !ChartCtor) return;
  const series = MONTHLY_FOREST_DATA.slice(-12);
  const style = getComputedStyle(document.documentElement);
  const leaf = style.getPropertyValue('--leaf').trim() || '#568a3d';
  const coral = style.getPropertyValue('--coral').trim() || '#a84f2d';
  const sky = '#4e7089';
  const animationDuration = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;

  cashflowCanvas.setAttribute('aria-label', `過去 ${series.length} 個月收入、支出與結餘折線圖`);
  cashflowChart?.destroy();
  cashflowChart = new ChartCtor(cashflowCanvas, {
    type: 'line',
    data: {
      labels: series.map((month) => month.label),
      datasets: [
        { label: '收入', data: series.map((month) => month.income), borderColor: leaf, backgroundColor: leaf, borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '支出', data: series.map((month) => month.expense), borderColor: coral, backgroundColor: coral, borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '結餘', data: series.map((month) => month.income - month.expense), borderColor: sky, backgroundColor: sky, borderWidth: 2, pointRadius: 2, borderDash: [5, 5], tension: .28 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: animationDuration },
      plugins: { legend: { display: false }, tooltip: { padding: 10, cornerRadius: 6, displayColors: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#746550', font: { size: 10, family: 'Arial Rounded MT Bold, PingFang TC, sans-serif' } }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: '#e5dbc2', borderDash: [3, 3] }, ticks: { color: '#746550', callback: (/** @type {number|string} */ value) => `${value}萬`, font: { size: 9 } }, border: { display: false } }
      }
    }
  });

  const trend = netWorthTrendFor(series);
  netWorthCanvas.setAttribute('aria-label', trend
    ? `過去 ${series.length} 個月淨資產趨勢，從 ${formatWan(trend.first)} 到 ${formatWan(trend.last)}`
    : '過去十二個月淨資產趨勢圖');
  netWorthChart?.destroy();
  netWorthChart = new ChartCtor(netWorthCanvas, {
    type: 'line',
    data: {
      labels: series.map((month) => month.label),
      datasets: [{
        label: '淨資產',
        data: series.map((month) => month.netWorth),
        borderColor: leaf,
        backgroundColor: 'rgba(86, 138, 61, .16)',
        borderWidth: 3,
        fill: true,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: .24
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: animationDuration },
      plugins: {
        legend: { display: false },
        tooltip: {
          padding: 10,
          cornerRadius: 6,
          displayColors: false,
          callbacks: { label: (/** @type {{parsed:{y:number}}} */ context) => `淨資產 ${formatWan(context.parsed.y)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#746550', font: { size: 10, family: 'Arial Rounded MT Bold, PingFang TC, sans-serif' } }, border: { display: false } },
        y: { beginAtZero: false, grid: { color: '#e5dbc2', borderDash: [3, 3] }, ticks: { color: '#746550', callback: (/** @type {number|string} */ value) => `${value}萬`, font: { size: 9 } }, border: { display: false } }
      }
    }
  });
}

document.querySelectorAll('[data-stock]').forEach((button) => {
  button.addEventListener('click', () => {
    const symbol = /** @type {HTMLElement} */ (button).dataset.stock || '';
    const stock = valuationStocks[symbol];
    const growthInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#growthRange'));
    const terminalPeInput = /** @type {HTMLInputElement|null} */ (document.querySelector('#terminalPeRange'));
    if (!stock || !growthInput || !terminalPeInput) return;
    selectedValuationStock = symbol;
    growthInput.value = String(stock.growth);
    terminalPeInput.value = String(stock.terminalPe);
    document.querySelectorAll('[data-stock]').forEach((item) => item.classList.toggle('active', item === button));
    renderValuation();
  });
});

document.querySelectorAll('.assumption-control input[type="range"]').forEach((input) => {
  input.addEventListener('input', renderValuation);
});

document.querySelectorAll('[data-currency]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedCurrency = /** @type {HTMLElement} */ (button).dataset.currency === 'USD' ? 'USD' : 'TWD';
    renderCurrencyValues();
  });
});

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    const filter = /** @type {HTMLElement} */ (button).dataset.filter || 'all';
    document.querySelectorAll('[data-filter]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('tbody tr[data-kind]').forEach((row) => {
      const kind = /** @type {HTMLElement} */ (row).dataset.kind;
      row.toggleAttribute('hidden', filter !== 'all' && kind !== filter);
    });
  });
});

const reminderDialog = /** @type {HTMLDialogElement|null} */ (document.querySelector('#reminderDialog'));
const notebookDialog = /** @type {HTMLDialogElement|null} */ (document.querySelector('#notebookDialog'));
const guideDialog = /** @type {HTMLDialogElement|null} */ (document.querySelector('#guideDialog'));
document.querySelector('#openReminder')?.addEventListener('click', () => reminderDialog?.showModal());
document.querySelector('#openNotebook')?.addEventListener('click', () => notebookDialog?.showModal());
document.querySelector('#openGuide')?.addEventListener('click', () => guideDialog?.showModal());

document.querySelectorAll('.forest-dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) /** @type {HTMLDialogElement} */ (dialog).close();
  });
});

document.querySelectorAll('.trail-nav a').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.trail-nav a').forEach((item) => item.classList.toggle('active', item === link));
    link.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
});

function syncTrailWithHash() {
  const hash = globalThis.location.hash || '#overview';
  document.querySelectorAll('.trail-nav a').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === hash);
  });
}

globalThis.addEventListener('hashchange', syncTrailWithHash);

hydrateIcons();
document.querySelectorAll('[data-filter], [data-stock]').forEach((item) => {
  item.setAttribute('aria-pressed', String(item.classList.contains('active')));
});
renderValuation();
renderCurrentMonth();
syncTrailWithHash();
