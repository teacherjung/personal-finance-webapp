// @ts-check
/* global document, getComputedStyle, localStorage, Element, HTMLSelectElement */
// @ts-ignore Browser-root import is served by the prototype's static server.
import { hydrateIcons } from '/modules/icons.js';
import {
  MONTHLY_FOREST_DATA,
  FOREST_ATMOSPHERES,
  DEFAULT_CARD_LAYOUT,
  allowedSizesForCard,
  atmosphereForChange,
  moveCard,
  netWorthChangeAt,
  normalizeCardLayout
} from './forest-ui-model.js';

const EXCHANGE_RATE = 32.6;
const AMBIENCE_KEY = 'forest.ui.ambience.v1';
const LAYOUT_KEY = 'forest.ui.layout.v1';
const sizeLabels = /** @type {Record<string, string>} */ ({ compact: '精簡', standard: '標準', wide: '加寬', full: '滿版' });

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
let selectedPeriod = 12;
let selectedMonthIndex = MONTHLY_FOREST_DATA.length - 1;
/** @type {any} */
let chart;

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

/** @param {number} index */
function monthStateAt(index) {
  const change = netWorthChangeAt(MONTHLY_FOREST_DATA, index);
  if (!change || change.pct === null) return 'neutral';
  return atmosphereForChange(change.pct);
}

function buildMonthTrail() {
  const track = htmlElement('#monthTrack');
  if (!track) return;
  track.replaceChildren();
  MONTHLY_FOREST_DATA.forEach((month, index) => {
    const change = netWorthChangeAt(MONTHLY_FOREST_DATA, index);
    const state = monthStateAt(index);
    const atmosphere = FOREST_ATMOSPHERES[state];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'month-dot';
    button.id = `forest-month-${month.key}`;
    button.dataset.monthIndex = String(index);
    button.dataset.state = state;
    button.dataset.comparison = !change ? 'baseline' : change.pct === null ? 'zero-base' : 'comparable';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === selectedMonthIndex));
    button.tabIndex = index === selectedMonthIndex ? 0 : -1;
    button.setAttribute('aria-label', !change
      ? `${month.yearLabel}，第一筆資料，尚無比較`
      : change.pct === null
        ? `${month.yearLabel}，上月底淨資產為零，無法計算變動比例`
        : `${month.yearLabel}，${atmosphere.statusLabel}，${formatSignedPct(change.pct)}`);
    button.textContent = month.label;
    button.title = button.getAttribute('aria-label') || month.yearLabel;
    button.addEventListener('click', () => {
      selectedMonthIndex = index;
      renderSelectedMonth();
    });
    track.append(button);
  });
}

function updateMonthTrailSelection() {
  document.querySelectorAll('[data-month-index]').forEach((item) => {
    const button = /** @type {HTMLButtonElement} */ (item);
    const active = Number(button.dataset.monthIndex) === selectedMonthIndex;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) {
      const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
      button.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  });
  const previous = /** @type {HTMLButtonElement|null} */ (document.querySelector('#previousMonth'));
  const next = /** @type {HTMLButtonElement|null} */ (document.querySelector('#nextMonth'));
  if (previous) previous.setAttribute('aria-disabled', String(selectedMonthIndex <= 0));
  if (next) next.setAttribute('aria-disabled', String(selectedMonthIndex >= MONTHLY_FOREST_DATA.length - 1));
}

