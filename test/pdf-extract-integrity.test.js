// @ts-check
// PDF 座標抽取層與主入口接線考題（夜班稽核第四批C，2026-08-05；Codex r1 退回後重做）。
//
// 夜班稽核在這一片找到的病：
//
// 一、**契約說有考題、實際零考題**：銀行與證券的 PDF 座標抽取器
//    （`extractBankLines`／`extractSecuritiesLines`）。契約明文寫著「改 pdfjs 版本或抽取邏輯時
//    三份都要過各自的合成座標考題」，但夜班實測把這兩支的橫向座標全部改成 0（＝座標資訊全毀），
//    當時的 1487 題全綠：既有的解析考題（`test/bank-statement.test.js`／
//    `test/taishin-securities.test.js`）全部從**已經抽好的合成座標列**進場，
//    而既有兩支餵真 PDF 位元組的考題**都不斷言「抽出來的座標等於版面上的實際值」**：
//    `test/pdf-limits-wiring.test.js` 只看頁數上限與畸形檔的錯誤形狀；
//    `test/pdf-isolate.test.js` 看的是行程邊界與錯誤歸因——它其實也餵**銀行主入口**
//    （`test/pdf-isolate.test.js:162`，斷言 `code === 'pdf_timeout'`），
//    而它唯一比對抽取結果的那題（:181-186）比的是「跨行程前後一不一樣」，
//    兩邊一起把 x 歸零照樣相等，而且餵的是信用卡那支 `extractLinesForIsolation`。
//    座標是分欄的唯一依據：橫向決定「支出／存入」，縱向決定「換行備註歸哪一列」。
//    哪天升級 pdfjs，銀行與證券的匯入可能整片壞掉而測試不出聲。
//
// 二、**空包彈考題**（題目寫了保證、斷言只碰旁邊的零件）：
//    `test/taishin-securities.test.js` 兩題的名稱寫著「主入口據此 throw 400」，
//    但斷言只驗解析器回的旗標、沒驗主入口真的擋。
//    實務後果＝對帳單版面一變就靜靜匯入 0 筆、回你成功，使用者以為當月沒有交易。
//    **本檔補上主入口那一半**——精確範圍：`parseBankStatement` 與 `parseTaishinSecuritiesPdf`
//    在「抽取完成之後」自己丟的每一個 400（銀行 2 處：型別守衛／明細欄位位置；證券 4 處：
//    型別守衛／多月份／headerFound／stmtMonth），本檔每一處都有考題，而且每一題都有對應的突變驗過。
//    ⚠️ **組合條件的每一處各不只一題**（一個組合條件一題只釘得住一個角，剩下的角改一個字就全綠）：
//    銀行型別守衛＝`帳戶概要區` AND `往來明細|交易往來`，共 5 題（兩個標記都沒有／只缺其中一個 ×2／
//    **兩個分支各一份只命中它的完整對帳單、要放行且真的抽得出帳戶與交易** ×2，r4 加的）；
//    銀行明細欄位位置＝`!xOut || !xIn || !xBal`，共 4 題（三欄一起拆／三欄各單獨拆一次，r4 加的）；
//    證券型別守衛＝`證券` AND NOT `帳戶概要區` AND (`(成交|交易)明細` OR (`有價證券` AND `電子對帳單`)
//    OR `應收付金額`)，共 9 題（哪一段都不像／**三個 OR 分支各一份只命中它的完整對帳單、要放行且
//    真的抽得出成交與年月** ×4（`(成交|交易)明細` 內部還有兩個字樣）／必要標記與排除標記各一／
//    第二個分支內部的合取兩個角各一）。⚠️ **證券這一處是 r6 才補的**：r4 只修了銀行側，
//    檔頭卻寫成「銀行那兩處各不只一題」、誠實劃界也沒點名證券——同一個病型在隔壁放著沒修。
//    自審實測的三個一行改動（刪 `|| /應收付金額/`／刪 `|| (/有價證券/ && /電子對[帳賬]單/)`／
//    把 `if (!/證券/ || /帳戶概要區/)` 砍成只剩 `!/證券/`）當時全套 1507 題都照樣綠。
//    ⚠️ 抽取器**內部**丟的 400（PDF 密碼／加密、開檔失敗、頁數與節點上限）不在本檔：
//    頁數上限與畸形檔在 `test/pdf-limits-wiring.test.js`（三支抽取器都驗），
//    加密／密碼那條在 `test/pdf-isolate.test.js`（只對信用卡那支 `parseStatement` 驗；
//    銀行與證券的密碼分支是逐字重複的三胞胎之一，**沒有各自的考題**）。
//
// ⚠️ **r5 又被抓到兩個繞法**（Codex 審 `c2d7517` 那一輪；同樣是「fixture 剛好讓偷懶寫法也答對」）：
//    ⑥**`w` 可以用人造值頂替**：座標題的 fixture 全是同一個字級的 ASCII，斷言寫的又剛好是「字數 × 5」，
//      所以兩支抽取器的 `w` 一起改成 `5 * it.str.trim().length`（完全不讀 PDF 的字寬）全套考題照樣綠。
//      `w` 是右對齊金額判欄的依據（右緣＝x+w），真帳單的字級與字寬不會固定。⇒ 現在座標題讓**同一段文字
//      以兩種字級進場**（10pt 與 20pt，w 要翻倍）並多驗一格中文（字寬 1000，一個字 10pt 不是 5pt）；
//      主入口那邊各補**邊界案例**：銀行第 4 筆的金額右緣剛好跨在支出／存入分界上、證券的成交金額用小字級印。
//      ⚠️ **r6 修正**：上一版這裡寫「兩者都只有拿真實 `w` 才會落進正確的欄位」——**證券那一半查得出反例**。
//      證券 fixture 每一格金額的左緣本來就對齊自己那一欄的表頭 x，所以把 `lib/taishin-securities.js` 的
//      `pos = isAmt && cell.w ? cell.x + cell.w : cell.x` 整條退回左緣錨點 `pos = cell.x`（＝右緣規則
//      完全拿掉）全套 1507 題照樣綠；它當時只擋得掉「w 被放大」一種假值。⇒ 證券 fixture 現在**兩格併存**：
//      成交金額小字級（擋放大的 w）＋折讓金額的**左緣落在前一欄、右緣才落回自己這一欄**（擋右緣規則被拿掉）。
//      銀行那一半是真的（對照組實測：`lib/bank-statement.js` 的 `r = cell.w ? cell.x + cell.w : cell.x`
//      改成 `r = cell.x`，本檔 fail 3——第 4 筆左緣 355 在支出欄、右緣 405 才在存入欄）。
//    ⑦**銀行型別守衛的正向題鎖住了「空內容也算成功」**：舊版只丟三個標記進去、只斷言「主入口沒有錯」，
//      實際上它是成功回了**空結果**——日後把「抽不到任何帳戶與交易也放行」補成 fail-closed 反而會轉紅。
//      而且其他 fixture 寫的是「交易往來明細」，同時命中 `往來明細` 與 `交易往來` 兩個分支，
//      把判準砍成只認 `/交易往來/` 全套照樣綠。⇒ 現在改成**兩份完整有效的對帳單**
//      （只含 `往來明細` ／只含 `交易往來`，各自附 fixture 自檢），並斷言真的抽出帳戶與四筆交易。
//
// ⚠️ **r2 又交了兩顆假保證**（Codex 2026-08-05 第二次退回；同一種病換個位置長出來——
//    「斷言的文字寫著保證 X，但 fixture 剛好讓不做 X 的寫法也答對」）：
//    ④座標題只比對「值」不比對**順序**：fixture 三段本來就照 x 升冪寫進內容串流，於是兩支抽取器的
//      `cells.sort((a,b)=>a.x-b.x)` 可以整行刪掉而當時的 1499 題全綠，而那條斷言偏偏寫著「照版面順序排好」。
//      ⇒ 現在 `ROW` 與銀行明細列都**逆序（右→左）寫進內容串流**，排序才真的被撐著。
//    ⑤銀行成功題寫「換行備註靠 y 歸位」，但 fixture 的孤兒備註剛好貼在**最後一筆**旁邊，
//      「完全不看 y、一律黏最後一筆」照樣全綠。⇒ 現在多筆交易、三段孤兒備註：一段在自己那筆下方、
//      一段在自己那筆**上方**、一段離所有交易都太遠（不該黏），四種偷懶寫法答案全不同。
//
// ⚠️ **r1 自己也交了三顆空包彈**（Codex 2026-08-05 退回，逐條記下來因為都是同一種病）：
//    ①座標題只驗「互異、遞增」——Codex 把兩支抽取器改成完全忽略 PDF 座標、回傳人造
//      `x = 該列已收字數+1`／`y = -已收列數`，四題全綠。⇒ 現在改成**逐格比對 fixture 指定的
//      文字與 x/y 實際值**，再各走一次真實分欄（銀行的支出／存入、證券的雙層表頭 band）。
//    ②兩題主入口只跑拒絕面——把主入口改成「抽完一律 400」照樣全綠。⇒ 各補一份**有效 PDF 的
//      成功面**，斷言主入口真的解析成功並且欄位各就各位。
//    ③檔尾原本寫「中文要 CID 字型、這套 harness 打不到」——**那句話是錯的**。用同一種 Type1
//      Helvetica，只加 `/Encoding /Differences` 把字碼映到 `/uniXXXX` glyph 名，pdfjs 就抽得出
//      中文（它是照 glyph 名回推 Unicode 的）。⇒ 原本宣稱做不到的兩條接線（headerFound → 400、
//      多月份 → 400）這一版真的補上考題了。
//
// 手法：手工造**最小的合法 PDF**（沿用 `test/pdf-limits-wiring.test.js` 的 makePdf 思路並擴充成
// 「可指定每段文字的座標，且中英文都帶得動」），這樣不需要真實帳單（真 PDF 絕不進版控——
// 裡面是真的財務資料）。LOCAL 模式下 `extractPdfLines` 不繞子行程，所以直接呼叫主入口就是真實路徑。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractBankLines, parseBankStatement } = await import('../lib/bank-statement.js');
const { extractSecuritiesLines, parseTaishinSecuritiesPdf } = await import('../lib/taishin-securities.js');

