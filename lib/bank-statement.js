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
  if (!isBankStatement(lines)) throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400, code: 'bank_unrecognized' });
  const { referenceDate, accounts, accountCurrency } = parseBankSummary(lines);
  const transactions = parseBankDetail(lines);
  return { bank: '台新', referenceDate, accounts, accountCurrency, transactions };
}
