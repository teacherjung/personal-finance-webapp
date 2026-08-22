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
import { assertPageLimit, readPageTextCapped } from './parse-limits.js';
import { extractPdfLines } from './pdf-isolate.js';
import { isRealDate } from './schema.js';

/** @typedef {{x:number, w:number, s:string}} Cell x＝左緣、w＝文字寬（x+w＝右緣，右對齊金額靠它分欄） */
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
    // ⚠️ **開檔失敗也要放掉 task**（2026-07-28，Codex 收官審查 #7）：
    //    下面那段 `try/finally { task.destroy() }` 只包住「載入成功之後」的迴圈，
    //    而畸形 PDF 正好都是在**這一步**就失敗——最容易被攻擊的那條路恰好沒被包到。
    //    （實測這個 repo 沒開 pdfjs 的 worker，物件其實會被 GC 回收、不會真的洩漏；
    //     但「防資源耗盡的程式自己不放資源」是結構問題，照樣要修。）
    await task.destroy().catch(() => {});
    if (String(/** @type {any} */ (e)?.name).includes('Password')) {
      // code:'pdf_password'（P0.5）＝機器判準：試密碼迴圈與前端「跳密碼窗」認欄位不認訊息字面
      throw Object.assign(new Error(password ? '銀行對帳單 PDF 密碼錯誤' : '這份 PDF 有加密，請提供密碼'), { status: 400, code: 'pdf_password' });
    }
    throw Object.assign(new Error('PDF 無法開啟：' + (/** @type {any} */ (e).message || e)), { status: 400 });
  }
  /** @type {BLine[]} */
  const lines = [];
  let pageBase = 0;   // 跨頁 y 單調：每頁往下推一個大位移，讓後頁 y 一定小於前頁
  // 解析器資源上限（2026-07-28）：檔案小不代表解析便宜——一份 200KB 的 PDF 可以有幾萬頁
  // 或幾十萬個文字節點，解析時把記憶體吃光。超標**明確拒絕**，不靜默截斷。
  // ⚠️ **整段包在 try/finally 裡**：上限一 throw 就會跳過 `task.destroy()`，
  //    pdfjs 的 worker 與已配置的頁面資源就留在那裡不放——「防資源耗盡」的那條路自己在漏資源。
  try {
    assertPageLimit(doc.numPages, '銀行對帳單 PDF');
    let itemCount = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      // ⚠️ **邊收邊數**（2026-07-29）：`getTextContent()` 會把整頁材料化之後才回來，
      //    所以節點上限無論擺在哪都是「事後才數」——單頁塞爆就整個繞過（實測 138KB 打死行程）。
      //    `readPageTextCapped` 用 `streamTextContent()` 一邊收一邊數，超標當場 cancel。
      const tc = await readPageTextCapped(page, itemCount, '銀行對帳單 PDF');
      itemCount = tc.count;
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
      pageBase -= 100000;   // 大於任何單頁 y 範圍，保證跨頁單調
    }
  } finally {
    await task.destroy();
  }
  return lines;
}

/** 這份 PDF 內容像不像台新銀行綜合對帳單（與信用卡帳單區分）。 @param {BLine[]} lines */
export function isBankStatement(lines) {
  const text = lines.map(l => l.cells.map(c => c.s).join('')).join('\n');
  return /帳戶概要區/.test(text) && /往來明細|交易往來/.test(text);
}

