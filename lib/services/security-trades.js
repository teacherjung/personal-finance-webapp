// @ts-check
// 證券交易「共同格式」正規化器（S1，設計藍圖 §四/§五/§六）。純函式、不碰資料庫——
// S2 的匯入/同步服務再把結果 upsert 進 `securityTrades` 集合（schema/READONLY 也在 S2 一起加）。
//
// 三條鐵則（藍圖拍板）：
//  ①金額一律保留**原幣**，不同幣別不可默默加總（本檔不提供任何跨幣別加總 helper＝結構性防呆）。
//  ②買賣方向（side）與現金方向（cashDirection）分開保存：買→out、賣→in，**不靠金額正負猜**。
//  ③去重 identifier-first：IBKR 優先官方識別碼（transactionID→tradeID→ibExecID；使用者的 Flex XML
//    已實測三者都有，2026-07-23）；台新＝多維指紋＋**同批出現序**（同日同代號同價的兩筆真交易都要活）。
//  ④未知交易類別＝side null＋flag，**不猜方向**（S2 預覽據此 fail-closed 阻擋）。
import { createHash } from 'node:crypto';
import { isRealDate } from '../schema.js';

/**
 * @typedef {object} SecurityTrade 共同交易格式（藍圖 §四；id/importBatch/importedAt 由 S2 匯入層補）
 * @property {'ibkr'|'taishin'} source
 * @property {string} sourceAccountId    內部穩定帳戶身分（指紋，不可逆）
 * @property {string} sourceAccountLabel 前端可見的遮罩名稱
 * @property {string} tradeDate          YYYY-MM-DD
 * @property {string|null} settlementDate
 * @property {string} symbol
 * @property {string} name
 * @property {'buy'|'sell'|null} side    null＝未知類別（fail-closed，別讓它入庫）
 * @property {number} quantity           一律正數（方向看 side）
 * @property {number|null} price
 * @property {number|null} grossAmount   原幣成交金額
 * @property {number|null} commission
 * @property {number|null} tax
 * @property {number|null} feeDiscount
 * @property {number|null} otherFees
 * @property {number|null} netSettlement 來源顯示的應收付**絕對值**（查帳真相）
 * @property {'in'|'out'|null} cashDirection 買→out、賣→in（由 side 導出，非金額正負）
 * @property {string} currency
 * @property {string} market
 * @property {string} rawType            來源原始交易類別（查錯用）
 * @property {string} sourceRef          去重鍵（identifier-first；服務層擁有）
 * @property {{unknownType?:boolean, missingId?:boolean, missingAccount?:boolean}} flags
 */

/** 帳戶識別 → 不可逆指紋（畫面永不顯示完整帳號；比對/去重都用指紋）。 @param {string} s */
export function accountFingerprint(s) {
  const t = String(s || '').replace(/\s/g, '');
  return t ? createHash('sha256').update(t).digest('hex').slice(0, 12) : '';
}

// ---- 台新：交易類別 → 買賣方向（單一真相表；taishin-securities.js 的 sideHint 只是彙總核對用的鬆版）----
/** @type {Record<string,'buy'|'sell'>} */
const TAISHIN_TRADE_TYPES = Object.freeze({
  '現買': 'buy', '現股買進': 'buy', '零股買進': 'buy', '定期定額買進': 'buy', '融資買進': 'buy', '融券買進': 'buy',
  '現賣': 'sell', '現股賣出': 'sell', '零股賣出': 'sell', '融資賣出': 'sell', '融券賣出': 'sell',
});
/** 未知類別回 null（**不猜**）。查表用 hasOwn——rawType 是帳單文字（AGENTS 3.5 原型鍵）。 @param {string} rawType @returns {'buy'|'sell'|null} */
export function taishinSide(rawType) {
  const k = String(rawType || '').replace(/\s/g, '');
  return Object.hasOwn(TAISHIN_TRADE_TYPES, k) ? TAISHIN_TRADE_TYPES[k] : null;
}

/** side → 現金方向（買＝錢出去、賣＝錢進來；唯一的導出點，別在別處各寫一份）。 @param {'buy'|'sell'|null} side @returns {'in'|'out'|null} */
export const cashDirectionOf = (side) => side === 'buy' ? 'out' : side === 'sell' ? 'in' : null;

/**
 * IBKR Flex 日期容錯：'20260113' 與 '2026-01-13' 都轉 ISO；**過真實日曆驗證**（自審發現：只驗長相會讓
 * '20260230'/'20261301' 這種假日期一路流到 S2 寫入櫃檯才炸 500、毒死整批——比照台新側 isRealDate 守則）。
 * @param {any} s @returns {string|null}
 */
