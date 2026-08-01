// @ts-check
/* global document */
import { hydrateIcons } from '/modules/icons.js';

hydrateIcons();

const chartSeries = {
  6: {
    labels: ['2 月', '3 月', '4 月', '5 月', '6 月', '7 月'],
    income: [18.2, 19.1, 17.7, 20.4, 18.8, 19.8],
    expense: [12.3, 11.7, 13.5, 10.9, 12.2, 11.2],
    balance: [5.9, 7.4, 4.2, 9.5, 6.6, 8.6]
  },
  12: {
    labels: ['8 月', '9 月', '10 月', '11 月', '12 月', '1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月'],
    income: [17.9, 18.4, 19.2, 17.8, 22.3, 18.9, 18.2, 19.1, 17.7, 20.4, 18.8, 19.8],
    expense: [13.4, 12.6, 11.9, 13.8, 16.7, 12.4, 12.3, 11.7, 13.5, 10.9, 12.2, 11.2],
    balance: [4.5, 5.8, 7.3, 4.0, 5.6, 6.5, 5.9, 7.4, 4.2, 9.5, 6.6, 8.6]
  }
};

const returnWeather = {
  positive: {
    scene: 'assets/forest-return-positive.webp',
    sceneAlt: '陽光照耀的森林小徑',
    guide: 'assets/guide-return-positive.webp',
    guideAlt: '微笑的森森嚮導',
    heading: '本月投資組合維持正報酬',
    summary: '本月報酬率為正，資產配置與持股上限均維持在既定範圍內。',
    detail: '投資組合維持正報酬，仍應依既定配置執行。',
    statusClass: 'good'
  },
  neutral: {
    scene: 'assets/forest-return-neutral.webp',
    sceneAlt: '陰天但視野清楚的森林小徑',
    guide: 'assets/guide-return-neutral.webp',
    guideAlt: '表情中性的森森嚮導',
    heading: '本月投資組合小幅波動',
    summary: '本月報酬率接近持平，建議持續觀察資產配置偏移與現金部位。',
    detail: '報酬率接近持平，先觀察而不因短期波動改變策略。',
    statusClass: 'calm'
  },
  negative: {
    scene: 'assets/forest-return-negative.webp',
    sceneAlt: '下雨中的森林小徑',
    guide: 'assets/guide-return-negative.webp',
    guideAlt: '審慎思考的森森嚮導',
    heading: '本月投資組合出現回檔',
    summary: '本月報酬率為負，先檢查回檔來源、配置偏移與既定風險上限。',
    detail: '檢查回檔來源與風險上限，不以單月損益取代研究。',
    statusClass: 'watch'
  }
};

/** @param {number} value */
function weatherStateForReturn(value) {
  if (value > .5) return 'positive';
  if (value < -.5) return 'negative';
  return 'neutral';
}

/** @param {number} value */
function formatSignedPct(value) {
  if (value < 0) return `−${Math.abs(value).toFixed(1)}%`;
  return `+${value.toFixed(1)}%`;
}

/** @param {number} value */
function renderMonthlyReturn(value) {
  const state = weatherStateForReturn(value);
  const weather = returnWeather[state];
  const scene = /** @type {HTMLElement|null} */ (document.querySelector('.forest-scene'));
  const sceneArt = /** @type {HTMLImageElement|null} */ (document.querySelector('#sceneArt'));
  const guide = /** @type {HTMLImageElement|null} */ (document.querySelector('#guidePortrait'));
  const returnMark = /** @type {HTMLElement|null} */ (document.querySelector('#returnStatusMark'));
  const formatted = formatSignedPct(value);

  if (scene) scene.dataset.weather = state;
  if (sceneArt) {
    sceneArt.src = weather.scene;
    sceneArt.alt = weather.sceneAlt;
  }
  if (guide) {
    guide.src = weather.guide;
    guide.alt = weather.guideAlt;
  }
  if (returnMark) returnMark.className = `status-mark ${weather.statusClass}`;
  const sceneTitle = document.querySelector('#scene-title');
  const sceneSummary = document.querySelector('#sceneSummary');
  const monthReturn = document.querySelector('#monthReturn');
  const returnTitle = document.querySelector('#returnStatusTitle');
  const returnDetail = document.querySelector('#returnStatusDetail');
  if (sceneTitle) sceneTitle.textContent = weather.heading;
  if (sceneSummary) sceneSummary.textContent = weather.summary;
  if (monthReturn) monthReturn.textContent = formatted;
  if (returnTitle) returnTitle.textContent = `本月報酬率 ${formatted}`;
  if (returnDetail) returnDetail.textContent = weather.detail;
  document.querySelectorAll('[data-month-return]').forEach((button) => {
    const buttonValue = Number(/** @type {HTMLElement} */ (button).dataset.monthReturn);
    button.classList.toggle('active', buttonValue === value);
  });
}