const NBSP = /\s+/g;
/** 去掉字元間空白（台新把標題逐字拆開）。P2 配方引擎（parse-recipe.js）共用＝單一實作。 @param {string} s */
export const squash = (s) => String(s || '').replace(NBSP, '');
/** 金額字串 → number（去 $ 與千分位；非數字回 null）。 @param {string} s @returns {number|null} */
export function parseAmount(s) {
  const m = String(s || '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(m)) return null;
  return Number(m);
}
/** 「$金額 備註」的格拆成 {amt, rest}（餘額格常把備註黏在後面）；非金額起頭回 null。
 * P2 配方引擎共用＝單一實作。allowNegative（r9#3）＝配方引擎專用：泛化版面會印負餘額
 * （-100），parseAmount 本來就收負號、這裡不收＝同檔數字文法不一致 ⇒ date-first 整列消失。
 * ⚠️ **模板呼叫端刻意不帶旗標＝台新行為凍結**——bankRef 含餘額段、位元組級凍結，
 * 改了模板的負餘額判讀＝歷史資料重匯判不出重複。 @param {Cell} cell @param {boolean=} allowNegative */
export function splitAmount(cell, allowNegative) {
  if (!allowNegative) {
    const m = String(cell.s).match(/^\$?([\d,]+(?:\.\d+)?)\s*(.*)$/);
    return (m && /\d/.test(m[1])) ? { amt: Number(m[1].replace(/,/g, '')), rest: m[2].trim() } : null;
  }
  // 負號三種常見印法都收：-100／$-100／-$100（r11#2）；「-$-100」雙負號＝看不懂回 null
  const m = String(cell.s).match(/^(-?)\$?(-?)([\d,]+(?:\.\d+)?)\s*(.*)$/);
  if (!m || !/\d/.test(m[3]) || (m[1] && m[2])) return null;
  return { amt: Number(((m[1] || m[2]) ? '-' : '') + m[3].replace(/,/g, '')), rest: m[4].trim() };
}
/** 遮罩帳號取「末尾可見數字」。 @param {string} s */
export function accountSuffix(s) {
  const m = String(s || '').match(/\*+\s*(\d+)\s*$/);
  return m ? m[1] : '';
}
/** 讀不到幣別時的哨兵值（**刻意不在 `schema.js` 的 CURRENCIES 裡**）：
 * 帶著它的帳戶會走既有的 `unsupported` 分支＝跳過、不建帳戶、不動餘額；
 * 明細那條路也因為「非 TWD」而不計入台幣現金流。fail-closed 勝過猜一個幣別。 */
export const UNKNOWN_CURRENCY = 'UNKNOWN';
/** 遮罩帳號判準（P2 配方引擎共用＝單一實作——遮罩長相是跨銀行通則，刻意不做成配方槽位）。 */
export const isMaskedAccount = (/** @type {string} */ s) => /^\d+\*{2,}\d+$/.test(String(s || '').replace(/\s/g, ''));
const isBankDate = (/** @type {string} */ s) => /^\d{4}\/\d{2}\/\d{2}$/.test(String(s || '').trim());

/**
 * 解析「帳戶概要區」（stage 2）：新臺幣＋外幣兩區，回每個帳戶的末碼、餘額、幣別、標籤。
 * accountCurrency＝**所有**帳戶（含餘額空白被略過的）的「完整遮罩帳號→幣別」對照，供 stage 3 明細可靠判幣別。
 * @param {BLine[]} lines
 * @returns {{ referenceDate: string|null, accounts: {suffix:string, masked:string, balance:number, currency:string, label:string, note:string, kind:'demand'|'time', period:string}[], accountCurrency: Record<string,string> }}
 */
export function parseBankSummary(lines) {
  /** @type {{suffix:string, masked:string, balance:number, currency:string, label:string, note:string, kind:'demand'|'time', period:string}[]} */
  const accounts = [];
  /** @type {Record<string,string>} 完整遮罩帳號→幣別（含餘額空白的帳戶） */
  const accountCurrency = {};
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
    // 外幣區的「非帳戶列」分三種處理（r1，Codex 複審阻擋#2 收緊）：
    //   ①**認得出的幣別標題**（整列只有一個三字母代碼）→ 設為目前幣別。
    //     判準刻意不再限制「該列 ≤2 格」——`幣別｜JPY｜匯率` 這種多一格的版面本來就該認得出來，
    //     限格數只會讓它整組退回預設值。
    //   ②**匯率列／空列**（純數字或沒有內容）→ 結構上無意義，不動目前幣別（sticky 的意義就在這裡）。
    //   ③**其他看不懂的結構列**（有文字、卻讀不出唯一幣別；或一列出現兩個以上代碼）→ **清成不知道**。
    //     這條是 sticky 的必要配套：只讓標題延續到下一個標題，**絕不讓上一組的幣別漏到下一組**
    //     （Codex 實測：JPY 標題→帳戶→認不出的 USD 標題→帳戶，第二戶會被算成 JPY）。
    if (section === 'foreign' && !cells.some(isMaskedAccount)) {
      const curs = [...new Set(cells.map(c => c.trim()).filter(c => /^[A-Z]{3}$/.test(c)))];
      if (curs.length === 1) { pendingCurrency = curs[0]; continue; }
      const meaningful = cells.map(c => c.trim()).filter(Boolean);
      const rateOrBlank = meaningful.length === 0 || meaningful.every(c => /^[\d.,%$]+$/.test(c));
      if (!rateOrBlank) pendingCurrency = null;   // 看不懂＝寧可不知道（下面會落到 UNKNOWN 哨兵）
      continue;
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
    // ⚠️ 幣別標題是 **sticky** 的（2026-07-28 修，Codex 重審抓到）：原本每解析完一個外幣帳戶就把
    // pendingCurrency 清成 null，於是「同一個幣別標題底下的第二個帳戶」會落到預設值。
    // 也**不再 fail-open 成 USD**——讀不到幣別就給一個不在 CURRENCIES 裡的哨兵值，
    // 讓既有的 unsupported 分支接手（預覽顯示跳過、不建帳戶、不動餘額；明細那條路也因為非 TWD 不計入現金流）。
    // 實測後果：一個 JPY 標題下兩個各 ¥100,000 的帳戶 → 第二戶被當 USD，
    // 現金從 43,000 TWD 變成 3,221,500 TWD（虛增約 150 倍），真 JPY 帳戶還被留在舊餘額、外加一個幽靈帳戶。
    // 這違反下一行原本就寫著的「不確定就不可猜」原則。
    const currency = section === 'foreign' ? (pendingCurrency || UNKNOWN_CURRENCY) : 'TWD';
    accountCurrency[masked] = currency;                    // 記**所有**帳戶的幣別（含餘額空白被略過的）→ 明細判幣別不 fail-open 成 TWD
    if (balance == null) continue;                         // 透支負餘額被台新留空→不進「餘額更新」清單（幣別已記）
    const note = squash(after.filter(c => !/\$/.test(c) && parseAmount(c) == null).join(' '));
    // 定存列（2026-08-18 William 裁示「每筆定存分開列管」）：類別從帳號左側的「帳號類別」格認
    //（塌進 label 的「外幣定存/定期存款」字樣）；起迄日從帳號右側的格抓日期區間（parseAmount 對
    // 「2026/01/25~2026/04/25」本來就回 null＝素材一直都在 note 裡、這裡結構化成 period）。
    // ⚠️ 台新帳單的「存單號碼」欄實測是**空的**、兩筆定存可以完全同值（同期間同利率同金額）——
    // 唯一天然可用的判別＝列印順序，身分鍵的「第幾筆」由寫入端算（單一實作在 bank-import）。
    const kind = /定存|定期存款/.test(label) ? 'time' : 'demand';   // 「定期存款」正中；刻意不用裸「定期」——「定期定額」是投資申購、誤中＝建假定存戶＋末筆閘卸甲（Grok G5）
    // r1#1：期間**正規化成單一表示**（抓兩端日期重組、分隔符一律 ~）——原樣入鍵的話，銀行下期把
    // 「~」印成「至」＝同一筆定存 cdKey 變了＝裂戶雙計（Codex 探針實證，且不在已揭露殘餘內）。
    const periodCell = after.map(c => String(c).match(/(\d{4}\/\d{1,2}\/\d{1,2})\s*[~〜至-]\s*(\d{4}\/\d{1,2}\/\d{1,2})/)).find(Boolean);
    // r2#1：兩端日期也補零成固定表示——「2026/1/10」與「2026/01/10」是同一天的兩種合法印法，
    // 原樣入鍵＝下期改印法就裂戶雙計（分隔符那課的同族、審查者合成重現）。
    const padDate = (/** @type {string} */ d) => d.split('/').map((x, i) => (i === 0 ? x : x.padStart(2, '0'))).join('/');
    const period = periodCell ? `${padDate(periodCell[1])}~${padDate(periodCell[2])}` : '';
    accounts.push({ suffix, masked, balance, currency, label, note, kind, period });
  }
  return { referenceDate, accounts, accountCurrency };
}

/** @typedef {{acctSuffix:string, acctMasked:string, date:string, summary:string, direction:'in'|'out', amount:number, balance:number|null, note:string}} BankTx */

/**
 * 解析「交易往來明細」（stage 3）：每一筆往來。方向靠 x 座標（落在支出金額欄＝out、存入金額欄＝in），
 * 備註靠 y 座標把換行片段歸到最近的交易列。回原始交易（分箱＝收入/支出/內轉在服務層 bank-import.js）。
 * @param {BLine[]} lines @returns {BankTx[]}
 */
export function parseBankDetail(lines) {
  /** @type {(BankTx & {y:number, _notes:{y:number,t:string}[]})[]} */
  const rows = [];
  /** @type {{y:number, t:string}[]} */
  const orphans = [];
  // 欄位 x：每遇「明細表頭列」重設（逐區段適應版面，不用全域 last-wins）
  let xChk = 0, xOut = 0, xIn = 0, xBal = 0, xNote = 0, mid = 0, inDetail = false;
  const ORPHAN_MAX_DY = 40;   // 換行備註歸位的 y 距離上限（>此＝不同交易/跨頁，寧留白不亂黏）

  for (const line of lines) {
    const c = line.cells;
    // 明細表頭：squash 容錯（台新會逐字拆標題，比對整列 squash）；抓不到欄位 x → 丟可見錯誤（不靜默歸零）
    const jc = squash(c.map(x => x.s).join(''));
    if (/支出金額/.test(jc) && /存入金額/.test(jc) && /帳戶餘額/.test(jc)) {
      const findX = (/** @type {string} */ name) => { const cell = c.find(x => x.s === name); return cell ? cell.x : 0; };
      xChk = findX('支票號碼'); xOut = findX('支出金額'); xIn = findX('存入金額'); xBal = findX('帳戶餘額'); xNote = findX('備註');
      if (!xOut || !xIn || !xBal) {
        // code＝機器判準（同 pdf_password 那條通道，P1b-2）：前端據它決定要不要提供「請 AI 讀一次」的
        // 救援入口。⚠️ **對帳閘紅刻意沒有 code**（bank-import.js gateFailureMessage）——那是「範本讀得懂
        // 但數字對不上」＝★6 裁決的禁止匯入，絕不可落到 AI 重試。
        throw Object.assign(new Error('讀不到銀行明細的欄位位置（帳單版面可能與預期不同，請回報）'), { status: 400, code: 'bank_unrecognized' });
      }
      mid = (xOut + xIn) / 2;   // 方向界＝支出/存入兩欄中線（金額右對齊，大額左緣會越過表頭左緣，用中線才不翻面）
      inDetail = true;
      continue;
    }
    if (!inDetail) continue;

    if (isMaskedAccount(c[0]?.s) && isBankDate(c[1]?.s)) {
      const rest = c.slice(2);
      const summary = squash(rest.filter(x => x.x < xBal && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join(''));
      // 欄位判定：**支出/存入金額**是「純右對齊數字」→ 用右緣 r=x+w（右緣穩定，左緣會因金額長短飄移：
      // 小額支出左緣越過中線被判存入、純數字支票號碼被當金額）。**帳戶餘額**常把備註黏在後面而變寬→右緣
      // 不可靠，改用左緣（x≥xBal）抓。支票號碼欄(右緣落 [xChk,xOut))一律忽略。無寬度(w=0)時右緣退回左緣。
      const amtCells = rest.filter(x => parseAmount(x.s) != null || /\$/.test(x.s));
      let outCell = null, inCell = null, balCell = null;
      for (const cell of amtCells) {
        if (cell.x >= xBal) { if (!balCell) balCell = cell; continue; }   // 餘額欄（左緣起；黏著備註也照抓、免遺失餘額與備註）
        const r = cell.w ? cell.x + cell.w : cell.x;
        if (xChk && r >= xChk && r < xOut) continue;                       // 支票號碼欄→忽略（不可當金額）
        if (r >= xOut && r < xIn) { if (!outCell) outCell = cell; }        // 支出金額欄
        else if (r >= xIn && r < xBal) { if (!inCell) inCell = cell; }     // 存入金額欄
      }
      let txnCell = outCell || inCell;
      /** @type {'in'|'out'|null} */
      let direction = outCell ? 'out' : (inCell ? 'in' : null);
      if (!txnCell) {   // 退路（右緣分不出欄）：舊「左緣+中線」法
        const lower = xChk || (xOut - 60);
        // ⚠️ **退路也要排除支票號碼欄**（2026-08-05，Codex #408 r1 H② 實測打出來的真 bug）：
        //    主判斷（右緣分欄）有排除票號，但這條退路原本從 xChk 起掃**未過濾的** amtCells ⇒
        //    「只有票號、沒有交易金額」的列會把票號當成金額寫進現金流＝**憑空多一筆支出**
        //    （實測：票號 0123456 → 支出 123,456 元）。純數字票號本來就不是金額，兩條路都要擋。
        txnCell = amtCells.find(x => {
          if (x.x < lower || x.x >= xBal) return false;
          const r = x.w ? x.x + x.w : x.x;
          if (xChk && r >= xChk && r < xOut) return false;
          return true;
        }) || null;
        if (txnCell) direction = txnCell.x < mid ? 'out' : 'in';
      }
      if (!txnCell || !direction) continue;
      const amount = parseAmount(String(txnCell.s).match(/[\d,]+(?:\.\d+)?/)?.[0] || '');
      if (amount == null) continue;
      const dateIso = c[1].s.replace(/\//g, '-');
      if (!isRealDate(dateIso)) continue;   // 壞日期（如 2026-02-31）→ 跳過整筆，免整張帳單匯入時撞 schema 500
      const bs = balCell ? splitAmount(balCell) : null;
      // 同列、左緣落「備註欄」(x≥xNote)的非金額文字也要收（劃撥等有時放在獨立備註欄；漏收會把百萬劃撥誤當收入）
      const rowNote = xNote ? rest.filter(x => x.x >= xNote && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join('') : '';
      /** @type {{y:number,t:string}[]} */
      const ns = [];
      if (bs && bs.rest) ns.push({ y: line.y, t: bs.rest });
      if (rowNote) ns.push({ y: line.y, t: rowNote });
      rows.push({
        y: line.y, acctSuffix: accountSuffix(c[0].s), acctMasked: String(c[0].s).replace(/\s/g, ''),
        date: dateIso, summary, direction, amount, balance: bs ? bs.amt : null, note: '', _notes: ns,
      });
    } else if (xNote && c.length && c.every(x => x.x >= xNote - 70) && !isMaskedAccount(c[0]?.s)) {
      orphans.push({ y: line.y, t: c.map(x => x.s).join('') });   // 換行的備註片段（高 x、無帳號；xNote 抓不到就不收，免恆真）
    }
  }
  // ⚠️**方向以 running 餘額為權威**（對抗審查）：金額右對齊、x 幾何在小額/大額邊界會判反（實測小額手續費
  // 被判反、大額也有風險）。銀行自己印的「帳戶餘額」是每筆後的結餘＝算術真相：同帳戶相鄰兩列餘額差的符號
  // 就是方向（且 |差|＝金額才採信）。x 判向只當「每帳戶第一列／餘額讀不到／差對不上金額」的 fallback。
  /** @type {Map<string, typeof rows>} */
  const byAcct = new Map();   // 分組用**完整遮罩帳號**（非末碼）——末碼相同、前綴不同的兩帳戶不可混算餘額差
  for (const r of rows) { const g = byAcct.get(r.acctMasked); if (g) g.push(r); else byAcct.set(r.acctMasked, [r]); }
  for (const list of byAcct.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.balance == null || cur.balance == null) continue;
      const delta = cur.balance - prev.balance;
      if (delta !== 0 && Math.abs(Math.abs(delta) - cur.amount) < 1) cur.direction = delta > 0 ? 'in' : 'out';
    }
  }

  // 換行備註片段→最近的交易列（用 y，且距離要夠近，免密集列/跨頁誤黏翻動分箱）
  for (const o of orphans) {
    let best = null, bd = Infinity;
    for (const r of rows) { const d = Math.abs(r.y - o.y); if (d < bd) { bd = d; best = r; } }
    if (best && bd <= ORPHAN_MAX_DY) best._notes.push(o);
  }
  return rows.map(r => ({
    acctSuffix: r.acctSuffix, acctMasked: r.acctMasked, date: r.date, summary: r.summary, direction: r.direction,
    amount: r.amount, balance: r.balance, note: r._notes.sort((a, b) => b.y - a.y).map(n => n.t).join(''),
  }));
}


// ================== 台新「簽帳金融卡消費明細」內建範本（2026-08-20）==================
// 與上面的綜合對帳單**同住一檔、解析各走各的**（同 lib/statement.js 讓富邦／台新 PDF／台新 XLSX
// 三種版面同住的既有前例）：兩邊只共用抽字與數字工具（squash/parseAmount/splitAmount），
// 判準與欄位定位完全分開——揉在一起會讓任一邊的版面微調動到對方，而台新的去重鍵是位元組級凍結的。
/** 明細表頭的六個欄名（**全部到齊**才算數＝這是區段界線，不可放寬成「有其中幾個」）。 */
const DETAIL_HEADS = ['日期', '摘要', '支出', '存入', '餘額', '備註'];
/** 跨行備註歸位的 y 距離上限（真檔量到：同一格的第二行 4~5、隔壁交易列 13~17）。 */
const ORPHAN_MAX_DY_DEBIT = 10;

/**
 * 這份 PDF 是不是台新簽帳金融卡消費明細。
 * 三個條件同時成立才算（任一條單獨出現都可能是別的文件）：
 * ①抬頭講「簽帳金融卡」②有「對帳單期間」③有 D 區的六欄表頭。
 * @param {BLine[]} lines
 */
export function isTaishinDebitStatement(lines) {
  const text = lines.map((l) => squash(l.cells.map((c) => c.s).join(''))).join('\n');
  return /簽帳金融卡/.test(text) && /對帳單期間/.test(text) && DETAIL_HEADS.every((h) => text.includes(h));
}

/** 一組格是不是 D 區的表頭：六欄到齊、**而且 x 照「日期／摘要／支出／存入／餘額／備註」由左到右排**。
 * ⚠️ 誠實劃界：程式只看得到文字與座標，**證明不了**這六個字真的是 D 區表頭——它擋得住「六個欄名但順序不對」，
 *    擋不住別區按同樣順序印出這六個欄名；「表頭之前不收」這道界線的前提是真版面的 A／B／C 區不會那樣印。
 *    相鄰兩列合併的表頭**信任面比整列更大**（兩列各三個欄名比整列六個欄名更容易在別區湊出來），所以合併
 *    只在整份**沒有任何整列表頭**時才啟用（見 parseTaishinDebitDetail）。 @param {BLine['cells']} cells */
function isDetailHeaderCells(cells) {
  const xs = DETAIL_HEADS.map((h) => { const c = cells.find((x) => String(x.s).trim() === h); return c ? c.x : null; });
  if (xs.some((x) => x == null)) return false;
  return xs.every((x, i) => i === 0 || /** @type {number} */ (x) > /** @type {number} */ (xs[i - 1]));
}
/** 這一列是不是 D 區的表頭。 @param {BLine} line */
function isDetailHeader(line) { return isDetailHeaderCells(line.cells); }

/** 表頭被抽字拆成兩列時，兩列的 y 距離上限（Stage 3）。與 ORPHAN_MAX_DY_DEBIT **同一個物理事實**
 * （同一列印出來的字被拆開＝4~5；真的隔一列＝13~17），刻意共用同一個數字、不另量一把尺。 */
const HEADER_SPLIT_MAX_DY = ORPHAN_MAX_DY_DEBIT;

/** 這一列是不是表頭的**碎片**（Stage 3：抽字把六欄拆成兩列時，每列各帶幾個欄名）。
 * 判準刻意**很窄**：每一格都**剛好是**六個欄名之一、而且至少一格——含任何別的字就不算。
 * 窄的理由：碎片會跟相鄰一列**合併成表頭**，表頭是「錢不被算兩次」的區段界線，
 * 寬鬆判準（像「含有其中幾個欄名」）會讓摘要含「日期」字樣的說明列被當成表頭、把 A/B/C 區放進來。
 * 回欄名集合；不是碎片回 null。 @param {BLine} line @returns {Set<string>|null} */
function headFragment(line) {
  const cells = line.cells.map((c) => String(c.s).trim()).filter(Boolean);
  if (!cells.length || !cells.every((c) => DETAIL_HEADS.includes(c))) return null;
  return new Set(cells);
}

/** 帳單期間的結束日 → 現值參考日（ISO）。讀不到回 null（**絕不自己補今天**）。
 * ⚠️ 只認「對帳單期間」這個標籤：帳單上還有別的區間（消費日、入帳日），拿錯了會用舊餘額蓋掉新的。
 * @param {BLine[]} lines */
function pickReferenceDate(lines) {
  for (const l of lines) {
    const t = squash(l.cells.map((c) => c.s).join(''));
    const m = t.match(/對帳單期間[:：]?(\d{4})\/(\d{2})\/(\d{2})\s*[~～-]\s*(\d{4})\/(\d{2})\/(\d{2})/);
    if (m) {
      const iso = `${m[4]}-${m[5]}-${m[6]}`;
      return isRealDate(iso) ? iso : null;   // 假日期（2026/02/31）＝當成讀不到，不可拿去比新舊（r1#3）
    }
  }
  return null;
}

/** 抬頭那句「(存款帳號**********8791)」裡的遮罩帳號。讀不到回 ''。
 * ⚠️ **照抄原樣**（含前面那串星號）：它會進去重鍵，改寫形狀＝同一份帳單重匯時認不出重複。
 * @param {BLine[]} lines */
function pickMaskedAccount(lines) {
  for (const l of lines) {
    const t = squash(l.cells.map((c) => c.s).join(''));
    const m = t.match(/存款帳號\s*([*＊]*\d[\d*＊]*)/);
    if (m) return m[1];
  }
  return '';
}

/** 遮罩帳號的末尾可見數字（本檔自用：帳號可能整串前綴都是星號，`bank-statement.js` 的
 * `accountSuffix` 對 `**********8791` 也取得到，這裡直接沿用它的判準、不另立第二把尺）。
 * @param {string} masked */
function suffixOf(masked) {
  const m = String(masked || '').match(/[*＊]+\s*(\d+)\s*$/);
  return m ? m[1] : '';
}

/**
 * 解析 D 區（帳戶往來明細）。
 *
 * **欄位定位＝表頭 x 當邊界、值取右緣**：金額欄是右對齊的（同綜合對帳單的既有課題），
 * 用左緣會因為金額長短飄移而翻面；用「值的右緣落在哪兩個表頭之間」才穩：
 *   支出：右緣 ≤ 表頭「存入」的 x
 *   存入：右緣 ≤ 表頭「餘額」的 x
 *   餘額：右緣 > 表頭「餘額」的 x，**且是這一段裡第一個讀得出金額的格**
 *         （備註也落在這一段，所以用「讀不讀得出金額」分辨，不用備註欄的 x——真版面的備註
 *          `榮先生` 右緣 399 比備註表頭 415 還小，拿表頭當界線反而會把它誤判成餘額）
 * ⚠️ 餘額格常把備註黏在同一格（`269,323 822CCA4B27 202601122510`）＝共用 `splitAmount` 拆開，
 *    數字進餘額、剩下的字進備註。這正是真檔實測時「餘額鏈 4 對接不上」的唯一原因。
 *
 * @param {BLine[]} lines
 * @returns {{ transactions: BankTx[], skippedZero: number, sawHeader: boolean }}
 */
export function parseTaishinDebitDetail(lines) {
  /** @type {(BankTx & {y:number})[]} */
  const rows = [];
  /** @type {{y:number, t:string}[]} 跨行的備註（見下方 ORPHAN_MAX_DY） */
  const orphans = [];
  let xOut = 0, xIn = 0, xBal = 0, inDetail = false, skippedZero = 0, sawHeader = false;
  /** 上一列若是表頭碎片就留在這裡，等下一列來湊（Stage 3）；任何不是碎片的列都會把它清掉＝只看**相鄰**兩列。 */
  /** @type {{y:number, cells:BLine['cells']}|null} */ let pendingFrag = null;
  // 碎片合併只當**退路**：整份有任何一列整列表頭＝版面沒被拆、走整列那條（合併的信任面比整列大——
  //   Codex #498 r2#1 的版面：A 區兩列湊出六欄、其後才是真表頭，整列判準會等到真表頭、合併會提早開閘）。
  //   整份連一列整列表頭都沒有時，不合併本來就是整份認不得；合併只在那種帳單上多冒險，不在別的帳單上冒險。
  const mergeAllowed = !lines.some(isDetailHeader);

  /** 用一組表頭格定位三個欄位的 x（整列表頭與兩列合併的表頭共用同一套，不另立第二把尺）。
   * 跨頁會重印表頭＝每次都重新定位（版面微調不必改程式）。 @param {BLine['cells']} headCells */
  const locate = (headCells) => {
    const at = (/** @type {string} */ name) => {
      const c = headCells.find((x) => String(x.s).trim() === name);
      return c ? c.x : 0;
    };
    xOut = at('支出'); xIn = at('存入'); xBal = at('餘額');   // 備註欄不必定位：餘額右邊那一段裡，「讀得出金額的那一格」就是餘額，其餘是備註
    sawHeader = true; inDetail = true; pendingFrag = null;
  };

  for (const line of lines) {
    if (isDetailHeader(line)) { locate(line.cells); continue; }
    // 抽字有時把六欄表頭**拆成相鄰兩列**（#492 r1#1 實測）：相鄰兩列都是純碎片、y 夠近、合起來六欄到齊
    //   且 x 順序對 ⇒ 當成一列表頭（定位與整列表頭同一套）。條件缺一＝**不當表頭**：
    //   ・還沒定位到任何表頭 ⇒ 走到最後仍 sawHeader=false ⇒ 整份 bank_unrecognized（退回 AI，不猜界線）；
    //   ・已在明細裡（跨頁重印被拆開卻湊不齊）⇒ 這幾列就是「不是交易列」，明細照上一個表頭的欄界續讀
    //     ——與整列表頭時代「第二頁表頭認不得」的行為相同，不新增 fail-closed（真版面跨頁欄界相同、續讀是對的）。
    //   碎片列本身不進跨行備註歸位（它只含欄名、不是備註）。整份有整列表頭時碎片判定整個關閉（mergeAllowed）。
    const frag = mergeAllowed ? headFragment(line) : null;
    if (frag) {
      if (pendingFrag && Math.abs(pendingFrag.y - line.y) <= HEADER_SPLIT_MAX_DY) {
        const merged = [...pendingFrag.cells, ...line.cells];
        if (isDetailHeaderCells(merged)) { locate(merged); continue; }
      }
      pendingFrag = { y: line.y, cells: line.cells };   // 留著等下一列（湊不齊就留這一列、換成最新的碎片）
      continue;
    }
    pendingFrag = null;
    if (!inDetail) continue;   // ⚠️ A/B/C 三區都印在表頭之前——這一行就是「錢不被算兩次」的界線

    const cells = [...line.cells].sort((a, b) => a.x - b.x);

    const date = String(cells[0]?.s || '').trim();
    const m = date.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (m && !isRealDate(`${m[1]}-${m[2]}-${m[3]}`)) {
      // ⚠️ 只驗長相不夠（r1#3）：`2026/02/31` 長得像日期、卻不是真日曆日。放它過去＝一路到
      //   寫入櫃檯才變成程式錯誤（使用者看到的是看不懂的訊息、也沒有 AI 救援入口）。
      //   這種列代表我們的欄位定位讀錯了，照實喊認不得。
      throw Object.assign(new Error('簽帳金融卡明細有一列的日期不是真日曆日（帳單版面可能與預期不同，請回報）'),
        { status: 400, code: 'bank_unrecognized' });
    }
    if (!m) {
      // ⚠️ **離場錨點只看非交易列**（Codex #492 r4#1：合法交易的摘要／備註若含錨點字樣，
      //    裸字串判定會把那一筆連同**後面全部**截掉，而截斷後的前綴餘額鏈仍自洽＝閘看不到）。
      //    日期起頭的列永遠不進這裡＝交易列免疫。A/B/C 若被重印在明細之後，它們的標題列
      //    不以日期起頭，一樣攔得到。
      const joined = squash(cells.map((c) => c.s).join(''));
      // A 區表頭＝**同列合取**（「外幣折換日」＋「扣款日／消費日」——r4#1：單一裸字樣會誤傷
      //   跨行備註；同列同時出現兩個欄名的只有表頭本身）；「卡號末四碼」＝A 區第二道；
      //   B/C＝各自的標題字樣。
      if (/已消費未扣款|消費支出類別|本月消費金額共計|本月退款金額共計|卡號末四碼/.test(joined)
        || (/外幣折換日/.test(joined) && /扣款日|消費日/.test(joined))) { inDetail = false; continue; }
      // 不是交易列＝說明文字或**跨行的備註**。備註格會換行（真檔實測：店名 `ｍｏｍｏ＊買買奇
      // ＭｙＭａｒｋ`＋`ｅ` 分兩行、轉帳的 `養育費`＋`RICHA` 也是），而備註是分類與內轉判定
      // 的依據，**丟掉會讓百萬元的帳戶互轉被判成收支**。落在備註欄帶的就留起來稍後歸位。
      if (xBal && cells.length && cells.every((c) => c.x > xBal)) {
        orphans.push({ y: line.y, t: squash(cells.map((c) => c.s).join(' ')) });
      }
      continue;
    }

    const right = (/** @type {any} */ c) => c.x + (c.w || 0);
    /** @type {any[]} */ const after = cells.slice(1);
    const summary = squash(after.filter((c) => right(c) <= xOut).map((c) => c.s).join(''));
    const out = after.find((c) => right(c) > xOut && right(c) <= xIn);
    const inn = after.find((c) => right(c) > xIn && right(c) <= xBal);
    const tail = after.filter((c) => right(c) > xBal);
    // ⚠️ 餘額要**與備註之間有空白**才算數：`splitAmount` 的數字部分是貪婪的，
    //    `317,491822CCA4B27` 會被讀成 317491822（憑空多出三位數、還會讓餘額鏈報一個假的不一致）。
    //    分不出來就記成「讀不到餘額」（null）＝那一對跳過，比塞一個假數字誠實。
    const balCell = tail.find((c) => /^\$?[\d,]+(\.\d+)?(\s|$)/.test(String(c.s).trim()));
    const split = balCell ? splitAmount({ ...balCell, s: String(balCell.s) }) : null;
    const notes = tail.filter((c) => c !== balCell).map((c) => String(c.s).trim());
    if (split && split.rest) notes.unshift(split.rest);   // 黏在餘額格後面的備註

    // ⚠️ **「讀不到」不可折疊成 0**（Codex #492 r2#1 探針實測）：格子缺失或內容不是數字＝
    //    我們的欄位定位讀錯了；折疊成 0 會讓整份走「兩欄都 0＝跳過」→ 交易 0 筆、對帳閘
    //    weak/ok、apply 回 imported:0 還發 batchId ＝**靜靜匯入 0 筆回報成功**——正好繞過
    //    「認得版面卻收不到東西要丟錯」那道 fail-closed。真數字 0 才是 0（真檔每一列的
    //    支出與存入兩欄都印出數字、沒往來的那一欄印 0）。
    const outAmt = out ? parseAmount(String(out.s)) : null;
    const inAmt = inn ? parseAmount(String(inn.s)) : null;
    if (outAmt == null || inAmt == null) {
      throw Object.assign(new Error('簽帳金融卡明細有一列的支出或存入欄讀不出數字（帳單版面可能與預期不同，請回報）'),
        { status: 400, code: 'bank_unrecognized' });
    }
    if (outAmt && inAmt) {
      // 支出與存入同時有數字＝這一列的方向讀不出來。**不可挑一個**（挑錯＝收入被記成支出）——
      // 照實喊認不得，讓使用者走 AI 那條路。真檔沒有這種列，這是 fail-closed 的縱深。
      throw Object.assign(new Error('簽帳金融卡明細有一列同時填了支出與存入，方向判不出來（請回報這份帳單）'),
        { status: 400, code: 'bank_unrecognized' });
    }
    if (!outAmt && !inAmt) { skippedZero++; continue; }   // 兩欄都 0＝沒有金流（餘額也不會變，跳過不影響鏈）

    rows.push({
      y: line.y,
      acctSuffix: '', acctMasked: '',                     // 由 parseTaishinDebit 統一填（整份只有一個帳戶）
      date: `${m[1]}-${m[2]}-${m[3]}`,
      direction: outAmt ? 'out' : 'in',
      amount: outAmt || inAmt,
      balance: split ? split.amt : null,
      summary,
      note: squash(notes.join(' ')),
    });
  }

  // 跨行備註歸位：黏到**y 最近**的那一筆（真檔量到的距離＝同一格的第二行約 4~5、
  // 隔壁交易列約 13~17，所以「最近的那一筆」分得開；超過上限就寧可留白、不亂黏）。
  for (const o of orphans) {
    let best = null, bestDy = Infinity;
    for (const r of rows) { const dy = Math.abs(r.y - o.y); if (dy < bestDy) { bestDy = dy; best = r; } }
    if (best && bestDy <= ORPHAN_MAX_DY_DEBIT) best.note = squash([best.note, o.t].filter(Boolean).join(' '));
  }
  const transactions = rows.map((r) => { const t = { ...r }; delete (/** @type {any} */ (t)).y; return /** @type {BankTx} */ (t); });   // y 只是歸位用的鷹架，不進資料

  return { transactions, skippedZero, sawHeader };
}

/**
 * A 區「刷卡消費明細」＝同一筆錢的**另一種印法**（William 2026-08-20 排定「一份帳單產出兩種明細」的地基）。
 * D 區把刷卡記成「刷卡消費／刷卡退貨」兩種摘要＝**錢的流向**（進現金流）；A 區每筆多了消費日、店名、
 * 消費地區＝**買了什麼**（給消費分析用的卡片帳本）。本函式只**讀出** A 區、不決定它怎麼入帳——入帳那半
 * 是另案裁決（同一筆錢兩區都出現，怎麼不算兩次）；這裡的契約只有「抄得對、抄不對就說」。
 *
 * 版面（真檔量到）：每一筆佔三列——店名列（y 高約 5）、主列（「扣款日 消費日」合在一格＋國外交易服務費＋
 * 台幣金額，金額右對齊、退款印負號）、消費地區列（y 低約 4）；相鄰兩筆的主列相距 13~17。店名與地區都落在
 * 「消費明細 / 消費地區」那一欄的 x 帶裡（表頭 x 到「外幣折換日」表頭 x 之間）＝靠 **x 帶＋y 距離**歸到
 * **最近的那一列主列**（每片只歸一筆；距離上限與 D 區跨行備註共用同一個量到的數字——相鄰兩筆的片段
 * 在半徑內會同時看得到兩筆，所以不可以「半徑內全收」，Codex #501 r1#1）。
 * 「卡號末四碼：NNNN」列＝之後的筆都屬這張卡（一份帳單可能多張卡、A 區跨頁會重印表頭）。
 * **抄不對就說**（一律丟 `bank_unrecognized`，不靜靜跳過）：主列的日期讀不出（長得像日期卻不是、或不是真日曆日）、
 * 台幣金額讀不出、還沒看到卡號就出現交易、看到「卡號末四碼」卻讀不出四碼。
 * ⚠️ 誠實劃界：外幣消費列（有外幣折換日／幣別／外幣金額的）**沒有真檔可量**——主列多出來的格一律
 *    原文收進 `extra`、不拆欄不猜語意；台幣金額仍取最右那一格。
 * @param {BLine[]} lines
 * @returns {{ rows: DebitCardRow[], sawHeader: boolean }}
 */
export function parseTaishinDebitCardRows(lines) {
  /** @type {(DebitCardRow & {y:number})[]} */ const rows = [];
  /** @type {{y:number, t:string}[]} */ const frags = [];
  let inA = false, sawHeader = false, lastFour = '', xDesc = 0, xFx = 0;
  const unrecognized = (/** @type {string} */ msg) => Object.assign(new Error(`簽帳金融卡的刷卡消費明細${msg}（帳單版面可能與預期不同，請回報）`), { status: 400, code: 'bank_unrecognized' });
  for (const line of lines) {
    const cells = [...line.cells].sort((a, b) => a.x - b.x);
    const joined = squash(cells.map((c) => c.s).join(''));
    // A 區表頭＝同列合取「扣款日」＋「消費日」，**且**定位得到「消費明細」與「外幣折換日」兩個欄名的 x。
    // 承重的是後面那道（C 區表頭也印「消費日」，但沒有那兩欄＝進不來）；前面的合取只是先篩。
    if (/扣款日/.test(joined) && /消費日/.test(joined)) {
      const at = (/** @type {RegExp} */ re) => { const c = cells.find((x) => re.test(squash(String(x.s)))); return c ? c.x : 0; };
      xDesc = at(/^消費明細/); xFx = at(/^外幣折換日/);
      if (!xDesc || !xFx) continue;   // 表頭長相不對＝不進 A 區（寧可讀不到，也不拿錯的 x 帶亂歸店名）
      inA = true; sawHeader = true; continue;
    }
    if (!inA) continue;
    // 離場：B 區（總額／類別表）、C 區（已消費未扣款）、D 區表頭（整列或被拆成碎片的那一列，同一個碎片判準）
    if (/本月消費金額共計|本月退款金額共計|消費支出類別|已消費未扣款/.test(joined) || headFragment(line)) { inA = false; continue; }   // headFragment＝每格都是 D 表頭欄名（整列表頭與拆開的碎片都算）
    if (/卡號末四碼/.test(joined)) {
      const m4 = joined.match(/卡號末四碼[:：]?(\d{4})(?!\d)/);
      if (!m4) throw unrecognized('有一列印著「卡號末四碼」卻讀不出四碼數字——之後的筆會掛錯卡');
      lastFour = m4[1]; continue;
    }
    const first = String(cells[0]?.s || '').trim();
    const second = String(cells[1]?.s || '').trim();
    // 主列＝「扣款日 消費日」合在一格、落在日期欄（x 在「消費明細」欄之前）；抽字偶爾會拆成兩格（各一個日期）＝
    //   兩格都要落在日期欄才收（第二格若落在別欄——例如外幣折換日——那是別的日期，不是消費日；Codex #501 r2#3）。
    const descLeft = xDesc - 12;   // 「消費明細」欄的左界（店名列左緣比表頭略左，真檔 208 vs 表頭 210）；日期欄＝這條線以左
    const inDateCols = (/** @type {any} */ c) => c && c.x < descLeft;
    const dateish = /^\d{4}\/\d{1,2}\//.test(first) && inDateCols(cells[0]);   // 長得像日期、又在日期欄＝主列候選（年份起頭的說明句不算，r2#4）
    let md = first.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})$/);
    let amtIdx = 1;
    if (md && !inDateCols(cells[0])) md = null;
    if (!md && /^\d{4}\/\d{2}\/\d{2}$/.test(first) && /^\d{4}\/\d{2}\/\d{2}$/.test(second) && inDateCols(cells[0]) && inDateCols(cells[1])) {
      md = `${first} ${second}`.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})$/); amtIdx = 2;
    }
    if (!md) {
      if (dateish) throw unrecognized('有一列以日期起頭、卻讀不成「扣款日 消費日」兩個日期');   // 抄不對就說，不可當成說明列跳過
      // 不是主列＝店名或消費地區的片段（只收落在「消費明細」欄 x 帶裡的；別欄的字不收，免把金額當店名）
      const right = (/** @type {any} */ c) => c.x + (c.w || 0);
      if (cells.length && cells.every((c) => c.x >= descLeft && right(c) <= xFx)) frags.push({ y: line.y, t: cells.map((c) => String(c.s).trim()).join(' ') });
      continue;
    }
    const postDate = `${md[1]}-${md[2]}-${md[3]}`, date = `${md[4]}-${md[5]}-${md[6]}`;
    if (!isRealDate(postDate) || !isRealDate(date)) throw unrecognized('有一列的日期不是真日曆日');
    if (!lastFour) throw unrecognized('還沒看到「卡號末四碼」就出現了消費列——不知道這筆屬於哪張卡');
    // 台幣金額＝最右那一格，且要落在「外幣折換日」欄之後（真版面右緣 469）；日期之後至少要有「服務費＋金額」兩格，
    //   只剩一格＝金額欄整格缺失、那一格是服務費（Codex #501 r2#2：缺金額格時 0 會被當成金額）。
    const amtCell = cells[cells.length - 1];
    const amount = (cells.length - amtIdx >= 2 && amtCell.x > xFx) ? parseAmount(String(amtCell.s)) : null;
    if (amount == null) throw unrecognized('有一列讀不出台幣金額');
    // 主列中間的格：台幣列只有一格＝「國外交易服務費」（真檔每列印 0）；多於一格＝外幣列（沒真檔可量）
    //   ＝原文收進 extra、不拆欄不猜語意。
    const mid = cells.slice(amtIdx, -1).map((c) => String(c.s).trim()).filter(Boolean);
    const fee = (mid.length === 1) ? parseAmount(mid[0]) : null;
    const extra = (mid.length === 1 && fee != null) ? '' : mid.join(' ');
    rows.push({ y: line.y, postDate, date, amount, fee, lastFour, desc: '', region: '', extra });
  }
  // 店名（主列上方）與消費地區（主列下方）歸位＝**照版面的順序走**，不是比距離：真版面每一筆的區塊由上而下是
  //   [店名列（可多行）][主列][地區列]，下一筆的店名接在上一筆的地區之後。所以由上而下掃：主列之後**緊接的第一片**
  //   （距離 ≤ 上限）＝這一筆的地區，其餘落在下一個主列之前的片段＝下一筆的店名（距離 ≤ 上限）。
  //   比距離會在換行店名（主列上 10 與 5）遇上前一筆的地區時搶錯（Codex #501 r2#1）；順序不會。
  //   ⚠️ 前提＝文字列不重疊（下一筆的店名一定印在上一筆的地區之下）——這是紙本版面的物理事實，不是程式能驗的。
  const items = [...rows.map((r) => ({ y: r.y, row: r, frag: null })), ...frags.map((f) => ({ y: f.y, row: null, frag: f }))].sort((a, b) => b.y - a.y);
  /** @type {(DebitCardRow & {y:number})|null} */ let lastRow = null;
  /** @type {{y:number, t:string}[]} */ let pendingDesc = [];
  for (const it of items) {
    if (it.row) {
      it.row.desc = pendingDesc.filter((f) => f.y - it.row.y <= ORPHAN_MAX_DY_DEBIT).map((f) => f.t).join(' ');   // 上方、夠近的＝店名（由上而下）
      pendingDesc = []; lastRow = it.row; continue;
    }
    const f = /** @type {{y:number, t:string}} */ (it.frag);
    if (lastRow && !lastRow.region && lastRow.y - f.y <= ORPHAN_MAX_DY_DEBIT) { lastRow.region = f.t; continue; }   // 主列之後緊接的第一片＝地區
    pendingDesc.push(f);
  }
  for (const r of rows) r.desc = r.desc.replace(/\s*\/\s*$/, '').trim();   // 欄名是「消費明細 / 消費地區」：店名尾端印著分隔用的「/」
  return { rows: rows.map((r) => ({ postDate: r.postDate, date: r.date, amount: r.amount, fee: r.fee, lastFour: r.lastFour, desc: r.desc, region: r.region.trim(), extra: r.extra })), sawHeader };   // y 只在歸位時用，不外流
}
/** @typedef {{ postDate:string, date:string, amount:number, fee:number|null, lastFour:string, desc:string, region:string, extra:string }} DebitCardRow
 *  postDate＝扣款日（＝D 區那一筆的日期）、date＝消費日、amount＝台幣金額（退款為負）、fee＝國外交易服務費
 *  （台幣列印 0；讀不出＝null）、desc＝店名原文、region＝消費地區原文、extra＝主列裡沒拆欄的其餘格（外幣列用；原文、不猜語意）。 */

