// @ts-check
// 台新「證券」電子對帳單解析器（證券交易 S1，設計藍圖 docs/證券交易-設計藍圖.md §三）。
// 與信用卡（lib/statement.js）、銀行綜合對帳單（lib/bank-statement.js）**完全分開**：
// 這份餵的是「歷史成交紀錄」，不是消費、也不是現金流。
//
// 版面特性（藍圖 §三，據使用者真實對帳單校準的結構描述；解析器全靠合成座標列考題，不需真 PDF）：
//  ①成交明細是**雙層表頭**：同一個欄位位置，上層與下層代表不同名稱——上層欄名對應每筆的**第一行**
//    （成交日/交割日/代號/數量/價格…），下層欄名對應**第二行**（交易類別/證券名稱/成交金額/費稅…）。
//  ②**一筆成交跨兩行**：靠 y 相鄰把兩行組回一筆；欄位靠表頭 token 的 x 建立分欄邊界。
//  ③多筆成交後有**交割彙總列**（應收付日期＋合計金額）：同一交割日可對應多筆成交——彙總列
//    把交割日回填給前面尚無交割日的成交，並交叉核對「明細應收付加總 vs 彙總合計」（不符＝記
//    sumMatches:false，S2 預覽據此 fail-closed 阻擋，**不偷改來源數字**）。
//  ④頁尾有大量法規說明：遇到法規/警語關鍵字即停止，法規裡的數字不可被當成交。
//
// 隱私：PDF 密碼只在記憶體傳給 pdfjs、不落檔不入 log；本檔不出現任何真實帳號/姓名/交易。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseAmount } from './bank-statement.js';
import { rocToIso } from './statement.js';
import { isRealDate } from './schema.js';
import { taishinSide } from './services/security-trades.js';   // 方向判準單一真相（security-trades 對本檔只有 JSDoc 型別引用，無 runtime 環）

/** @typedef {{x:number, w:number, s:string}} Cell */
/** @typedef {{y:number, cells:Cell[]}} SLine */
/**
 * @typedef {object} TaishinSecTrade
 * @property {string} tradeDate        成交日 YYYY-MM-DD
 * @property {string|null} settlementDate 交割日（列上有就用；否則由交割彙總列回填；都沒有＝null）
 * @property {string} rawType          來源原始交易類別（現買/現賣…；**不猜方向**，對應表在 security-trades.js）
 * @property {string} symbol           證券代號
 * @property {string} name             證券名稱
 * @property {number|null} quantity
 * @property {number|null} price
 * @property {number|null} grossAmount 成交金額（原幣）
 * @property {number|null} commission  手續費
 * @property {number|null} feeDiscount 折讓金額
 * @property {number|null} tax         證交稅
 * @property {number|null} otherFees
 * @property {number|null} netSettlement 應收付金額（對帳單印的查帳真相，絕對值）
 * @property {string} currency         這份格式預設 TWD，但欄位存在、不寫死假設
 */
/** @typedef {{date:string|null, total:number|null, tradeCount:number, sumMatches:boolean|null}} SettleGroup */

/**
 * 抽取 PDF 每列的儲存格（x/y 座標；跨頁 y 單調遞減）。與 bank-statement.js 的 extractBankLines
 * 同一套模式，**刻意各自一份**：錯誤文案不同（證券 vs 銀行），且 S1 不動共用檔（平行施工規則）。
 * pdfjs 會 detach 傳入 buffer，一律傳副本（Codex PR#30 的坑）。
 * @param {Uint8Array} data @param {string=} password @returns {Promise<SLine[]>}
 */
export async function extractSecuritiesLines(data, password) {
  const task = getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc;
  try { doc = await task.promise; }
  catch (e) {
    if (String(/** @type {any} */ (e)?.name).includes('Password')) {
      throw Object.assign(new Error(password ? '證券對帳單 PDF 密碼錯誤' : '這份 PDF 有加密，請提供密碼'), { status: 400 });
    }
    throw Object.assign(new Error('PDF 無法開啟：' + (/** @type {any} */ (e).message || e)), { status: 400 });
  }
  /** @type {SLine[]} */
  const lines = [];
  let pageBase = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    /** @type {Record<number, Cell[]>} */
    const rows = {};
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: Math.round(it.transform[4]), w: Math.round(it.width || 0), s: it.str.trim() });
    }
    for (const [y, cells] of Object.entries(rows).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      lines.push({ y: pageBase + Number(y), cells: cells.sort((a, b) => a.x - b.x) });
    }
    pageBase -= 100000;
  }
  await task.destroy();
  return lines;
}