document.querySelectorAll('[data-month-return]').forEach((button) => {
  button.addEventListener('click', () => {
    renderMonthlyReturn(Number(/** @type {HTMLElement} */ (button).dataset.monthReturn));
  });
});

renderMonthlyReturn(2.4);

const valuationStocks = {
  AAPL: { name: 'Apple Inc.', sector: '美國・消費科技', eps: 6.43, price: 214.29, growth: 8, terminalPe: 24 },
  GOOGL: { name: 'Alphabet Inc.', sector: '美國・數位廣告與雲端', eps: 8.1, price: 191.2, growth: 12, terminalPe: 22 },
  TSM: { name: 'TSMC (ADR)', sector: '台灣・半導體', eps: 6.72, price: 205.5, growth: 15, terminalPe: 20 }
};

let selectedValuationStock = 'TSM';

/** @param {string} selector */
function htmlElement(selector) {
  return /** @type {HTMLElement|null} */ (document.querySelector(selector));
}

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

/** @param {number} value @param {number} max */
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

  const ticker = htmlElement('#valuationTicker');
  const company = htmlElement('#valuationCompany');
  const sector = htmlElement('#valuationSector');
  const growthValue = htmlElement('#growthValue');
  const terminalPeValue = htmlElement('#terminalPeValue');
  const discountValue = htmlElement('#discountValue');
  if (ticker) ticker.textContent = selectedValuationStock;
  if (company) company.textContent = stock.name;
  if (sector) sector.textContent = stock.sector;
  if (growthValue) growthValue.textContent = `${growth}%`;
  if (terminalPeValue) terminalPeValue.textContent = `${terminalPe}×`;
  if (discountValue) discountValue.textContent = `${discount}%`;
  growthInput.setAttribute('aria-valuetext', `${growth}%`);
  terminalPeInput.setAttribute('aria-valuetext', `${terminalPe} 倍`);
  discountInput.setAttribute('aria-valuetext', `${discount}%`);

  ['#fairValue', '#fairBarValue'].forEach((selector) => {
    const element = htmlElement(selector);
    if (element) element.textContent = fairText;
  });
  ['#marketPrice', '#priceBarValue'].forEach((selector) => {
    const element = htmlElement(selector);
    if (element) element.textContent = priceText;
  });
  const axis = htmlElement('#valueAxisMax');
  if (axis) axis.textContent = formatUsd(axisMax);
  setBarWidth('#fairBar', fairValue, axisMax);
  setBarWidth('#priceBar', stock.price, axisMax);

  const verdict = htmlElement('#valuationVerdict');
  const guide = /** @type {HTMLImageElement|null} */ (document.querySelector('#valuationGuide'));
  const verdictText = htmlElement('#verdictText');
  const premiumText = htmlElement('#premiumText');
  const note = htmlElement('#valuationNote');
  if (premium > .1) {
    if (verdict) verdict.dataset.tone = 'watch';
    if (guide) {
      guide.src = 'assets/guide-return-negative.webp';
      guide.alt = '審慎提醒的小森森';
    }
    if (verdictText) verdictText.textContent = '高於估算值，先保留安全邊際';
    if (premiumText) premiumText.textContent = `目前價格較估算合理價高 ${Math.round(premium * 100)}%`;
    if (note) note.textContent = '請再用較保守的成長率與終值倍數試算，確認結論不依賴單一樂觀假設。';
  } else if (premium < -.15) {
    if (verdict) verdict.dataset.tone = 'good';
    if (guide) {
      guide.src = 'assets/guide-return-positive.webp';
      guide.alt = '微笑提醒的小森森';
    }
    if (verdictText) verdictText.textContent = '低於估算值，仍須確認基本面';
    if (premiumText) premiumText.textContent = `目前價格較估算合理價低 ${Math.round(Math.abs(premium) * 100)}%`;
    if (note) note.textContent = '估值折價只是研究起點；請先確認競爭優勢與財務體質沒有明顯惡化。';
  } else {
    if (verdict) verdict.dataset.tone = 'calm';
    if (guide) {
      guide.src = 'assets/guide-return-neutral.webp';
      guide.alt = '平靜提醒的小森森';
    }
    if (verdictText) verdictText.textContent = '接近估算區間，適合分批評估';
    const distance = Math.round(Math.abs(premium) * 100);
    if (premiumText) premiumText.textContent = `目前價格與估算合理價相差約 ${distance}%`;
    if (note) note.textContent = '估值是一個區間，不是單一答案。請用保守、基準與樂觀三組假設交叉檢查。';
  }

  [growthInput, terminalPeInput, discountInput].forEach(updateRangeFill);
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