function renderSelectedMonth() {
  const month = MONTHLY_FOREST_DATA[selectedMonthIndex];
  if (!month) return;
  const change = netWorthChangeAt(MONTHLY_FOREST_DATA, selectedMonthIndex);
  const amount = change?.amount ?? 0;
  const pct = change?.pct ?? null;
  const hasComparablePct = Boolean(change && pct !== null);
  const state = hasComparablePct ? atmosphereForChange(/** @type {number} */ (pct)) : 'neutral';
  const atmosphere = FOREST_ATMOSPHERES[state];
  const cashflowNet = month.income - month.expense;
  const windowStart = Math.max(0, selectedMonthIndex - selectedPeriod + 1);
  const periodMonths = MONTHLY_FOREST_DATA.slice(windowStart, selectedMonthIndex + 1);
  const averageCashflow = periodMonths.reduce((total, item) => total + item.income - item.expense, 0) / periodMonths.length;

  document.body.dataset.weather = state;
  setText('#selectedMonthLabel', `${month.yearLabel}・合成情境`);
  const scene = htmlElement('.forest-scene');
  if (scene) scene.dataset.weather = state;
  const sceneArt = imageElement('#sceneArt');
  if (sceneArt) {
    sceneArt.src = atmosphere.scene;
    sceneArt.alt = atmosphere.sceneAlt;
  }
  [imageElement('#guidePortrait'), imageElement('#guideDialogPortrait')].forEach((guide) => {
    if (!guide) return;
    guide.src = atmosphere.guide;
    guide.alt = atmosphere.guideAlt;
  });
  setText('#scene-title', !change
    ? '從這個月開始記錄淨資產'
    : hasComparablePct
      ? atmosphere.heading
      : '本月淨資產已有金額變動');
  setText('#sceneSummary', !change
    ? '這是時間軸中的第一筆資料，尚無上月底資料可比較。'
    : hasComparablePct
      ? `較上月底${changePhrase(amount)}。這是整體淨資產變動，不等於投資報酬率。`
      : `較上月底${changePhrase(amount)}。上月底淨資產為 0，無法計算變動比例；這不等於投資報酬率。`);
  setText('#monthChangeAmount', change ? formatWan(amount, true) : '尚無比較');
  setText('#monthChangePct', !change ? '首筆資料' : formatSignedPct(pct));
  setCurrencyValue('#netWorthValue', month.netWorth);
  setCurrencyValue('#cashflowNetValue', cashflowNet, true);
  setCurrencyValue('#cashflowAverageValue', averageCashflow);
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
  if (statusMark) statusMark.className = `status-mark ${atmosphere.statusClass}`;
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
  updateMonthTrailSelection();
  drawChart();
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

function drawChart() {
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.querySelector('#cashflowChart'));
  const ChartCtor = /** @type {any} */ (globalThis).Chart;
  if (!canvas || !ChartCtor) return;
  const start = Math.max(0, selectedMonthIndex - selectedPeriod + 1);
  const series = MONTHLY_FOREST_DATA.slice(start, selectedMonthIndex + 1);
  canvas.setAttribute('aria-label', `過去 ${series.length} 個月收入、支出與結餘折線圖`);
  const style = getComputedStyle(document.documentElement);
  const leaf = style.getPropertyValue('--leaf').trim() || '#568a3d';
  const coral = style.getPropertyValue('--coral').trim() || '#a84f2d';
  chart?.destroy();
  chart = new ChartCtor(canvas, {
    type: 'line',
    data: {
      labels: series.map((month) => month.label),
      datasets: [
        { label: '收入', data: series.map((month) => month.income), borderColor: leaf, backgroundColor: leaf, borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '支出', data: series.map((month) => month.expense), borderColor: coral, backgroundColor: coral, borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '結餘', data: series.map((month) => month.income - month.expense), borderColor: '#4e7089', backgroundColor: '#4e7089', borderWidth: 2, pointRadius: 2, borderDash: [5, 5], tension: .28 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: document.body.dataset.ambience === 'static' ? 0 : 180 },
      plugins: { legend: { display: false }, tooltip: { padding: 10, cornerRadius: 6, displayColors: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#746550', font: { size: 10, family: 'Arial Rounded MT Bold, PingFang TC, sans-serif' } }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: '#e5dbc2', borderDash: [3, 3] }, ticks: { color: '#746550', callback: (/** @type {number|string} */ value) => `${value}萬`, font: { size: 9 } }, border: { display: false } }
      }
    }
  });
}

/** @returns {string} */
function readAmbience() {
  try {
    const stored = localStorage.getItem(AMBIENCE_KEY);
    return stored && ['static', 'gentle', 'immersive'].includes(stored) ? stored : 'gentle';
  } catch {
    return 'gentle';
  }
}

/** @param {string} value */
function setAmbience(value) {
  const ambience = ['static', 'gentle', 'immersive'].includes(value) ? value : 'gentle';
  document.body.dataset.ambience = ambience;
  document.querySelectorAll('[data-ambience]').forEach((item) => {
    const button = /** @type {HTMLButtonElement} */ (item);
    const active = button.dataset.ambience === ambience;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  try {
    localStorage.setItem(AMBIENCE_KEY, ambience);
  } catch {
    // The prototype remains usable when storage is unavailable.
  }
  drawChart();
}

/** @returns {{id:string,size:string}[]} */
function readCardLayout() {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    return normalizeCardLayout(stored ? JSON.parse(stored) : DEFAULT_CARD_LAYOUT);
  } catch {
    return normalizeCardLayout(DEFAULT_CARD_LAYOUT);
  }
}

/** @param {{id:string,size:string}[]} layout */
function saveCardLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(normalizeCardLayout(layout)));
  } catch {
    // Persistence is optional; layout changes still apply to this session.
  }
}