// ─────────────────────────────────────────────────────────────────────────────
// 造 PDF：可指定座標、中英文都帶得動
// ─────────────────────────────────────────────────────────────────────────────

/** 字寬（千分之一 em）。自己宣告 `/Widths` 才能讓 fixture 的 x 與抽出來的 w 都是**可預測的整數**。 */
const ASCII_W = 500, CJK_W = 1000;
/** 預設字級。ASCII 一個字 5pt、中文一個字 10pt（字寬 × 字級 ÷ 1000）——fixture 的欄位間距都照這個算。 */
const FONT_SIZE = 10;
/** 大字級（＝預設的兩倍）。**每一段文字都可以自己指定字級**，這是「w 不能用人造值頂替」的關鍵：
 *  同一段文字換個字級，抽出來的 `w` 必須跟著變，`5 × 字數` 這種只看字數的假值就對不上了。 */
const FONT_SIZE_BIG = 20;
/** 小字級。同理，用在證券主入口的邊界案例（真實 w 比「字數 × 5」小，右緣才落得進正確的欄位）。 */
const FONT_SIZE_SMALL = 6;
/** 抽取器每翻一頁把 y 往下推的位移（`lib/bank-statement.js`／`lib/taishin-securities.js` 的 pageBase）。 */
const PAGE_SHIFT = 100_000;
/**
 * ⚠️ **MediaBox 要夠大**：pdfjs 會把**落在頁面框外的文字整段丟掉**，而且一聲不吭。
 *    第一版沿用 792pt 高，於是 y≥800 的列（表頭、概要區）全部人間蒸發，
 *    害我以為是中文字型的問題查了半天。造 fixture 時寧可把紙開大。
 */
const MEDIA_BOX = '[0 0 1000 1000]';

/**
 * 手工造一份最小的合法 PDF，內容是「指定座標的文字段」。
 *
 * 中文怎麼帶進去（Codex r1 示範，實測可行）：仍然是 Type1 Helvetica，但加一份
 * `/Encoding << /Differences [128 /uni8B49 …] >>`，把自訂字碼映到 `/uniXXXX` 這種 glyph 名。
 * pdfjs 抽字時是**照 glyph 名回推 Unicode**，所以不需要真的嵌入 CID 中文字型。
 * （畫面上當然畫不出中文字形——但我們要的只有「抽得出什麼字、在哪個座標」。）
 *
 * @param {{x:number,y:number,text:string,size?:number}[][]} pages 每頁一個陣列（`size` 省略＝預設字級）
 * @returns {Uint8Array}
 */
