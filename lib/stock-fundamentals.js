// @ts-check
// SEC Company Facts 純解析器：只整理官方 JSON，不碰網路、資料庫、DOM 或使用者研究內容。

import { isProtoKey } from './safe-map.js';

/** @typedef {'duration'|'instant'} FactNature */
/** @typedef {'currency'|'per-share'|'shares'} UnitKind */
/** @typedef {'includes-current-long-term-debt'|'short-term-only'|'unknown'} CurrentDebtLabelHint */
/** @typedef {'newer-periods'|'first-tag'} CrossTagFallback */

/**
 * SEC 資料不符合解析契約（**來源資料**的問題，不是程式 bug）。
 * 服務層據此把 parse 失敗歸類為「SEC 端失敗」（可記入租戶 lastError）；
 * 解析器裡其他任何例外＝程式 bug＝內部錯誤，**不得**穿上 SEC 外衣（#358 r1 blocking：
 * 舊版把包括程式 bug 在內的一切都包成 sec_parse_error，#351 那類 bug 因此被誤報成上游故障）。
 */
export class SecDataContractError extends TypeError {}

const DAY_MS = 24 * 60 * 60 * 1000;
const CROSS_TAG_OVERLAP_RELATIVE_TOLERANCE = 0.001;
const CROSS_TAG_ROUNDING_UNIT = 1_000_000;
const CROSS_TAG_ROUNDING_MAX_RELATIVE_DIFFERENCE = 0.01;
const ANNUAL_FORMS = new Set(['10-K', '10-K/A']);
const QUARTER_FORMS = new Set(['10-Q', '10-Q/A']);
const QUARTER_PERIODS = new Set(['Q1', 'Q2', 'Q3']);

const RAW_SEC_METRICS = {
  revenue: {
    label: '營收',
    nature: 'duration',
    unitKind: 'currency',
    tags: [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'SalesRevenueNet'
    ]
  },
  grossProfit: {
    label: '毛利',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['GrossProfit']
  },
  operatingIncome: {
    label: '營業利益',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['OperatingIncomeLoss']
  },
  netIncome: {
    label: '淨利',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['NetIncomeLoss', 'ProfitLoss']
  },
  dilutedEps: {
    label: '稀釋後 EPS',
    nature: 'duration',
    unitKind: 'per-share',
    tags: ['EarningsPerShareDiluted']
  },
  operatingCashFlow: {
    label: '營業現金流',
    nature: 'duration',
    unitKind: 'currency',
    tags: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'
    ]
  },
  capitalExpenditure: {
    label: '資本支出',
    nature: 'duration',
    unitKind: 'currency',
    // 舊第 2 順位 PaymentsForAdditionsToPropertyPlantAndEquipment 是查無此元素的假名
    // （官方 taxonomy 2011–2026 每版皆無、SEC 抽樣 0 筆）＝那條退路從未啟動過。
    // 換成 PaymentsForCapitalImprovements（真科目；裁示紀錄與實查數據＝PR #549）。
    // 排最後＝同期間語意優先序最低：它偏「改良既有資產」、比 ProductiveAssets（廣義購置）窄。
    // ⚠️ 誠實劃界：這不是「前兩科目整條沒資料才啟動」——本表走預設 newer-periods，
    // 高順位已有資料時，低順位仍可補「沒重疊到的較新期間」（標 MIXED_TAG、F5 轉不可比較；
    // 同期重疊判為實質口徑衝突則整顆拒收——門檻與百萬位進位例外的判準在共用挑值器，
    // 正本＝契約「SEC 官方指標挑值」節）。寬窄口徑禁不禁接力＝口徑裁決：noncurrentDebt 裁了
    // first-tag 禁接力，這兩個指標裁「照現行規則走」（紀錄＝PR #546 Grok 判定表第 1 條、PR #549）。
    tags: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
      'PaymentsForCapitalImprovements'
    ]
  },
  cashAndEquivalents: {
    label: '現金及約當現金',
    nature: 'instant',
    unitKind: 'currency',
    tags: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'
    ]
  },
  currentDebt: {
    label: '流動債務',
    nature: 'instant',
    unitKind: 'currency',
    // Company Facts 會把申報的 presentation／calculation 關係攤平，所以三種來源不能再放進
    // first-hit-wins 的同義清單：DebtCurrent 是總額；另外兩組可能是互斥科目，也可能父子重疊。
    currentDebtSources: {
      total: ['DebtCurrent'],
      shortTerm: ['ShortTermBorrowings'],
      currentMaturity: [
        'LongTermDebtAndCapitalLeaseObligationsCurrent',
        'LongTermDebtCurrent'
      ]
    }
  },
  noncurrentDebt: {
    label: '非流動債務',
    nature: 'instant',
    unitKind: 'currency',
    crossTagFallback: 'first-tag',
    // ⚠️ 官方元素名是 Capital 不是 Finance：ASC 842 把 capital lease 改稱 finance lease，
    // 但 us-gaap 元素名沒跟著改名（實查官方 taxonomy 2011–2026 **每一版**都只有 Capital 版，
    // 且 SEC 實際申報查不到 Finance 版一筆）。而且非流動那顆**沒有 Noncurrent 字尾**——帶字尾的是 ...Current 與
    // ...IncludingCurrentMaturities。兩顆的語意差在租賃：
    //   LongTermDebtAndCapitalLeaseObligations = 長期債務＋租賃，列為非流動（較寬、優先）
    //   LongTermDebtNoncurrent                 = 長期債務非流動，**不含**租賃（較窄、退路）
    // 寬的排前面＝與上面 currentDebt.currentMaturity 同形（那組也是 ...CapitalLeaseObligationsCurrent
    // 先於 LongTermDebtCurrent），流動與非流動兩邊對稱。
    tags: [
      'LongTermDebtAndCapitalLeaseObligations',
      'LongTermDebtNoncurrent'
    ]
  },
  dilutedShares: {
    label: '稀釋加權平均股數',
    nature: 'duration',
    unitKind: 'shares',
    tags: ['WeightedAverageNumberOfDilutedSharesOutstanding']
  },
  stockBasedCompensation: {
    label: '股票薪酬',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['ShareBasedCompensation']
  },
  shareRepurchases: {
    label: '股票回購',
    nature: 'duration',
    unitKind: 'currency',
    // 舊第 2 順位 PaymentsForRepurchaseOfCommonAndPreferredStock 是查無此元素的假名。
    // 換成 PaymentsForRepurchaseOfEquity（普通股＋特別股合計，最接近假名原本想表達的語意；
    // 裁示紀錄與實查數據＝PR #549）。「只買回特別股」那顆（...PreferredStockAndPreferenceStock）
    // 裁示不加：經濟性質偏還債，顯示成「股票回購」會被誤讀成回饋普通股股東。
    // ⚠️ 誠實劃界：合計口徑可經 newer-periods 補進普通股序列的較新缺期（標 MIXED_TAG；
    // 同期實質衝突整顆拒收）——衝突判準與口徑裁決紀錄同上面 capitalExpenditure 的劃界。
    tags: ['PaymentsForRepurchaseOfCommonStock', 'PaymentsForRepurchaseOfEquity']
  },
  dividendsPaid: {
    label: '支付股利',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock']
  }
};

