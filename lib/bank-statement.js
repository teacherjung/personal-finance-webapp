// @ts-check
// 台新銀行「綜合對帳單」解析器（三層重構 stage 2/3，使用者定 2026-07-20）。
// 與信用卡帳單（lib/statement.js）**完全分開**：銀行對帳單餵的是「收入支出現金流」與「帳戶餘額」。
// stage 2＝帳戶概要區（parseBankSummary→更新/建帳戶餘額）；stage 3＝交易往來明細（parseBankDetail→分箱進收支）。
//
// ⚠️ 與信用卡解析器的關鍵差異：
//  ①銀行明細的「支出金額 / 存入金額」是**兩個獨立欄位、只填一個**，光看文字分不出方向——靠 **x 座標**
//    判斷落在哪一欄（右對齊金額落在該欄 header 與下一欄 header 之間）。
//  ②備註常「換行」到相鄰列（且可能在交易列的上方或下方）——靠 **y 座標**把換行片段歸到最近的交易列。
//  所以這裡自己做一份「保留 x＋y 座標」的抽取（extractBankLines），不共用 statement.js 丟掉座標的 extractLines。
//
// 隱私：PDF 密碼＝身分證字號，只在記憶體傳給 pdfjs、絕不落檔；帳單內容含真實餘額/帳號/交易，只在解析當下處理。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** @typedef {{x:number, s:string}} Cell */
/** @typedef {{y:number, cells:Cell[]}} BLine 一列：全域遞減的 y（跨頁單調）＋依 x 排序的儲存格 */

/**
 * 抽取 PDF 每一列的「儲存格（含 x）＋列的 y」（依 y 分列、列內依 x 排序；y 做成跨頁單調遞減供明細歸位）。
 * pdfjs 會 detach 傳入 buffer，一律傳副本（Codex PR#30 的坑）。
 * @param {Uint8Array} data @param {string=} password @returns {Promise<BLine[]>}
 */
export async function extractBankLines(data, password) {
  const task = getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc;
  try { doc = await task.promise; }
  catch (e) {
    if (String(/** @type {any} */ (e)?.name).includes('Password')) {
      throw Object.assign(new Error(password ? '銀行對帳單 PDF 密碼錯誤' : '這份 PDF 有加密，請提供密碼'), { status: 400 });
    }
    throw Object.assign(new Error('PDF 無法開啟：' + (/** @type {any} */ (e).message || e)), { status: 400 });
  }
  /** @type {BLine[]} */
  const lines = [];
  let pageBase = 0;   // 跨頁 y 單調：每頁往下推一個大位移，讓後頁 y 一定小於前頁
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    /** @type {Record<number, Cell[]>} */
    const rows = {};
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: Math.round(it.transform[4]), s: it.str.trim() });
    }
    for (const [y, cells] of Object.entries(rows).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      lines.push({ y: pageBase + Number(y), cells: cells.sort((a, b) => a.x - b.x) });
    }
    pageBase -= 100000;   // 大於任何單頁 y 範圍，保證跨頁單調
  }
  await task.destroy();
  return lines;
}

/** 這份 PDF 內容像不像台新銀行綜合對帳單（與信用卡帳單區分）。 @param {BLine[]} lines */
export function isBankStatement(lines) {
  const text = lines.map(l => l.cells.map(c => c.s).join('')).join('\n');
  return /帳戶概要區/.test(text) && /往來明細|交易往來/.test(text);
}

