// @ts-check
// 投資組合視覺區塊：把已算好的紀律、曝險、分層與持股資料格式化成 HTML。

import { ACCENT, CHART } from './theme.js';
import { marginCallDistance } from './portfolio-calculations.js';
import { companyExposure, companyRegionOf, fxExposure } from './portfolio-exposure.js';
import { stockExposureBySymbol } from './portfolio-risk.js';

/** @typedef {{ symbol?: string, layer?: string, currency?: string, valueTwd: number }} VisualRow */
/** @typedef {{ type?: string, currency?: string, balance?: number }} VisualAccount */
/** @typedef {{ escapeHtml:(value:any)=>string, formatMoney:(value:number)=>string, formatPercent:(value:number, digits?:number)=>string }} VisualFormatters */

// 分層設定同時供畫面區塊、持股表、表單與列印報表使用。
export const LAYERS = {
  core:      { label: '核心（美股）', color: CHART.blue,   min: 45, max: 65 },
  satellite: { label: '衛星',         color: CHART.yellow, min: 8,  max: 20 },
  bond:      { label: '債券',         color: CHART.green,  min: 15, max: 30 },
  gold:      { label: '黃金',         color: CHART.brown,  min: 0,  max: 10 },
  stock:     { label: '個股',         color: CHART.orange, min: 0,  max: 20 }
};
export const LAYER_ORDER = ['core', 'satellite', 'stock', 'bond', 'gold'];

const CUR_COLOR = { USD: CHART.blue, TWD: CHART.green, GBP: CHART.brown, JPY: CHART.yellow };
const REGION_COLOR = { '美國': CHART.blue, '中國': CHART.red, '日本': CHART.yellow, '韓國': CHART.brown, '台灣': CHART.green, '印度': CHART.orange, '其他': CHART.gray };

// 上限黑線固定在每條 bar 的同一位置（CAP_X%），讓各列黑線上下對齊；
// 綠/紅長度照「值 ÷ 上限」等比縮放，超過的部分往右畫紅。
/** @param {number} value @param {number} cap */
function capBar(value, cap) {
  const CAP_X = 70;
  if (!(cap > 0) && value > 0) {
    return `<div class="cap-bar"><div class="cb-over" style="width:${100 - CAP_X}%;margin-left:${CAP_X}%"></div><div class="cb-mark" style="left:${CAP_X}%"></div></div>`;
  }
  const ratio = cap > 0 ? value / cap : 0;
  const okW = Math.max(0, Math.min(ratio, 1)) * CAP_X;
  const overW = ratio > 1 ? Math.min((ratio - 1) * CAP_X, 100 - CAP_X) : 0;
  return `<div class="cap-bar"><div class="cb-ok" style="width:${okW.toFixed(1)}%"></div>${overW > 0 ? `<div class="cb-over" style="width:${overW.toFixed(1)}%"></div>` : ''}<div class="cb-mark" style="left:${CAP_X}%"></div></div>`;
}

/** @param {number} ibValTwd @param {number} loanTwd @param {{maint:number}} caps */
function marginDistanceBlock(ibValTwd, loanTwd, caps) {
  if (!(loanTwd > 0)) return `<div class="rc-block" style="margin-top:12px"><b>斷頭距離</b>：目前無融資借款，不存在強制平倉風險。</div>`;
  const distance = marginCallDistance(ibValTwd, loanTwd, caps.maint) ?? 0;
  const stress = Math.min(caps.maint + 10, 50);
  const stressDistance = marginCallDistance(ibValTwd, loanTwd, stress) ?? 0;
  const tone = distance < 35 ? 'var(--neg)' : distance < 50 ? 'var(--warn)' : 'var(--pos)';
  const judge = distance < 35 ? '危險：一次大型回檔就會觸及' : distance < 50 ? '偏緊：撐不過 2008 級回檔（−57%）' : '尚有餘裕（2008 級回檔 −57%）';
  return `<div class="rc-block" style="margin-top:12px"><b>斷頭距離</b>：IB 持倉市值再跌
    <b style="color:${tone};font-size:15px">${distance.toFixed(0)}%</b> 會觸及強平線（維持率 ${caps.maint}%）——${judge}。
    <span class="muted">若 IB 危機時調高維持率到 ${stress}%，距離縮到 ${stressDistance.toFixed(0)}%。IB 強平為即時自動執行、無寬限期。</span></div>`;
}

/**
 * 投資原則：紀律檢查卡。
 * @param {VisualRow[]} rows
 * @param {Record<string, number>} regionMap
 * @param {number} equityValue
 * @param {number} netWorth
 * @param {number} leverage
 * @param {{equity:number,stock:number,china:number,country:number,lev:number,maint:number}} caps
 * @param {number} ibValueTwd
 * @param {number} loanTwd
 * @param {VisualFormatters} formatters
 */