export const SEC_METRIC_CANDIDATES = Object.freeze(Object.fromEntries(
  Object.entries(RAW_SEC_METRICS).map(([key, metric]) => {
    const currentDebtSources = metric.currentDebtSources
      ? Object.freeze(Object.fromEntries(
        Object.entries(metric.currentDebtSources).map(([role, tags]) => [
          role,
          Object.freeze(tags.slice())
        ])
      ))
      : null;
    const tags = currentDebtSources
      ? Object.values(currentDebtSources).flat()
      : metric.tags;
    return [key, Object.freeze({
      ...metric,
      ...(currentDebtSources ? { currentDebtSources } : {}),
      tags: Object.freeze(tags.slice())
    })];
  })
));

/** @param {unknown} value */
export function normalizeSecSymbol(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (isProtoKey(raw)) return null;
  const symbol = raw.toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol) ? symbol : null;
}

/** @param {unknown} value */
export function normalizeSecCik(value) {
  let text = '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) text = String(value);
  if (typeof value === 'string') text = value.trim();
  if (!/^\d{1,10}$/.test(text) || Number(text) <= 0) return null;
  return text.padStart(10, '0');
}

/** @param {string} value */
function decodeXmlText(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 從申報者自己的 XBRL label linkbase 判斷 ShortTermBorrowings 這一列是否明說包含一年內長債。
 * 標準 label 永遠只是「Short-Term Debt」，不能用；只採申報者實際提供的 terse／verbose label。
 * @param {unknown} xml
 * @returns {CurrentDebtLabelHint}
 */
export function parseCurrentDebtLabelHint(xml) {
  if (typeof xml !== 'string' || !xml) return 'unknown';
  const filerLabels = [];
  const labelPattern = /<link:label\b([^>]*)>([\s\S]*?)<\/link:label>/gi;
  for (const match of xml.matchAll(labelPattern)) {
    const attrs = match[1];
    const label = /\bxlink:label=(['"])lab_us-gaap_ShortTermBorrowings\1/i.exec(attrs)?.[0];
    const role = /\bxlink:role=(['"])([^'"]+)\1/i.exec(attrs)?.[2] || '';
    if (!label || /\/role\/label$/i.test(role)) continue;
    const text = decodeXmlText(match[2]);
    if (text) filerLabels.push(text);
  }
  if (!filerLabels.length) return 'unknown';
  const includesCurrentMaturity = filerLabels.some(text => (
    /current\s+(?:portion|maturit(?:y|ies))\s+of\s+long[\s-]*term\s+debt/i.test(text)
    || /long[\s-]*term\s+debt.{0,40}current\s+(?:portion|maturit(?:y|ies))/i.test(text)
  ));
  return includesCurrentMaturity ? 'includes-current-long-term-debt' : 'short-term-only';
}

/**
 * 找出同一份申報裡同時出現「短借」與「一年內長債」的 accession；只有這些申報需要抓 label。
 * tag 全部從 currentDebtSources 取，避免服務層再手寫第二份清單。
 * @param {unknown} companyFacts
 */
export function currentDebtLabelAccessions(companyFacts) {
  const payload = companyFacts && typeof companyFacts === 'object'
    ? /** @type {Record<string, any>} */ (companyFacts)
    : {};
  const usGaap = payload.facts && typeof payload.facts === 'object'
    ? payload.facts['us-gaap']
    : null;
  const definition = /** @type {any} */ (SEC_METRIC_CANDIDATES.currentDebt);
  const sources = definition.currentDebtSources;
  if (!usGaap || typeof usGaap !== 'object' || !sources) return [];

  /** @type {[string, Set<string>][]} */
  const roles = [
    ['shortTerm', new Set(sources.shortTerm)],
    ['currentMaturity', new Set(sources.currentMaturity)]
  ];
  /** @type {Map<string, {filed:string,roles:Set<string>}>} */
  const byAccession = new Map();
  for (const [role, tags] of roles) {
    for (const tag of tags) {
      const units = Object.hasOwn(usGaap, tag) ? usGaap[tag]?.units : null;
      if (!units || typeof units !== 'object') continue;
      for (const rows of Object.values(/** @type {Record<string, any>} */ (units))) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const accession = typeof row?.accn === 'string' ? row.accn.trim() : '';
          const filed = typeof row?.filed === 'string' ? row.filed.trim() : '';
          if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)
            || typeof row?.val !== 'number' || !Number.isFinite(row.val)) continue;
          const entry = byAccession.get(accession) || { filed, roles: new Set() };
          if (filed > entry.filed) entry.filed = filed;
          entry.roles.add(role);
          byAccession.set(accession, entry);
        }
      }
    }
  }
  return [...byAccession.entries()]
    .filter(([, entry]) => entry.roles.size === roles.length)
    .sort((left, right) => right[1].filed.localeCompare(left[1].filed))
    .slice(0, 8)
    .map(([accession]) => accession);
}

/**
 * 從 SEC company_tickers.json 找單一 ticker；重複 ticker 指向不同 CIK 時 fail-closed。
 * @param {unknown} payload
 * @param {unknown} requestedSymbol
 */
export function lookupSecTicker(payload, requestedSymbol) {
  const symbol = normalizeSecSymbol(requestedSymbol);
  if (!symbol || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  /** @type {{symbol:string,cik:string,name:string}|null} */
  let match = null;
  for (const row of Object.values(/** @type {Record<string, any>} */ (payload))) {
    if (!row || typeof row !== 'object' || normalizeSecSymbol(row.ticker) !== symbol) continue;
    const cik = normalizeSecCik(row.cik_str);
    const name = typeof row.title === 'string' ? row.title.trim() : '';
    if (!cik || !name) continue;
    if (match && match.cik !== cik) return null;
    match = { symbol, cik, name };
  }
  return match;
}

/** @param {unknown} value */
function realIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value.trim()
    : null;
}

/** @param {unknown} value */
function realMonthDay(value) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return null;
  return realIsoDate(`2000-${value.slice(0, 2)}-${value.slice(2)}`) ? value : null;
}

/** @param {string} start @param {string} end */
function durationDays(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);
}

/** @param {unknown} unit @param {UnitKind} kind */
function validUnit(unit, kind) {
  if (typeof unit !== 'string') return false;
  if (kind === 'shares') return unit === 'shares';
  if (kind === 'per-share') return /^[A-Z]{3}\/shares$/.test(unit);
  return /^[A-Z]{3}$/.test(unit);
}

/** @param {string} unit @param {UnitKind} kind */
function unitPriority(unit, kind) {
  if (kind === 'currency') return unit === 'USD' ? 0 : 1;
  if (kind === 'per-share') return unit === 'USD/shares' ? 0 : 1;
  return 0;
}