/** D 區的哪些列是刷卡（摘要字樣）——A 區每一筆都對應其中一列。與 parseTaishinDebit 的分箱無關，純標記。 */
export const DEBIT_CARD_SUMMARIES = ['刷卡消費', '刷卡退貨'];

/**
 * 把 A 區的筆對到 D 區的列（純函式；只產對照表，不改任何一邊）。
 * 對法＝**扣款日＋方向＋金額**一對一；店名刻意**不**進對法（A 區是店名原文、D 區備註是截短版＋授權碼，字面不穩）。
 * ⚠️ 同鍵多筆（同日、同方向、同額）＝**群組層級**才對得上：兩區各自的列印順序是否一致沒有真檔證據，所以那幾對
 *    一律標 `ambiguous:true`——下游只能拿它做「這一群對得上」的結論（去重、計數），**不可拿它搬店名到某一筆**
 *    （Codex #501 r1#5）。
 * @param {DebitCardRow[]} cardRows @param {BankTx[]} transactions
 * @returns {{ pairs: {card:number, tx:number, ambiguous:boolean}[], unmatchedCards: number[], unmatchedTxs: number[] }} 三者都是索引
 */
export function linkDebitCardRows(cardRows, transactions) {
  const keyOfTx = (/** @type {BankTx} */ t) => `${t.date}|${t.direction}|${t.amount}`;
  const keyOfCard = (/** @type {DebitCardRow} */ r) => `${r.postDate}|${r.amount < 0 ? 'in' : 'out'}|${Math.abs(r.amount)}`;
  /** @type {Map<string, number[]>} */ const pool = new Map();
  transactions.forEach((t, i) => {
    if (!DEBIT_CARD_SUMMARIES.includes(t.summary)) return;
    const k = keyOfTx(t);
    const g = pool.get(k) || []; g.push(i); pool.set(k, g);
  });
  /** @type {Map<string, number>} */ const txCount = new Map([...pool].map(([k, g]) => [k, g.length]));
  /** @type {Map<string, number>} */ const cardCount = new Map();
  for (const r of cardRows) { const k = keyOfCard(r); cardCount.set(k, (cardCount.get(k) || 0) + 1); }
  /** @type {{card:number, tx:number, ambiguous:boolean}[]} */ const pairs = [];
  /** @type {number[]} */ const unmatchedCards = [];
  cardRows.forEach((r, i) => {
    const k = keyOfCard(r);
    const g = pool.get(k);
    const tx = g && g.length ? g.shift() : undefined;
    if (tx === undefined) { unmatchedCards.push(i); return; }
    pairs.push({ card: i, tx, ambiguous: (cardCount.get(k) || 0) > 1 || (txCount.get(k) || 0) > 1 });   // 同鍵多筆＝群組層級才對得上
  });
  const unmatchedTxs = [...pool.values()].flat().sort((a, b) => a - b);
  return { pairs, unmatchedCards, unmatchedTxs };
}