export function disciplineSection(rows, regionMap, equityValue, netWorth, leverage, caps, ibValueTwd, loanTwd, formatters) {
  if (!(netWorth > 0)) return '';
  const { escapeHtml: esc, formatPercent: fmtPct } = formatters;
  const percentOfNetWorth = (value) => value / netWorth * 100;
  const row = (label, value, cap, unit = '%', overLabel = '凍結') => {
    const over = value > cap;
    const finite = isFinite(value);
    const valueText = unit === 'x' ? (finite ? value.toFixed(2) + 'x' : '∞') : fmtPct(value);
    const capText = unit === 'x' ? cap + 'x' : cap + '%';
    const tag = over ? `<b class="neg rv-tag">${overLabel}</b>` : '<span class="pos rv-tag">✓</span>';
    return `<div class="rrow cap-row">
      <span class="nowrap">${label}</span>
      ${capBar(finite ? value : cap * 2, cap)}
      <span class="rval"><span class="rv-val">${valueText}</span><span class="rv-sep">/</span><span class="rv-cap">${capText}</span>${tag}</span>
    </div>`;
  };
  const items = [];
  items.push(row('股票總曝險', percentOfNetWorth(equityValue), caps.equity));
  Object.entries(stockExposureBySymbol(rows)).sort((a, b) => b[1] - a[1])
    .forEach(([symbol, value]) => items.push(row(esc(symbol), percentOfNetWorth(value), caps.stock)));
  Object.entries(regionMap).filter(([region]) => region !== '美國' && region !== '其他')
    .sort((a, b) => b[1] - a[1])
    .forEach(([region, value]) => items.push(row(`${esc(region)}（穿透）`, percentOfNetWorth(value), region === '中國' ? caps.china : caps.country)));
  items.push(row('IB 融資槓桿', leverage, caps.lev, 'x', '停借'));
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3><button type="button" class="info-link" id="disciplineInfo">紀律檢查</button></h3>
    <div class="region-rows" style="margin-top:12px">${items.join('')}</div>
    ${marginDistanceBlock(ibValueTwd, loanTwd, caps)}
  </div>`;
}

// 各幣別組成說明（股票＋債券＋黃金＋現金，略過 0）。
const fxParts = (value, formatMoney) => [['股票', value.stockTwd], ['債券', value.bondTwd], ['黃金', value.goldTwd], ['現金', value.cashTwd]]
  .filter(([, amount]) => Math.round(Math.abs(amount)) > 0)
  .map(([label, amount]) => `${label} ${formatMoney(amount)}`)
  .join(' ＋ ');

/** @param {VisualRow[]} rows @param {VisualAccount[]|undefined} accounts @param {Record<string, number|null>} fx @param {VisualFormatters} formatters */
export function fxSection(rows, accounts, fx, formatters) {
  const { escapeHtml: esc, formatMoney, formatPercent: fmtPct } = formatters;
  const byCurrency = fxExposure(rows, accounts, fx);
  const totalTwd = Object.values(byCurrency).reduce((sum, currency) => sum + currency.netTwd, 0);
  const currencies = Object.entries(byCurrency).sort((a, b) => b[1].netTwd - a[1].netTwd);
  const maxTwd = Math.max(...currencies.map(([, currency]) => Math.abs(currency.netTwd)), 1);

  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>幣別曝險 <span class="stat-sub" style="font-weight:400;margin:0">（依底層曝險＋現金帳戶）</span></h3>
    <div class="region-rows">
      ${currencies.map(([currency, value]) => {
        const parts = fxParts(value, formatMoney);
        const color = currency === '黃金' ? CHART.brown : (CUR_COLOR[currency] || CHART.gray);
        return `<div class="rrow fx-row">
        <span class="rlabel"><span class="cat-dot" style="background:${color}"></span>${esc(currency)}</span>
        <div>
          <div class="rbar"><div style="width:${(Math.abs(value.netTwd) / maxTwd * 100).toFixed(1)}%;background:${value.netTwd < 0 ? CHART.red : color}"></div></div>
          <div class="fx-amt muted">${formatMoney(value.netTwd)}${parts ? ` ＝ ${parts}` : ''}</div>
        </div>
        <span class="rval ${value.netTwd < 0 ? 'neg' : ''}">${fmtPct(totalTwd ? value.netTwd / totalTwd * 100 : 0)}</span>
      </div>`;
      }).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">註解：換算匯率來自 Yahoo Finance</p>
  </div>`;
}