renderValuation();

/** @type {any} */
let chart;

function drawChart(period = 12) {
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.querySelector('#cashflowChart'));
  if (!canvas || !globalThis.Chart) return;
  const series = chartSeries[period === 6 ? 6 : 12];
  chart?.destroy();
  chart = new globalThis.Chart(canvas, {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [
        { label: '收入', data: series.income, borderColor: '#568a3d', backgroundColor: '#568a3d', borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '支出', data: series.expense, borderColor: '#ca7049', backgroundColor: '#ca7049', borderWidth: 3, pointRadius: 2, tension: .28 },
        { label: '結餘', data: series.balance, borderColor: '#6689a3', backgroundColor: '#6689a3', borderWidth: 2, pointRadius: 2, borderDash: [5, 5], tension: .28 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 180 },
      plugins: { legend: { display: false }, tooltip: { padding: 10, cornerRadius: 6, displayColors: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#746550', font: { size: 10, family: 'Arial Rounded MT Bold, PingFang TC, sans-serif' } }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: '#e5dbc2', borderDash: [3, 3] }, ticks: { color: '#746550', callback: (value) => `${value}萬`, font: { size: 9 } }, border: { display: false } }
      }
    }
  });
}

drawChart();

document.querySelectorAll('[data-currency]').forEach((button) => {
  button.addEventListener('click', () => {
    const currency = /** @type {HTMLElement} */ (button).dataset.currency || 'TWD';
    document.querySelectorAll('[data-currency]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.js-value').forEach((item) => {
      const el = /** @type {HTMLElement} */ (item);
      el.textContent = currency === 'USD' ? el.dataset.usd || '' : el.dataset.twd || '';
    });
  });
});

document.querySelectorAll('[data-period]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach((item) => item.classList.toggle('active', item === button));
    drawChart(Number(/** @type {HTMLElement} */ (button).dataset.period));
  });
});

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    const filter = /** @type {HTMLElement} */ (button).dataset.filter || 'all';
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('tbody tr[data-kind]').forEach((row) => {
      const kind = /** @type {HTMLElement} */ (row).dataset.kind;
      row.toggleAttribute('hidden', filter !== 'all' && kind !== filter);
    });
  });
});

const reminderDialog = /** @type {HTMLDialogElement|null} */ (document.querySelector('#reminderDialog'));
const notebookDialog = /** @type {HTMLDialogElement|null} */ (document.querySelector('#notebookDialog'));
document.querySelector('#openReminder')?.addEventListener('click', () => reminderDialog?.showModal());
document.querySelector('#openNotebook')?.addEventListener('click', () => notebookDialog?.showModal());

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
syncTrailWithHash();