/**
 * 主入口：抽好的文字列 → 與綜合對帳單**同形狀**的解析結果（下游一行不必改）。
 * 帳戶只有一個、幣別台幣、期末餘額＝明細最後一列的餘額。
 * @param {BLine[]} lines
 * @returns {{ bank:'台新', referenceDate:string|null,
 *   accounts:{suffix:string,masked:string,balance:number,currency:'TWD',label:string,note:string,kind:'demand',period:string,suffixOnly:true,balanceFromDetail:true}[],
 *   accountCurrency:Record<string,string>, transactions:BankTx[] }}
 */
export function parseTaishinDebit(lines) {
  const masked = pickMaskedAccount(lines);
  const suffix = suffixOf(masked);
  if (!masked || !suffix) {
    // 認得版面卻讀不到帳號＝**不可猜**：帳號是去重鍵與帳戶配對的依據，猜錯會把錢記到別的帳戶。
    throw Object.assign(new Error('讀不到簽帳金融卡明細的存款帳號（帳單版面可能與預期不同，請回報）'),
      { status: 400, code: 'bank_unrecognized' });
  }
  const { transactions, skippedZero, sawHeader } = parseTaishinDebitDetail(lines);
  // ⚠️ **認得版面卻收不到東西＝不可以回報成功**（靜靜匯入 0 筆比擋下來更糟：使用者以為匯進去了）。
  //   兩種都要擋，而且**判準不同**（Codex #492 r1#1 抓到只擋了後者）：
  //   ①**根本沒定位到表頭**——辨識用的是整份文字、定位用的是單一列或相鄰兩列的碎片合起來；
  //     拆成三列、隔太遠、湊不齊六欄、x 順序不對時前者說認得、後者找不到 ⇒ 迴圈一列都沒進去。
  //   ②定位到了，但一列交易都讀不出來。
  //   兩者都丟既有的 bank_unrecognized＝退回 AI 救援那條路，不新增第二種錯誤碼。
  if (!sawHeader) {
    throw Object.assign(new Error('認得這是簽帳金融卡明細，卻定位不到「日期／摘要／支出／存入／餘額／備註」那一列表頭（整列或相鄰兩列合起來看都不成立；帳單版面可能與預期不同，請回報）'),
      { status: 400, code: 'bank_unrecognized' });
  }
  if (!transactions.length && !skippedZero) {
    throw Object.assign(new Error('讀得到簽帳金融卡明細的表頭，卻一列交易都讀不出來（帳單版面可能與預期不同，請回報）'),
      { status: 400, code: 'bank_unrecognized' });
  }
  for (const t of transactions) { t.acctMasked = masked; t.acctSuffix = suffix; }

  // 帳戶（Stage 1，William 2026-08-20 拍板三情境）：這條路**要**建戶與更新餘額——
  //   ①先匯金融卡＝建「台新 8791」，帳號只記末四碼、**蓋 suffixOnly 標記**（帳號身分不完整）
  //   ②日後匯綜合對帳單＝憑標記認出同一顆、把帳號補登成完整遮罩（matchAccount 的寬鬆徑）
  //   ③先綜合後金融卡＝末碼直接配得到（既有嚴格徑），帳號不動。
  //   ⚠️ #492 初版「刻意不產 accounts」的兩個理由，如今各有去處：裂戶＝改由 suffixOnly 標記＋
  //   唯一命中判準處理（lib/services/bank-import.js matchAccount）；「末筆對概要自證」＝
  //   `balanceFromDetail` 旗標讓對帳閘誠實跳過那一對（statement-reconcile.js），不灌水。
  // 期末餘額＝**真正最後一列**的餘額。⚠️ 末列餘額讀不到＝**不報帳戶**（Codex #494 r1#2：
  //   reverse+find 會拿較早那列的 running balance 冒充期末——之後還有交易，那個數字已經過時，
  //   而對帳閘對這種列又刻意 skip 末筆對概要＝沒有任何檢查會抓到。同 statement-reconcile
  //   「不可拿較早的餘額冒充末筆」那條既有裁決）。
  const last = transactions.length ? transactions[transactions.length - 1] : null;
  const accounts = (last && last.balance != null) ? [{
    suffix, masked, balance: /** @type {number} */ (last.balance), currency: /** @type {const} */ ('TWD'),
    label: '簽帳金融卡', note: '', kind: /** @type {const} */ ('demand'), period: '',   // 這個版面沒有定存列
    suffixOnly: /** @type {const} */ (true),          // 帳號只印得出末四碼（matchAccount 憑它走「唯一命中才配」的寬鬆徑）
    balanceFromDetail: /** @type {const} */ (true),   // 餘額出自明細末列＝沒有獨立概要可對，對帳閘的末筆對概要跳過（不自證）
  }] : [];
  return { bank: '台新', referenceDate: pickReferenceDate(lines), accounts,
    accountCurrency: { [masked]: 'TWD' }, transactions };
}

