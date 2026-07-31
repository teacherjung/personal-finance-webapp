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