/** @param {string} message */
function announceLayout(message) {
  setText('#layoutStatus', message);
}

const dashboard = htmlElement('#customDashboard');
let cardLayout = readCardLayout();
let draggedCardId = '';
let focusedCardId = '';

/** @param {{id:string,action:string}=} focusTarget */
function applyCardLayout(focusTarget) {
  if (!dashboard) return;
  cardLayout = normalizeCardLayout(cardLayout);
  cardLayout.forEach((item, index) => {
    const card = /** @type {HTMLElement|null} */ (dashboard.querySelector(`[data-card-id="${item.id}"]`));
    if (!card) return;
    card.dataset.size = item.size;
    const select = /** @type {HTMLSelectElement|null} */ (card.querySelector('.card-size-select'));
    if (select) select.value = item.size;
    card.querySelector('[data-card-action="previous"]')?.setAttribute('aria-disabled', String(index === 0));
    card.querySelector('[data-card-action="next"]')?.setAttribute('aria-disabled', String(index === cardLayout.length - 1));
    dashboard.append(card);
  });
  if (focusTarget) {
    const control = /** @type {HTMLElement|null} */ (dashboard.querySelector(`[data-card-id="${focusTarget.id}"] [data-card-action="${focusTarget.action}"]`));
    control?.focus();
  }
}

function buildCardToolbars() {
  if (!dashboard) return;
  dashboard.querySelectorAll('.layout-card').forEach((item) => {
    const card = /** @type {HTMLElement} */ (item);
    const id = card.dataset.cardId || '';
    const label = card.dataset.cardLabel || '卡片';
    const toolbar = document.createElement('div');
    toolbar.className = 'layout-card-toolbar';
    toolbar.setAttribute('aria-label', `${label}版面工具`);
    toolbar.innerHTML = `
      <button class="drag-handle" type="button" draggable="true" data-card-action="drag" title="拖曳移動" aria-label="拖曳移動${label}"><span data-icon="grip"></span></button>
      <button type="button" data-card-action="previous" title="往前移" aria-label="將${label}往前移">←</button>
      <button type="button" data-card-action="next" title="往後移" aria-label="將${label}往後移">→</button>
      <select class="card-size-select" data-card-action="size" aria-label="${label}大小"></select>
      <button class="card-focus" type="button" data-card-action="focus" title="聚焦卡片" aria-label="聚焦${label}" aria-pressed="false">□</button>`;
    const select = /** @type {HTMLSelectElement|null} */ (toolbar.querySelector('select'));
    if (select) {
      allowedSizesForCard(id).forEach((size) => {
        const option = document.createElement('option');
        option.value = size;
        option.textContent = sizeLabels[size] || size;
        select.append(option);
      });
    }
    card.prepend(toolbar);
  });
  hydrateIcons(dashboard);
}

/** @param {boolean} enabled */
function setLayoutEditing(enabled) {
  if (!globalThis.matchMedia('(min-width: 821px)').matches) enabled = false;
  document.body.classList.toggle('layout-editing', enabled);
  const bar = htmlElement('#layoutBar');
  if (bar) bar.hidden = !enabled;
  const toggle = /** @type {HTMLButtonElement|null} */ (document.querySelector('#layoutToggle'));
  if (toggle) toggle.setAttribute('aria-pressed', String(enabled));
  announceLayout(enabled ? '版面調整模式已開啟。可拖曳、用箭頭移動，或選擇卡片大小。' : '版面調整完成。');
}

