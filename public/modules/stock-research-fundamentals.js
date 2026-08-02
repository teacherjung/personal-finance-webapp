// @ts-check
// 個股基本面頁籤的純呈現與狀態整理：只接 SEC 快取與既有研究資料，不碰 DOM、API 或路由。

import { icon } from './icons.js';
import {
  FUNDAMENTAL_METRIC_DEFINITIONS,
  buildStockResearchMethod
} from './stock-research-method.js';

const METRIC_DEFINITIONS = new Map(
  FUNDAMENTAL_METRIC_DEFINITIONS.map(definition => [definition.key, definition])
);

/** @param {unknown} value */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function finiteOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** @param {unknown} value */
function safeHttpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isoStamp(value) {
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)
    ? `${raw.slice(0, 16).replace('T', ' ')} UTC`
    : raw;
}

/**
 * 第一版只做保守辨認；辨認不到就不開一般公司衍生結論。
 * @param {unknown} value
 * @returns {'general'|'bank'|'insurance'|'reit'|'unknown'}
 */
export function companyKindFromSic(value) {
  const raw = typeof value === 'number' ? String(value) : text(value);
  const sic = Number(raw);
  if (!Number.isInteger(sic) || sic < 100 || sic > 9999) return 'unknown';
  if (sic === 6798) return 'reit';
  if (sic >= 6000 && sic <= 6199) return 'bank';
  if (sic >= 6300 && sic <= 6499) return 'insurance';
  return 'general';
}

/** @param {unknown} cache */
export function shouldRefreshStockFundamentals(cache) {
  const value = objectOrEmpty(cache);
  return !value.data || value.freshness === 'missing' || value.freshness === 'stale' || value.stale === true;
}

/**
 * GET／POST 失敗時保留前一份成功資料，只附上這次可見錯誤。
 * @param {unknown} previous
 * @param {unknown} error
 * @param {unknown} symbol
 */
export function stockFundamentalsFailureState(previous, error, symbol) {
  const prior = objectOrEmpty(previous);
  const message = text(/** @type {any} */ (error)?.message) || 'SEC 官方資料暫時無法取得';
  return {
    ...prior,
    symbol: text(prior.symbol) || text(symbol),
    freshness: prior.data ? (prior.freshness || 'stale') : 'missing',
    fresh: Boolean(prior.data && prior.fresh),
    stale: Boolean(prior.data && !prior.fresh),
    refreshError: {
      message,
      code: text(/** @type {any} */ (error)?.code),
      stage: text(/** @type {any} */ (error)?.stage)
    }
  };
}

/** @param {Record<string, any>} metrics */
function taxonomyOf(metrics) {
  for (const metric of Object.values(metrics)) {
    const taxonomy = text(metric?.taxonomy).toLowerCase();
    if (taxonomy) return taxonomy;
    for (const fact of arrayOrEmpty(metric?.annual)) {
      const factTaxonomy = text(fact?.taxonomy).toLowerCase();
      if (factTaxonomy) return factTaxonomy;
    }
  }
  return null;
}

/**
 * @param {{
 *   cache?:unknown,
 *   refreshing?:unknown,
 *   watchMetrics?:unknown,
 *   legacyMetrics?:unknown
 * }} input
 */
export function buildStockFundamentalsViewModel(input = {}) {
  const cache = objectOrEmpty(input.cache);
  const data = objectOrEmpty(cache.data);
  const company = objectOrEmpty(data.company);
  const metrics = objectOrEmpty(data.metrics);
  const taxonomy = taxonomyOf(metrics);
  const method = buildStockResearchMethod({
    companyKind: companyKindFromSic(company.sic),
    taxonomy
  });
  const allowed = new Set(method.metrics.map(metric => metric.key));
  const rows = method.metrics.map(definition => {
    const metric = objectOrEmpty(metrics[definition.key]);
    return {
      ...definition,
      ...metric,
      key: definition.key,
      label: text(metric.label) || definition.label,
      kind: metric.kind === 'official' || metric.kind === 'derived' ? metric.kind : definition.kind,
      formula: text(metric.formula) || text(definition.formula),
      annual: arrayOrEmpty(metric.annual),
      latestQuarter: metric.latestQuarter && typeof metric.latestQuarter === 'object'
        ? metric.latestQuarter
        : null,
      status: metric.status === 'available' ? 'available' : 'missing'
    };
  }).filter(metric => allowed.has(metric.key));
  const error = objectOrEmpty(cache.refreshError || cache.loadError || (
    cache.freshness === 'fresh' ? null : cache.lastError
  ));

  return {
    symbol: text(cache.symbol || data.symbol),
    market: text(data.market),
    company: {
      name: text(company.name),
      cik: text(company.cik),
      sic: text(company.sic),
      fiscalYearEnd: text(company.fiscalYearEnd)
    },
    fetchedAt: isoStamp(cache.fetchedAt),
    freshness: text(cache.freshness) || (data.symbol ? 'stale' : 'missing'),
    hasData: Boolean(cache.data && typeof cache.data === 'object'),
    refreshing: Boolean(input.refreshing),
    errorMessage: text(error.message),
    warnings: [
      ...arrayOrEmpty(data.warnings)
        .filter(item => text(item?.code) !== 'METRIC_MISSING')
        .map(item => text(item?.message))
        .filter(Boolean),
      ...method.warnings
    ],
    method,
    officialMetrics: rows.filter(metric => metric.kind === 'official'),
    derivedMetrics: rows.filter(metric => metric.kind === 'derived'),
    watchMetrics: arrayOrEmpty(input.watchMetrics),
    legacyMetrics: text(input.legacyMetrics)
  };
}