function makeTextPdf(pages) {
  /** @type {string[]} */
  const objs = [];
  // 物件配置：1 Catalog／2 Pages／3 Font／4+2i 內容串流／5+2i 頁
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`);
  /** @type {Map<string, number>} 非 ASCII 字元 → 自訂字碼（128 起） */
  const glyphs = new Map();
  let next = 0x80;
  for (const segs of pages) for (const s of segs) for (const ch of s.text) {
    if ((ch.codePointAt(0) || 0) > 0x7e && !glyphs.has(ch)) glyphs.set(ch, next++);
  }
  assert.ok(next <= 0x100, `這份 fixture 用到 ${glyphs.size} 個非 ASCII 字元，超過單位元組字碼的容量`);
  const diffs = [...glyphs.entries()]
    .map(([ch, code]) => `${code} /uni${(ch.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
  const lastCode = next - 1;
  /** @type {number[]} */
  const widths = [];
  for (let c = 32; c <= lastCode; c++) widths.push(c >= 0x80 ? CJK_W : ASCII_W);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica'
    + (diffs ? ` /Encoding << /Type /Encoding /Differences [${diffs}] >>` : '')
    + ` /FirstChar 32 /LastChar ${lastCode} /Widths [${widths.join(' ')}] >>`;
  /** 一律用八進位跳脫：`(` `)` `\` 之類的字元就不必個別處理。 @param {string} t */
  const enc = (t) => [...t]
    .map(ch => '\\' + (glyphs.get(ch) ?? (ch.codePointAt(0) || 0)).toString(8).padStart(3, '0'))
    .join('');
  pages.forEach((segs, i) => {
    const body = segs.map(s => `BT /F1 ${s.size || FONT_SIZE} Tf ${s.x} ${s.y} Td (${enc(s.text)}) Tj ET`).join('\n');
    objs[4 + i * 2] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox ${MEDIA_BOX} `
      + `/Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
  });
  let out = '%PDF-1.4\n';
  /** @type {number[]} */
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    if (!objs[i]) continue;
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    out += objs[i] ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 造一段文字（`size` 省略＝`FONT_SIZE`）。 @param {number} x @param {number} y @param {string} text @param {number=} size */
const S = (x, y, text, size) => ({ x, y, text, size });

/** fixture 指定的三個欄位 x（下面的座標題會**逐格比對這三個數字**）。 */
const ROW_X = /** @type {const} */ ([50, 200, 400]);
/**
 * 一列三段文字，落在 ROW_X 三個欄位（模擬「帳號｜日期｜金額」那種表格列）。
 *
 * ⚠️ **內容串流刻意寫成右→中→左（x 遞減）**：這是為了讓「抽取器有沒有依 x 排序」變成可測的。
 * r2 版的 fixture 是照 x 升冪寫進去的，於是抽取器那句 `cells.sort((a,b)=>a.x-b.x)` 可以整行刪掉
 * 而全部考題照樣綠（Codex r2 實測 1499/1499）——排序題卻寫著「照版面順序排好」＝假保證。
 * 真帳單的右對齊金額在內容串流裡後畫是很常見的版面，沒有排序的話 `parseBankDetail` 的
 * `c[0]=遮罩帳號`／`c[1]=日期` 位置判準就整片對不上，而且**不報錯**、靜靜抽出 0 筆。
 * 逆序寫進去、再斷言抽出來是 x 升冪，那行 sort 才真的被考題撐著。
 *
 * @param {number} y @param {string} a @param {string} b @param {string} c @param {number=} size
 */
const ROW = (y, a, b, c, size) => [S(ROW_X[2], y, c, size), S(ROW_X[1], y, b, size), S(ROW_X[0], y, a, size)];

// ─────────────────────────────────────────────────────────────────────────────
// 一、座標真的被抽出來（橫向分欄、縱向歸列的唯一依據）
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, extract] of /** @type {const} */ ([
  ['銀行對帳單', extractBankLines],
  ['證券對帳單', extractSecuritiesLines],
])) {
  test(`${name}抽取器｜文字與 x／w 必須逐格等於 fixture 指定的值（含**兩種字級與中文**），且**照 x 升冪重排**`, async () => {
    // ⚠️ r1 版只驗「互異且遞增」，Codex 用「x＝該列已收字數+1」的人造遞增值就繞過去了。
    //    所以這裡改成**比對實際數字**：文字 ['AAA','BBBB','CC']、x [50,200,400]、
    //    w [15,20,10]（ASCII 一個字 5pt）。Codex 那種「第幾個字」的人造數列同時對不上這三組。
    // ⚠️ r2 版又漏了排序：fixture 本來就照 x 升冪寫進內容串流，抽取器把 sort 整行刪掉照樣全綠。
    //    現在 `ROW` **逆序（右→中→左）**寫進去，下面三條斷言就同時把「值」與「順序」釘住了。
    // ⚠️ r5 版的 w 還是可以用人造值頂替：整份 fixture 同一個字級、又全是 ASCII，
    //    於是「w ＝ 字數 × 5」這種完全不讀 PDF 的假值剛好每一格都對。**這一版讓同一段文字
    //    以兩種字級進場**（第 2 列字級 20 → w 要翻倍）**外加一格中文**（字寬 1000，一個字 10pt），
    //    只看字數的假值在這兩處同時對不上。
    const pdf = makeTextPdf([[
      ...ROW(700, 'AAA', 'BBBB', 'CC'),                    // 字級 10 → w＝字數 × 5
      ...ROW(650, 'AAA', 'BBBB', 'CC', FONT_SIZE_BIG),     // **同樣的文字**、字級 20 → w＝字數 × 10
      S(50, 600, '存入金額'),                               // 中文：字寬 1000 → 字級 10 下 4 個字 40pt
    ]]);
    const lines = await extract(pdf, undefined);
    assert.equal(lines.length, 3, `應該抽出三列（實際 ${JSON.stringify(lines).slice(0, 400)}）`);
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.y), [700, 650, 600],
      'y 要等於 fixture 指定的值、且由上而下');
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.s)),
      [['AAA', 'BBBB', 'CC'], ['AAA', 'BBBB', 'CC'], ['存入金額']],
      '每一格的文字要照版面順序（x 升冪）排好——前兩列是**逆序**寫進內容串流的（右→中→左），'
      + '抽取器少了依 x 排序就會回 [CC, BBBB, AAA]');
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.x)),
      [[50, 200, 400], [50, 200, 400], [50]],
      `x 要等於 fixture 指定的 ${JSON.stringify([...ROW_X])}**而且是升冪**——`
      + '座標一旦被換成人造值（歸零、或「第幾個字」這種遞增數列），或是照內容串流原序不重排，'
      + '支出／存入分欄、支票欄排除、`c[0]=帳號 c[1]=日期` 的位置判準就整片失效（而且不報錯）');
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.w)),
      [[15, 20, 10], [30, 40, 20], [40]],
      'w 要是**PDF 裡真正的字寬**（字寬 × 字級 ÷ 1000），不是任何一組只看字數的人造值：'
      + '第 1 列與第 2 列是同樣的三段文字、只差字級（10 → 20），w 必須整組翻倍；'
      + '中文那格字寬是 ASCII 的兩倍（4 個字 40pt 不是 20pt）。'
      + 'w 是右對齊金額判欄的依據（右緣 ＝ x + w），假的 w 會讓金額靜靜漂到隔壁欄');
  });

  test(`${name}抽取器｜跨頁的 y 必須是「頁內 y 減去每頁 ${PAGE_SHIFT} 的位移」`, async () => {
    // ⚠️ 縱向座標決定「孤兒備註黏到哪一筆交易」。兩頁都用同一個頁內 y=700，
    //    抽出來必須是 700 與 700-100000＝-99300；只驗「遞減」的話，人造的 -1、-2 也會過。
    const pdf = makeTextPdf([
      ROW(700, 'P1-A', 'P1-B', 'P1-C'),
      ROW(700, 'P2-A', 'P2-B', 'P2-C'),   // 第 2 頁刻意用同一個頁內 y
    ]);
    const lines = await extract(pdf, undefined);
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.y), [700, 700 - PAGE_SHIFT],
      '跨頁 y 要是實際頁內 y 加上頁位移（第 2 頁 → -99300），不是任何一組「只要遞減就好」的數字');
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.s)),
      [['P1-A', 'P1-B', 'P1-C'], ['P2-A', 'P2-B', 'P2-C']],
      '兩頁的文字不可交叉或遺失，而且各自照 x 升冪重排（fixture 兩頁都是逆序寫進內容串流的）');
    assert.deepEqual(lines.map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.x)),
      [[50, 200, 400], [50, 200, 400]], '兩頁的 x 都要照 fixture，而且都是升冪');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、主入口的成功面：有效 PDF 進去 → 真的解析出來，而且**分欄是靠座標分的**
//    （這一節同時是 Codex r1 要求的「證明主入口不是一律拒絕」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一份合法的台新綜合對帳單 fixture（概要區＋明細；金額右對齊、備註換行到相鄰列）。
 *
 * ⚠️ **三個地方是刻意「做成不好過」的**，因為前幾版三者都被實際繞法穿過：
 *
 * ①**明細的每一列都逆序（x 遞減）寫進內容串流**。真帳單的右對齊金額／備註在內容串流裡後畫很常見，
 *   而 `parseBankDetail` 靠 `c[0]=遮罩帳號`／`c[1]=日期` 的位置判準認交易列——抽取器少了依 x 排序，
 *   `c[0]` 會變成備註或餘額格，整張帳單靜靜抽出 0 筆。r2 版是照 x 升冪寫的，於是兩支抽取器的
 *   `cells.sort((a,b)=>a.x-b.x)` 可以一起刪掉而當時的 1499 題全綠。
 *
 * ②**四筆交易、三段孤兒備註**：A 在它那筆（第 2 筆）的**下方**、B 在它那筆（第 3 筆）的**上方**
 *   （`lib/bank-statement.js` 檔頭自己註明備註可能印在交易列上方）、C 離所有交易列都太遠（一筆都不該黏）。
 *   r2 版只有兩筆、孤兒備註剛好貼著最後一筆，所以「完全不看 y、一律黏到最後一筆」的寫法照樣全綠；
 *   這一版 A 與 B 歸的都**不是**最後一筆（最後一筆是第 4 筆），那種寫法兩處都會答錯。
 *   y 距離是承重的：黏錯的話
 *   第 5 筆的「劃撥」會跑到第 30 筆，正是 `lib/bank-statement.js` 那句「漏收會把百萬劃撥誤當收入」。
 *   A、B 到「自己那筆」的 y 距離都是 10、到相鄰交易列都 ≥50（＞`ORPHAN_MAX_DY`＝40），
 *   所以「靠 y 最近」與「靠列序（第一筆／最後一筆／前一列／後一列）」四種寫法在這份 fixture 上答案全不同。
 *
 * ③**第 4 筆是「只有真實字寬 `w` 才判得對」的邊界案例**（Codex 審 `c2d7517` 那一輪的繞法：
 *   把兩支抽取器的 `w` 都換成 `5 * it.str.trim().length`，完全不讀 PDF 的字寬，全套考題照樣綠）。
 *   它的金額用**字級 20** 印（`w` 是預設字級的兩倍），左緣刻意擺在支出欄裡：
 *   真實 `w`＝50 → 右緣 405 落在存入欄 [400,500)；假的「字數 × 5」＝25 → 右緣 380 落回支出欄 [300,400)。
 *   它同時是**自己那個帳戶的唯一一列**，所以 running 餘額校正救不回來——方向錯就是錯。
 *
 * @param {{splitHeader?: ''|'支出金額'|'存入金額'|'帳戶餘額', detailMarker?: string}} [opts]
 *   - `splitHeader`：把明細表頭的**其中一欄**逐字拆成獨立的格（其餘一律完整），用來單獨打掉那一欄的 x。
 *     `''`＝成功面（全部完整）。拆開的字距 20pt（中文一個字 10pt），所以拆出來的四格
 *     仍然落在自己那一欄與下一欄之間，只有「哪一格**等於**完整欄名」這件事變了。
 *   - `detailMarker`：明細段落的標題字樣。`isBankStatement` 的第二個條件是 `往來明細|交易往來` 的**擇一**，
 *     預設值「交易往來明細」同時命中兩個分支——要單獨釘住某一個分支就傳只命中它的字樣。
 */
