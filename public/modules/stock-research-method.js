// @ts-check
// 個股研究方法與基本面證據契約：固定問題、指標用途與可比較性，不碰 DOM、API 或資料庫。

/** @typedef {'general'|'bank'|'insurance'|'reit'|'unknown'} CompanyKind */
/** @typedef {'official'|'derived'} MetricKind */

const RAW_RESEARCH_METHOD_SECTIONS = [
  {
    key: 'business-model',
    label: '公司靠什麼賺錢',
    questions: [
      '客戶是誰，付錢買什麼？',
      '收入來自哪些產品、地區或客群？',
      '收入是一次性、週期性，還是可重複？',
      '最重要的成本與產能限制是什麼？'
    ],
    automaticEvidence: ['revenue', 'revenueCagr3y', 'grossMargin'],
    manualEvidence: '產品與地區拆分常使用公司自訂欄位，仍要閱讀 10-K／10-Q 與管理層說明。'
  },
  {
    key: 'moat',
    label: '護城河是否真的存在',
    questions: [
      '客戶為什麼不換別家？',
      '優勢來自品牌、網路效應、轉換成本、成本結構、規模還是法規？',
      '這個優勢是在增強，還是在被競爭侵蝕？',
      '毛利率與營業利益率是否支持這個說法？'
    ],
    automaticEvidence: ['grossMargin', 'operatingMargin'],
    manualEvidence: '護城河是商業判斷；利潤率只能當證據，不能單獨證明優勢存在。'
  },
  {
    key: 'growth',
    label: '成長從哪裡來',
    questions: [
      '成長是價格、銷量、新產品、併購還是景氣循環？',
      '營收成長是否也帶來營業利益與現金流成長？',
      '成長是否需要愈來愈高的資本支出？',
      '稀釋後每股成果是否跟公司總額一起成長？'
    ],
    automaticEvidence: [
      'revenueCagr3y',
      'operatingIncome',
      'operatingCashFlow',
      'capitalExpenditure',
      'dilutedEps',
      'dilutedSharesChange'
    ],
    manualEvidence: '數字不會自動說明成長來源；價格、銷量、併購與景氣因素仍要從申報內容判讀。'
  },
  {
    key: 'cash-quality',
    label: '利潤是否能變成現金',
    questions: [
      '淨利與營業現金流長期是否同方向？',
      '自由現金流是否穩定，或只在單一年份看起來很好？',
      '應收、存貨或預付款是否吃掉現金？',
      '股票薪酬是否讓現金流好看，卻持續稀釋股東？'
    ],
    automaticEvidence: [
      'netIncome',
      'operatingCashFlow',
      'freeCashFlow',
      'freeCashFlowMargin',
      'cashConversion',
      'stockCompToRevenue'
    ],
    manualEvidence: '異常營運資金、一次性項目與股票薪酬品質仍要回到現金流量表與附註確認。'
  },
  {
    key: 'resilience',
    label: '資產負債表能不能讓公司活過壞年',
    questions: [
      '現金與債務各有多少？',
      '利潤下滑時，現金流能否負擔利息與必要投資？',
      '是否依賴短期融資或不斷發新股？',
      '帳上負債的風險是否符合這個產業的正常結構？'
    ],
    automaticEvidence: [
      'cashAndEquivalents',
      'currentDebt',
      'noncurrentDebt',
      'operatingCashFlow',
      'dilutedSharesChange'
    ],
    manualEvidence: '銀行、保險與 REIT 的資產負債結構不同，第一版不套一般公司的自動結論。'
  },
  {
    key: 'capital-allocation',
    label: '管理層怎麼分配資本',
    questions: [
      '現金拿去再投資、併購、還債、股利還是回購？',
      '回購是否真的降低稀釋後股數，還是只抵銷股票薪酬？',
      '高資本支出有沒有換來後續營收與利潤？',
      '併購後商譽、減損與報酬是否合理？'
    ],
    automaticEvidence: [
      'capitalExpenditure',
      'stockBasedCompensation',
      'shareRepurchases',
      'dividendsPaid',
      'dilutedSharesChange'
    ],
    manualEvidence: '併購品質、減損原因與管理層紀律需要閱讀附註，不能從現金用途直接推論。'
  },
  {
    key: 'valuation',
    label: '現價需要多好的未來',
    questions: [
      '保守、基準、樂觀三種情境各需要哪些成長與利潤假設？',
      '現價相對情境合理價值的距離是多少？',
      '目前估值是否已經要求公司長期維持非常高的成長？',
      '估值變便宜，是價格波動還是基本面真的變差？'
    ],
    automaticEvidence: ['revenueCagr3y', 'operatingMargin', 'freeCashFlowMargin', 'dilutedEps'],
    manualEvidence: '合理價值與三情境仍由使用者填寫；官方基本面只提供可追溯的估值輸入。'
  },
  {
    key: 'disconfirmation',
    label: '什麼證據會證明自己看錯',
    questions: [
      '哪三件事一旦發生，原始論點就不成立？',
      '哪些是短期價格波動，哪些是企業本質惡化？',
      '下一份財報要檢查哪 3–8 個指標？',
      '何時重新評分，什麼情況需要降部位而不是加碼？'
    ],
    automaticEvidence: ['revenueCagr3y', 'operatingMargin', 'freeCashFlow', 'dilutedSharesChange'],
    manualEvidence: '反證條件、檢查頻率與部位決策由使用者負責，程式不可自動改研究狀態。'
  }
];

