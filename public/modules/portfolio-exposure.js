// @ts-check
// 投資組合的曝險資料與純計算：不碰 DOM、API 或頁面狀態。

import { normalizePortfolioSymbol } from './portfolio-symbol.js';

/** @typedef {{ type: 'equity'|'bond'|'gold', regions: Record<string, number> }} Composition */
/** @typedef {{ symbol?: string, layer?: string, currency?: string, valueTwd: number }} ExposureRow */
/** @typedef {{ v: number, src: Record<string, number> }} CompanyExposure */
/** @typedef {{ type?: string, currency?: string, balance?: number }} ExposureAccount */
/** @typedef {{ stockTwd: number, bondTwd: number, goldTwd: number, cashTwd: number, netTwd: number }} CurrencyExposure */

// ETF 成分穿透（近似權重；可隨基金年報更新）。
// 與 lib/derive.js 的同名複本是刻意同步點，前後端無法直接共用 runtime 模組。
/** @type {Record<string, Composition>} */
const COMPOSITION = {
  CSPX: { type: 'equity', regions: { 美國: 1 } },
  QQQM: { type: 'equity', regions: { 美國: 1 } },
  VUAA: { type: 'equity', regions: { 美國: 1 } },
  SPY: { type: 'equity', regions: { 美國: 1 } },
  VOO: { type: 'equity', regions: { 美國: 1 } },
  GOOGL: { type: 'equity', regions: { 美國: 1 } },
  GOOG: { type: 'equity', regions: { 美國: 1 } },
  AAPL: { type: 'equity', regions: { 美國: 1 } },
  TSLA: { type: 'equity', regions: { 美國: 1 } },
  SPACEX: { type: 'equity', regions: { 美國: 1 } },
  EIMI: { type: 'equity', regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 } },
  XUSE: { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  EXUS: { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  ICHN: { type: 'equity', regions: { 中國: 1 } },
  KWEB: { type: 'equity', regions: { 中國: 1 } },
  CSKR: { type: 'equity', regions: { 韓國: 1 } },
  SJPA: { type: 'equity', regions: { 日本: 1 } },
  '0050': { type: 'equity', regions: { 台灣: 1 } },
  '006208': { type: 'equity', regions: { 台灣: 1 } },
  SMH: { type: 'equity', regions: { 美國: 1 } },
  SPCX: { type: 'equity', regions: { 美國: 1 } },
  SGLD: { type: 'gold', regions: {} },
  GLD: { type: 'gold', regions: {} },
  IAU: { type: 'gold', regions: {} },
  '00719B': { type: 'bond', regions: {} },
  '00720B': { type: 'bond', regions: {} }
};

/** COMPOSITION 收錄的代號清單（**export 供考題取真 union**，2026-08-05 Codex #409 r1 H①）：
 * 這份表與另一邊（後端 lib/derive.js）是刻意的複本、必須逐鍵相等。
 * 考題手抄清單會漏（實測漏了 GOOGL/GOOG/TSLA/SPACEX/SPCX、還多寫一個兩邊都沒有的），
 * 所以改成兩邊各自吐出真實 key、由考題取聯集後逐鍵比對——新增代號自動納入。 */
export const COMPOSITION_SYMBOLS = Object.freeze(Object.keys(COMPOSITION));

/** ETF/持股 → 成分（型別、區域穿透）；未知代號依 layer 退回。 @param {{symbol?: string, layer?: string}} h @returns {Composition} */
export const compOf = (h) => COMPOSITION[normalizePortfolioSymbol(h.symbol)]
  || { type: h.layer === 'bond' ? 'bond' : h.layer === 'gold' ? 'gold' : 'equity', regions: { 其他: 1 } };

// ETF 內含公司穿透（各 ETF 前十大成分的近似權重）。
// XUSE/EXUS 刻意不列：成分極分散，僅做區域穿透。
const T50 = { 台積電: 0.56, 鴻海: 0.05, 聯發科: 0.04, 台達電: 0.025, 廣達: 0.02, 富邦金: 0.015, 國泰金: 0.014, 中信金: 0.012, 日月光: 0.012, 聯電: 0.01 };
const COMPANY_WEIGHTS = {
  CSPX: { 輝達: 0.075, 微軟: 0.065, 蘋果: 0.065, Alphabet: 0.04, 亞馬遜: 0.04, Meta: 0.026, 博通: 0.025, 特斯拉: 0.02, 波克夏: 0.016, 禮來: 0.012 },
  QQQM: { 輝達: 0.09, 微軟: 0.085, 蘋果: 0.08, 亞馬遜: 0.055, Alphabet: 0.05, 博通: 0.05, Meta: 0.05, 特斯拉: 0.03, Netflix: 0.025, Costco: 0.025 },
  SMH: { 輝達: 0.20, 台積電: 0.12, 博通: 0.08, 超微: 0.05, 艾司摩爾: 0.05, 德儀: 0.04, 高通: 0.04, 美光: 0.04, 應用材料: 0.04, 科林研發: 0.04 },
  '0050': T50,
  '006208': T50,
  EIMI: { 台積電: 0.085, 騰訊: 0.04, 三星電子: 0.03, 阿里巴巴: 0.025, 小米: 0.012, 美團: 0.01, HDFC銀行: 0.01, 信實工業: 0.009, 拼多多: 0.008 },
  KWEB: { 騰訊: 0.11, 阿里巴巴: 0.10, 拼多多: 0.08, 美團: 0.08, 網易: 0.05, 京東: 0.05, 百度: 0.05, 攜程: 0.05, 快手: 0.04, 貝殼: 0.03 },
  ICHN: { 騰訊: 0.14, 阿里巴巴: 0.09, 拼多多: 0.05, 美團: 0.04, 小米: 0.04, 比亞迪: 0.025, 網易: 0.02, 京東: 0.02, 百度: 0.015 },
  SJPA: { 豐田: 0.045, 三菱UFJ: 0.03, Sony: 0.03, 日立: 0.025, 三井住友金融: 0.02, 東京威力科創: 0.02, 任天堂: 0.015, Keyence: 0.015, 迅銷: 0.015, 軟銀集團: 0.015 },
  CSKR: { 三星電子: 0.28, SK海力士: 0.13, 現代汽車: 0.04, 起亞: 0.03, Celltrion: 0.03, NAVER: 0.03, KB金融: 0.03, 新韓金融: 0.025, 三星生物: 0.025, LG新能源: 0.02 }
};

const DIRECT_COMPANY = { AAPL: '蘋果', GOOGL: 'Alphabet', TSLA: '特斯拉', SPCX: 'SpaceX' };
const COMPANY_REGION = {
  台積電: '台灣', 鴻海: '台灣', 聯發科: '台灣', 台達電: '台灣', 廣達: '台灣', 富邦金: '台灣', 國泰金: '台灣', 中信金: '台灣', 日月光: '台灣', 聯電: '台灣',
  輝達: '美國', 微軟: '美國', 蘋果: '美國', Alphabet: '美國', 亞馬遜: '美國', Meta: '美國', 博通: '美國', 特斯拉: '美國', 波克夏: '美國', 禮來: '美國',
  Netflix: '美國', Costco: '美國', 超微: '美國', 德儀: '美國', 高通: '美國', 美光: '美國', 應用材料: '美國', 科林研發: '美國', SpaceX: '美國',
  騰訊: '中國', 阿里巴巴: '中國', 拼多多: '中國', 美團: '中國', 網易: '中國', 京東: '中國', 百度: '中國', 攜程: '中國', 快手: '中國', 貝殼: '中國', 比亞迪: '中國', 小米: '中國',
  三星電子: '韓國', SK海力士: '韓國', 現代汽車: '韓國', 起亞: '韓國', Celltrion: '韓國', NAVER: '韓國', KB金融: '韓國', 新韓金融: '韓國', 三星生物: '韓國', LG新能源: '韓國',
  豐田: '日本', 三菱UFJ: '日本', Sony: '日本', 日立: '日本', 三井住友金融: '日本', 東京威力科創: '日本', 任天堂: '日本', Keyence: '日本', 迅銷: '日本', 軟銀集團: '日本',
  HDFC銀行: '印度', 信實工業: '印度', 艾司摩爾: '其他'
};

/** @param {ExposureRow[]} rows @returns {Record<string, number>} */
export function regionExposure(rows) {
  /** @type {Record<string, number>} */
  const regions = {};
  rows.forEach(row => {
    const composition = compOf(row);
    if (composition.type !== 'equity') return;
    for (const [region, weight] of Object.entries(composition.regions)) regions[region] = (regions[region] || 0) + row.valueTwd * weight;
  });
  return regions;
}

/**
 * 幣別底層曝險：00719B/00720B 歸美元、黃金獨立一列、現金含負融資。
 * @param {ExposureRow[]} rows
 * @param {ExposureAccount[]|undefined} accounts
 * @param {Record<string, number>} fx
 * @returns {Record<string, CurrencyExposure>}
 */
export function fxExposure(rows, accounts, fx) {
  const exposureCurrency = (r) => {
    const sym = normalizePortfolioSymbol(r.symbol);
    if (compOf(r).type === 'gold') return '黃金';
    if (sym === '00719B' || sym === '00720B') return 'USD';   // 台幣交易的美元債 ETF，曝險歸美元
    return r.currency || 'TWD';   // 缺幣別預設台幣（與 derive/上面 rows 同口徑，自主體檢）
  };
  /** @type {Record<string, CurrencyExposure>} */
  const byCur = {};
  const bucket = (cur) => byCur[cur] = byCur[cur] || /** @type {CurrencyExposure} */ ({ stockTwd: 0, bondTwd: 0, goldTwd: 0, cashTwd: 0 });
  for (const r of rows) {
    const c = bucket(exposureCurrency(r));
    const type = compOf(r).type;
    if (type === 'bond') c.bondTwd += r.valueTwd;
    else if (type === 'gold') c.goldTwd += r.valueTwd;
    else c.stockTwd += r.valueTwd;
  }
  // ⚠️ 同步點：LIABILITY_TYPES 與 lib/derive.js 同一份判準（前端不能 import lib/，故複本；改其一要改兩處）
  const LIABILITY_TYPES = new Set(['loan', 'liability', 'mortgage', 'creditcard']);
  for (const a of accounts || []) {
    let bal = Number(a.balance || 0);
    if (!bal) continue;
    // 負債型帳戶填「正數」是允許的資料形狀（derive.js 也兜住了淨資產）——這裡不跟著兜的話，
    // 幣別曝險會把房貸當「+690 萬現金曝險」，方向整個反掉（自主體檢實測）
    if (LIABILITY_TYPES.has(a.type || '') && bal > 0) bal = -bal;
    const cur = a.currency || 'TWD';
    bucket(cur).cashTwd += bal * (fx[cur] || 1);
  }
  for (const c of Object.values(byCur)) c.netTwd = c.stockTwd + c.bondTwd + c.goldTwd + c.cashTwd;
  return byCur;
}

/** @param {ExposureRow[]} rows @param {number} [limit=20] @returns {{ top: [string, CompanyExposure][], coveredValue: number }} */
export function companyExposure(rows, limit = 20) {
  /** @type {Record<string, CompanyExposure>} */
  const aggregate = {};
  const add = (company, value, symbol) => {
    const item = aggregate[company] = aggregate[company] || { v: 0, src: {} };
    item.v += value;
    item.src[symbol] = (item.src[symbol] || 0) + value;
  };
  for (const row of rows) {
    if (compOf(row).type !== 'equity' || !(row.valueTwd > 0)) continue;
    const symbol = normalizePortfolioSymbol(row.symbol);
    if (DIRECT_COMPANY[symbol]) { add(DIRECT_COMPANY[symbol], row.valueTwd, symbol); continue; }
    const weights = COMPANY_WEIGHTS[symbol];
    if (!weights) continue;
    for (const [company, fraction] of Object.entries(weights)) add(company, row.valueTwd * fraction, symbol);
  }
  const top = Object.entries(aggregate).sort((a, b) => b[1].v - a[1].v).slice(0, limit);
  return { top, coveredValue: top.reduce((sum, [, item]) => sum + item.v, 0) };
}

/** @param {string} company @returns {string|undefined} */
export const companyRegionOf = (company) => COMPANY_REGION[company];