function bankStatementPdf({ splitHeader = '', detailMarker = '交易往來明細' } = {}) {
  /** 明細列：逆序（右→左）寫進內容串流，見上面 ①。 @param {{x:number,y:number,text:string,size?:number}[]} segs */
  const detailRow = (segs) => [...segs].sort((a, b) => b.x - a.x);
  /** 表頭一格：指定要拆的那一欄逐字拆開。 @param {number} x @param {string} name */
  const H = (x, name) => (name === splitHeader
    ? [...name].map((ch, i) => S(x + i * 20, 780, ch))
    : [S(x, 780, name)]);
  return makeTextPdf([[
    S(40, 900, '台新銀行綜合對帳單'),
    S(40, 880, '現值參考日：2026/01/31'),
    S(40, 860, '新臺幣帳戶概要區'),
    S(40, 845, '台幣活存'), S(200, 845, '900100****7788'), S(360, 845, '$100,000'),
    S(40, 830, '台幣活存'), S(200, 830, '900100****1122'), S(360, 830, '$50,000'),
    S(40, 820, '合計'),
    S(40, 800, detailMarker),
    // 明細表頭：欄位 x ＝ 支票號碼 200／支出金額 300／存入金額 400／帳戶餘額 500／備註 620
    ...H(200, '支票號碼'), ...H(300, '支出金額'), ...H(400, '存入金額'),
    ...H(500, '帳戶餘額'), ...H(620, '備註'),
    // 第 1 筆（y=760）：金額右緣 315+25=340 落在「支出」欄 [300,400) → out；備註在同列，不是孤兒
    ...detailRow([
      S(40, 760, '900100****7788'), S(140, 760, '2026/01/05'), S(240, 760, '轉帳'),
      S(315, 760, '1,234'), S(510, 760, '$98,766'), S(620, 760, '轉出'),
    ]),
    // 第 2 筆（y=700）：金額右緣 445+25=470 落在「存入」欄 [400,500) → in；備註換行到**下方**
    ...detailRow([
      S(40, 700, '900100****7788'), S(140, 700, '2026/01/07'), S(240, 700, '薪轉'),
      S(445, 700, '5,000'), S(510, 700, '$103,766'),
    ]),
    S(620, 690, '公司薪資'),   // 孤兒備註 A：離第 2 筆 10、離第 1 筆 70、離第 3 筆 50 → 只有第 2 筆收得到
    S(620, 650, '匯費'),       // 孤兒備註 B：印在第 3 筆**上方**，離第 3 筆 10、離第 2 筆 50
    // 第 3 筆（y=640）：金額右緣 325+15=340 落在「支出」欄 → out
    ...detailRow([
      S(40, 640, '900100****7788'), S(140, 640, '2026/01/20'), S(240, 640, '匯出'),
      S(325, 640, '300'), S(510, 640, '$103,466'),
    ]),
    // 第 4 筆（y=580）＝字寬邊界案例，見上面 ③：金額用字級 20 印在 x=355，
    // 真實 w=50 → 右緣 405 落在「存入」欄；假的「字數 × 5」=25 → 右緣 380 落回「支出」欄。
    // 它是帳戶 900100****1122 的唯一一列，沒有前一列餘額可以把方向校正回來。
    ...detailRow([
      S(40, 580, '900100****1122'), S(140, 580, '2026/01/25'), S(240, 580, '轉入'),
      S(355, 580, '2,468', FONT_SIZE_BIG), S(510, 580, '$50,000'),
    ]),
    S(620, 480, '本頁小計說明'),   // 孤兒備註 C：離最近的第 4 筆 100 ＞ ORPHAN_MAX_DY(40) → 一段都不該黏上去
  ]]);
}

/** 這份 fixture 抽出來的四筆交易（日期／方向／金額）——多處斷言共用。 */
const BANK_TXNS = /** @type {const} */ ([
  ['2026-01-05', 'out', 1234],
  ['2026-01-07', 'in', 5000],
  ['2026-01-20', 'out', 300],
  ['2026-01-25', 'in', 2468],
]);

test('銀行主入口｜有效 PDF → 成功解析（不是一律 400），而且支出／存入靠 x 分欄、換行備註靠 y（不是列序）歸位', async () => {
  // ⚠️ r1 只有拒絕面，Codex 把主入口改成「抽完一律回同一個 400」全綠。這一題是成功面：
  //    ①主入口真的回得來 ②概要區的餘額 ③**第 1 筆的方向只有 x 判得出來**
  //    （它是該帳戶第一列，沒有前一列餘額可以拿來校正）④備註跨列歸位。
  //    ⑤（r3 加的，補 r2 那兩顆假保證）明細列逆序進場＋孤兒備註 A 歸的是第 2 筆而不是最後一筆
  //      ——見 `bankStatementPdf` 的說明。
  const r = await parseBankStatement(bankStatementPdf(), undefined);
  assert.equal(r.bank, '台新');
  assert.equal(r.referenceDate, '2026-01-31', '概要區的現值參考日要讀得到');
  assert.deepEqual(r.accounts.map(a => [a.masked, a.balance, a.currency, a.label]),
    [['900100****7788', 100000, 'TWD', '台幣活存'], ['900100****1122', 50000, 'TWD', '台幣活存']],
    '概要區兩個帳戶（末碼／餘額／幣別／標籤）');
  assert.equal(r.transactions.length, 4,
    '明細要抽出四筆——列內少了依 x 排序的話 `c[0]` 會變成備註／餘額格，整張靜靜抽出 0 筆');
  const [t1, t2, t3] = r.transactions;
  assert.deepEqual([t1.date, t1.direction, t1.amount, t1.balance, t1.summary, t1.note],
    ['2026-01-05', 'out', 1234, 98766, '轉帳', '轉出'],
    '第 1 筆＝支出：方向只能由「金額右緣落在支出欄」判出來（該帳戶第一列沒有前值餘額可校正）；'
    + '備註在同列，不該被孤兒備註污染');
  assert.deepEqual([t2.date, t2.direction, t2.amount, t2.balance, t2.summary],
    ['2026-01-07', 'in', 5000, 103766, '薪轉'], '第 2 筆＝存入');
  assert.deepEqual([t3.date, t3.direction, t3.amount, t3.balance, t3.summary],
    ['2026-01-20', 'out', 300, 103466, '匯出'], '第 3 筆＝支出');
  assert.equal(t2.note, '公司薪資',
    '換行到**下一列**的備註要靠 y 距離歸回第 2 筆——它不是最後一筆，'
    + '所以「一律黏最後一筆」「黏第一筆」這種不看 y 的寫法在這裡會答錯（內轉／劃撥分箱全看備註）');
  assert.equal(t3.note, '匯費',
    '印在交易列**上方**的備註要歸回第 3 筆——「只往前找／只往後找」的寫法會答錯一段；'
    + '而且離最近交易列 100 的那段（本頁小計說明）不可以黏上來（y 距離上限拿掉就會多出這一段）');
});

test('銀行主入口｜金額右緣剛好跨在支出／存入分界上 → 只有 PDF 的**真實字寬**判得對方向', async () => {
  // ⚠️ 這一題釘的是 `w`（Codex 審 `c2d7517` 那一輪的繞法：兩支抽取器的 `w` 一起換成
  //    `5 * it.str.trim().length`，完全不讀 PDF 的字寬，全套考題照樣綠——因為當時每一格
  //    都剛好是同一個字級的 ASCII）。第 4 筆的金額是**字級 20** 印的：
  //      真實 w=50 → 右緣 355+50=405 → 落在存入欄 [400,500) → in（正確）
  //      假的字數 × 5 = 25 → 右緣 380 → 落回支出欄 [300,400) → out（**收入被記成支出**）
  //    而且它是帳戶 900100****1122 的唯一一列，`parseBankDetail` 的 running 餘額校正
  //    （同帳戶相鄰兩列餘額差）救不到它——錯了就一路錯進現金流帳本。
  const r = await parseBankStatement(bankStatementPdf(), undefined);
  assert.deepEqual(r.transactions.map(t => [t.date, t.direction, t.amount]), BANK_TXNS.map(t => [...t]),
    '四筆的日期／方向／金額都要對——第 4 筆（2026-01-25、2,468）的方向完全靠「x + w 這個右緣」'
    + '落在哪一欄判出來，w 一旦被人造值頂替（歸零、或只看字數）它就會從 in 翻成 out');
  const t4 = r.transactions[3];
  assert.equal(t4.acctMasked, '900100****1122', '第 4 筆屬於另一個帳戶（所以沒有前一列餘額可校正）');
  assert.equal(t4.balance, 50000);
  assert.equal(t4.note, '',
    '離它 100 的那段（本頁小計說明）超過 ORPHAN_MAX_DY(40)，不可以黏上來');
});