const squash = (/** @type {string} */ s) => String(s || '').replace(/\s+/g, '');

/** 這份 PDF 像不像台新「證券」對帳單（與銀行綜合對帳單、信用卡帳單區分）。 @param {SLine[]} lines */
export function isSecuritiesStatement(lines) {
  const text = lines.map(l => squash(l.cells.map(c => c.s).join(''))).join('\n');
  return /證券/.test(text) && /(成交|交易)明細/.test(text) && !/帳戶概要區/.test(text);
}

/**
 * 對帳單年月 → 'YYYY-MM'。支援民國（115年1月／115年01月）與西元（2026年1月、2026/01）。
 * @param {SLine[]} lines @returns {string|null}
 */
export function extractSecStatementMonth(lines) {
  for (const line of lines.slice(0, 40)) {   // 年月在表頭區；限前段免掃到法規文字裡的年月
    const t = squash(line.cells.map(c => c.s).join(''));
    // **西元年月優先**（自審高風險）：民國式 /(\d{2,3})年/ 無邊界會從 '2026年' 回溯咬到 '026年'→1937，
    // 害後續所有 MM/DD 成交日與去重鍵靜默偏移 89 年。先試四位年，再退民國（前置非數字邊界）。
    let m = t.match(/(\d{4})年(\d{1,2})月/);
    if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
    m = t.match(/(?<!\d)(\d{2,3})年(\d{1,2})月/);
    if (m) return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}`;
    m = t.match(/(\d{4})[/.](\d{1,2})(?:月|[/.]|$)/);
    if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  return null;
}

/**
 * 成交日字串 → ISO。支援 民國 115/01/13、1150113、西元 2026/01/13，以及 MM/DD（年份由對帳單年月推：
 * 藍圖必考「前一月交易出現在下一月對帳單」——交易月份大於帳單月份很多（如 12 月出現在 1 月帳單）＝去年。
 * @param {string} s @param {string|null} stmtMonth 'YYYY-MM' @returns {string|null}
 */
export function resolveSecDate(s, stmtMonth) {
  const str = String(s || '').trim();
  const roc = rocToIso(str);
  if (roc) return roc;
  let m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) { const iso = `${m[1]}-${m[2]}-${m[3]}`; return isRealDate(iso) ? iso : null; }
  m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && stmtMonth) {
    const [sy, sm] = stmtMonth.split('-').map(Number);
    const tm = Number(m[1]);
    // 12 月交易印在 01 月帳單 → 去年；01 月交割日印在 12 月帳單（T+2 跨年）→ 明年；同月/近月 → 當年（自審：補前向跨年）
    const y = tm > sm + 6 ? sy - 1 : tm < sm - 6 ? sy + 1 : sy;
    const iso = `${y}-${String(tm).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    return isRealDate(iso) ? iso : null;
  }
  return null;
}

// ---- 表頭 token → 欄位名（上層＝每筆第一行 A、下層＝第二行 B）----
/** @type {Record<string,string>} */
const H_A = {
  '成交日': 'tradeDate', '成交日期': 'tradeDate',
  '交割日': 'settlementDate', '交割日期': 'settlementDate',
  '證券代號': 'symbol', '代號': 'symbol', '股票代號': 'symbol',
  '數量': 'quantity', '股數': 'quantity', '成交股數': 'quantity',
  '成交價': 'price', '單價': 'price', '成交單價': 'price',
  '手續費': 'commission',
  '應收付金額': 'netSettlement', '淨收付金額': 'netSettlement', '應收付款': 'netSettlement',
};
/** @type {Record<string,string>} */
const H_B = {
  '交易類別': 'rawType', '類別': 'rawType', '交易種類': 'rawType',
  '證券名稱': 'name', '名稱': 'name', '股票名稱': 'name',
  '成交金額': 'grossAmount', '價金': 'grossAmount', '成交價金': 'grossAmount',
  '折讓金額': 'feeDiscount', '折讓': 'feeDiscount',
  '證交稅': 'tax', '交易稅': 'tax',
  '其他費用': 'otherFees', '其他': 'otherFees',
  '幣別': 'currency',
};
const isHeaderLine = (/** @type {string[]} */ ss, /** @type {Record<string,string>} */ dict) =>
  ss.filter(s => Object.hasOwn(dict, squash(s))).length >= 2;   // hasOwn：token 是帳單文字（AGENTS 3.5）