export const RESEARCH_METHOD_SECTIONS = Object.freeze(
  RAW_RESEARCH_METHOD_SECTIONS.map(section => Object.freeze({
    ...section,
    questions: Object.freeze(section.questions.slice()),
    automaticEvidence: Object.freeze(section.automaticEvidence.slice())
  }))
);

const RAW_METRIC_DEFINITIONS = [
  { key: 'revenue', label: '營收', kind: 'official', questionKeys: ['business-model', 'growth'] },
  { key: 'grossProfit', label: '毛利', kind: 'official', questionKeys: ['moat'] },
  { key: 'operatingIncome', label: '營業利益', kind: 'official', questionKeys: ['growth', 'moat'] },
  { key: 'netIncome', label: '淨利', kind: 'official', questionKeys: ['cash-quality'] },
  { key: 'dilutedEps', label: '稀釋後 EPS', kind: 'official', questionKeys: ['growth', 'valuation'] },
  { key: 'operatingCashFlow', label: '營業現金流', kind: 'official', questionKeys: ['cash-quality', 'resilience'] },
  {
    key: 'capitalExpenditure',
    label: '資本支出',
    kind: 'official',
    questionKeys: ['growth', 'cash-quality', 'capital-allocation'],
    excludedFor: ['bank', 'insurance']
  },
  { key: 'cashAndEquivalents', label: '現金及約當現金', kind: 'official', questionKeys: ['resilience'] },
  { key: 'currentDebt', label: '流動債務', kind: 'official', questionKeys: ['resilience'] },
  { key: 'noncurrentDebt', label: '非流動債務', kind: 'official', questionKeys: ['resilience'] },
  { key: 'dilutedShares', label: '稀釋加權平均股數', kind: 'official', questionKeys: ['growth', 'capital-allocation'] },
  {
    key: 'stockBasedCompensation',
    label: '股票薪酬',
    kind: 'official',
    questionKeys: ['cash-quality', 'capital-allocation']
  },
  { key: 'shareRepurchases', label: '股票回購', kind: 'official', questionKeys: ['capital-allocation'] },
  { key: 'dividendsPaid', label: '支付股利', kind: 'official', questionKeys: ['capital-allocation'] },
  {
    key: 'revenueCagr3y',
    label: '3 年營收複合成長率',
    kind: 'derived',
    formula: '(最新年度營收／三年前年度營收)^(1／年數)−1',
    requires: ['revenue'],
    questionKeys: ['business-model', 'growth', 'valuation', 'disconfirmation']
  },
  {
    key: 'grossMargin',
    label: '毛利率',
    kind: 'derived',
    formula: '毛利／營收',
    requires: ['grossProfit', 'revenue'],
    questionKeys: ['business-model', 'moat']
  },
  {
    key: 'operatingMargin',
    label: '營業利益率',
    kind: 'derived',
    formula: '營業利益／營收',
    requires: ['operatingIncome', 'revenue'],
    questionKeys: ['moat', 'valuation', 'disconfirmation']
  },
  {
    key: 'netMargin',
    label: '淨利率',
    kind: 'derived',
    formula: '淨利／營收',
    requires: ['netIncome', 'revenue'],
    questionKeys: ['cash-quality']
  },
  {
    key: 'freeCashFlow',
    label: '自由現金流',
    kind: 'derived',
    formula: '營業現金流−資本支出',
    requires: ['operatingCashFlow', 'capitalExpenditure'],
    questionKeys: ['cash-quality', 'disconfirmation'],
    excludedFor: ['bank', 'insurance', 'reit']
  },
  {
    key: 'freeCashFlowMargin',
    label: '自由現金流率',
    kind: 'derived',
    formula: '自由現金流／營收',
    requires: ['freeCashFlow', 'revenue'],
    questionKeys: ['cash-quality', 'valuation'],
    excludedFor: ['bank', 'insurance', 'reit']
  },
  {
    key: 'cashConversion',
    label: '現金轉換',
    kind: 'derived',
    formula: '營業現金流／淨利；淨利小於等於 0 時不解讀',
    requires: ['operatingCashFlow', 'netIncome'],
    questionKeys: ['cash-quality'],
    excludedFor: ['bank', 'insurance', 'reit']
  },
  {
    key: 'stockCompToRevenue',
    label: '股票薪酬占營收',
    kind: 'derived',
    formula: '股票薪酬／營收',
    requires: ['stockBasedCompensation', 'revenue'],
    questionKeys: ['cash-quality', 'capital-allocation']
  },
  {
    key: 'dilutedSharesChange',
    label: '稀釋股數變化',
    kind: 'derived',
    formula: '最新稀釋加權平均股數／前期股數−1',
    requires: ['dilutedShares'],
    questionKeys: ['growth', 'resilience', 'capital-allocation', 'disconfirmation']
  }
];