/**
 * 一份合法的台新證券對帳單 fixture（雙層表頭；一筆成交跨兩行）。
 *
 * ⚠️ **下層那一列有兩格是「只有拿真實 `w` 才判得對欄位」的邊界案例**，而且**兩格封的是不同的假值**
 *    （r6 補的第二格：r5 只有第一格，自審實測**查得出反例**——把 `lib/taishin-securities.js` 的
 *    `const pos = isAmt && cell.w ? cell.x + cell.w : cell.x` 整條退回左緣錨點 `const pos = cell.x`
 *    ＝右緣規則完全拿掉，全套考題照樣綠，因為當時每一格金額的**左緣本來就落在自己那一欄**）。
 *    `assignCols` 的 band 邊界＝下一欄表頭的左緣：成交金額 [240,300)／折讓 [300,360)／證交稅 [360,430)。
 *
 *    ①**成交金額用小字級印**（`FONT_SIZE_SMALL`，x=270）——封「w 被放大」：
 *        真實 w＝7 字 × 3pt ＝ 21 → 右緣 291 → 「成交金額」band ✔
 *        假的「字數 × 5」＝35     → 右緣 305 → 落進「折讓」band ✘
 *    ②**折讓金額的左緣落在前一欄**（預設字級，x=290、3 字 → w=15）——封「右緣規則被整條拿掉」：
 *        真實右緣 305 → 「折讓」band ✔（左緣 290 還在「成交金額」band 裡）
 *        不看 w（pos＝左緣 290）→ 落回「成交金額」band ✘
 *      這正是真對帳單的幾何：金額**右對齊**，左緣隨位數往左飄，飄過表頭左緣是常態。
 *
 *    **實測後果**（兩種假值各跑一次量的）：
 *      w ← `5 * it.str.trim().length`：`grossAmount` 變 `null`、`feeDiscount` 變 104000104
 *        （「104,000」與折讓那格被併成一格）；
 *      `pos` ← `cell.x`：`grossAmount` 變 104000104、`feeDiscount` 變 `null`。
 *      兩者都**不報錯**，只是金額全錯（成交金額漂進折讓、折讓漂成 null）。
 *
 * ⚠️ 三個**型別守衛的標記**可以換（`isSecuritiesStatement` 是四段組合條件，見下面那組單分支考題）：
 *    - `sectionTitle`：成交表的段落標題。預設「成交明細」命中 `(成交|交易)明細` 這個分支；
 *      真版面校準（`lib/taishin-securities.js:103-106`）說使用者 2026/03 真單**沒有**這四個字、
 *      標題是「上市／上櫃／興櫃」——所以要單獨釘別的分支時就傳「上市」。
 *    - `netHeader`：應收付欄的表頭字樣。預設「應收付金額」命中第三個分支；傳「淨收付金額」
 *      （`H_A` 的同義詞，解析結果一模一樣）就不命中。
 *    - `docTitle`：多印一行文件抬頭，用來命中「有價證券 ∧ 電子對帳單」那個分支。
 *
 * @param {{sectionTitle?:string, netHeader?:string, docTitle?:string}} [opts]
 */
function securitiesStatementPdf({ sectionTitle = '成交明細', netHeader = '應收付金額', docTitle = '' } = {}) {
  return makeTextPdf([[
    S(40, 900, '台新綜合證券'), S(300, 900, '115年1月'),
    S(40, 880, '帳號：9001-900100'),          // 明顯假值（合成測試不得用真實帳號）
    ...(docTitle ? [S(40, 870, docTitle)] : []),
    S(40, 860, sectionTitle),
    // 上層表頭（每筆第一行的欄名）
    S(40, 840, '成交日'), S(95, 840, '交割日'), S(150, 840, '證券代號'), S(240, 840, '數量'),
    S(300, 840, '成交價'), S(360, 840, '手續費'), S(430, 840, netHeader),
    // 下層表頭（每筆第二行的欄名）
    S(40, 830, '交易類別'), S(150, 830, '證券名稱'), S(240, 830, '成交金額'),
    S(300, 830, '折讓'), S(360, 830, '證交稅'), S(430, 830, '幣別'),
    // 一筆成交的第一行／第二行（應收付 104,044 ＝ 成交 104,000 ＋ 手續費 148 − 折讓 104；
    // 折讓 104 ＝ 手續費打三折後退回來的部分，數字彼此對得起來，不是隨手填的）
    S(40, 800, '115/01/13'), S(95, 800, '115/01/15'), S(150, 800, '0050'), S(240, 800, '1,000'),
    S(300, 800, '104.00'), S(360, 800, '148'), S(430, 800, '104,044'),
    S(40, 790, '現買'), S(150, 790, '元大台灣50'), S(270, 790, '104,000', FONT_SIZE_SMALL),
    S(290, 790, '104'),   // 折讓：左緣 290 在「成交金額」band、右緣 305 才落回「折讓」band（見上面 ②）
    S(360, 790, '0'), S(430, 790, 'TWD'),
  ]]);
}

test('證券主入口｜有效 PDF → 成功解析（不是一律 400），而且雙層表頭的欄位靠 x 各就各位', async () => {
  const r = await parseTaishinSecuritiesPdf(securitiesStatementPdf(), undefined);
  assert.equal(r.stmtMonth, '2026-01', '民國年月要換算成西元');
  assert.equal(r.accountRaw, '9001-900100');
  assert.equal(r.headerFound, true, '雙層表頭要真的建得起來');
  assert.equal(r.trades.length, 1, '跨兩行仍然只有一筆');
  const t = r.trades[0];
  // ⚠️ 每一個欄位都是「靠 x 落在哪個 band」分出來的——座標一被換成人造值，
  //    數量會漂進代號、手續費會黏進應收付（不是報錯，是**靜靜給你錯的金額**）。
  //    成交金額與折讓那兩格另外釘住 **w**（見 fixture 說明的①②，下面還有一題專門講它）。
  assert.deepEqual(
    [t.tradeDate, t.settlementDate, t.symbol, t.name, t.rawType,
      t.quantity, t.price, t.grossAmount, t.commission, t.tax, t.netSettlement, t.currency],
    ['2026-01-13', '2026-01-15', '0050', '元大台灣50', '現買',
      1000, 104, 104000, 148, 0, 104044, 'TWD']);
  assert.equal(t.feeDiscount, 104, '折讓欄要讀得到（它的左緣落在前一欄，右緣才落回自己這一欄）');
});