const NBSP = /\s+/g;
/** 去掉字元間空白（台新把標題逐字拆開）。 @param {string} s */
const squash = (s) => String(s || '').replace(NBSP, '');
/** 金額字串 → number（去 $ 與千分位；非數字回 null）。 @param {string} s @returns {number|null} */
export function parseAmount(s) {
  const m = String(s || '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(m)) return null;
  return Number(m);
}
/** 「$金額 備註」的格拆成 {amt, rest}（餘額格常把備註黏在後面）；非金額起頭回 null。 @param {Cell} cell */
function splitAmount(cell) {
  const m = String(cell.s).match(/^\$?([\d,]+(?:\.\d+)?)\s*(.*)$/);
  return (m && /\d/.test(m[1])) ? { amt: Number(m[1].replace(/,/g, '')), rest: m[2].trim() } : null;
}
/** 遮罩帳號取「末尾可見數字」。 @param {string} s */
export function accountSuffix(s) {
  const m = String(s || '').match(/\*+\s*(\d+)\s*$/);
  return m ? m[1] : '';
}
const isMaskedAccount = (/** @type {string} */ s) => /^\d+\*{2,}\d+$/.test(String(s || '').replace(/\s/g, ''));
const isBankDate = (/** @type {string} */ s) => /^\d{4}\/\d{2}\/\d{2}$/.test(String(s || '').trim());

/**
 * 解析「帳戶概要區」（stage 2）：新臺幣＋外幣兩區，回每個帳戶的末碼、餘額、幣別、標籤。
 * @param {BLine[]} lines
 * @returns {{ referenceDate: string|null, accounts: {suffix:string, masked:string, balance:number, currency:string, label:string, note:string}[] }}
 */
export function parseBankSummary(lines) {
  /** @type {{suffix:string, masked:string, balance:number, currency:string, label:string, note:string}[]} */
  const accounts = [];
  let referenceDate = null;
  let section = null;   // 'twd' | 'foreign' | null
  let pendingCurrency = null;

  for (const line of lines) {
    const cells = line.cells.map(c => c.s);
    const joined = squash(cells.join(''));
    if (referenceDate == null) {
      const m = joined.match(/現值參考日[:：]?(\d{4})\/(\d{2})\/(\d{2})/);
      if (m) referenceDate = `${m[1]}-${m[2]}-${m[3]}`;
    }
    if (/新臺幣帳戶概要區/.test(joined)) { section = 'twd'; continue; }
    if (/外幣帳戶概要區/.test(joined)) { section = 'foreign'; pendingCurrency = null; continue; }
    if (/^合計/.test(squash(cells[0] || ''))) { section = null; continue; }   // 首格＝合計 收尾（免類別名誤收尾）
    if (!section) continue;
    if (section === 'foreign') {
      const cur = cells.map(c => c.trim()).find(c => /^[A-Z]{3}$/.test(c));
      if (cur && cells.length <= 2) { pendingCurrency = cur; continue; }
    }
    const accIdx = cells.findIndex(isMaskedAccount);
    if (accIdx < 0) continue;
    const suffix = accountSuffix(cells[accIdx]);
    if (!suffix) continue;
    const masked = String(cells[accIdx]).replace(/\s/g, '');
    const label = squash(cells.slice(0, accIdx).join(' ')) || (section === 'foreign' ? '外幣活存' : '新臺幣活存');
    const after = cells.slice(accIdx + 1);
    const moneyCells = after.filter(c => /\$/.test(c));   // 餘額＝帶 $ 的第一格（利率/起迄日 無 $）；外幣取第一個＝原幣
    const balance = moneyCells.length ? parseAmount(moneyCells[0]) : null;
    if (balance == null) continue;                         // 透支負餘額被台新留空→略過
    const note = squash(after.filter(c => !/\$/.test(c) && parseAmount(c) == null).join(' '));
    const currency = section === 'foreign' ? (pendingCurrency || 'USD') : 'TWD';
    if (section === 'foreign') pendingCurrency = null;
    accounts.push({ suffix, masked, balance, currency, label, note });
  }
  return { referenceDate, accounts };
}

/** @typedef {{acctSuffix:string, date:string, summary:string, direction:'in'|'out', amount:number, balance:number|null, note:string}} BankTx */

/**
 * 解析「交易往來明細」（stage 3）：每一筆往來。方向靠 x 座標（落在支出金額欄＝out、存入金額欄＝in），
 * 備註靠 y 座標把換行片段歸到最近的交易列。回原始交易（分箱＝收入/支出/內轉在服務層 bank-import.js）。
 * @param {BLine[]} lines @returns {BankTx[]}
 */
export function parseBankDetail(lines) {
  // 從表頭抓欄位 x（不寫死，適應版面）
  let xIn = 0, xBal = 0, xNote = 0;
  for (const l of lines) for (const c of l.cells) {
    if (c.s === '存入金額') xIn = c.x;
    if (c.s === '帳戶餘額') xBal = c.x;
    if (c.s === '備註') xNote = c.x;
  }
  if (!xIn || !xBal) return [];   // 沒有明細表頭

  /** @type {(BankTx & {y:number, _notes:{y:number,t:string}[]})[]} */
  const rows = [];
  /** @type {{y:number, t:string}[]} */
  const orphans = [];
  let inDetail = false;
  for (const line of lines) {
    const c = line.cells;
    if (c.some(x => x.s === '支出金額') && c.some(x => x.s === '存入金額')) { inDetail = true; continue; }
    if (!inDetail) continue;
    if (isMaskedAccount(c[0]?.s) && isBankDate(c[1]?.s)) {
      const rest = c.slice(2);
      // 摘要＝日期後、餘額欄之前、非金額的文字
      const summary = squash(rest.filter(x => x.x < xBal && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join(''));
      const amtCells = rest.filter(x => parseAmount(x.s) != null || /\$/.test(x.s));
      const txnCell = amtCells.find(x => x.x < xBal);     // 交易金額（支出或存入欄，右對齊落在 xBal 之前）
      const balCell = amtCells.find(x => x.x >= xBal);    // 帳戶餘額（可能黏著備註）
      if (!txnCell) continue;
      const amount = parseAmount(String(txnCell.s).match(/[\d,]+(?:\.\d+)?/)?.[0] || '');
      if (amount == null) continue;
      const bs = balCell ? splitAmount(balCell) : null;
      const direction = txnCell.x < xIn ? /** @type {'out'} */ ('out') : /** @type {'in'} */ ('in');   // < 存入欄 x ＝支出欄
      rows.push({
        y: line.y, acctSuffix: accountSuffix(c[0].s), date: c[1].s.replace(/\//g, '-'),
        summary, direction, amount, balance: bs ? bs.amt : null, note: '',
        _notes: bs && bs.rest ? [{ y: line.y, t: bs.rest }] : [],
      });
    } else if (c.length && c.every(x => x.x >= xNote - 70) && !isMaskedAccount(c[0]?.s)) {
      orphans.push({ y: line.y, t: c.map(x => x.s).join('') });   // 換行的備註片段（高 x、無帳號）
    }
  }
  // 換行備註片段→最近的交易列（用 y）；每列備註依 y 遞減（上→下＝閱讀順序）合併
  for (const o of orphans) {
    let best = null, bd = Infinity;
    for (const r of rows) { const d = Math.abs(r.y - o.y); if (d < bd) { bd = d; best = r; } }
    if (best) best._notes.push(o);
  }
  return rows.map(r => ({
    acctSuffix: r.acctSuffix, date: r.date, summary: r.summary, direction: r.direction,
    amount: r.amount, balance: r.balance, note: r._notes.sort((a, b) => b.y - a.y).map(n => n.t).join(''),
  }));
}

/**
 * 銀行對帳單主入口：概要區帳戶（stage 2）＋交易明細（stage 3）＋參考日。
 * @param {Uint8Array} data @param {string=} password
 * @returns {Promise<{ bank:'台新', referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], transactions:BankTx[] }>}
 */
export async function parseBankStatement(data, password) {
  const lines = await extractBankLines(data, password);
  if (!isBankStatement(lines)) throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 });
  const { referenceDate, accounts } = parseBankSummary(lines);
  const transactions = parseBankDetail(lines);
  return { bank: '台新', referenceDate, accounts, transactions };
}