/** @typedef {{x:number, field:string}[]} ColMap */
/** 依表頭 token 建一層的欄位地圖（x 升冪）。 @param {Cell[]} cells @param {Record<string,string>} dict @returns {ColMap} */
function colsOf(cells, dict) {
  /** @type {ColMap} */
  const cols = [];
  for (const c of cells) {
    const k = squash(c.s);
    if (Object.hasOwn(dict, k)) cols.push({ x: c.x, field: dict[k] });
  }
  return cols.sort((a, b) => a.x - b.x);
}

/**
 * 把一列 record 的儲存格依欄位地圖分欄。金額右對齊會因位數左緣飄移——金額格用右緣 r=x+w、
 * 文字格用左緣（同 parseBankDetail 的混合法；w=0 時右緣退回左緣）。邊界＝相鄰欄 x 的中線。
 * @param {Cell[]} cells @param {ColMap} cols @returns {Record<string,string>}
 */
function assignCols(cells, cols) {
  /** @type {Record<string,string>} */
  const out = Object.create(null);   // field 名是我們自己的常數，仍用 null-proto 防萬一
  if (!cols.length) return out;
  // **band 分欄（自審高風險修正）**：邊界＝下一欄的表頭左緣（非相鄰中線）。右對齊金額的右緣天生落在
  // 「本欄表頭左緣～下一欄表頭左緣」band 內（同 lib/bank-statement.js:176-178 的 [xOut,xIn) 做法）；
  // 中線法會讓金額右緣一過中線就整欄右移串接（手續費黏進應收付、名稱尾碼數字黏進成交金額、數字代號漂進數量）。
  // idx＝左緣 ≤ 錨點的最右欄（col 0 當地板）；錨點：數字格用右緣 x+w（右對齊）、文字格用左緣 x。
  const bounds = cols.map((c, i) => i === 0 ? -Infinity : c.x);
  for (const cell of cells) {
    const isAmt = parseAmount(cell.s) != null;
    const pos = isAmt && cell.w ? cell.x + cell.w : cell.x;
    let idx = 0;
    for (let i = 0; i < cols.length; i++) if (pos >= bounds[i]) idx = i;
    const f = cols[idx].field;
    out[f] = out[f] ? out[f] + ' ' + cell.s : cell.s;   // 同欄多片段（名稱被拆字、金額被拆段）併回
  }
  return out;
}

const LEGAL_RE = /注意事項|警語|受託買賣|法令|金融監督|金融消費|申訴|請詳閱/;
const SUMMARY_RE = /應收付日|合計/;

/**
 * 解析台新證券對帳單（純函式，吃合成座標列）。
 * 回傳：對帳單年月、帳戶原文（遮罩顯示由呼叫端處理；本函式不產生指紋）、成交清單、交割彙總群組。
 * @param {SLine[]} lines
 * @returns {{ stmtMonth:string|null, accountRaw:string, trades:TaishinSecTrade[], groups:SettleGroup[], headerFound:boolean }}
 */