test('證券主入口｜金額的左緣飄進前一欄、右緣才落回自己這一欄 → 只有 PDF 的**真實字寬**判得對欄位', async () => {
  // ⚠️ 這一題釘的是 `lib/taishin-securities.js` 的 `assignCols` 那句
  //    `const pos = isAmt && cell.w ? cell.x + cell.w : cell.x`（註解自己標「自審高風險修正」的右緣規則）。
  //    r5 版的 fixture 擋不住「右緣規則被整條拿掉」：每一格金額的左緣本來就落在自己那一欄，
  //    退回 `const pos = cell.x` 全套考題照樣綠（自審實測 1507/1507）。
  //    真對帳單的金額是**右對齊**的：左緣隨位數往左飄、飄過表頭左緣是常態，右緣才是穩定的錨點
  //    （`assignCols` 的註解自己就寫著中線法會「手續費黏進應收付、名稱尾碼數字黏進成交金額」；
  //     真帳單上會錯成哪一欄取決於版面，本檔量得到的是下面這一份 fixture 的版本）。
  //  兩格的幾何（下層欄位左緣：成交金額 240／折讓 300／證交稅 360）：
  //    折讓「104」   x=290 w=15 → 右緣 305 ∈ [300,360) ✔；不看 w（pos=290）→ 落回成交金額欄 ✘
  //    成交金額「104,000」小字級 x=270 w=21 → 右緣 291 ∈ [240,300) ✔；假的「字數×5」=35 → 305 → 折讓欄 ✘
  //  **兩格併存才同時封住「不看 w」與「假的大 w」**（實測：前者 grossAmount 變 104000104、feeDiscount 變 null；
  //  後者 grossAmount 變 null、feeDiscount 變 104000104）。
  const r = await parseTaishinSecuritiesPdf(securitiesStatementPdf(), undefined);
  const t = r.trades[0];
  assert.deepEqual([t.grossAmount, t.feeDiscount], [104000, 104],
    '成交金額與折讓要各就各位：右緣規則一被拿掉（或 w 被人造值頂替），這兩格會併成一格、'
    + '另一格變 null——金額全錯而且完全不報錯');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、主入口的拒絕面：六條 fail-closed 接線
//    （銀行的兩條與證券的型別守衛都是**組合條件**，各拆成多題把每一個角釘住
//    ——見檔頭「組合條件的每一處各不只一題」）
// ─────────────────────────────────────────────────────────────────────────────

test('銀行主入口｜不是台新綜合對帳單的 PDF → 明確 400，不可靜靜回 0 筆', async () => {
  // ⚠️ 守衛拿掉之後，把信用卡帳單餵進銀行端點不再明確拒絕，而是靜靜解析出 0 筆或錯誤分欄的
  //    結果——使用者以為匯進去了。
  const notBank = makeTextPdf([[
    S(50, 700, 'Some other document'),
    S(50, 680, 'nothing to do with bank statements'),
  ]]);
  const err = await parseBankStatement(notBank, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '不是銀行對帳單的 PDF 必須被擋下來（靜靜回 0 筆＝使用者以為匯進去了）');
  assert.equal(err.status, 400, '要回 400（可修的輸入錯誤），不是 500');
  assert.match(err.message, /台新銀行綜合對帳單/,
    '訊息要說清楚「這份看起來不是台新銀行綜合對帳單」，使用者才知道自己上傳錯檔案');
});

test('銀行主入口｜明細表頭**三欄全部**被逐字拆（湊不出完整欄名）→ 400，不可把欄位 x 靜默歸零', async () => {
  // 表頭辨識是「整列 squash 後比對」，但欄位 x 是「哪一格**正好等於**欄名」——台新把標題逐字拆開時
  // 前者仍然命中、後者全部拿到 0，於是每一筆的方向都會落到 x=0 的退路上。`parseBankDetail` 因此
  // 大聲擋下（status 400）；這一題驗那條 throw 真的接在主入口的路上。
  // ⚠️ 這一題只釘住守衛的**一個角**（三個 x 同時是 0）。三選一的另外三個角由下面那組單欄題釘。
  const split = makeTextPdf([[
    S(40, 900, '新臺幣帳戶概要區'),
    S(40, 880, '台幣活存'), S(200, 880, '900100****7788'), S(360, 880, '$100,000'),
    S(40, 860, '合計'),
    S(40, 840, '交易往來明細'),
    // 「支出金額」「存入金額」「帳戶餘額」逐字拆成 12 格：squash 後仍然認得出這是表頭列，
    // 但沒有任何一格的文字**等於**完整欄名
    S(200, 820, '支'), S(240, 820, '出'), S(280, 820, '金'), S(320, 820, '額'),
    S(360, 820, '存'), S(400, 820, '入'), S(440, 820, '金'), S(480, 820, '額'),
    S(520, 820, '帳'), S(560, 820, '戶'), S(600, 820, '餘'), S(640, 820, '額'),
  ]]);
  const err = await parseBankStatement(split, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '欄位位置讀不到就不可以繼續解析（x 全歸零＝方向亂判，而且完全沒有錯誤訊息）');
  assert.equal(err.status, 400);
  assert.match(err.message, /讀不到銀行明細的欄位位置/, '要說清楚是「版面與預期不同」，請使用者回報');
});

// `if (!xOut || !xIn || !xBal)` 是**三選一**：任何一欄讀不到就要擋。上面那題三欄一起拆，
// 只驗到「三個都是 0」那一角——把守衛改成合取（`&&`）全套考題照樣全綠，而真實情境是台新只拆其中一欄。
// 下面三題各只拆一欄，其餘欄位完好，所以每一個 disjunct 都各自被撐著。
// 每一列的實害都是**實測**的（把守衛改成 `&&` 之後跑同一組 fixture 量到的，不是推論）：
for (const [col, harm] of /** @type {const} */ ([
  ['支出金額',
    '守衛改成合取後這一格的四筆數字碰巧還全對——所以它釘的是守衛本身：'
    + '欄位 x 缺一個就不可以往下走（同時 [xChk,xOut) 這個「支票號碼欄排除區間」會塌成空集合）'],
  ['存入金額',
    '守衛改成合取後**第 1 筆的方向從 out 翻成 in**（1,234 元的支出被記成收入）——'
    + '它是該帳戶第一列，沒有前一列餘額可以校正回來；同帳戶的第 3 筆被 running 餘額救回去、'
    + '另一個帳戶的第 4 筆碰巧沒判錯，所以錯的只有第一筆、整份預覽看起來完全正常'],
  ['帳戶餘額',
    '守衛改成合取後**四筆交易全部靜靜掉光（0 筆）**，而概要區的帳戶餘額照樣回得漂亮——'
    + '預覽看起來就像「這個月沒有交易」'],
])) {
  test(`銀行主入口｜明細表頭只有「${col}」一欄被逐字拆 → 一樣要 400（三選一守衛的單欄面）`, async () => {
    /** @type {any} */
    let got = null;
    const err = await parseBankStatement(bankStatementPdf({ splitHeader: col }), undefined)
      .then((v) => { got = v; return null; }, (/** @type {any} */ e) => e);
    assert.ok(err, `只有「${col}」讀不到位置也必須擋下來，實際卻沒有 throw——${harm}`
      + `（本次實際回了 ${got?.transactions?.length} 筆：`
      + `${JSON.stringify(got?.transactions?.map((/** @type {any} */ t) => [t.date, t.direction, t.amount]))}）`);
    assert.equal(err.status, 400);
    assert.match(err.message, /讀不到銀行明細的欄位位置/);
  });
}

// `isBankStatement` 是「帳戶概要區 AND 往來明細」的合取，但上面那題餵的是**兩個標記都沒有**的文件，
// 只跑到「兩邊都不像」那一面——把 `&&` 改成 `||` 全 repo 沒有一題會紅（原本 `isBankStatement` 零考題）。
// 下面兩題各只給一個標記：合取一鬆掉，這份殘缺文件就會被當成銀行對帳單放進來，
// 然後靜靜解析出 0 筆／殘缺帳戶，使用者以為匯進去了。
for (const [label, marker, missing] of /** @type {const} */ ([
  ['只有概要區、沒有明細標記', '新臺幣帳戶概要區', '往來明細'],
  ['只有明細標記、沒有概要區', '交易往來明細', '帳戶概要區'],
])) {
  test(`銀行主入口｜${label} → 400（型別守衛是合取，兩個標記各釘一題）`, async () => {
    const half = makeTextPdf([[
      S(40, 900, '台新銀行'),
      S(40, 880, marker),
      S(50, 700, '這份文件缺了另一半'),
    ]]);
    const err = await parseBankStatement(half, undefined).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, `少了「${missing}」就不是完整的綜合對帳單，必須擋下來`
      + '（守衛一鬆成 `||`，這份殘缺文件會被放進來、靜靜回 0 筆）');
    assert.equal(err.status, 400);
    assert.match(err.message, /台新銀行綜合對帳單/);
  });
}

// 守衛的第二個條件是 `往來明細|交易往來` 的**擇一**，而上面每一份 fixture 的明細標記都寫「交易往來明細」
// ——它同時命中兩個分支，所以把判準砍成只認其中一個（Codex 實測：改成 `/交易往來/`），全套考題照樣綠。
// 下面兩題各用一份**只命中單一分支的完整對帳單**（帳戶概要區＋明細表頭＋四筆交易齊全），
// 那個分支一被刪，這份**真帳單就會被擋在門外**、使用者拿到「這不是台新銀行綜合對帳單」。
//
// ⚠️ 它們刻意斷言「抽出了什麼」而不只是「沒有錯」（r5 版就是只斷言沒有錯）：
//    只丟三個標記進去的話，主入口其實是**成功回了空結果**——那種寫法等於把「抽不到任何帳戶與交易
//    也放行」鎖成正確行為，日後要把它補成 fail-closed 反而會被自己的考題擋住。
for (const [marker, absent] of /** @type {const} */ ([
  ['往來明細', '交易往來'],
  ['交易往來', '往來明細'],
])) {
  test(`銀行主入口｜明細標記只寫「${marker}」（整份沒有「${absent}」）的完整對帳單 → 要放行並真的抽出帳戶與交易`, async () => {
    const pdf = bankStatementPdf({ detailMarker: marker });
    // fixture 自檢：這一題只有在「這份真的只命中一個分支」時才問得出問題
    const text = (await extractBankLines(pdf, undefined))
      .map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.s).join('')).join('\n');
    assert.ok(text.includes(marker) && !text.includes(absent),
      `fixture 自檢失敗：這份 PDF 必須只命中「${marker}」、不可含「${absent}」`);
    const r = await parseBankStatement(pdf, undefined);
    assert.deepEqual(r.accounts.map(a => [a.masked, a.balance]),
      [['900100****7788', 100000], ['900100****1122', 50000]],
      `走「${marker}」這個分支的真帳單要照樣抽出概要區兩個帳戶`);
    assert.deepEqual(r.transactions.map(t => [t.date, t.direction, t.amount]), BANK_TXNS.map(t => [...t]),
      `走「${marker}」這個分支的真帳單要照樣抽出四筆交易——`
      + `判準少了這個分支，整份會在型別守衛就被 400 擋掉（真帳單匯不進來）`);
  });
}