export const FUNDAMENTAL_METRIC_DEFINITIONS = Object.freeze(
  RAW_METRIC_DEFINITIONS.map(definition => Object.freeze({
    ...definition,
    questionKeys: Object.freeze(definition.questionKeys.slice()),
    requires: Object.freeze((definition.requires || []).slice()),
    excludedFor: Object.freeze((definition.excludedFor || []).slice())
  }))
);

const COMPANY_KIND = Object.freeze({
  general: Object.freeze({ label: '一般營運公司', warning: '' }),
  bank: Object.freeze({
    label: '銀行',
    warning: '銀行的負債是營運原料，第一版不套一般公司的自由現金流與負債健康度結論。'
  }),
  insurance: Object.freeze({
    label: '保險',
    warning: '保險公司的準備金與投資資產需要專用框架，第一版只保留可追溯原始值。'
  }),
  reit: Object.freeze({
    label: 'REIT',
    warning: 'REIT 應以 FFO／AFFO 與物業指標評估，第一版不拿一般公司的自由現金流代替。'
  }),
  unknown: Object.freeze({
    label: '尚未辨認',
    warning: '尚未辨認公司類型，先顯示研究問題與官方原始值，不產生一般公司的衍生結論。'
  })
});

/** @param {unknown} value */
function normalizedToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** @param {unknown} value @returns {CompanyKind} */
function companyKindOf(value) {
  const key = normalizedToken(value);
  return Object.hasOwn(COMPANY_KIND, key) ? /** @type {CompanyKind} */ (key) : 'unknown';
}

/**
 * 研究問題永遠保留；特殊產業只關閉不適用的自動衍生值，不替使用者刪掉研究方向。
 * @param {{companyKind?:unknown,taxonomy?:unknown}} [input]
 */
export function buildStockResearchMethod(input = {}) {
  const companyKind = companyKindOf(input.companyKind);
  const taxonomy = normalizedToken(input.taxonomy);
  const profile = COMPANY_KIND[companyKind];
  const warnings = [];
  if (profile.warning) warnings.push(profile.warning);
  if (!taxonomy) {
    warnings.push('尚未取得 taxonomy；先顯示研究問題與官方原始值，不先開啟衍生公式。');
  } else if (taxonomy !== 'us-gaap') {
    warnings.push(taxonomy === 'ifrs-full'
      ? '這家公司使用 IFRS；第一版只有有限欄位映射，缺值不會用 US-GAAP 欄位猜。'
      : '尚未支援這套 taxonomy；只保留可追溯原始值，不產生自動衍生結論。');
  }

  const fullAutomation = companyKind === 'general' && taxonomy === 'us-gaap';
  const unsupportedTaxonomy = taxonomy !== 'us-gaap';
  const metrics = [];
  const excludedMetrics = [];
  for (const metric of FUNDAMENTAL_METRIC_DEFINITIONS) {
    const excludedByKind = metric.excludedFor.includes(companyKind);
    const excludedByCoverage = metric.kind === 'derived'
      && (companyKind === 'unknown' || unsupportedTaxonomy);
    (excludedByKind || excludedByCoverage ? excludedMetrics : metrics).push(metric);
  }

  return {
    companyKind,
    companyKindLabel: profile.label,
    taxonomy: taxonomy || null,
    automation: fullAutomation ? 'supported' : 'limited',
    sections: RESEARCH_METHOD_SECTIONS,
    metrics,
    excludedMetrics,
    warnings
  };
}