export function parseTaishinSecurities(lines) {
  const stmtMonth = extractSecStatementMonth(lines);
  let accountRaw = '';
  /** @type {TaishinSecTrade[]} */
  const trades = [];
  /** @type {SettleGroup[]} */
  const groups = [];
  /** @type {ColMap} */ let colsA = [];
  /** @type {ColMap} */ let colsB = [];
  /** @type {TaishinSecTrade|null} */ let pendingA = null;
  let pendingAY = 0;    // A 行的 y（B 行相鄰判定用；不掛在 trade 物件上）
  let groupStart = 0;   // 本交割群組第一筆的 index
  let headerFound = false;   // 有沒有成功建立過雙層欄位地圖（fail-closed 用：表頭讀不到≠沒交易）
  const DY_MAX = 40;    // A/B 兩行的 y 相鄰上限（同 bank ORPHAN_MAX_DY 量級；跨頁/隔太遠不硬併）

  const num = (/** @type {string|undefined} */ s) => s == null ? null : parseAmount(String(s).replace(/[^\d.,-]/g, ''));

  for (const line of lines) {
    const ss = line.cells.map(c => c.s);
    const joined = squash(ss.join(''));

    if (!accountRaw) {
      const m = joined.match(/帳[戶號][:：]?([\d*-]{6,})/);
      if (m) accountRaw = m[1];
    }

    // 雙層表頭：上層（A 欄名）與下層（B 欄名）各自比對；兩層都到齊才進明細模式
    if (isHeaderLine(ss, H_A)) { colsA = colsOf(line.cells, H_A); continue; }
    if (colsA.length && isHeaderLine(ss, H_B)) { colsB = colsOf(line.cells, H_B); headerFound = true; continue; }
    if (!colsA.length || !colsB.length) continue;

    // 頁尾法規小字 → **退出明細模式**（自審高風險：原本 break 會把跨頁帳單第 2 頁以後的成交全砍）。
    // 清欄位地圖＋pending；跨頁時下一頁表頭重印（上面 isHeaderLine 分支）會重建，續收。只有真文件尾才停解析。
    if (LEGAL_RE.test(joined)) { colsA = []; colsB = []; pendingA = null; continue; }

    // 交割彙總列：應收付日期＋合計 → 回填交割日＋交叉核對群組加總
    if (SUMMARY_RE.test(joined)) {
      const dateCell = ss.map(s => s.match(/[\d/]{5,}/)?.[0] || '').find(s => resolveSecDate(s, stmtMonth));
      const gDate = dateCell ? resolveSecDate(dateCell, stmtMonth) : null;
      const amts = ss.map(s => parseAmount(s)).filter(v => v != null);
      const gTotal = amts.length ? amts[amts.length - 1] : null;
      const members = trades.slice(groupStart);
      let sumMatches = null;
      if (gTotal != null && members.length) {
        const sides = members.map(t => taishinSide(t.rawType));   // 嚴格枚舉真相表（自審：與 sideHint 判準統一）
        const allSame = sides.every(s => s !== null && s === sides[0]);
        if (allSame) {
          // 同向群組：藍圖 §七「應收付**加總**」＋§四 netSettlement＝**絕對值** → 各筆絕對值加總 ≈ 合計。
          const sum = members.reduce((acc, t) => acc + (t.netSettlement || 0), 0);
          sumMatches = Math.abs(sum - Math.abs(gTotal)) < 1;
        }
        // 混合買賣 or 含未知類別 → 保持 null（核對不了）：合計是淨額還是絕對加總未經真實版面校準，不押注（自審）
      }
      for (const t of members) if (!t.settlementDate && gDate) t.settlementDate = gDate;
      groups.push({ date: gDate, total: gTotal, tradeCount: members.length, sumMatches });
      groupStart = trades.length;
      pendingA = null;
      continue;
    }

    // 第一行（A）：成交日欄有真日期
    const a = assignCols(line.cells, colsA);
    const tradeDate = a.tradeDate ? resolveSecDate(a.tradeDate, stmtMonth) : null;
    if (tradeDate) {
      pendingAY = line.y;
      pendingA = {
        tradeDate,
        settlementDate: a.settlementDate ? resolveSecDate(a.settlementDate, stmtMonth) : null,
        rawType: '', symbol: squash(a.symbol || ''), name: '',
        quantity: num(a.quantity), price: num(a.price),
        grossAmount: null, commission: num(a.commission), feeDiscount: null, tax: null, otherFees: null,
        netSettlement: num(a.netSettlement), currency: 'TWD',
      };
      trades.push(pendingA);
      continue;
    }

    // 第二行（B）：黏回最近的 pending A（y 要夠近；隔太遠寧可留白）
    if (pendingA && Math.abs(pendingAY - line.y) <= DY_MAX) {
      const b = assignCols(line.cells, colsB);
      if (b.rawType || b.name || b.grossAmount) {
        pendingA.rawType = squash(b.rawType || '');
        pendingA.name = squash(b.name || '');
        if (b.grossAmount != null) pendingA.grossAmount = num(b.grossAmount);
        if (b.feeDiscount != null) pendingA.feeDiscount = num(b.feeDiscount);
        if (b.tax != null) pendingA.tax = num(b.tax);
        if (b.otherFees != null) pendingA.otherFees = num(b.otherFees);
        if (b.currency && /^[A-Z]{3}$/.test(squash(b.currency))) pendingA.currency = squash(b.currency);
        pendingA = null;
      }
    }
  }

  // 收尾：最後一組沒有彙總列 → 仍回報群組（date/total 空、sumMatches null），S2 預覽可見「沒對到彙總」
  if (trades.length > groupStart) groups.push({ date: null, total: null, tradeCount: trades.length - groupStart, sumMatches: null });

  return { stmtMonth, accountRaw, trades, groups, headerFound };
}