/** @param {string} id */
function setFocusedCard(id) {
  const backdrop = htmlElement('#focusBackdrop');
  const previousId = focusedCardId;
  const card = /** @type {HTMLElement|null} */ (id ? dashboard?.querySelector(`[data-card-id="${id}"]`) || null : null);
  if (id && !card) id = '';
  if (id) setLayoutEditing(false);
  dashboard?.querySelectorAll('.layout-card').forEach((item) => item.classList.remove('is-focused'));
  focusedCardId = id;
  document.body.classList.toggle('card-focused', Boolean(id));
  if (backdrop) backdrop.hidden = !id;
  dashboard?.querySelectorAll('.card-focus').forEach((item) => item.setAttribute('aria-pressed', 'false'));
  document.querySelectorAll('.forest-rail, .topbar, .month-trail, .forest-scene, .layout-card').forEach((item) => {
    const element = /** @type {HTMLElement} */ (item);
    element.inert = Boolean(id) && element !== card;
  });
  if (!id) {
    const restore = /** @type {HTMLElement|null} */ (previousId ? dashboard?.querySelector(`[data-card-id="${previousId}"] [data-card-action="focus"]`) || null : null);
    const restoreCard = /** @type {HTMLElement|null} */ (previousId ? dashboard?.querySelector(`[data-card-id="${previousId}"]`) || null : null);
    if (restore?.offsetParent) restore.focus();
    else if (restoreCard) {
      restoreCard.tabIndex = -1;
      restoreCard.focus({ preventScroll: true });
    }
    chart?.resize();
    return;
  }
  if (!card) return;
  card.classList.add('is-focused');
  const focusButton = /** @type {HTMLElement|null} */ (card.querySelector('.card-focus'));
  focusButton?.setAttribute('aria-pressed', 'true');
  focusButton?.focus();
  card.scrollIntoView({ block: 'center', behavior: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  globalThis.setTimeout(() => chart?.resize(), 220);
}

buildCardToolbars();
applyCardLayout();

dashboard?.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement|null} */ (event.target instanceof Element ? event.target.closest('[data-card-action]') : null);
  if (!target) return;
  const card = /** @type {HTMLElement|null} */ (target.closest('[data-card-id]'));
  const id = card?.dataset.cardId || '';
  const action = target.dataset.cardAction;
  if (!id || action === 'drag' || action === 'size') return;
  if (action === 'previous' || action === 'next') {
    if (target.getAttribute('aria-disabled') === 'true') {
      announceLayout(`${card?.dataset.cardLabel || '卡片'}已在${action === 'previous' ? '最前方' : '最後方'}。`);
      return;
    }
    cardLayout = moveCard(cardLayout, id, action === 'previous' ? -1 : 1);
    saveCardLayout(cardLayout);
    applyCardLayout({ id, action });
    announceLayout(`${card?.dataset.cardLabel || '卡片'}已${action === 'previous' ? '往前' : '往後'}移動。`);
  }
  if (action === 'focus') setFocusedCard(focusedCardId === id ? '' : id);
});

dashboard?.addEventListener('change', (event) => {
  const select = /** @type {HTMLSelectElement|null} */ (event.target instanceof HTMLSelectElement ? event.target : null);
  if (!select || select.dataset.cardAction !== 'size') return;
  const card = /** @type {HTMLElement|null} */ (select.closest('[data-card-id]'));
  const id = card?.dataset.cardId || '';
  cardLayout = cardLayout.map((item) => item.id === id ? { ...item, size: select.value } : item);
  cardLayout = normalizeCardLayout(cardLayout);
  saveCardLayout(cardLayout);
  applyCardLayout({ id, action: 'size' });
  announceLayout(`${card?.dataset.cardLabel || '卡片'}已改為${sizeLabels[select.value] || select.value}。`);
});