export function ibDate(s) {
  const t = String(s ?? '').trim();
  let iso = null;
  if (/^\d{8}$/.test(t)) iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = t;
  return iso && isRealDate(iso) ? iso : null;
}

const absOrNull = (/** @type {any} */ v) => {
  if (v == null || v === '') return null;   // 空字串≠0（Codex r9#1 的教訓：Number('') 是 0）
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n) : null;
};

/**
 * IBKR Flex `<Trade …/>` 原始屬性 → 共同格式（**吃原始 XML 屬性物件**，不依賴 lib/ib.js 目前
 * 精簡過的 trades 形狀——S2 接線時由 ib-sync 把原始節點餵進來，lib/ib.js 屆時同 PR 調整）。
 * 使用者 Flex 已含：tradeID/transactionID/ibExecID/settleDateTarget/ibCommission/taxes/proceeds（2026-07-23 實測）。
 * @param {any} raw @returns {SecurityTrade|null} null＝缺核心欄位（成交日/代號/數量），整筆不收
 */
export function normalizeIbTrade(raw) {
  const tradeDate = ibDate(raw?.tradeDate);
  const symbol = String(raw?.symbol || '').toUpperCase().trim();
  const qty = Number(raw?.quantity);
  if (!tradeDate || !symbol || !Number.isFinite(qty) || qty === 0) return null;
  const bs = String(raw?.buySell || '').toUpperCase().trim();
  /** @type {'buy'|'sell'|null} */
  // **精確等值**（自審高風險）：IB Flex 的 buySell 官方值含取消列 'BUY (Ca.)'/'SELL (Ca.)'（(Ca.)＝
  // cancellation，常帶反向數量沖銷原單）。用 startsWith 會把取消列當正常買賣＝幽靈交易雙倍計。
  // 只認精確 'BUY'/'SELL'，其餘（含 (Ca.)）落 null→unknownType→S2 fail-closed 讓使用者看原文，不猜方向。
  const side = bs === 'BUY' ? 'buy' : bs === 'SELL' ? 'sell' : null;
  const acct = String(raw?.accountId || '');
  return {
    source: 'ibkr',
    sourceAccountId: accountFingerprint(acct),
    sourceAccountLabel: acct ? `IBKR …${acct.slice(-4)}` : 'IBKR',
    tradeDate,
    settlementDate: ibDate(raw?.settleDateTarget),
    symbol,
    name: String(raw?.description || ''),
    side,
    quantity: Math.abs(qty),                       // IB 賣出常帶負數量：數量一律正、方向看 side
    price: absOrNull(raw?.tradePrice),
    // ?? 要在「解析後為 null」時才退位（tradeMoney='' 時 absOrNull 回 null → 退到 proceeds）；
    // 原本 raw?.tradeMoney ?? raw?.proceeds 對空字串不退位，會讓有 proceeds 的成交金額遺失（自審）。
    grossAmount: absOrNull(raw?.tradeMoney) ?? absOrNull(raw?.proceeds),
    commission: absOrNull(raw?.ibCommission),
    tax: absOrNull(raw?.taxes),
    feeDiscount: null,
    otherFees: null,
    netSettlement: absOrNull(raw?.netCash),
    cashDirection: cashDirectionOf(side),
    currency: String(raw?.currency || 'USD').toUpperCase(),
    market: String(raw?.listingExchange || raw?.exchange || ''),
    rawType: bs || String(raw?.transactionType || ''),
    sourceRef: ibSourceRef(raw),                   // 官方識別碼版；缺識別碼＝退路指紋（無 seq，assignSeqSuffix 補）
    flags: { ...(side === null ? { unknownType: true } : {}), ...(hasOfficialId(raw) ? {} : { missingId: true }), ...(acct ? {} : { missingAccount: true }) },
  };
}

const hasOfficialId = (/** @type {any} */ raw) => Boolean(raw?.transactionID || raw?.tradeID || raw?.ibExecID);

/**
 * IBKR 去重鍵（藍圖 §六優先序）：官方識別碼 → 帳戶＋識別碼；只有都缺才退路指紋（不含 seq，
 * 由 assignSeqSuffix 補「同批出現序」——同日同價可以合法成交多筆，光靠欄位值不唯一）。
 * @param {any} raw @returns {string}
 */
export function ibSourceRef(raw) {
  if (raw?.transactionID) return `ib|txn|${raw.transactionID}`;
  if (raw?.tradeID) return `ib|trd|${raw.tradeID}`;
  if (raw?.ibExecID) return `ib|exe|${raw.ibExecID}`;
  const fp = [accountFingerprint(String(raw?.accountId || '')), ibDate(raw?.tradeDate) || '', String(raw?.symbol || '').toUpperCase(),
    String(raw?.buySell || '').toUpperCase(), Math.abs(Number(raw?.quantity) || 0), Number(raw?.tradePrice) || 0, Number(raw?.netCash) || 0].join('|');
  return `ib|fp|${fp}`;
}