/**
 * 表頭區是否為「多月份跨度」對帳單（年度單「115年1月~12月」、季度單「115年1月至3月」）。
 * 只掃前段（年月都印在表頭區）；單月的「115年1月」不會命中。
 * @param {SLine[]} lines @returns {boolean}
 */
export function isMultiMonthHeader(lines) {
  for (const line of lines.slice(0, 40)) {
    const t = squash(line.cells.map(c => c.s).join(''));
    if (/\d{1,2}月\s*[~～〜至\-—–－]\s*\d{1,2}月/.test(t)) return true;   // 1月~12月／1月至3月（含全形－、波浪〜，自審 #5）
    if (/年\d{1,2}月[~～〜至\-—–－]/.test(t)) return true;                   // 115年1月~（右邊接年或月都算跨度）
  }
  return false;
}

// 舊名保留給既有考題；判準**委託 security-trades 的枚舉真相表**（自審：原鬆版把 '融資買'/'申購買進'
// 猜成 buy、真相表卻回 null，兩份判準漂移讓 sumMatches 建立在被判「不可猜」的方向上）。
export const taishinSideHint = taishinSide;

/**
 * 主入口：解密 → 抽座標列 → 判格式 → 解析。
 * @param {Uint8Array} data @param {string=} password
 */
export async function parseTaishinSecuritiesPdf(data, password) {
  const lines = await extractSecuritiesLines(data, password);
  if (!isSecuritiesStatement(lines)) {
    throw Object.assign(new Error('這份 PDF 看起來不是台新證券對帳單'), { status: 400 });
  }
  // 非月結單阻擋（S2 拍板點：sourceRef 含對帳單年月＝藍圖 §六鍵，但年度/季度單抽到的「第一個年月」會讓
  // 跨度後段所有交易掛錯年月→去重鍵毒化＋MM/DD 年份推斷全錯。fail-closed：只支援單月對帳單）。
  if (isMultiMonthHeader(lines)) {
    throw Object.assign(new Error('這份對帳單涵蓋多個月份（年度/季度單）。目前僅支援單月對帳單——請改用各月份的月結單分別上傳。'), { status: 400 });
  }
  const r = parseTaishinSecurities(lines);
  // fail-closed（藍圖 §七「讀不到交易表頭或欄位位置」，自審）：表頭讀不到就不能靜默回 0 筆
  //（會與「當月真的沒交易」無法分辨）。台新逐字拆表頭的完整容錯需真 PDF 校準、屆時再擴，先大聲擋下。
  if (!r.headerFound) throw Object.assign(new Error('讀不到成交明細的欄位位置（表頭可能被逐字拆或版面不同，請回報帳單版面）'), { status: 400 });
  if (!r.stmtMonth) throw Object.assign(new Error('讀不到對帳單年月，無法匯入（請回報帳單版面）'), { status: 400 });
  return r;
}