/**
 * 銀行對帳單主入口：概要區帳戶（stage 2）＋交易明細（stage 3）＋參考日。
 * @param {Uint8Array} data @param {string=} password
 * @returns {Promise<{ bank:'台新', referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string,kind:'demand'|'time',period:string}[], accountCurrency:Record<string,string>, transactions:BankTx[] }>}
 */
export async function parseBankStatement(data, password) {
  const lines = await extractPdfLines('bank', extractBankLines, data, password);
  // code: 'bank_unrecognized'＝「內建範本認不得這份版面」的機器判準（P1b-2 前端據它提供 AI 救援入口；
  // 判準與訊息分家的理由同 P0.5 的 pdf_password）。⚠️ 抽字失敗（extractPdfLines 的「PDF 無法開啟」）
  // **刻意不給 code**：AI 路線自己也要抽字、同樣開不了，給了入口＝使用者白按一次。
  // 版面分流（2026-08-20 新增第二個內建範本）：綜合對帳單那條**一個位元組都沒動**、仍是第一順位；
  // 認不出來才試簽帳金融卡明細；兩個都不認才丟 bank_unrecognized（前端據它給 AI 救援入口）。
  if (isBankStatement(lines)) {
    const { referenceDate, accounts, accountCurrency } = parseBankSummary(lines);
    const transactions = parseBankDetail(lines);
    return { bank: '台新', referenceDate, accounts, accountCurrency, transactions };
  }
  if (isTaishinDebitStatement(lines)) return parseTaishinDebit(lines);
  throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單，也不是簽帳金融卡消費明細'), { status: 400, code: 'bank_unrecognized' });
}