/**
 * 台新解析結果（lib/taishin-securities.js 的 TaishinSecTrade）→ 共同格式。
 * @param {import('../taishin-securities.js').TaishinSecTrade} t
 * @param {{accountRaw:string, accountLabel?:string, stmtMonth:string}} ctx
 * @returns {SecurityTrade|null} null＝缺核心欄位
 */
export function normalizeTaishinTrade(t, ctx) {
  if (!t?.tradeDate || !t.symbol || !Number.isFinite(Number(t.quantity)) || Number(t.quantity) === 0) return null;
  const side = taishinSide(t.rawType);
  const fp = accountFingerprint(ctx.accountRaw);
  return {
    source: 'taishin',
    sourceAccountId: fp,
    sourceAccountLabel: ctx.accountLabel || '台新證券',
    tradeDate: t.tradeDate,
    settlementDate: t.settlementDate || null,
    symbol: t.symbol,
    name: t.name || '',
    side,
    quantity: Math.abs(Number(t.quantity)),
    price: absOrNull(t.price),
    grossAmount: absOrNull(t.grossAmount),
    commission: absOrNull(t.commission),
    tax: absOrNull(t.tax),
    feeDiscount: absOrNull(t.feeDiscount),
    otherFees: absOrNull(t.otherFees),
    netSettlement: absOrNull(t.netSettlement),
    cashDirection: cashDirectionOf(side),
    currency: t.currency || 'TWD',
    market: 'TWSE',
    rawType: t.rawType || '',
    // 藍圖 §六台新鍵：券商+帳戶指紋+對帳單年月+成交日+代號+類別+數量+成交價+成交金額+應收付（+同批出現序，assignSeqSuffix 補）。
    // 所有欄位剝 '|'（分隔符），symbol 也剝（不只 rawType，自審：symbol 理論上不含 | 但一致較安全）。
    // ⚠️ stmtMonth 進鍵＝藍圖 §六 L245 原文，但與 §六 L247「重疊月份另一份對帳單不可重複入帳」相衝（年度單/跨月重印會雙記）——
    //    這是 **S2 入庫前必拍板** 的規格矛盾（二選一：鍵移除 stmtMonth／S2 偵測非月結單就阻擋上傳）；S1 純解析不去重，先照藍圖保留。
    sourceRef: `ts|${fp}|${ctx.stmtMonth}|${t.tradeDate}|${String(t.symbol).replace(/\|/g, '')}|${String(t.rawType || '').replace(/\|/g, '')}|${Number(t.quantity)}|${t.price ?? ''}|${t.grossAmount ?? ''}|${t.netSettlement ?? ''}`,
    // fail-open 防呆（自審）：帳號抽取失敗→空指紋 fp，兩個不同帳戶的同欄位交易會互撞去重。標 missingAccount 讓 S2 fail-closed。
    flags: { ...(side === null ? { unknownType: true } : {}), ...(fp ? {} : { missingAccount: true }) },
  };
}

/** 官方識別碼版 ref（transactionID/tradeID/ibExecID）＝天生唯一，永不加序。 @param {string} ref */
const isOfficialRef = (ref) => /^ib\|(?:txn|trd|exe)\|/.test(String(ref || ''));

/**
 * 「同批出現序」：**退路指紋類** ref（`ts|…` 與 `ib|fp|…`）一律依批內出現順序補 `|#N`（唯一時也補 `|#1`）。
 * 官方識別碼類 ref 天生唯一、**不加序**。
 * ⚠️ 自審高風險修正：舊版只在「批內同鍵 count>1」才加序 → 跨批 multiplicity 一變（重疊期間重同步、補發更正版對帳單
 * 多/少一筆），同一筆真交易的 ref 會在 `bare` 與 `|#1` 之間漂移 → S2 upsert 判成新的、重複入帳。改成
 * 「序號只依出現順序、不依重複數」後：第 1 筆恆 `|#1`（命中舊庫）、第 2 筆才 `|#2`（新增）＝S2 冪等地基穩。
 * **就地改寫 list 裡各筆的 sourceRef**，回傳同一個 list。
 * @template {{sourceRef:string}} T @param {T[]} list @returns {T[]}
 */
export function assignSeqSuffix(list) {
  /** @type {Map<string, number>} */
  const seq = new Map();
  for (const t of list) {
    if (isOfficialRef(t.sourceRef)) continue;   // 官方識別碼：不加序（重複＝資料錯，該去重成一筆）
    const n = (seq.get(t.sourceRef) || 0) + 1;
    seq.set(t.sourceRef, n);
    t.sourceRef = `${t.sourceRef}|#${n}`;
  }
  return list;
}
