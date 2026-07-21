// @ts-check
// 台新銀行「綜合對帳單」解析器（三層重構 stage 2/3，使用者定 2026-07-20）。
// 與信用卡帳單（lib/statement.js）**完全分開**：銀行對帳單餵的是「收入支出現金流」與「帳戶餘額」，
// 不是信用卡消費明細。stage 2＝帳戶概要區（更新/自動建帳戶餘額）；stage 3＝交易往來明細（分箱進收支）。
//
// ⚠️ 與信用卡解析器的關鍵差異：銀行明細的「支出金額 / 存入金額」是**兩個獨立欄位、只填一個**，
// 光看文字分不出方向——必須靠 **x 座標**判斷落在哪一欄（右對齊金額落在該欄 header 與下一欄 header 之間）。
// 所以這裡自己做一份「保留 x 座標」的抽取（extractBankLines），不共用 statement.js 丟掉 x 的 extractLines。
//
// 隱私：PDF 密碼＝身分證字號（pdfPassword），只在記憶體傳給 pdfjs，絕不落檔。帳單內容含真實餘額/帳號，
// 只在解析當下處理、不持久化原始 PDF。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** @typedef {{x:number, s:string}[]} XLine 一列（依 x 排序的儲存格） */

/**
 * 抽取 PDF 每一列的「儲存格＋x 座標」（依 y 分列、列內依 x 排序）。與 statement.js extractLines 同法，
 * 但**保留 x**（銀行明細分欄靠它）。pdfjs 會 detach 傳入 buffer，一律傳副本（Codex PR#30 的坑）。
 * @param {Uint8Array} data @param {string=} password @returns {Promise<XLine[]>}
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
  /** @type {XLine[]} */
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    /** @type {Record<number, {x:number, s:string}[]>} */
    const rows = {};
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;   // 只取有文字的 TextItem
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: Math.round(it.transform[4]), s: it.str.trim() });
    }
    for (const [, cells] of Object.entries(rows).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      lines.push(cells.sort((a, b) => a.x - b.x));
    }
  }
  await task.destroy();
  return lines;
}

/** 這份 PDF 內容像不像台新銀行綜合對帳單（與信用卡帳單區分）。 @param {XLine[]} lines */
export function isBankStatement(lines) {
  const text = lines.map(l => l.map(c => c.s).join('')).join('\n');
  return /帳戶概要區/.test(text) && /往來明細|交易往來/.test(text);
}