/** @param {string} cik @param {string} accession */
function filingUrl(cik, accession) {
  const entity = cik.replace(/^0+/, '') || '0';
  const directory = accession.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${entity}/${directory}/${accession}-index.html`;
}

/**
 * @param {any} row
 * @param {string} cik
 * @param {string} taxonomy
 * @param {string} tag
 * @param {string} unit
 * @param {FactNature} nature
 */
function normalizeFact(row, cik, taxonomy, tag, unit, nature) {
  if (!row || typeof row !== 'object' || typeof row.val !== 'number' || !Number.isFinite(row.val)) return null;
  const end = realIsoDate(row.end);
  const filed = realIsoDate(row.filed);
  const accession = typeof row.accn === 'string' ? row.accn.trim() : '';
  const form = typeof row.form === 'string' ? row.form.trim().toUpperCase() : '';
  if (!end || !filed || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !form) return null;

  let start = null;
  let days = null;
  if (nature === 'duration') {
    start = realIsoDate(row.start);
    if (!start) return null;
    days = durationDays(start, end);
    if (!Number.isFinite(days) || days < 0) return null;
  }
  return {
    value: row.val,
    unit,
    periodStart: start,
    periodEnd: end,
    form,
    filedAt: filed,
    accession,
    taxonomy,
    tag,
    filingUrl: filingUrl(cik, accession),
    fiscalYear: typeof row.fy === 'number' || typeof row.fy === 'string' ? row.fy : null,
    fiscalPeriod: typeof row.fp === 'string' ? row.fp.trim().toUpperCase() : null,
    periodType: '',
    durationDays: days
  };
}

/** @param {any} left @param {any} right */
function laterSource(left, right) {
  const filed = String(left.filedAt).localeCompare(String(right.filedAt));
  if (filed !== 0) return filed > 0 ? left : right;
  return String(left.accession).localeCompare(String(right.accession)) >= 0 ? left : right;
}

/** @param {any[]} rows @param {FactNature} nature */
function dedupePeriods(rows, nature) {
  const byPeriod = new Map();
  for (const row of rows) {
    const key = nature === 'duration'
      ? `${row.periodStart}|${row.periodEnd}`
      : row.periodEnd;
    const current = byPeriod.get(key);
    byPeriod.set(key, current ? laterSource(current, row) : row);
  }
  return [...byPeriod.values()].sort((a, b) => (
    String(a.periodEnd).localeCompare(String(b.periodEnd))
    || String(a.periodStart || '').localeCompare(String(b.periodStart || ''))
  ));
}

/**
 * @param {any[]} sourceRows
 * @param {string} cik
 * @param {string} taxonomy
 * @param {string} tag
 * @param {string} unit
 * @param {FactNature} nature
 */
function selectPeriods(sourceRows, cik, taxonomy, tag, unit, nature) {
  const annual = [];
  const quarters = [];
  const ytdExcludedKeys = [];
  for (const sourceRow of sourceRows) {
    const fact = normalizeFact(sourceRow, cik, taxonomy, tag, unit, nature);
    if (!fact) continue;
    const fp = fact.fiscalPeriod || '';
    if (ANNUAL_FORMS.has(fact.form) && fp === 'FY') {
      if (nature === 'instant' || (
        fact.durationDays !== null && fact.durationDays >= 335 && fact.durationDays <= 395
      )) {
        fact.periodType = 'annual';
        annual.push(fact);
      }
      continue;
    }
    if (!QUARTER_FORMS.has(fact.form) || !QUARTER_PERIODS.has(fp)) continue;
    if (nature === 'instant') {
      fact.periodType = 'quarter';
      quarters.push(fact);
      continue;
    }
    if (fact.durationDays !== null && fact.durationDays >= 75 && fact.durationDays <= 105) {
      fact.periodType = 'quarter';
      quarters.push(fact);
    } else if (fact.durationDays !== null && fact.durationDays > 105) {
      ytdExcludedKeys.push([
        fact.periodStart || '',
        fact.periodEnd,
        fact.form,
        fact.accession,
        fact.unit,
        fact.taxonomy,
        fact.tag
      ].join('|'));
    }
  }
  const dedupedAnnual = dedupePeriods(annual, nature);
  const dedupedQuarters = dedupePeriods(quarters, nature);
  return {
    annual: dedupedAnnual,
    quarters: dedupedQuarters,
    latestQuarter: dedupedQuarters.at(-1) || null,
    ytdExcluded: ytdExcludedKeys.length,
    ytdExcludedKeys
  };
}

/** @param {any[]} warnings @param {string} code @param {string} message @param {string|null} [metric] */
function addWarning(warnings, code, message, metric = null) {
  if (warnings.some(item => item.code === code && item.metric === metric)) return;
  warnings.push({ code, metric, message });
}

/** @param {any[]} facts */
function latestPeriodEnd(facts) {
  return facts.reduce((latest, fact) => {
    const end = String(fact.periodEnd || '');
    return end > latest ? end : latest;
  }, '');
}

/** @param {any} fact */
function officialSourceKey(fact) {
  const taxonomy = typeof fact?.taxonomy === 'string' ? fact.taxonomy : '';
  const tag = typeof fact?.tag === 'string' ? fact.tag : '';
  if (!taxonomy || taxonomy === 'derived' || !tag) return null;
  return `${taxonomy}|${tag}|${String(fact.unit || '')}`;
}

/** @param {any} fact */
function officialTagKey(fact) {
  const taxonomy = typeof fact?.taxonomy === 'string' ? fact.taxonomy : '';
  const tag = typeof fact?.tag === 'string' ? fact.tag : '';
  return taxonomy && taxonomy !== 'derived' && tag ? `${taxonomy}|${tag}` : null;
}

/** @param {number} left @param {number} right */
function overlapValuesMatchReportedRounding(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return false;
  if (Math.sign(left) !== Math.sign(right)) return false;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  if (Math.min(Math.abs(left), Math.abs(right)) < CROSS_TAG_ROUNDING_UNIT
    || Math.abs(left - right) / scale > CROSS_TAG_ROUNDING_MAX_RELATIVE_DIFFERENCE) return false;
  const roundedLeft = Math.round(left / CROSS_TAG_ROUNDING_UNIT) * CROSS_TAG_ROUNDING_UNIT;
  const roundedRight = Math.round(right / CROSS_TAG_ROUNDING_UNIT) * CROSS_TAG_ROUNDING_UNIT;
  return roundedLeft === roundedRight
    && (left % CROSS_TAG_ROUNDING_UNIT === 0 || right % CROSS_TAG_ROUNDING_UNIT === 0);
}

/** @param {number} left @param {number} right */
function overlapValuesAreClose(left, right) {
  if (Object.is(left, right)) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return (scale > 0
    && Math.abs(left - right) / scale <= CROSS_TAG_OVERLAP_RELATIVE_TOLERANCE)
    || overlapValuesMatchReportedRounding(left, right);
}

/** @param {string} excludedKey */
function ytdOfficialTagKey(excludedKey) {
  const parts = excludedKey.split('|');
  const tag = parts.pop() || '';
  const taxonomy = parts.pop() || '';
  return taxonomy && tag ? `${taxonomy}|${tag}` : null;
}

/**
 * @param {any} fact
 * @param {string} fallbackMetricKey
 * @param {Map<string, Set<string>>} [sources]
 */
function collectOfficialSources(fact, fallbackMetricKey, sources = new Map()) {
  if (!fact || typeof fact !== 'object') return sources;
  const metricKey = typeof fact.metricKey === 'string' && fact.metricKey
    ? fact.metricKey
    : fallbackMetricKey;
  const sourceKey = officialSourceKey(fact);
  if (metricKey && sourceKey) {
    if (!sources.has(metricKey)) sources.set(metricKey, new Set());
    sources.get(metricKey)?.add(sourceKey);
  }
  if (fact.inputs && typeof fact.inputs === 'object') {
    for (const [inputKey, input] of Object.entries(fact.inputs)) {
      collectOfficialSources(input, inputKey, sources);
    }
  }
  return sources;
}

/** @param {any} metric */
function latestQuarterMatchesAnnualSource(metric) {
  const latestAnnual = metric?.annual?.at(-1);
  const latestQuarter = metric?.latestQuarter;
  if (!latestAnnual || !latestQuarter) return true;
  const annualSources = collectOfficialSources(latestAnnual, String(metric?.key || ''));
  const quarterSources = collectOfficialSources(latestQuarter, String(metric?.key || ''));
  if (!annualSources.size || !quarterSources.size) return true;
  if (annualSources.size !== quarterSources.size) return false;
  for (const [metricKey, annualSet] of annualSources) {
    const quarterSet = quarterSources.get(metricKey);
    if (!quarterSet || annualSet.size !== quarterSet.size) return false;
    for (const source of annualSet) {
      if (!quarterSet.has(source)) return false;
    }
  }
  return true;
}

/**
 * 用兩個 tag 的完整期間史判斷口徑；低順位 tag 不改寫同期，一般只補更新期。
 * 至少兩個重疊期間完全同值且沒有其他非完全同值重疊，才補中間缺口。
 * @param {any[]} target
 * @param {any[]} candidates
 * @param {string} boundary
 * @param {number} outputLimit
 */
function mergeFallbackPeriods(target, candidates, boundary, outputLimit) {
  let latest = boundary;
  const addedFacts = [];
  const existingPeriods = new Set(target.map(periodKey));
  const missingCandidates = candidates.filter(fact => !existingPeriods.has(periodKey(fact)));
  const relevantOutputPeriods = new Set(
    [...target, ...missingCandidates]
      .sort((left, right) => (
        String(left.periodEnd || '').localeCompare(String(right.periodEnd || ''))
        || String(left.periodStart || '').localeCompare(String(right.periodStart || ''))
      ))
      .slice(-outputLimit)
      .map(periodKey)
  );
  const hasRelevantMissingPeriod = missingCandidates.some(fact => (
    relevantOutputPeriods.has(periodKey(fact))
  ));
  const targetByPeriod = new Map(target.map(fact => [periodKey(fact), fact]));
  let matchingOverlaps = 0;
  let nonExactOverlap = false;
  let materialOverlapConflict = false;
  for (const fact of candidates) {
    const current = targetByPeriod.get(periodKey(fact));
    if (!current) continue;
    if (current.unit === fact.unit && Object.is(current.value, fact.value)) matchingOverlaps += 1;
    else {
      nonExactOverlap = true;
      if (current.unit !== fact.unit || !overlapValuesAreClose(current.value, fact.value)) {
        materialOverlapConflict = true;
      }
    }
  }
  if (materialOverlapConflict) {
    return {
      latest,
      added: false,
      addedFacts,
      materialOverlapConflict: true,
      hasRelevantMissingPeriod
    };
  }
  const canBackfill = !nonExactOverlap && matchingOverlaps >= 2;
  for (const fact of candidates) {
    const key = periodKey(fact);
    if (existingPeriods.has(key)) continue;
    const end = String(fact.periodEnd || '');
    if (!end || (end <= latest && !canBackfill)) continue;
    target.push(fact);
    existingPeriods.add(key);
    addedFacts.push(fact);
    if (end > latest) latest = end;
  }
  return {
    latest,
    added: addedFacts.length > 0,
    addedFacts,
    materialOverlapConflict: false,
    hasRelevantMissingPeriod
  };
}

/**
 * @param {Record<string, any>} taxonomyFacts
 * @param {string} cik
 * @param {string} key
 * @param {{label:string,nature:FactNature,unitKind:UnitKind,tags:readonly string[]}} definition
 * @param {readonly string[]} tags
 * @param {any[]} warnings
 * @param {CrossTagFallback} [crossTagFallback]
 */
function selectMetricFromTags(
  taxonomyFacts,
  cik,
  key,
  definition,
  tags,
  warnings,
  crossTagFallback = 'newer-periods'
) {
  /** @type {{unit:string,annual:any[],quarters:any[],ytdExcludedKeys:Set<string>,multipleUnitSources:Set<string>}|null} */
  let chosen = null;
  let annualBoundary = '';
  let quarterBoundary = '';
  for (const tag of tags) {
    const concept = Object.hasOwn(taxonomyFacts, tag) ? taxonomyFacts[tag] : null;
    const units = concept && typeof concept === 'object' && concept.units && typeof concept.units === 'object'
      ? concept.units
      : null;
    if (!units) continue;
    const choices = [];
    for (const [unit, rows] of Object.entries(/** @type {Record<string, any>} */ (units))) {
      if (!validUnit(unit, definition.unitKind) || !Array.isArray(rows)) continue;
      const selected = selectPeriods(rows, cik, 'us-gaap', tag, unit, definition.nature);
      if (!selected.annual.length && !selected.quarters.length) continue;
      choices.push({ unit, ...selected });
    }
    if (!choices.length) continue;

    if (!chosen) {
      choices.sort((a, b) => (
        unitPriority(a.unit, definition.unitKind) - unitPriority(b.unit, definition.unitKind)
        || (b.annual.length + b.quarters.length) - (a.annual.length + a.quarters.length)
        || a.unit.localeCompare(b.unit)
      ));
      const primary = choices[0];
      const primarySources = new Set(
        [...primary.annual, ...primary.quarters]
          .map(officialTagKey)
          .filter(source => source !== null)
      );
      chosen = {
        unit: primary.unit,
        annual: primary.annual.slice(),
        quarters: primary.quarters.slice(),
        ytdExcludedKeys: new Set(primary.ytdExcludedKeys),
        multipleUnitSources: choices.length > 1 ? primarySources : new Set()
      };
      annualBoundary = latestPeriodEnd(chosen.annual);
      quarterBoundary = latestPeriodEnd(chosen.quarters);
      if (crossTagFallback === 'first-tag') break;
      continue;
    }

    const chosenUnit = chosen.unit;
    const fallback = choices.find(choice => choice.unit === chosenUnit);
    if (!fallback) continue;
    const annualResult = mergeFallbackPeriods(
      chosen.annual.slice(), fallback.annual, annualBoundary, 5
    );
    const quarterResult = mergeFallbackPeriods(
      chosen.quarters.slice(), fallback.quarters, quarterBoundary, 1
    );
    const sourceConflict = annualResult.materialOverlapConflict
      || quarterResult.materialOverlapConflict;
    if (sourceConflict) {
      if (annualResult.hasRelevantMissingPeriod || quarterResult.hasRelevantMissingPeriod) {
        addWarning(
          warnings,
          'TAG_OVERLAP_CONFLICT',
          `${definition.label}的候選 tag 在重疊期間有實質差異；沒有接續該來源的新舊期間。`,
          key
        );
      }
      continue;
    }
    chosen.annual.push(...annualResult.addedFacts);
    chosen.quarters.push(...quarterResult.addedFacts);
    annualBoundary = annualResult.latest;
    quarterBoundary = quarterResult.latest;
    if (annualResult.added || quarterResult.added) {
      if (choices.length > 1) {
        for (const fact of [...annualResult.addedFacts, ...quarterResult.addedFacts]) {
          const source = officialTagKey(fact);
          if (source) chosen.multipleUnitSources.add(source);
        }
      }
      for (const excludedKey of fallback.ytdExcludedKeys) chosen.ytdExcludedKeys.add(excludedKey);
    }
  }

  if (!chosen) return null;
  chosen.annual.sort((left, right) => (
    String(left.periodEnd).localeCompare(String(right.periodEnd))
    || String(left.periodStart || '').localeCompare(String(right.periodStart || ''))
  ));
  chosen.quarters.sort((left, right) => (
    String(left.periodEnd).localeCompare(String(right.periodEnd))
    || String(left.periodStart || '').localeCompare(String(right.periodStart || ''))
  ));
  const annual = chosen.annual.slice(-5);
  const latestQuarter = chosen.quarters.at(-1) || null;
  const outputSources = new Set(
    [...annual, ...(latestQuarter ? [latestQuarter] : [])]
      .map(officialTagKey)
      .filter(source => source !== null)
  );
  if ([...chosen.multipleUnitSources].some(source => outputSources.has(source))) {
    addWarning(
      warnings,
      'MULTIPLE_UNITS',
      `${definition.label}同時出現多種 unit；只採 ${chosen.unit}，沒有混合趨勢。`,
      key
    );
  }
  if (outputSources.size > 1) {
    addWarning(
      warnings,
      'MIXED_TAG',
      `${definition.label}由多個官方 tag 接續不同期間；保留原始列，但跨期衍生值不混算。`,
      key
    );
  }
  const outputYtdExcludedKeys = new Set(
    [...chosen.ytdExcludedKeys].filter(excludedKey => {
      const source = ytdOfficialTagKey(excludedKey);
      return source !== null && outputSources.has(source);
    })
  );
  if (outputYtdExcludedKeys.size > 0) {
    addWarning(
      warnings,
      'YTD_EXCLUDED',
      `${definition.label}略過 ${outputYtdExcludedKeys.size} 筆六個月／九個月累計值，沒有冒充單季。`,
      key
    );
  }
  const latest = latestQuarter || annual.at(-1);
  return {
    key,
    label: definition.label,
    kind: 'official',
    nature: definition.nature,
    taxonomy: latest?.taxonomy || null,
    tag: latest?.tag || null,
    unit: chosen.unit,
    annual,
    latestQuarter,
    status: 'available'
  };
}

/**
 * @param {Record<string, any>} taxonomyFacts
 * @param {string} cik
 * @param {string} key
 * @param {{label:string,nature:FactNature,unitKind:UnitKind,tags:readonly string[],currentDebtSources?:Record<string,readonly string[]>,crossTagFallback?:CrossTagFallback}} definition
 * @param {any[]} warnings
 * @param {Record<string, CurrentDebtLabelHint>} [currentDebtLabelHints]
 */
function selectMetric(taxonomyFacts, cik, key, definition, warnings, currentDebtLabelHints = {}) {
  if (definition.currentDebtSources) {
    return selectCurrentDebt(
      taxonomyFacts,
      cik,
      key,
      /** @type {any} */ (definition),
      currentDebtLabelHints,
      warnings
    );
  }
  const selected = selectMetricFromTags(
    taxonomyFacts,
    cik,
    key,
    definition,
    definition.tags,
    warnings,
    definition.crossTagFallback
  );
  if (selected) return selected;
  addWarning(warnings, 'METRIC_MISSING', `${definition.label}沒有命中可比較的標準 tag。`, key);
  return {
    key,
    label: definition.label,
    kind: 'official',
    nature: definition.nature,
    taxonomy: null,
    tag: null,
    unit: null,
    annual: [],
    latestQuarter: null,
    status: 'missing'
  };
}

/** 衍生指標的輸入可以「來自申報」也可以「來自另一個衍生指標」——後者沒有 form／accession／tag 這些申報欄位。 */
const DERIVED_INPUT_FIELDS = ['value', 'unit', 'periodStart', 'periodEnd', 'form', 'filedAt', 'accession', 'taxonomy', 'tag', 'filingUrl'];

/**
 * ⚠️ **只複製有值的欄位，缺的整個鍵不要出現**——不可以退回逐欄逐項寫死。
 *
 * 2026-07-29 實測：原本無條件複製那十欄，輸入是衍生指標時（自由現金流率的輸入＝自由現金流，
 * 它是算出來的、沒有申報欄位）就會生出 `form: undefined` 這種鍵。寫入櫃檯的 `isSafeFundamentalsJson`
 * 把 `undefined` 當非法型別，整包被拒 → `POST /api/stock-fundamentals/:symbol/refresh` 回 502，
 * **GOOGL／AAPL／MSFT 三支全掛，等於整個 SEC 基本面功能在真資料上是死的**。
 *
 * 為什麼合成考題全綠：`JSON.stringify` 會把 `undefined` 鍵直接丟掉（實測 24 個 → 來回一趟後 0 個）。
 * fixture 從 JSON 進來、斷言也多半比對 JSON，中間那段「解析器直接餵給驗證器」沒人走過。
 * 守這條的考題在 `test/stock-fundamentals.test.js`：①輸出不得有任何 undefined 值的鍵
 * ②解析結果**不經 JSON** 丟進 `sanitizeDbForWrite({mode:'throw'})` 必須被收下。
 *
 * @param {any} fact @param {string} metricKey
 */
function derivedInput(fact, metricKey) {
  /** @type {Record<string, any>} */
  const input = { metricKey };
  for (const field of DERIVED_INPUT_FIELDS) {
    if (fact[field] !== undefined) input[field] = fact[field];
  }
  if (typeof fact.formula === 'string') input.formula = fact.formula;
  if (fact.inputs && typeof fact.inputs === 'object') input.inputs = fact.inputs;
  return input;
}

/** @param {any} fact */
function periodKey(fact) {
  return `${fact.periodStart || ''}|${fact.periodEnd}`;
}

/** @param {any} left @param {any} right */
function sameCurrentDebtContext(left, right) {
  return left.unit === right.unit
    && left.periodStart === right.periodStart
    && left.periodEnd === right.periodEnd
    && left.accession === right.accession
    && left.form === right.form
    && left.filedAt === right.filedAt;
}

/** @param {any} shortTerm @param {any} currentMaturity */
function summedCurrentDebtFact(shortTerm, currentMaturity) {
  const formula = `${shortTerm.tag} + ${currentMaturity.tag}`;
  return {
    value: shortTerm.value + currentMaturity.value,
    unit: shortTerm.unit,
    periodStart: shortTerm.periodStart,
    periodEnd: shortTerm.periodEnd,
    form: shortTerm.form,
    filedAt: shortTerm.filedAt,
    accession: shortTerm.accession,
    taxonomy: 'derived',
    tag: formula,
    filingUrl: shortTerm.filingUrl,
    fiscalYear: shortTerm.fiscalYear,
    fiscalPeriod: shortTerm.fiscalPeriod,
    periodType: shortTerm.periodType,
    durationDays: shortTerm.durationDays,
    formula,
    inputs: {
      shortTerm: derivedInput(shortTerm, 'currentDebt.shortTerm'),
      currentMaturity: derivedInput(currentMaturity, 'currentDebt.currentMaturity')
    }
  };
}

/**
 * 缺總額時的單期判準。單一來源必須原樣回傳；兩個來源只在 label 或數值關係能排除父子重疊時才相加。
 * @param {any[]} parts
 * @param {Record<string, CurrentDebtLabelHint>} labelHints
 * @param {any[]} warnings
 * @param {string} key
 */
function resolveCurrentDebtPeriod(parts, labelHints, warnings, key) {
  if (parts.length === 1) return parts[0].fact;
  const shortTerm = parts.find(part => part.role === 'shortTerm')?.fact;
  const currentMaturity = parts.find(part => part.role === 'currentMaturity')?.fact;
  if (!shortTerm) return currentMaturity || null;
  if (!currentMaturity) return shortTerm;

  const hint = Object.hasOwn(labelHints, shortTerm.accession)
    ? labelHints[shortTerm.accession]
    : 'unknown';
  if (hint === 'includes-current-long-term-debt') return shortTerm;
  if (!sameCurrentDebtContext(shortTerm, currentMaturity)
    || shortTerm.value < 0 || currentMaturity.value < 0) {
    addWarning(
      warnings,
      'CURRENT_DEBT_CONTEXT_MISMATCH',
      '流動債務的短借與一年內長債不在同一申報脈絡，沒有相加以免混算。',
      key
    );
    return shortTerm;
  }
  if (hint === 'short-term-only' || shortTerm.value < currentMaturity.value) {
    if (Number.isFinite(shortTerm.value + currentMaturity.value)) {
      return summedCurrentDebtFact(shortTerm, currentMaturity);
    }
    addWarning(
      warnings,
      'CURRENT_DEBT_SUM_INVALID',
      '流動債務成分相加後不是有限數字，已保留短借原值，沒有讓壞值進寫入櫃檯。',
      key
    );
    return shortTerm;
  }
  addWarning(
    warnings,
    'CURRENT_DEBT_OVERLAP_UNRESOLVED',
    'ShortTermBorrowings 可能已包含一年內長債；無總額且無申報 label 可判斷時不重複相加。',
    key
  );
  return shortTerm;
}

/**
 * currentDebt 不是同義 tag 的 first-hit-wins：每一期先採官方總額，沒有總額才判斷兩個成分能否安全相加。
 * @param {Record<string, any>} taxonomyFacts
 * @param {string} cik
 * @param {string} key
 * @param {{label:string,nature:FactNature,unitKind:UnitKind,tags:readonly string[],currentDebtSources:Record<string,readonly string[]>}} definition
 * @param {Record<string, CurrentDebtLabelHint>} labelHints
 * @param {any[]} warnings
 */
function selectCurrentDebt(taxonomyFacts, cik, key, definition, labelHints, warnings) {
  const sources = definition.currentDebtSources;
  const total = selectMetricFromTags(
    taxonomyFacts,
    cik,
    key,
    definition,
    sources.total,
    warnings,
    'first-tag'
  );
  const shortTerm = selectMetricFromTags(
    taxonomyFacts,
    cik,
    key,
    definition,
    sources.shortTerm,
    warnings,
    'first-tag'
  );
  const currentMaturity = selectMetricFromTags(
    taxonomyFacts,
    cik,
    key,
    definition,
    sources.currentMaturity,
    warnings,
    'first-tag'
  );
  const available = [total, shortTerm, currentMaturity].filter(metric => metric !== null);
  if (available.length === 1) return available[0];
  if (!available.length) {
    addWarning(warnings, 'METRIC_MISSING', `${definition.label}沒有命中可比較的標準 tag。`, key);
    return {
      key,
      label: definition.label,
      kind: 'official',
      nature: definition.nature,
      taxonomy: null,
      tag: null,
      unit: null,
      annual: [],
      latestQuarter: null,
      status: 'missing'
    };
  }

  const annualPeriods = new Set();
  for (const metric of available) {
    for (const fact of metric.annual) annualPeriods.add(periodKey(fact));
  }
  const annual = [...annualPeriods].map(keyForPeriod => {
    const totalFact = total?.annual.find(fact => periodKey(fact) === keyForPeriod);
    if (totalFact) return totalFact;
    const shortTermFact = shortTerm?.annual.find(fact => periodKey(fact) === keyForPeriod);
    const currentMaturityFact = currentMaturity?.annual.find(
      fact => periodKey(fact) === keyForPeriod
    );
    return resolveCurrentDebtPeriod([
      ...(shortTermFact
        ? [{ role: 'shortTerm', fact: shortTermFact }]
        : []),
      ...(currentMaturityFact
        ? [{
            role: 'currentMaturity',
            fact: currentMaturityFact
          }]
        : [])
    ], labelHints, warnings, key);
  }).filter(fact => fact !== null).sort((left, right) => (
    String(left.periodEnd).localeCompare(String(right.periodEnd))
  )).slice(-5);

  const quarterCandidates = [
    total?.latestQuarter ? { role: 'total', fact: total.latestQuarter } : null,
    shortTerm?.latestQuarter ? { role: 'shortTerm', fact: shortTerm.latestQuarter } : null,
    currentMaturity?.latestQuarter ? { role: 'currentMaturity', fact: currentMaturity.latestQuarter } : null
  ].filter(candidate => candidate !== null);
  const latestQuarterEnd = quarterCandidates
    .map(candidate => candidate.fact.periodEnd)
    .sort()
    .at(-1);
  const latestQuarterParts = quarterCandidates.filter(candidate => (
    candidate.fact.periodEnd === latestQuarterEnd
  ));
  const totalQuarter = latestQuarterParts.find(part => part.role === 'total')?.fact;
  const latestQuarter = totalQuarter || resolveCurrentDebtPeriod(
    latestQuarterParts.filter(part => part.role !== 'total'),
    labelHints,
    warnings,
    key
  );
  const latest = latestQuarter || annual.at(-1);
  return {
    key,
    label: definition.label,
    kind: 'official',
    nature: definition.nature,
    taxonomy: latest?.taxonomy || null,
    tag: latest?.tag || null,
    unit: latest?.unit || null,
    annual,
    latestQuarter,
    status: annual.length || latestQuarter ? 'available' : 'missing'
  };
}

/**
 * @param {Record<string, any>} metrics
 * @param {string} key
 * @param {string} label
 * @param {string} formula
 * @param {string} leftKey
 * @param {string} rightKey
 * @param {(left:number,right:number)=>number|null} calculate
 * @param {(left:any,right:any)=>string|null} outputUnit
 */
function binaryDerived(metrics, key, label, formula, leftKey, rightKey, calculate, outputUnit) {
  const left = metrics[leftKey];
  const right = metrics[rightKey];
  const annual = [];
  if (left && right) {
    const rightByPeriod = new Map(right.annual.map((fact) => [periodKey(fact), fact]));
    for (const leftFact of left.annual) {
      const rightFact = rightByPeriod.get(periodKey(leftFact));
      if (!rightFact) continue;
      const unit = outputUnit(leftFact, rightFact);
      const value = calculate(leftFact.value, rightFact.value);
      if (!unit || value === null || !Number.isFinite(value)) continue;
      annual.push({
        value,
        unit,
        periodStart: leftFact.periodStart,
        periodEnd: leftFact.periodEnd,
        periodType: 'annual',
        durationDays: leftFact.durationDays,
        formula,
        inputs: {
          [leftKey]: derivedInput(leftFact, leftKey),
          [rightKey]: derivedInput(rightFact, rightKey)
        }
      });
    }
  }

  let latestQuarter = null;
  const leftQuarter = left?.latestQuarter;
  const rightQuarter = right?.latestQuarter;
  if (leftQuarter && rightQuarter
    && latestQuarterMatchesAnnualSource(left)
    && latestQuarterMatchesAnnualSource(right)
    && periodKey(leftQuarter) === periodKey(rightQuarter)) {
    const unit = outputUnit(leftQuarter, rightQuarter);
    const value = calculate(leftQuarter.value, rightQuarter.value);
    if (unit && value !== null && Number.isFinite(value)) {
      latestQuarter = {
        value,
        unit,
        periodStart: leftQuarter.periodStart,
        periodEnd: leftQuarter.periodEnd,
        periodType: 'quarter',
        durationDays: leftQuarter.durationDays,
        formula,
        inputs: {
          [leftKey]: derivedInput(leftQuarter, leftKey),
          [rightKey]: derivedInput(rightQuarter, rightKey)
        }
      };
    }
  }
  return {
    key,
    label,
    kind: 'derived',
    formula,
    requires: [leftKey, rightKey],
    unit: annual.at(-1)?.unit || latestQuarter?.unit || null,
    annual,
    latestQuarter,
    status: annual.length || latestQuarter ? 'available' : 'missing'
  };
}

/** @param {any} left @param {any} right */
function matchingUnit(left, right) {
  return left.unit === right.unit ? left.unit : null;
}

/** @param {any} left @param {any} right */
function ratioUnit(left, right) {
  return left.unit === right.unit ? 'ratio' : null;
}

/** @param {Record<string, any>} metrics */
function revenueCagr(metrics) {
  const formula = '(latestRevenue / earliestRevenue) ** (1 / years) - 1';
  const annual = [];
  const rows = metrics.revenue?.annual || [];
  for (let index = 0; index < rows.length; index += 1) {
    const latest = rows[index];
    const latestYear = Number(String(latest.periodEnd).slice(0, 4));
    const earliest = rows.slice(0, index).find((row) => (
      latestYear - Number(String(row.periodEnd).slice(0, 4)) === 3
    ));
    if (!earliest
      || latest.unit !== earliest.unit
      || officialSourceKey(latest) !== officialSourceKey(earliest)
      || latest.value <= 0
      || earliest.value <= 0) continue;
    const years = durationDays(earliest.periodEnd, latest.periodEnd) / 365.2425;
    if (years < 2.7 || years > 3.3) continue;
    const value = (latest.value / earliest.value) ** (1 / years) - 1;
    if (!Number.isFinite(value)) continue;
    annual.push({
      value,
      unit: 'ratio',
      periodStart: earliest.periodEnd,
      periodEnd: latest.periodEnd,
      periodType: 'annual',
      durationDays: durationDays(earliest.periodEnd, latest.periodEnd),
      years,
      formula,
      inputs: {
        earliestRevenue: derivedInput(earliest, 'revenue'),
        latestRevenue: derivedInput(latest, 'revenue')
      }
    });
  }
  return {
    key: 'revenueCagr3y',
    label: '3 年營收複合成長率',
    kind: 'derived',
    formula,
    requires: ['revenue'],
    unit: annual.length ? 'ratio' : null,
    annual,
    latestQuarter: null,
    status: annual.length ? 'available' : 'missing'
  };
}

/** @param {Record<string, any>} metrics */
function dilutedSharesChange(metrics) {
  const formula = 'dilutedShares / priorDilutedShares - 1';
  const annual = [];
  const rows = metrics.dilutedShares?.annual || [];
  for (let index = 1; index < rows.length; index += 1) {
    const prior = rows[index - 1];
    const current = rows[index];
    if (prior.unit !== current.unit || prior.value === 0) continue;
    const value = current.value / prior.value - 1;
    if (!Number.isFinite(value)) continue;
    annual.push({
      value,
      unit: 'ratio',
      periodStart: prior.periodEnd,
      periodEnd: current.periodEnd,
      periodType: 'annual',
      durationDays: durationDays(prior.periodEnd, current.periodEnd),
      formula,
      inputs: {
        priorDilutedShares: derivedInput(prior, 'dilutedShares'),
        dilutedShares: derivedInput(current, 'dilutedShares')
      }
    });
  }
  return {
    key: 'dilutedSharesChange',
    label: '稀釋股數變化',
    kind: 'derived',
    formula,
    requires: ['dilutedShares'],
    unit: annual.length ? 'ratio' : null,
    annual,
    latestQuarter: null,
    status: annual.length ? 'available' : 'missing'
  };
}

/** @param {Record<string, any>} official */
function deriveMetrics(official) {
  return {
    revenueCagr3y: revenueCagr(official),
    grossMargin: binaryDerived(
      official, 'grossMargin', '毛利率', 'grossProfit / revenue',
      'grossProfit', 'revenue',
      (grossProfit, revenue) => revenue === 0 ? null : grossProfit / revenue,
      ratioUnit
    ),
    operatingMargin: binaryDerived(
      official, 'operatingMargin', '營業利益率', 'operatingIncome / revenue',
      'operatingIncome', 'revenue',
      (operatingIncome, revenue) => revenue === 0 ? null : operatingIncome / revenue,
      ratioUnit
    ),
    netMargin: binaryDerived(
      official, 'netMargin', '淨利率', 'netIncome / revenue',
      'netIncome', 'revenue',
      (netIncome, revenue) => revenue === 0 ? null : netIncome / revenue,
      ratioUnit
    ),
    freeCashFlow: binaryDerived(
      official, 'freeCashFlow', '自由現金流', 'operatingCashFlow - capitalExpenditure',
      'operatingCashFlow', 'capitalExpenditure',
      (operatingCashFlow, capitalExpenditure) => operatingCashFlow - capitalExpenditure,
      matchingUnit
    ),
    freeCashFlowMargin: null,
    cashConversion: binaryDerived(
      official, 'cashConversion', '現金轉換', 'operatingCashFlow / netIncome',
      'operatingCashFlow', 'netIncome',
      (operatingCashFlow, netIncome) => netIncome <= 0 ? null : operatingCashFlow / netIncome,
      ratioUnit
    ),
    stockCompToRevenue: binaryDerived(
      official, 'stockCompToRevenue', '股票薪酬占營收', 'stockBasedCompensation / revenue',
      'stockBasedCompensation', 'revenue',
      (stockBasedCompensation, revenue) => revenue === 0 ? null : stockBasedCompensation / revenue,
      ratioUnit
    ),
    dilutedSharesChange: dilutedSharesChange(official)
  };
}

/** @param {Record<string, any>} metrics */
function addDependentDerived(metrics) {
  metrics.freeCashFlowMargin = binaryDerived(
    metrics, 'freeCashFlowMargin', '自由現金流率', 'freeCashFlow / revenue',
    'freeCashFlow', 'revenue',
    (freeCashFlow, revenue) => revenue === 0 ? null : freeCashFlow / revenue,
    ratioUnit
  );
}

/**
 * 各列會保留自己的最新合法單季；只有截止日全相同時才適合視為同一欄比較。
 * @param {Record<string, any>} metrics
 * @param {any[]} warnings
 */
function addQuarterPeriodWarning(metrics, warnings) {
  const periodEnds = [...new Set(Object.values(metrics)
    .map(metric => String(metric?.latestQuarter?.periodEnd || ''))
    .filter(Boolean))].sort();
  if (periodEnds.length <= 1) return;
  addWarning(
    warnings,
    'QUARTER_PERIOD_MISMATCH',
    `最新單季分屬 ${periodEnds.length} 個不同截止日（${periodEnds.join('、')}）；請以每列標示期間為準，不可直接橫向比較。`
  );
}

/** @param {Record<string, any>} metrics @param {any[]} warnings */
function periodSummary(metrics, warnings) {
  let annualFacts = metrics.revenue?.annual || [];
  if (!annualFacts.length) {
    annualFacts = Object.values(metrics)
      .filter(metric => metric?.kind === 'official' && metric.nature === 'duration')
      .flatMap(metric => metric.annual || []);
  }
  const annualByEnd = new Map();
  for (const fact of annualFacts) {
    if (!annualByEnd.has(fact.periodEnd)) {
      annualByEnd.set(fact.periodEnd, {
        periodStart: fact.periodStart,
        periodEnd: fact.periodEnd
      });
    }
  }

  let latestQuarter = metrics.revenue?.latestQuarter || null;
  if (!latestQuarter) {
    const quarters = Object.values(metrics)
      .filter(metric => metric?.kind === 'official' && metric.nature === 'duration')
      .map(metric => metric.latestQuarter)
      .filter(Boolean)
      .sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
    latestQuarter = quarters.at(-1) || null;
  }
  addQuarterPeriodWarning(metrics, warnings);
  return {
    annual: [...annualByEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-5),
    latestQuarterBasis: 'per-metric',
    latestQuarter: latestQuarter
      ? { periodStart: latestQuarter.periodStart, periodEnd: latestQuarter.periodEnd }
      : null
  };
}

/**
 * 把 submissions＋companyfacts 整理成可供 F4 快取的純資料契約。
 * @param {{
 *   symbol:unknown,
 *   cik?:unknown,
 *   submissions:unknown,
 *   companyFacts:unknown,
 *   currentDebtLabelHints?:unknown
 * }} input
 */
export function parseSecCompanyFacts(input) {
  if (!input || typeof input !== 'object') throw new SecDataContractError('SEC 解析輸入不是物件');
  const symbol = normalizeSecSymbol(input.symbol);
  if (!symbol) throw new SecDataContractError('SEC ticker 格式不合法');
  const submissions = input.submissions && typeof input.submissions === 'object'
    ? /** @type {Record<string, any>} */ (input.submissions)
    : null;
  const companyFacts = input.companyFacts && typeof input.companyFacts === 'object'
    ? /** @type {Record<string, any>} */ (input.companyFacts)
    : null;
  if (!submissions || !companyFacts) throw new SecDataContractError('SEC submissions／companyfacts 格式不合法');

  const suppliedCik = input.cik === undefined || input.cik === null
    ? null
    : normalizeSecCik(input.cik);
  const submissionsCik = normalizeSecCik(submissions.cik);
  const companyFactsCik = normalizeSecCik(companyFacts.cik);
  if ((input.cik !== undefined && input.cik !== null && !suppliedCik)
    || !submissionsCik || !companyFactsCik
    || submissionsCik !== companyFactsCik
    || (suppliedCik && suppliedCik !== submissionsCik)) {
    throw new SecDataContractError('SEC CIK 缺漏或來源不一致');
  }
  const cik = submissionsCik;

  const name = typeof submissions.name === 'string' && submissions.name.trim()
    ? submissions.name.trim()
    : typeof companyFacts.entityName === 'string' ? companyFacts.entityName.trim() : '';
  if (!name) throw new SecDataContractError('SEC 公司名稱缺漏');

  const usGaap = companyFacts.facts
    && typeof companyFacts.facts === 'object'
    && Object.hasOwn(companyFacts.facts, 'us-gaap')
    && companyFacts.facts['us-gaap']
    && typeof companyFacts.facts['us-gaap'] === 'object'
    ? companyFacts.facts['us-gaap']
    : {};
  /** @type {Record<string, CurrentDebtLabelHint>} */
  const currentDebtLabelHints = Object.create(null);
  if (input.currentDebtLabelHints && typeof input.currentDebtLabelHints === 'object') {
    for (const [accession, hint] of Object.entries(
      /** @type {Record<string, unknown>} */ (input.currentDebtLabelHints)
    )) {
      if (/^\d{10}-\d{2}-\d{6}$/.test(accession)
        && (hint === 'includes-current-long-term-debt' || hint === 'short-term-only')) {
        currentDebtLabelHints[accession] = hint;
      }
    }
  }
  const warnings = [];
  /** @type {Record<string, any>} */
  const metrics = {};
  for (const [key, rawDefinition] of Object.entries(SEC_METRIC_CANDIDATES)) {
    const definition = /** @type {{
     *   label:string,
     *   nature:FactNature,
     *   unitKind:UnitKind,
     *   tags:readonly string[],
     *   currentDebtSources?:Record<string,readonly string[]>
     * }} */ (
      rawDefinition
    );
    metrics[key] = selectMetric(
      usGaap,
      cik,
      key,
      definition,
      warnings,
      currentDebtLabelHints
    );
  }
  Object.assign(metrics, deriveMetrics(metrics));
  addDependentDerived(metrics);

  const sic = typeof submissions.sic === 'string' || typeof submissions.sic === 'number'
    ? String(submissions.sic).trim()
    : '';
  const fiscalYearEnd = typeof submissions.fiscalYearEnd === 'string'
    ? submissions.fiscalYearEnd.trim()
    : '';
  return {
    symbol,
    market: 'US',
    company: {
      cik,
      name,
      sic: /^\d{4}$/.test(sic) ? sic : null,
      fiscalYearEnd: realMonthDay(fiscalYearEnd)
    },
    periods: periodSummary(metrics, warnings),
    metrics,
    warnings
  };
}