test('證券主入口｜不是證券對帳單的 PDF → 明確 400（型別守衛那一道）', async () => {
  const notSec = makeTextPdf([[
    S(50, 700, 'Some other document'),
    S(50, 680, 'nothing here'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(notSec, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '不是證券對帳單的 PDF 必須擋下來');
  assert.equal(err.status, 400);
  assert.match(err.message, /不是台新證券對帳單/, '要說清楚上傳錯檔案');
});

// ⚠️ `isSecuritiesStatement` 也是**組合條件**，而且比銀行那兩處更多段：
//    `證券` ∧ ¬`帳戶概要區` ∧ (`(成交|交易)明細` ∨ (`有價證券` ∧ `電子對帳單`) ∨ `應收付金額`)。
//    上面那題餵的是「哪一段都不像」的文件，只跑到最外圈那一角——自審實測三個一行改動
//    （刪 `|| /應收付金額/`／刪 `|| (/有價證券/ && /電子對帳單/)`／刪 `|| /帳戶概要區/` 這個排除），
//    每一個都能讓當時的 1507 題全綠。r4 已經替**銀行**的型別守衛補過一模一樣的東西，證券這處被漏掉
//    （檔頭當時只寫「銀行那兩處各不只一題」，誠實劃界也沒點名這裡）——同一個病型放著沒修。
//    ⚠️ **別被「那邊不是有一題守門嗎」騙了**：`test/taishin-securities.test.js:269` 確實直接呼叫
//    `isSecuritiesStatement`，但它的真版面 fixture **同時**命中「有價證券∧電子對帳單」與「應收付金額」
//    兩個分支——兩個分支互相掩護，刪掉任一個它照樣綠；它的銀行反例（`台新銀行 帳戶概要區 證券劃撥`）
//    又一個分支標記都沒有，所以排除條件被刪也照樣綠。**實測**：上述四個角的突變逐一跑
//    `node --test test/taishin-securities.test.js`，四次都 fail 0。
//
// 一、三個 ∨ 分支：各一份**只命中它**的完整對帳單，要放行**而且真的抽得出交易與年月**。
//    （只斷言「沒有錯」等於把「放行空結果」鎖成正確行為——銀行那邊踩過，見檔頭⑦。）
//    實害是具體的：`lib/taishin-securities.js:103-106` 自己註明使用者 2026/03 的真單全文**沒有**
//    「成交明細」四個字（段落標題是「上市／上櫃／興櫃」），靠的就是後兩個分支——任何一個被靜靜刪掉，
//    **真帳單會在門口收到「這份 PDF 看起來不是台新證券對帳單」**，而全套考題不吭聲。
for (const { present, absent, opts } of /** @type {const} */ ([
  { present: ['成交明細'], absent: ['交易明細', '有價證券', '電子對帳單', '應收付金額'],
    opts: { netHeader: '淨收付金額' } },
  { present: ['交易明細'], absent: ['成交明細', '有價證券', '電子對帳單', '應收付金額'],
    opts: { sectionTitle: '交易明細', netHeader: '淨收付金額' } },
  { present: ['有價證券', '電子對帳單'], absent: ['成交明細', '交易明細', '應收付金額'],
    opts: { sectionTitle: '上市', netHeader: '淨收付金額', docTitle: '有價證券電子對帳單' } },
  { present: ['應收付金額'], absent: ['成交明細', '交易明細', '有價證券', '電子對帳單'],
    opts: { sectionTitle: '上市' } },
])) {
  test(`證券主入口｜只命中「${present.join('＋')}」這一個分支的完整對帳單 → 要放行並真的抽出交易`, async () => {
    const pdf = securitiesStatementPdf(opts);
    // fixture 自檢：這一題只有在「這份真的只命中一個分支」時才問得出問題
    const text = (await extractSecuritiesLines(pdf, undefined))
      .map((/** @type {any} */ l) => l.cells.map((/** @type {any} */ c) => c.s).join('')).join('\n');
    for (const k of present) assert.ok(text.includes(k), `fixture 自檢失敗：這份 PDF 必須含「${k}」`);
    for (const k of absent) {
      assert.ok(!text.includes(k), `fixture 自檢失敗：這份 PDF 不可含「${k}」（含了就不只命中一個分支）`);
    }
    const r = await parseTaishinSecuritiesPdf(pdf, undefined);
    assert.equal(r.stmtMonth, '2026-01',
      `走「${present.join('＋')}」這個分支的真帳單要照樣讀得到對帳單年月`);
    assert.deepEqual(
      r.trades.map((/** @type {any} */ t) => [t.tradeDate, t.symbol, t.rawType, t.quantity, t.grossAmount, t.netSettlement]),
      [['2026-01-13', '0050', '現買', 1000, 104000, 104044]],
      `走「${present.join('＋')}」這個分支的真帳單要照樣抽出那一筆成交——`
      + '判準少了這個分支，整份會在型別守衛就被 400 擋掉（真帳單匯不進來）');
  });
}

// 二、兩個 ∧ 條件（一個必要標記、一個排除標記）各一題：少了它們，別種文件會被當成證券對帳單放進來。
//    兩題都斷言**錯誤訊息**：守衛一鬆，這兩份文件會往下走到 `headerFound` 那道牆才被擋，
//    使用者拿到的是「表頭可能被逐字拆或版面不同，請回報帳單版面」——把「你上傳錯檔案」講成「程式看不懂你的帳單」。
test('證券主入口｜銀行綜合對帳單（有「帳戶概要區」、也自稱有價證券電子對帳單）→ 400（排除條件那一角）', async () => {
  // ⚠️ 這份 fixture 是**銀行版面＋證券標記**：帳戶概要區、帳戶列、明細標題都在，同時印著
  //    「有價證券電子對帳單」→ 命中證券守衛的第二個分支。（真的台新銀行綜合對帳單是不是逐字印這幾個字，
  //    我沒有真單可查證——但只要它命中三個分支裡的**任何一個**，把它擋在證券解析器門外的
  //    就只剩「帳戶概要區 → 不是證券單」這條排除，這一題釘的正是那條。）
  const bankLike = makeTextPdf([[
    S(40, 900, '台新銀行綜合對帳單'), S(300, 900, '115年1月'),
    S(40, 880, '有價證券電子對帳單'),
    S(40, 860, '新臺幣帳戶概要區'),
    S(40, 845, '台幣活存'), S(200, 845, '900100****7788'), S(360, 845, '$100,000'),
    S(40, 820, '交易往來明細'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(bankLike, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '銀行綜合對帳單餵進證券端點必須擋下來');
  assert.equal(err.status, 400);
  assert.match(err.message, /不是台新證券對帳單/,
    '排除條件一拿掉，這份銀行單會通過型別守衛、走到 headerFound 那道牆才被擋，訊息變成「請回報帳單版面」');
});

test('證券主入口｜信用卡帳單（有「交易明細」但全文沒有「證券」）→ 400（必要標記那一角）', async () => {
  const cardLike = makeTextPdf([[
    S(40, 900, '台新銀行信用卡'), S(300, 900, '115年1月'),
    S(40, 860, '交易明細'),
    S(40, 840, '消費日'), S(150, 840, '商店名稱'), S(430, 840, '金額'),
    S(40, 800, '01/13'), S(150, 800, 'PXMART'), S(430, 800, '1,234'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(cardLike, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '信用卡帳單的「交易明細」不可以讓它被當成證券對帳單');
  assert.equal(err.status, 400);
  assert.match(err.message, /不是台新證券對帳單/,
    '`/證券/` 這個必要條件一拿掉，信用卡帳單就會靠「交易明細」通過守衛');
});

// 「有價證券 ∧ 電子對帳單」自己也是合取——這兩組字樣**沒有一組是證券對帳單獨有的**
//（「電子對帳單」是各類帳單的通稱、「有價證券」是法律名詞，兩者都可能出現在別種文件上），
// 所以判準要求它們同時出現。合取一鬆成析取，下面這兩份只有一半的文件就進得來。
for (const [have, missing] of /** @type {const} */ ([
  ['電子對帳單', '有價證券'],
  ['有價證券', '電子對帳單'],
])) {
  test(`證券主入口｜只印「${have}」（沒有「${missing}」）→ 400（那個分支自己也是合取）`, async () => {
    const half = makeTextPdf([[
      S(40, 900, '台新綜合證券'), S(300, 900, '115年1月'),
      S(40, 880, have),
      S(40, 700, '這份文件缺了另一半'),
    ]]);
    const err = await parseTaishinSecuritiesPdf(half, undefined).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, `只有「${have}」一組字樣不足以判定是證券對帳單`);
    assert.equal(err.status, 400);
    assert.match(err.message, /不是台新證券對帳單/,
      `合取一鬆成析取，這份只有「${have}」的文件會被當成證券對帳單放進來`);
  });
}

test('證券主入口｜通過型別守衛、但成交表頭讀不到 → 400（headerFound 那條接線）', async () => {
  // ⚠️ 這條接線 r1 宣稱「需要中文 PDF、做不到」＝**錯的宣稱**（見檔頭）。這裡真的把它補上：
  //    fixture 是一份看得出「證券／成交明細」的 PDF，但下層表頭的欄名換成認不得的字樣
  //    （只湊得出 1 個 token，`isHeaderLine` 要 2 個）→ headerFound=false。
  //    沒有這道牆的話，版面一變就靜靜回 0 筆，跟「當月真的沒交易」分不出來。
  const noHeader = makeTextPdf([[
    S(40, 900, '台新綜合證券'), S(300, 900, '115年1月'),
    S(40, 860, '成交明細'),
    S(40, 840, '成交日'), S(95, 840, '交割日'), S(150, 840, '證券代號'), S(240, 840, '數量'),
    S(40, 830, '類別'), S(150, 830, '品名'), S(240, 830, '金額'),   // 下層只認得「類別」一個
    S(40, 800, '115/01/13'), S(150, 800, '0050'), S(240, 800, '1,000'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(noHeader, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '表頭讀不到就不可以靜默回 0 筆');
  assert.equal(err.status, 400);
  assert.match(err.message, /讀不到成交明細的欄位位置/, '訊息要指向「版面不同、請回報」');
});

test('證券主入口｜表頭讀得到但整份找不到對帳單年月 → 400（stmtMonth 那條接線）', async () => {
  // 對帳單年月是去重鍵 sourceRef 的一部分，也是 MM/DD 推年份的依據——讀不到就不能硬匯。
  // fixture：表頭與成交列都正常（成交日用民國全日期，不靠年月推算），但全文沒有任何年月字樣。
  const noMonth = makeTextPdf([[
    S(40, 900, '台新綜合證券'),
    S(40, 880, '帳號：9001-900100'),
    S(40, 860, '成交明細'),
    S(40, 840, '成交日'), S(95, 840, '交割日'), S(150, 840, '證券代號'), S(240, 840, '數量'),
    S(40, 830, '交易類別'), S(150, 830, '證券名稱'), S(240, 830, '成交金額'),
    S(40, 800, '115/01/13'), S(150, 800, '0050'), S(240, 800, '1,000'),
    S(40, 790, '現買'), S(150, 790, '元大台灣50'), S(240, 790, '104,000'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(noMonth, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '讀不到年月就不可以匯入（去重鍵會少一段，之後重複匯入抓不到）');
  assert.equal(err.status, 400);
  assert.match(err.message, /讀不到對帳單年月/);
});

test('證券主入口｜年度／季度單（多月份跨度）→ 400（isMultiMonthHeader 那條接線）', async () => {
  // ⚠️ 同樣是 r1 宣稱「做不到」的那條。sourceRef 含對帳單年月＝去重鍵的一部分，
  //    年度單只抽得到「第一個年月」，跨度後段的交易會全部掛錯年月＝去重鍵毒化。
  const yearly = makeTextPdf([[
    S(40, 900, '台新綜合證券'), S(300, 900, '115年1月~12月 對帳單'),
    S(40, 860, '成交明細'),
    S(40, 840, '成交日'), S(95, 840, '交割日'), S(150, 840, '證券代號'), S(240, 840, '數量'),
    S(40, 830, '交易類別'), S(150, 830, '證券名稱'), S(240, 830, '成交金額'),
    S(40, 800, '115/01/13'), S(150, 800, '0050'), S(240, 800, '1,000'),
  ]]);
  const err = await parseTaishinSecuritiesPdf(yearly, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '年度／季度單必須擋下來');
  assert.equal(err.status, 400);
  assert.match(err.message, /涵蓋多個月份/, '訊息要教使用者改用月結單分批上傳');
});

// ⚠️ 誠實劃界（寫得出反例的才寫）：
//  ①**這一檔只走 LOCAL 那條路。** `extractPdfLines` 在 `isHosted()` 為真時會把抽取丟進子行程
//    （`lib/pdf-isolate.js`），而考題行程沒有設 `NOTEASY_HOSTED=1`，所以上面每一題驗到的都是
//    「行程內直跑」。子行程那條路（序列化、深度上限、錯誤歸因、逾時）由 `test/pdf-isolate.test.js`
//    守著，它也有一題「跨行程前後抽出來的資料逐項相同」——但那一題只餵信用卡那支
//    `extractLinesForIsolation`。**銀行與證券跨行程後座標是否一致，目前沒有考題**
//    （子行程回傳前偷偷改掉 `x`，本檔不會轉紅）。
//  ②本檔的 PDF 是合成的：欄位間距、字寬、字級、頁面大小都是我挑的，**不是台新真實版面的量測值**。
//    它守得住「抽取層把座標／字寬弄丟、弄亂、換成人造值」，守不住「真實帳單的欄位比 fixture 更擠、更歪」。
//    字級也只驗了 6／10／20 三種，**不是**「任何字級都對」的證明。
//  ③信用卡那支刻意丟座標的 `extractLines` 不在本檔範圍。
//  ④**「列內依 x 排序」在證券端只被抽取層那一題撐著、沒有端到端的承重證明。**
//    銀行端有：`bankStatementPdf` 的明細列是逆序寫進去的，拿掉 `lib/bank-statement.js` 的 sort，
//    銀行成功題會直接掉到 0 筆。證券端的 `securitiesStatementPdf` 仍照 x 升冪寫，實測拿掉
//    `lib/taishin-securities.js` 的 sort 之後**證券成功題照樣綠**（它的表頭 token 在
//    `lib/taishin-securities.js:216` 又自己排了一次）——也就是說證券那行 sort 只有
//    「證券對帳單抽取器」那兩題在守，沒有考題說得出「拔掉它，證券會壞成什麼樣」。
//  ⑤孤兒備註的 y 距離上限（`ORPHAN_MAX_DY`）只被**這一份 fixture 的兩個實際距離**釘住
//    （10 要收、100 不可收；實測改成 1e9 或 5 都會轉紅）。40 這個數字本身沒有考題說它對——
//    改成 30 或 80 這種「還是 10<cap<100」的值，本檔不會轉紅。
//  ⑥**證券型別守衛的異體字那一支沒有考題**：`/電子對[帳賬]單/` 的字元類容忍簡體「賬」，
//    但本檔每一份 fixture 都寫「帳」——把它砍成 `/電子對帳單/`，本檔不會轉紅。
//    （同族的另一面本檔**有**釘住：`(成交|交易)明細` 的兩個字樣各有一份只命中它的完整對帳單。）
//  ⑦**證券 `assignCols` 的混合法只證到「金額格要用右緣」，沒證到「文字格必須用左緣」**：
//    實測把 `pos` 改成**所有格子一律用右緣**（拿掉 `isAmt &&`），本檔照樣全綠——
//    fixture 的文字格都短、右緣沒有溢出自己那一欄。真帳單的長證券名稱會不會溢出，本檔答不出來。