/** @param {Record<string, number>} regionMap @param {number} equityValue @param {VisualFormatters} formatters */
export function regionSection(regionMap, equityValue, formatters) {
  const { escapeHtml: esc, formatMoney, formatPercent: fmtPct } = formatters;
  const regions = Object.entries(regionMap).sort((a, b) => b[1] - a[1]);
  const maxValue = regions[0]?.[1] || 1;
  const india = equityValue > 0 ? (regionMap['印度'] || 0) / equityValue * 100 : 0;
  const china = equityValue > 0 ? (regionMap['中國'] || 0) / equityValue * 100 : 0;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>持股曝險 <span class="stat-sub" style="font-weight:400;margin:0">（已合併 ETF 內含成分，佔股票部位 %）</span></h3>
    <div class="region-rows">
      ${regions.map(([region, value]) => `<div class="rrow">
        <span class="rlabel"><span class="cat-dot" style="background:${REGION_COLOR[region] || CHART.gray}"></span>${esc(region)}</span>
        <div class="rbar"><div style="width:${(value / maxValue * 100).toFixed(1)}%;background:${REGION_COLOR[region] || CHART.gray}"></div></div>
        <span class="rval">${fmtPct(equityValue > 0 ? value / equityValue * 100 : 0)} <span class="muted">${formatMoney(value)}</span></span>
      </div>`).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">EIMI 內含的中國／印度／台灣／韓國權重已拆入各區域（近似值，可隨年報更新）。
    你真實的中國曝險 ${fmtPct(china)}＝ICHN＋KWEB＋EIMI 的中國成分；不看好的印度目前實佔 ${fmtPct(india)}。</p>
  </div>`;
}

/** @param {VisualRow[]} rows @param {number} equityValue @param {VisualFormatters} formatters */
export function companiesSection(rows, equityValue, formatters) {
  if (!(equityValue > 0)) return '';
  const { escapeHtml: esc, formatMoney, formatPercent: fmtPct } = formatters;
  const { top, coveredValue } = companyExposure(rows);
  if (!top.length) return '';
  const maxValue = top[0][1].v;
  const coveredPct = coveredValue / equityValue * 100;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>持股公司 Top 20 <span class="stat-sub" style="font-weight:400;margin:0">（穿透 ETF 成分，佔股票部位 %；顏色＝公司所屬國家）</span></h3>
    <div class="region-rows">
      ${top.map(([company, aggregate], index) => {
        const region = companyRegionOf(company);
        const color = (region && REGION_COLOR[region]) || CHART.gray;
        const sources = Object.entries(aggregate.src).sort((a, b) => b[1] - a[1]).map(([symbol, value]) => `${symbol} ${formatMoney(value)}`).join('、');
        return `<div class="rrow" title="${esc(company)} ＝ ${esc(sources)}">
        <span class="rlabel nowrap"><span class="muted" style="font-size:10.5px;display:inline-block;width:16px">${index + 1}</span><span class="cat-dot" style="background:${color}"></span>${esc(company)}</span>
        <div class="rbar"><div style="width:${(aggregate.v / maxValue * 100).toFixed(1)}%;background:${color}"></div></div>
        <span class="rval">${fmtPct(aggregate.v / equityValue * 100)} <span class="muted">${formatMoney(aggregate.v)}</span></span>
      </div>`;
      }).join('')}
    </div>
    <p class="muted small" style="margin-top:10px">ETF 只拆前十大成分（近似權重，可隨年報更新），其餘部分不入列；直接持股（AAPL、GOOGL…）以全額計。
    Top 20 合計約佔股票部位 ${fmtPct(coveredPct)}。滑鼠移到列上可見「這家公司是透過哪幾筆持股持有」。</p>
  </div>`;
}

/** @param {Record<string, number>} layerValues @param {number} total @param {VisualFormatters} formatters */
export function layerSection(layerValues, total, formatters) {
  const { formatMoney, formatPercent: fmtPct } = formatters;
  const rowsHtml = LAYER_ORDER.map(key => {
    const config = LAYERS[key];
    const value = layerValues[key] || 0;
    const percent = total > 0 ? value / total * 100 : 0;
    let tag;
    if (percent > config.max) tag = '<span class="tag amber">偏高</span>';
    else if (percent < config.min) tag = '<span class="tag amber">偏低</span>';
    else tag = '<span class="tag green">符合</span>';
    return `<tr>
      <td class="nowrap"><span class="cat-dot" style="background:${config.color}"></span>${config.label}</td>
      <td class="nowrap">${formatMoney(value)}</td>
      <td class="nowrap">${fmtPct(percent)}</td>
      <td class="nowrap muted">${config.min}–${config.max}%</td>
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

/** @param {VisualRow[]} rows @param {number} total @param {VisualFormatters} formatters */
export function holdingsDonut(rows, total, formatters) {
  if (!(total > 0)) return '';
  const { escapeHtml: esc, formatMoney } = formatters;
  const sorted = rows.filter(row => row.valueTwd > 0).slice().sort((a, b) => b.valueTwd - a.valueTwd);
  const items = sorted.map(row => ({ label: row.symbol, v: row.valueTwd }));
  const mix = (first, second, fraction) => {
    const color1 = [1, 3, 5].map(index => parseInt(first.slice(index, index + 2), 16));
    const color2 = [1, 3, 5].map(index => parseInt(second.slice(index, index + 2), 16));
    return '#' + color1.map((value, index) => Math.round(value + (color2[index] - value) * fraction).toString(16).padStart(2, '0')).join('');
  };
  const rampAt = (index, count) => mix(ACCENT, '#FBEAE1', count <= 1 ? 0 : index / (count - 1));

  const width = 780, height = 400, centerX = 390, centerY = 200, radius = 118, strokeWidth = 26;
  const polar = (rad, angle) => [centerX + rad * Math.cos(angle), centerY + rad * Math.sin(angle)];
  const gap = 2.5 / radius;
  let angle = -Math.PI / 2;
  const slices = items.map((item, index) => {
    const span = item.v / total * Math.PI * 2;
    const slice = { ...item, i: index, a0: angle, a1: angle + span, mid: angle + span / 2, pct: item.v / total * 100 };
    angle += span;
    return slice;
  });

  const arcs = slices.map(slice => {
    const sliceGap = Math.min(gap, (slice.a1 - slice.a0) / 4);
    const [x0, y0] = polar(radius, slice.a0 + sliceGap), [x1, y1] = polar(radius, slice.a1 - sliceGap);
    const large = (slice.a1 - slice.a0 - sliceGap * 2) > Math.PI ? 1 : 0;
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"
      fill="none" stroke="${rampAt(slice.i, slices.length)}" stroke-width="${strokeWidth}"
      ><title>${esc(slice.label)}　${formatMoney(slice.v)}（${slice.pct.toFixed(1)}%）</title></path>`;
  }).join('');

  const labelGap = 18;
  /** @type {{L:any[], R:any[]}} */
  const sides = { L: [], R: [] };
  slices.forEach(slice => sides[Math.cos(slice.mid) >= 0 ? 'R' : 'L'].push({ ...slice, ty: centerY + Math.sin(slice.mid) * (radius + 34) }));
  const labels = [];
  for (const side of ['L', 'R']) {
    const placed = [];
    for (const slice of sides[side].sort((a, b) => b.v - a.v)) {
      const base = Math.min(Math.max(slice.ty, 16), height - 8);
      let y = null;
      for (const offset of [0, -7, 7, -14, 14, -21, 21, -28, 28, -35, 35, -42, 42, -49, 49, -56, 56, -63, 63]) {
        const candidate = base + offset;
        if (candidate < 16 || candidate > height - 8) continue;
        if (placed.every(position => Math.abs(position - candidate) >= labelGap)) { y = candidate; break; }
      }
      if (y == null) continue;
      placed.push(y);
      const [pointX, pointY] = polar(radius + strokeWidth / 2 + 4, slice.mid);
      const textX = side === 'R' ? centerX + radius + 76 : centerX - radius - 76;
      const lineEnd = side === 'R' ? textX - 6 : textX + 6;
      const detail = slice.pct < 2.5 ? '' : `<tspan fill="var(--text-dim)"> ${formatMoney(slice.v)}（${slice.pct.toFixed(1)}%）</tspan>`;
      labels.push(`<line x1="${pointX.toFixed(1)}" y1="${pointY.toFixed(1)}" x2="${lineEnd}" y2="${(y - 4).toFixed(1)}" stroke="var(--line-2)" stroke-width="1"/>
        <text x="${textX}" y="${y.toFixed(1)}" text-anchor="${side === 'R' ? 'start' : 'end'}" font-size="12.5">
          <tspan fill="var(--text)" font-weight="600">${esc(slice.label)}</tspan>${detail}
        </text>`);
    }
  }

  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>持股佔比 <span class="stat-sub" style="font-weight:400;margin:0">（全部持股依市值；標籤放不下的小部位省略，滑鼠移上色塊可見明細）</span></h3>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:820px;display:block;margin:0 auto" role="img" aria-label="持股佔比圓環圖">
      ${arcs}
      ${labels.join('')}
      <text x="${centerX}" y="${centerY - 2}" text-anchor="middle" font-size="30" font-weight="500" style="font-family:var(--serif)" fill="var(--text)">${formatMoney(total)}</text>
      <text x="${centerX}" y="${centerY + 24}" text-anchor="middle" font-size="12.5" fill="var(--text-dim)">總市值</text>
    </svg>
  </div>`;
}
