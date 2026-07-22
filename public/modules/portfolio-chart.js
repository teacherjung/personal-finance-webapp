// @ts-check
// 投資頁折線圖設定：整理投入／市值資料與 Chart.js 設定，不碰 DOM 或圖表生命週期。

import { AXIS, GRID, ACCENT, ACCENT_SOFT } from './theme.js';
import { formatK, formatWan } from './portfolio-format.js';

/**
 * @param {Array<{month:string,cost:number,value:number}>} snapshots
 * @param {number} currentCost
 * @param {number} currentValue
 * @param {{viewCurrency:string,usdRate:number}} options
 */
export function investmentChartConfig(snapshots, currentCost, currentValue, options) {
  const { viewCurrency, usdRate } = options;
  const convert = (twd) => viewCurrency === 'USD' ? Math.round(twd / usdRate) : Math.round(twd);
  const labels = [...snapshots.map(snapshot => snapshot.month), '本月（現在）'];
  const costs = [...snapshots.map(snapshot => convert(snapshot.cost)), convert(currentCost)];
  const values = [...snapshots.map(snapshot => convert(snapshot.value)), convert(currentValue)];
  const yTick = (value) => viewCurrency === 'USD'
    ? (value / 1000).toFixed(0) + ' K'
    : (value / 10000).toFixed(0) + ' 萬';
  const tipValue = (value) => viewCurrency === 'USD'
    ? formatK(value) + ' K USD'
    : formatWan(value) + ' 萬';

  return {
    type: 'line',
    data: { labels, datasets: [
      { label: '投入成本', data: costs, borderColor: AXIS, backgroundColor: AXIS, borderDash: [5, 4], borderWidth: 2, pointRadius: 3, fill: false, tension: .25 },
      { label: '市值', data: values, borderColor: ACCENT, backgroundColor: ACCENT_SOFT, borderWidth: 2, pointRadius: 3, fill: true, tension: .25 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { color: AXIS, boxWidth: 14, padding: 12 } },
        tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: ${tipValue(context.parsed.y)}` } } },
      scales: { x: { ticks: { color: AXIS }, grid: { color: GRID } },
        y: { ticks: { color: AXIS, callback: yTick }, grid: { color: GRID } } } }
  };
}