/**
 * 0 與負值都是可用證據；只有缺值、非有限數字或明確不可比較才降級。
 * @param {unknown} value
 * @param {{comparable?:boolean,reason?:unknown}} [options]
 */
export function fundamentalMetricState(value, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      status: 'missing',
      value: null,
      canCompare: false,
      reason: '尚未取得'
    };
  }
  if (options.comparable === false) {
    const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
    return {
      status: 'not-comparable',
      value,
      canCompare: false,
      reason: reason || '期間、單位或原始欄位不同，不做趨勢比較'
    };
  }
  return {
    status: 'available',
    value,
    canCompare: true,
    reason: ''
  };
}

/** @param {Record<string, any>} point */
function periodClass(point) {
  const type = normalizedToken(point.periodType);
  const days = Number(point.durationDays);
  if (type === 'annual' && Number.isFinite(days) && days >= 335 && days <= 395) return 'annual';
  if (type === 'quarter' && Number.isFinite(days) && days >= 75 && days <= 105) return 'quarter';
  return '';
}

/** @param {unknown} value */
function isRealIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * 趨勢只能比較相同 unit／taxonomy／tag 與正常期間長度。缺一年度可留洞，但不能把 YTD 冒充單季。
 * @param {unknown} points
 */
export function comparableFundamentalSeries(points) {
  const copied = Array.isArray(points)
    ? points.map(point => (
      point && typeof point === 'object' ? { .../** @type {Record<string, any>} */ (point) } : point
    ))
    : [];
  const available = copied.filter(point => (
    point && typeof point === 'object'
    && typeof /** @type {Record<string, any>} */ (point).value === 'number'
    && Number.isFinite(/** @type {Record<string, any>} */ (point).value)
  ));
  if (!available.length) {
    return { status: 'missing', comparable: false, points: copied, availablePoints: [], reason: '尚未取得' };
  }

  const signatures = new Set();
  const periodEnds = new Set();
  let invalidPeriod = false;
  let duplicatePeriod = false;
  for (const point of available) {
    const row = /** @type {Record<string, any>} */ (point);
    const period = periodClass(row);
    const periodEnd = typeof row.periodEnd === 'string' ? row.periodEnd.trim() : '';
    const unit = normalizedToken(row.unit);
    const taxonomy = normalizedToken(row.taxonomy);
    const tag = normalizedToken(row.tag);
    const validPeriodEnd = isRealIsoDate(periodEnd);
    if (!period || !unit || !taxonomy || !tag || !validPeriodEnd) invalidPeriod = true;
    if (validPeriodEnd) {
      if (periodEnds.has(periodEnd)) duplicatePeriod = true;
      periodEnds.add(periodEnd);
    }
    signatures.add([
      unit,
      taxonomy,
      tag,
      period
    ].join('|'));
  }
  if (invalidPeriod || duplicatePeriod || signatures.size !== 1) {
    return {
      status: 'not-comparable',
      comparable: false,
      points: copied,
      availablePoints: available,
      reason: duplicatePeriod
        ? '同一期間出現重複資料，必須先依申報時間與 accession 去重'
        : invalidPeriod
        ? '來源欄位不完整，或期間長度不是可辨認的年度／單季，不能做趨勢比較'
        : '單位、taxonomy、原始 tag 或期間類型不同，不能混成一條趨勢'
    };
  }
  if (available.length < 2) {
    return {
      status: 'insufficient',
      comparable: false,
      points: copied,
      availablePoints: available,
      reason: '至少需要兩期相同口徑資料'
    };
  }
  return {
    status: 'comparable',
    comparable: true,
    points: copied,
    availablePoints: available,
    reason: '',
    hasGaps: available.length !== copied.length
  };
}