const NBSP = /\s+/g;
/** 去掉字元間空白（台新把標題逐字拆開：「現 值 參 考 日」→「現值參考日」）。 @param {string} s */
const squash = (s) => String(s || '').replace(NBSP, '');
/** 金額字串 → number（去 $ 與千分位；非數字回 null）。 @param {string} s @returns {number|null} */
export function parseAmount(s) {
  const m = String(s || '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(m)) return null;
  return Number(m);
}
/** 遮罩帳號取「末尾可見數字」：900100****3301→3301、900300****363→363。抓不到回 ''。 @param {string} s */
export function accountSuffix(s) {
  const m = String(s || '').match(/\*+\s*(\d+)\s*$/);
  return m ? m[1] : '';
}
/** 帳號遮罩樣式判斷（數字＋星號＋數字）。 @param {string} s */
const isMaskedAccount = (s) => /^\d+\*{2,}\d+$/.test(String(s || '').replace(/\s/g, ''));

/**
 * 解析「帳戶概要區」（stage 2）：新臺幣＋外幣兩區，回每個帳戶的末碼、餘額、幣別、標籤。
 * 台幣區列：帳號類別 | 帳號(遮罩) | $餘額 | [備註]；外幣區列：帳號類別 | 帳號 | $原幣 | $新臺幣 | [備註]，
 * 幣別(JPY/USD)在鄰近列。透支負餘額帳戶＝台新不納入計算（餘額欄留空），此處也一律略過（無金額列）。
 * @param {XLine[]} lines
 * @returns {{ referenceDate: string|null, accounts: {suffix:string, masked:string, balance:number, currency:string, label:string, note:string}[] }}
 */
export function parseBankSummary(lines) {
  /** @type {{suffix:string, masked:string, balance:number, currency:string, label:string, note:string}[]} */
  const accounts = [];
  let referenceDate = null;
  let section = null;   // 'twd' | 'foreign' | null
  /** @type {string|null} 外幣區：暫存「上一個幣別列」給下一筆外幣帳戶用 */
  let pendingCurrency = null;

  for (const line of lines) {
    const cells = line.map(c => c.s);
    const joined = squash(cells.join(''));

    // 現值參考日（兩區各印一次，取第一個）＝「較新才覆蓋」的依據
    if (referenceDate == null) {
      const m = joined.match(/現值參考日[:：]?(\d{4})\/(\d{2})\/(\d{2})/);
      if (m) referenceDate = `${m[1]}-${m[2]}-${m[3]}`;
    }

    if (/新臺幣帳戶概要區/.test(joined)) { section = 'twd'; continue; }
    if (/外幣帳戶概要區/.test(joined)) { section = 'foreign'; pendingCurrency = null; continue; }
    if (/^合計/.test(squash(cells[0] || ''))) { section = null; continue; }   // 概要區以「合計」收尾（判首格、非整列 join：免帳戶類別名以「合計」開頭誤收尾）
    if (!section) continue;

    if (section === 'foreign') {
      // 幣別列（單獨一格 JPY/USD）：記著給下一筆外幣帳戶
      const cur = cells.map(c => c.trim()).find(c => /^[A-Z]{3}$/.test(c));
      if (cur && cells.length <= 2) { pendingCurrency = cur; continue; }
    }

    // 資料列＝有一格是遮罩帳號
    const accIdx = cells.findIndex(isMaskedAccount);
    if (accIdx < 0) continue;
    const suffix = accountSuffix(cells[accIdx]);
    if (!suffix) continue;
    const masked = String(cells[accIdx]).replace(/\s/g, '');
    const label = squash(cells.slice(0, accIdx).join(' ')) || (section === 'foreign' ? '外幣活存' : '新臺幣活存');
    // 餘額＝帳號之後、**帶「$」的第一個金額格**（$ 才是餘額；定存利率 1.5、起迄日 都沒有 $，不會誤抓）。
    // 台幣區只有一個 $ 餘額；外幣區有兩個（$原幣、$新臺幣），取**第一個＝原幣**——account.currency=USD/JPY
    // 時 derive 會自己乘匯率換台幣，存新臺幣值會被重複換算。備註＝非金額的文字（Richart…）。
    const after = cells.slice(accIdx + 1);
    const moneyCells = after.filter(c => /\$/.test(c));
    const balance = moneyCells.length ? parseAmount(moneyCells[0]) : null;
    if (balance == null) continue;                      // 沒有 $ 餘額（透支負餘額被台新留空）→ 略過
    const note = squash(after.filter(c => !/\$/.test(c) && parseAmount(c) == null).join(' '));
    const currency = section === 'foreign' ? (pendingCurrency || 'USD') : 'TWD';
    if (section === 'foreign') pendingCurrency = null;
    accounts.push({ suffix, masked, balance, currency, label, note });
  }
  return { referenceDate, accounts };
}

/**
 * 銀行對帳單主入口（stage 2：只回概要區的帳戶＋參考日；stage 3 會補交易明細）。
 * @param {Uint8Array} data @param {string=} password
 * @returns {Promise<{ bank:'台新', referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[] }>}
 */
export async function parseBankStatement(data, password) {
  const lines = await extractBankLines(data, password);
  if (!isBankStatement(lines)) throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 });
  const { referenceDate, accounts } = parseBankSummary(lines);
  return { bank: '台新', referenceDate, accounts };
}