dashboard?.addEventListener('dragstart', (event) => {
  const handle = /** @type {HTMLElement|null} */ (event.target instanceof Element ? event.target.closest('.drag-handle') : null);
  const card = /** @type {HTMLElement|null} */ (handle?.closest('[data-card-id]') || null);
  if (!handle || !card || !document.body.classList.contains('layout-editing')) {
    event.preventDefault();
    return;
  }
  draggedCardId = card.dataset.cardId || '';
  card.classList.add('is-dragging');
  event.dataTransfer?.setData('text/plain', draggedCardId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
});

dashboard?.addEventListener('dragover', (event) => {
  if (!draggedCardId || !document.body.classList.contains('layout-editing')) return;
  const target = /** @type {HTMLElement|null} */ (event.target instanceof Element ? event.target.closest('.layout-card') : null);
  if (!target || target.dataset.cardId === draggedCardId) return;
  event.preventDefault();
  dashboard.querySelectorAll('.drop-before').forEach((item) => item.classList.remove('drop-before'));
  target.classList.add('drop-before');
});

dashboard?.addEventListener('drop', (event) => {
  if (!draggedCardId) return;
  const target = /** @type {HTMLElement|null} */ (event.target instanceof Element ? event.target.closest('.layout-card') : null);
  if (!target || target.dataset.cardId === draggedCardId) return;
  event.preventDefault();
  const dragged = cardLayout.find((item) => item.id === draggedCardId);
  const rest = cardLayout.filter((item) => item.id !== draggedCardId);
  const targetIndex = rest.findIndex((item) => item.id === target.dataset.cardId);
  if (dragged && targetIndex >= 0) rest.splice(targetIndex, 0, dragged);
  cardLayout = normalizeCardLayout(rest);
  saveCardLayout(cardLayout);
  applyCardLayout({ id: draggedCardId, action: 'drag' });
  announceLayout(`${target.dataset.cardLabel || '卡片'}前方已插入新位置。`);
});

dashboard?.addEventListener('dragend', () => {
  draggedCardId = '';
  dashboard.querySelectorAll('.is-dragging, .drop-before').forEach((item) => item.classList.remove('is-dragging', 'drop-before'));
});

document.querySelector('#layoutToggle')?.addEventListener('click', () => setLayoutEditing(!document.body.classList.contains('layout-editing')));
document.querySelector('#finishLayout')?.addEventListener('click', () => setLayoutEditing(false));
document.querySelector('#resetLayout')?.addEventListener('click', () => {
  cardLayout = normalizeCardLayout(DEFAULT_CARD_LAYOUT);
  saveCardLayout(cardLayout);
  applyCardLayout();
  announceLayout('已恢復預設版面。');
});
document.querySelector('#focusBackdrop')?.addEventListener('click', () => setFocusedCard(''));

const desktopMedia = globalThis.matchMedia('(min-width: 821px)');
desktopMedia.addEventListener('change', () => {
  if (!desktopMedia.matches) {
    setLayoutEditing(false);
    setFocusedCard('');
  }
});

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

document.querySelectorAll('[data-period]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedPeriod = Number(/** @type {HTMLElement} */ (button).dataset.period) === 6 ? 6 : 12;
    document.querySelectorAll('[data-period]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderSelectedMonth();
  });
});

document.querySelectorAll('[data-ambience]').forEach((button) => {
  button.addEventListener('click', () => setAmbience(/** @type {HTMLElement} */ (button).dataset.ambience || 'gentle'));
});

document.querySelector('#previousMonth')?.addEventListener('click', () => {
  if (document.querySelector('#previousMonth')?.getAttribute('aria-disabled') === 'true') return;
  selectedMonthIndex = Math.max(0, selectedMonthIndex - 1);
  renderSelectedMonth();
});
document.querySelector('#nextMonth')?.addEventListener('click', () => {
  if (document.querySelector('#nextMonth')?.getAttribute('aria-disabled') === 'true') return;
  selectedMonthIndex = Math.min(MONTHLY_FOREST_DATA.length - 1, selectedMonthIndex + 1);
  renderSelectedMonth();
});
document.querySelector('#monthTrack')?.addEventListener('keydown', (event) => {
  const keyboardEvent = /** @type {KeyboardEvent} */ (event);
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboardEvent.key)) return;
  keyboardEvent.preventDefault();
  if (keyboardEvent.key === 'Home') selectedMonthIndex = 0;
  if (keyboardEvent.key === 'End') selectedMonthIndex = MONTHLY_FOREST_DATA.length - 1;
  if (keyboardEvent.key === 'ArrowLeft') selectedMonthIndex = Math.max(0, selectedMonthIndex - 1);
  if (keyboardEvent.key === 'ArrowRight') selectedMonthIndex = Math.min(MONTHLY_FOREST_DATA.length - 1, selectedMonthIndex + 1);
  renderSelectedMonth();
  /** @type {HTMLElement|null} */ (document.querySelector(`[data-month-index="${selectedMonthIndex}"]`))?.focus();
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
globalThis.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && focusedCardId) setFocusedCard('');
});

hydrateIcons();
buildMonthTrail();
document.querySelectorAll('[data-period], [data-filter], [data-stock]').forEach((item) => {
  item.setAttribute('aria-pressed', String(item.classList.contains('active')));
});
setAmbience(readAmbience());
renderValuation();
renderSelectedMonth();
syncTrailWithHash();