/** @param {number} value @param {number} digits */
function decimal(value, digits = 2) {
  const sign = value < 0 ? '−' : '';
  return sign + Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

/** @param {number} value */
function compact(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${decimal(value / 1e12, 2)} 兆`;
  if (absolute >= 1e8) return `${decimal(value / 1e8, 2)} 億`;
  if (absolute >= 1e4) return `${decimal(value / 1e4, 2)} 萬`;
  return decimal(value, 2);
}

/** @param {any} fact */
function factValue(fact) {
  const value = finiteOrNull(fact?.value);
  if (value == null) return '尚未取得';
  const unit = text(fact?.unit);
  if (unit === 'ratio') return `${decimal(value * 100, 1)}%`;
  if (/\/shares?$/i.test(unit)) return `${decimal(value, 4)} ${unit}`;
  return `${compact(value)}${unit ? ` ${unit}` : ''}`;
}

/** @param {any} fact */
function periodText(fact) {
  const start = text(fact?.periodStart);
  const end = text(fact?.periodEnd);
  return start && end ? `${start} 至 ${end}` : end || '尚未取得';
}

/** @param {any} fact */
function quarterPeriodLabel(fact) {
  const start = text(fact?.periodStart);
  const end = text(fact?.periodEnd);
  if (start && end) return `${start}～${end}`;
  return end ? `截至 ${end}` : '單季期間未填';
}

/** @param {any} fact @param {(value:any)=>string} e */
function filingLink(fact, e) {
  const url = safeHttpUrl(fact?.filingUrl);
  const form = text(fact?.form) || '原始申報';
  return url
    ? `<a href="${e(url)}" target="_blank" rel="noopener">${e(form)} ${icon('link', 13)}</a>`
    : e(form);
}

/** @param {any} fact @param {(value:any)=>string} e */
function sourceFactsHtml(fact, e) {
  const rows = [
    ['期間', periodText(fact)],
    ['來源', `${text(fact?.filedAt) || '未填申報日'} · ${text(fact?.accession) || '未填 accession'}`],
    ['欄位', [text(fact?.taxonomy), text(fact?.tag)].filter(Boolean).join(' / ') || '尚未取得'],
    ['單位', text(fact?.unit) || '尚未取得']
  ];
  return `<dl class="stock-fact-source">
    ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${e(value)}</dd></div>`).join('')}
    <div><dt>申報</dt><dd>${filingLink(fact, e)}</dd></div>
  </dl>`;
}

/** @param {any} inputs @param {(value:any)=>string} e */
function derivedInputsHtml(inputs, e) {
  const entries = Object.entries(objectOrEmpty(inputs));
  if (!entries.length) return '<p class="muted">這個期間沒有可展開的輸入來源</p>';
  return `<ul class="stock-derived-inputs">${entries.map(([key, raw]) => {
    const input = objectOrEmpty(raw);
    const metricLabel = METRIC_DEFINITIONS.get(input.metricKey || key)?.label || input.metricKey || key;
    return `<li>
      <div><b>${e(metricLabel)}</b><span>${e(factValue(input))}</span></div>
      <small>${e(periodText(input))} · ${e([text(input.taxonomy), text(input.tag)].filter(Boolean).join(' / ') || '未填 tag')}</small>
      ${safeHttpUrl(input.filingUrl) ? `<a href="${e(safeHttpUrl(input.filingUrl))}" target="_blank" rel="noopener">${e(text(input.form) || '原始申報')} ${icon('link', 12)}</a>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

/**
 * 每個畫面數字都用自己的 details 包住；展開後可追到期間、tag、申報或衍生公式。
 * @param {any} fact
 * @param {any} metric
 * @param {(value:any)=>string} e
 * @param {string} [periodLabel]
 */
function factDisclosureHtml(fact, metric, e, periodLabel = '') {
  if (!fact || finiteOrNull(fact.value) == null) return '<span class="muted">尚未取得</span>';
  const derived = metric.kind === 'derived';
  return `<details class="stock-fact-disclosure">
    <summary>${periodLabel ? `<span>${e(periodLabel)}</span>` : ''}<b>${e(factValue(fact))}</b></summary>
    <div class="stock-fact-popover">
      ${derived
        ? `<div class="stock-formula"><span>NotEasy 計算</span><code>${e(text(fact.formula || metric.formula) || '公式尚未取得')}</code></div>
          ${derivedInputsHtml(fact.inputs, e)}`
        : sourceFactsHtml(fact, e)}
    </div>
  </details>`;
}

/** @param {any} metric @param {(value:any)=>string} e */
function metricRowHtml(metric, e) {
  const annual = arrayOrEmpty(metric.annual);
  const annualHtml = annual.length
    ? `<div class="stock-fact-trend">${annual.map(fact => (
      factDisclosureHtml(fact, metric, e, text(fact?.periodEnd).slice(0, 4) || '年度')
    )).join('')}</div>`
    : '<span class="muted">尚未取得</span>';
  const badge = metric.kind === 'derived' ? 'NotEasy 計算' : 'SEC 申報';
  return `<tr data-fundamental-metric="${e(metric.key)}">
    <th scope="row">
      <b>${e(metric.label)}</b>
      <span class="stock-metric-kind">${badge}</span>
    </th>
    <td>${factDisclosureHtml(
      metric.latestQuarter,
      metric,
      e,
      metric.latestQuarter ? quarterPeriodLabel(metric.latestQuarter) : ''
    )}</td>
    <td>${annualHtml}</td>
  </tr>`;
}

/** @param {string} title @param {any[]} metrics @param {(value:any)=>string} e */
function metricsTableHtml(title, metrics, e) {
  const rows = metrics.length
    ? metrics.map(metric => metricRowHtml(metric, e)).join('')
    : '<tr><td colspan="3" class="empty">尚無適用指標</td></tr>';
  return `<section class="stock-section stock-fundamental-metrics">
    <div class="stock-section-heading"><h2>${title}</h2><span>點數字展開期間與來源</span></div>
    <div class="tbl-wrap stock-table-wrap">
      <table class="stock-fundamentals-table">
        <thead><tr><th>指標</th><th>最新單季</th><th>最近五筆可得年度</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockFundamentalsViewModel>} view @param {(value:any)=>string} e */
function statusHtml(view, e) {
  const label = view.refreshing
    ? '正在更新 SEC 官方資料'
    : view.hasData
      ? view.freshness === 'fresh' ? 'SEC 官方資料已是最新快取' : '目前保留上次成功資料'
      : '尚未取得 SEC 官方資料';
  const meta = view.fetchedAt ? `最近成功：${view.fetchedAt}` : '取得資料後會保留最近成功版本';
  const tone = view.errorMessage ? ' danger' : view.freshness === 'stale' ? ' warn' : '';
  return `<div class="stock-fundamental-status${tone}">
    <div><b>${e(label)}</b><span>${e(meta)}</span>${view.errorMessage ? `<small>${e(view.errorMessage)}</small>` : ''}</div>
    <button type="button" class="btn-ghost" data-stock-fundamentals-refresh${view.refreshing ? ' disabled' : ''}>${icon('refresh', 15)}更新官方資料</button>
  </div>`;
}

/** @param {ReturnType<typeof buildStockFundamentalsViewModel>} view @param {(value:any)=>string} e */
function companyHtml(view, e) {
  if (!view.hasData) return '';
  const meta = [
    view.market,
    view.company.cik ? `CIK ${view.company.cik}` : '',
    view.company.sic ? `SIC ${view.company.sic}` : '',
    view.company.fiscalYearEnd ? `財年結束 ${view.company.fiscalYearEnd}` : ''
  ].filter(Boolean);
  return `<section class="stock-fundamental-company">
    <div><span class="stock-eyebrow">官方公司資料</span><h2>${e(view.company.name || view.symbol)}</h2></div>
    <div class="stock-fundamental-company-meta">${meta.map(item => `<span>${e(item)}</span>`).join('')}</div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockFundamentalsViewModel>} view @param {(value:any)=>string} e */
function warningsHtml(view, e) {
  const unique = [...new Set(view.warnings.filter(Boolean))];
  if (!unique.length) return '';
  return `<ul class="stock-fundamental-warnings">${unique.map(message => `<li>${e(message)}</li>`).join('')}</ul>`;
}

/** @param {ReturnType<typeof buildStockFundamentalsViewModel>} view @param {(value:any)=>string} e */
function methodHtml(view, e) {
  const metricLabels = new Map(FUNDAMENTAL_METRIC_DEFINITIONS.map(metric => [metric.key, metric.label]));
  const allowedEvidence = new Set(view.method.metrics.map(metric => metric.key));
  const rows = view.method.sections.map((section, index) => {
    const evidence = section.automaticEvidence
      .filter(key => allowedEvidence.has(key))
      .map(key => metricLabels.get(key))
      .filter(Boolean);
    return `<details class="stock-method-row"${index === 0 ? ' open' : ''}>
      <summary><span>${index + 1}</span><b>${e(section.label)}</b></summary>
      <div class="stock-method-body">
        <ul>${section.questions.map(question => `<li>${e(question)}</li>`).join('')}</ul>
        <div class="stock-method-evidence">
          <span>可對照的自動證據</span>
          <p>${e(evidence.join('、') || '目前沒有可自動整理的證據')}</p>
          <small>${e(section.manualEvidence)}</small>
        </div>
      </div>
    </details>`;
  }).join('');
  return `<section class="stock-section stock-method">
    <div class="stock-section-heading">
      <div><h2>研究這家公司要問的八組問題</h2><span>${e(view.method.companyKindLabel)}</span></div>
    </div>
    <div class="stock-method-list">${rows}</div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockFundamentalsViewModel>} view @param {(value:any)=>string} e */
function manualMetricsHtml(view, e) {
  const rows = view.watchMetrics.length
    ? view.watchMetrics.map(metric => {
      const value = finiteOrNull(metric?.value);
      const display = value == null
        ? '<span class="muted">尚未取得</span>'
        : `${decimal(value, 4)}${text(metric?.unit) ? ` ${e(metric.unit)}` : ''}`;
      return `<tr>
        <td><b>${e(text(metric?.label) || '未命名指標')}</b></td>
        <td class="num">${display}</td>
        <td>${e(text(metric?.period) || '—')}</td>
        <td>${e(text(metric?.source) || '—')}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="4" class="empty">尚無自訂追蹤指標</td></tr>';
  return `<section class="stock-section">
    <div class="stock-section-heading">
      <div><h2>關鍵指標</h2><span>手動內容不受 SEC 更新影響</span></div>
      <button type="button" class="info-link" data-stock-info="missing">「尚未取得」是什麼？</button>
    </div>
    ${view.legacyMetrics ? `<div class="stock-legacy-note"><span>既有觀察重點</span><p>${e(view.legacyMetrics).replace(/\r?\n/g, '<br>')}</p></div>` : ''}
    <div class="tbl-wrap stock-table-wrap">
      <table class="stock-metrics-table">
        <thead><tr><th>指標</th><th class="num">最新值</th><th>期間</th><th>來源</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/**
 * 不含最外層 mount，供控制器在背景更新完成後就地替換。
 * @param {Parameters<typeof buildStockFundamentalsViewModel>[0]} input
 * @param {{esc:(value:any)=>string}} formatters
 */
export function stockFundamentalsInnerHtml(input, formatters) {
  if (typeof formatters?.esc !== 'function') throw new TypeError('stockFundamentalsHtml 需要 esc 格式器');
  const e = (/** @type {unknown} */ value) => formatters.esc(String(value ?? ''));
  const view = buildStockFundamentalsViewModel(input);
  return [
    statusHtml(view, e),
    companyHtml(view, e),
    warningsHtml(view, e),
    view.hasData ? metricsTableHtml('SEC 官方指標', view.officialMetrics, e) : '',
    view.hasData ? metricsTableHtml('NotEasy 衍生指標', view.derivedMetrics, e) : '',
    methodHtml(view, e),
    manualMetricsHtml(view, e)
  ].join('');
}

/**
 * @param {Parameters<typeof buildStockFundamentalsViewModel>[0]} input
 * @param {{esc:(value:any)=>string}} formatters
 */
export function stockFundamentalsHtml(input, formatters) {
  return `<div class="stock-fundamentals" data-stock-fundamentals-root>${stockFundamentalsInnerHtml(input, formatters)}</div>`;
}
