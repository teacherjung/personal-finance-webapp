// @ts-check
// SEC Company Facts 純解析器：只整理官方 JSON，不碰網路、資料庫、DOM 或使用者研究內容。

import { isProtoKey } from './safe-map.js';

/** @typedef {'duration'|'instant'} FactNature */
/** @typedef {'currency'|'per-share'|'shares'} UnitKind */

const DAY_MS = 24 * 60 * 60 * 1000;
const ANNUAL_FORMS = new Set(['10-K', '10-K/A']);
const QUARTER_FORMS = new Set(['10-Q', '10-Q/A']);
const QUARTER_PERIODS = new Set(['Q1', 'Q2', 'Q3']);

const RAW_SEC_METRICS = {
  revenue: {
    label: '營收',
    nature: 'duration',
    unitKind: 'currency',
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
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
    tags: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsForAdditionsToPropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets'
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
    // ⚠️ **這一格與其他指標不同：組**間**是「該相加的科目」，不是同義替代。**
    // `ShortTermBorrowings`（短期借款／商業本票）與「一年內到期長債」在 US-GAAP 是**互斥且相加**的
    // 兩個科目，重槓桿公司（工業、公用事業、金融）兩者並報是常態。舊寫法把三個 tag 放同一個扁平清單、
    // 交給 first-hit-wins 挑一個 → **低報**：實測同日申報 3000＋12000 只顯示 3000（低報 80%）、零警告。
    // 組**內**仍是同義替代（含／不含融資租賃的兩種寫法），first-hit-wins 在組內是對的。
    // 對照組 `noncurrentDebt` 的兩個 tag 確實是近義替代 → 維持單組、行為不變。
    tagGroups: [
      ['ShortTermBorrowings'],
      ['LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtCurrent']
    ]
  },
  noncurrentDebt: {
    label: '非流動債務',
    nature: 'instant',
    unitKind: 'currency',
    tags: [
      'LongTermDebtAndFinanceLeaseObligationsNoncurrent',
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
    tags: ['PaymentsForRepurchaseOfCommonStock', 'PaymentsForRepurchaseOfCommonAndPreferredStock']
  },
  dividendsPaid: {
    label: '支付股利',
    nature: 'duration',
    unitKind: 'currency',
    tags: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock']
  }
};

// `tagGroups` 是分組指標（目前只有 currentDebt）的**單一真相**；`tags` 一律由它攤平算出、不手寫第二份
// ——兩份清單各自維護必然走散。多數指標只宣告 `tags`，在這裡補成單一組，選取邏輯因此只有一條路。
export const SEC_METRIC_CANDIDATES = Object.freeze(Object.fromEntries(
  Object.entries(RAW_SEC_METRICS).map(([key, metric]) => {
    const groups = metric.tagGroups ?? [metric.tags];
    return [key, Object.freeze({
      ...metric,
      tagGroups: Object.freeze(groups.map((group) => Object.freeze(group.slice()))),
      tags: Object.freeze(groups.flat())
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
  let ytdExcluded = 0;
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
      ytdExcluded += 1;
    }
  }
  const dedupedAnnual = dedupePeriods(annual, nature).slice(-5);
  const dedupedQuarters = dedupePeriods(quarters, nature);
  return {
    annual: dedupedAnnual,
    quarters: dedupedQuarters,
    latestQuarter: dedupedQuarters.at(-1) || null,
    ytdExcluded
  };
}

/** @param {any[]} warnings @param {string} code @param {string} message @param {string|null} [metric] */
function addWarning(warnings, code, message, metric = null) {
  if (warnings.some(item => item.code === code && item.metric === metric)) return;
  warnings.push({ code, metric, message });
}

/**
 * 從**一組同義替代**的 tag 裡挑一個（組內 first-hit-wins）。挑不到回 null。
 * 這是舊 `selectMetric` 的迴圈本體原樣搬出，行為不變——只為了讓「多組相加」能重複使用它。
 * @param {Record<string, any>} taxonomyFacts
 * @param {string} cik
 * @param {string} key
 * @param {{label:string,nature:FactNature,unitKind:UnitKind}} definition
 * @param {readonly string[]} tags
 * @param {any[]} warnings
 */
function selectFromTagGroup(taxonomyFacts, cik, key, definition, tags, warnings) {
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
      if (selected.annual.length || selected.quarters.length) choices.push({ unit, ...selected });
    }
    if (!choices.length) continue;
    choices.sort((a, b) => (
      unitPriority(a.unit, definition.unitKind) - unitPriority(b.unit, definition.unitKind)
      || (b.annual.length + b.quarters.length) - (a.annual.length + a.quarters.length)
      || a.unit.localeCompare(b.unit)
    ));
    const selected = choices[0];
    if (choices.length > 1) {
      addWarning(
        warnings,
        'MULTIPLE_UNITS',
        `${definition.label}同時出現多種 unit；只採 ${selected.unit}，沒有混合趨勢。`,
        key
      );
    }
    if (selected.ytdExcluded > 0) {
      addWarning(
        warnings,
        'YTD_EXCLUDED',
        `${definition.label}略過 ${selected.ytdExcluded} 筆六個月／九個月累計值，沒有冒充單季。`,
        key
      );
    }
    return {
      key,
      label: definition.label,
      kind: 'official',
      nature: definition.nature,
      taxonomy: 'us-gaap',
      tag,
      unit: selected.unit,
      annual: selected.annual,
      latestQuarter: selected.latestQuarter,
      status: 'available'
    };
  }
  return null;
}

/**
 * 把多組（＝該相加的科目）合成一個指標。
 *
 * **fail-closed 三處，都不靜默**：①各組 unit 不一致＝加不得，整支指標歸 missing＋警告
 * ②某個期間只有部分組有值＝加起來會少一塊，**丟掉該期間**＋警告（不輸出不完整的和）
 * ③最新單季期間對不齊＝不輸出 latestQuarter＋警告。
 * 期間對齊沿用 `periodKey`（與 `binaryDerived` 同一套紀律）。
 * 每一筆和都帶 `formula` 與 `inputs`＝來源可追回（與衍生指標同格式）。
 *
 * @param {string} key
 * @param {{label:string,nature:FactNature}} definition
 * @param {any[]} parts 各組挑出來的官方指標（長度 ≥ 2）
 * @param {any[]} warnings
 */
function sumTagGroups(key, definition, parts, warnings) {
  const missing = () => ({
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
  });

  const unit = parts[0].unit;
  if (parts.some((part) => part.unit !== unit)) {
    addWarning(
      warnings,
      'ADDITIVE_UNIT_MISMATCH',
      `${definition.label}的各組科目 unit 不一致（${parts.map((p) => `${p.tag}=${p.unit}`).join('、')}），無法相加。`,
      key
    );
    return missing();
  }

  const formula = parts.map((part) => part.tag).join(' + ');
  /** @param {any[]} facts */
  const sumFacts = (facts) => {
    const first = facts[0];
    return {
      value: facts.reduce((total, fact) => total + fact.value, 0),
      unit,
      periodStart: first.periodStart,
      periodEnd: first.periodEnd,
      periodType: first.periodType,
      durationDays: first.durationDays,
      formula,
      inputs: Object.fromEntries(facts.map((fact) => [fact.tag, derivedInput(fact, fact.tag)]))
    };
  };

  // 年度序列：只加總「每一組都有值」的期間
  const annual = [];
  let droppedPeriods = 0;
  const byPeriod = parts.map((part) => new Map(part.annual.map((fact) => [periodKey(fact), fact])));
  const allPeriods = new Set(byPeriod.flatMap((map) => [...map.keys()]));
  for (const period of [...allPeriods].sort()) {
    const facts = byPeriod.map((map) => map.get(period)).filter(Boolean);
    if (facts.length !== parts.length) { droppedPeriods += 1; continue; }
    annual.push(sumFacts(facts));
  }
  annual.sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));

  // 最新單季：所有組必須落在同一個期間
  let latestQuarter = null;
  const quarters = parts.map((part) => part.latestQuarter);
  const complete = quarters.every(Boolean);
  const aligned = complete && quarters.every((fact) => periodKey(fact) === periodKey(quarters[0]));
  if (aligned) latestQuarter = sumFacts(quarters);

  if (droppedPeriods > 0 || !aligned) {
    const parts2 = [];
    if (droppedPeriods > 0) parts2.push(`略過 ${droppedPeriods} 個只有部分科目申報的年度`);
    if (!aligned) parts2.push('最新單季各科目期間對不齊、不輸出單季');
    addWarning(
      warnings,
      'ADDITIVE_PERIOD_INCOMPLETE',
      `${definition.label}＝${formula}；${parts2.join('；')}（寧可不給，也不給少一塊的和）。`,
      key
    );
  }

  return {
    key,
    label: definition.label,
    kind: 'official',
    nature: definition.nature,
    taxonomy: 'us-gaap',
    tag: formula,
    unit,
    annual,
    latestQuarter,
    status: annual.length || latestQuarter ? 'available' : 'missing'
  };
}

/**
 * @param {Record<string, any>} taxonomyFacts
 * @param {string} cik
 * @param {string} key
 * @param {{label:string,nature:FactNature,unitKind:UnitKind,tagGroups:readonly (readonly string[])[]}} definition
 * @param {any[]} warnings
 */
function selectMetric(taxonomyFacts, cik, key, definition, warnings) {
  const parts = [];
  for (const group of definition.tagGroups) {
    const part = selectFromTagGroup(taxonomyFacts, cik, key, definition, group, warnings);
    if (part) parts.push(part);
  }
  // 只有一組命中＝與分組前完全相同的行為（多數指標、以及只申報一種債務的公司都走這條）
  if (parts.length === 1) return parts[0];
  if (parts.length > 1) return sumTagGroups(key, definition, parts, warnings);

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
  if (leftQuarter && rightQuarter && periodKey(leftQuarter) === periodKey(rightQuarter)) {
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
    if (!earliest || latest.unit !== earliest.unit || latest.value <= 0 || earliest.value <= 0) continue;
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

/** @param {Record<string, any>} metrics */
function periodSummary(metrics) {
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
  return {
    annual: [...annualByEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-5),
    latestQuarter: latestQuarter
      ? { periodStart: latestQuarter.periodStart, periodEnd: latestQuarter.periodEnd }
      : null
  };
}

/**
 * 把 submissions＋companyfacts 整理成可供 F4 快取的純資料契約。
 * @param {{symbol:unknown,cik?:unknown,submissions:unknown,companyFacts:unknown}} input
 */
export function parseSecCompanyFacts(input) {
  if (!input || typeof input !== 'object') throw new TypeError('SEC 解析輸入不是物件');
  const symbol = normalizeSecSymbol(input.symbol);
  if (!symbol) throw new TypeError('SEC ticker 格式不合法');
  const submissions = input.submissions && typeof input.submissions === 'object'
    ? /** @type {Record<string, any>} */ (input.submissions)
    : null;
  const companyFacts = input.companyFacts && typeof input.companyFacts === 'object'
    ? /** @type {Record<string, any>} */ (input.companyFacts)
    : null;
  if (!submissions || !companyFacts) throw new TypeError('SEC submissions／companyfacts 格式不合法');

  const suppliedCik = input.cik === undefined || input.cik === null
    ? null
    : normalizeSecCik(input.cik);
  const submissionsCik = normalizeSecCik(submissions.cik);
  const companyFactsCik = normalizeSecCik(companyFacts.cik);
  if ((input.cik !== undefined && input.cik !== null && !suppliedCik)
    || !submissionsCik || !companyFactsCik
    || submissionsCik !== companyFactsCik
    || (suppliedCik && suppliedCik !== submissionsCik)) {
    throw new TypeError('SEC CIK 缺漏或來源不一致');
  }
  const cik = submissionsCik;

  const name = typeof submissions.name === 'string' && submissions.name.trim()
    ? submissions.name.trim()
    : typeof companyFacts.entityName === 'string' ? companyFacts.entityName.trim() : '';
  if (!name) throw new TypeError('SEC 公司名稱缺漏');

  const usGaap = companyFacts.facts
    && typeof companyFacts.facts === 'object'
    && Object.hasOwn(companyFacts.facts, 'us-gaap')
    && companyFacts.facts['us-gaap']
    && typeof companyFacts.facts['us-gaap'] === 'object'
    ? companyFacts.facts['us-gaap']
    : {};
  const warnings = [];
  /** @type {Record<string, any>} */
  const metrics = {};
  for (const [key, rawDefinition] of Object.entries(SEC_METRIC_CANDIDATES)) {
    // `tagGroups` 由 SEC_METRIC_CANDIDATES 建表時補齊（只宣告 tags 的指標會拿到單一組），
    // 所以選取邏輯只吃 tagGroups、不必再看 tags。
    const definition = /** @type {{label:string,nature:FactNature,unitKind:UnitKind,tagGroups:readonly (readonly string[])[]}} */ (
      rawDefinition
    );
    metrics[key] = selectMetric(usGaap, cik, key, definition, warnings);
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
    periods: periodSummary(metrics),
    metrics,
    warnings
  };
}
