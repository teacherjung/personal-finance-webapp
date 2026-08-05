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
//    唯一餵真 PDF 位元組的 `test/pdf-limits-wiring.test.js` 只看頁數上限與畸形檔的錯誤形狀。
//    座標是分欄的唯一依據：橫向決定「支出／存入」，縱向決定「換行備註歸哪一列」。
//    哪天升級 pdfjs，銀行與證券的匯入可能整片壞掉而測試不出聲。
//
// 二、**空包彈考題**（題目寫了保證、斷言只碰旁邊的零件）：
//    `test/taishin-securities.test.js` 兩題的名稱寫著「主入口據此 throw 400」，
//    但斷言只驗解析器回的旗標、沒驗主入口真的擋。
//    實務後果＝對帳單版面一變就靜靜匯入 0 筆、回你成功，使用者以為當月沒有交易。
//    **本檔補上主入口那一半**——精確範圍：`parseBankStatement` 與 `parseTaishinSecuritiesPdf`
//    在「抽取完成之後」自己丟的每一個 400（銀行 2 處：型別守衛／明細欄位位置；證券 4 處：
//    型別守衛／多月份／headerFound／stmtMonth），本檔各有一題，而且每一題都有對應的突變驗過。
//    ⚠️ 抽取器**內部**丟的 400（PDF 密碼／加密、開檔失敗、頁數與節點上限）不在本檔：
//    頁數上限與畸形檔在 `test/pdf-limits-wiring.test.js`（三支抽取器都驗），
//    加密／密碼那條在 `test/pdf-isolate.test.js`（只對信用卡那支 `parseStatement` 驗；
//    銀行與證券的密碼分支是逐字重複的三胞胎之一，**沒有各自的考題**）。
//
// ⚠️ **r2 又交了兩顆假保證**（Codex 2026-08-05 第二次退回；同一種病換個位置長出來——
//    「斷言的文字寫著保證 X，但 fixture 剛好讓不做 X 的寫法也答對」）：
//    ④座標題只比對「值」不比對**順序**：fixture 三段本來就照 x 升冪寫進內容串流，於是兩支抽取器的
//      `cells.sort((a,b)=>a.x-b.x)` 可以整行刪掉而 1499 題全綠，而那條斷言偏偏寫著「照版面順序排好」。
//      ⇒ 現在 `ROW` 與銀行明細列都**逆序（右→左）寫進內容串流**，排序才真的被撐著。
//    ⑤銀行成功題寫「換行備註靠 y 歸位」，但 fixture 的孤兒備註剛好貼在**最後一筆**旁邊，
//      「完全不看 y、一律黏最後一筆」照樣全綠。⇒ 現在三筆交易、三段孤兒備註：一段在自己那筆下方、
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
/** 字級。ASCII 一個字 5pt、中文一個字 10pt（字寬 × 字級 ÷ 1000）——fixture 的欄位間距都照這個算。 */
const FONT_SIZE = 10;
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
 * @param {{x:number,y:number,text:string}[][]} pages 每頁一個陣列
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
    const body = segs.map(s => `BT /F1 ${FONT_SIZE} Tf ${s.x} ${s.y} Td (${enc(s.text)}) Tj ET`).join('\n');
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

/** 造一段文字。 @param {number} x @param {number} y @param {string} text */
const S = (x, y, text) => ({ x, y, text });

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
 * @param {number} y @param {string} a @param {string} b @param {string} c
 */
const ROW = (y, a, b, c) => [S(ROW_X[2], y, c), S(ROW_X[1], y, b), S(ROW_X[0], y, a)];

// ─────────────────────────────────────────────────────────────────────────────
// 一、座標真的被抽出來（橫向分欄、縱向歸列的唯一依據）
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, extract] of /** @type {const} */ ([
  ['銀行對帳單', extractBankLines],
  ['證券對帳單', extractSecuritiesLines],
])) {
  test(`${name}抽取器｜一列的文字與 x／w 必須逐格等於 fixture 指定的值，且**照 x 升冪重排**`, async () => {
    // ⚠️ r1 版只驗「互異且遞增」，Codex 用「x＝該列已收字數+1」的人造遞增值就繞過去了。
    //    所以這裡改成**比對實際數字**：文字 ['AAA','BBBB','CC']、x [50,200,400]、
    //    w [15,20,10]（ASCII 一個字 5pt）。Codex 那種「第幾個字」的人造數列同時對不上這三組。
    // ⚠️ r2 版又漏了排序：fixture 本來就照 x 升冪寫進內容串流，抽取器把 sort 整行刪掉照樣全綠。
    //    現在 `ROW` **逆序（右→中→左）**寫進去，下面三條斷言就同時把「值」與「順序」釘住了。
    const pdf = makeTextPdf([ROW(700, 'AAA', 'BBBB', 'CC')]);
    const lines = await extract(pdf, undefined);
    assert.equal(lines.length, 1, `應該只抽出一列（實際 ${JSON.stringify(lines).slice(0, 300)}）`);
    assert.equal(lines[0].y, 700, 'y 要等於 fixture 指定的 700');
    assert.deepEqual(lines[0].cells.map((/** @type {any} */ c) => c.s), ['AAA', 'BBBB', 'CC'],
      '每一格的文字要照版面順序（x 升冪）排好——fixture 是**逆序**寫進內容串流的（右→中→左），'
      + '抽取器少了依 x 排序就會回 [CC, BBBB, AAA]');
    assert.deepEqual(lines[0].cells.map((/** @type {any} */ c) => c.x), [50, 200, 400],
      `x 要等於 fixture 指定的 ${JSON.stringify([...ROW_X])}**而且是升冪**——`
      + '座標一旦被換成人造值（歸零、或「第幾個字」這種遞增數列），或是照內容串流原序不重排，'
      + '支出／存入分欄、支票欄排除、`c[0]=帳號 c[1]=日期` 的位置判準就整片失效（而且不報錯）');
    assert.deepEqual(lines[0].cells.map((/** @type {any} */ c) => c.w), [15, 20, 10],
      'w 要等於「字數 × 5pt」——w 是右對齊金額判欄的依據（右緣 ＝ x + w），丟了它金額會漂到隔壁欄');
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
 * ⚠️ **兩個地方是刻意「做成不好過」的**，因為 r2 版兩者都被實際繞法穿過：
 *
 * ①**明細的每一列都逆序（x 遞減）寫進內容串流**。真帳單的右對齊金額／備註在內容串流裡後畫很常見，
 *   而 `parseBankDetail` 靠 `c[0]=遮罩帳號`／`c[1]=日期` 的位置判準認交易列——抽取器少了依 x 排序，
 *   `c[0]` 會變成備註或餘額格，整張帳單靜靜抽出 0 筆。r2 版是照 x 升冪寫的，於是兩支抽取器的
 *   `cells.sort((a,b)=>a.x-b.x)` 可以一起刪掉而 1499 題全綠。
 *
 * ②**三筆交易、兩段孤兒備註，而且沒有一段屬於最後一筆**（一段在它那筆的下方、一段在**上方**——
 *   `lib/bank-statement.js` 檔頭自己註明備註可能印在交易列上方）。r2 版只有兩筆、孤兒備註剛好貼著
 *   最後一筆，所以「完全不看 y、一律黏到最後一筆」的寫法照樣全綠。y 距離是承重的：黏錯的話
 *   第 5 筆的「劃撥」會跑到第 30 筆，正是 `lib/bank-statement.js` 那句「漏收會把百萬劃撥誤當收入」。
 *   每段孤兒備註到「自己那筆」的 y 距離都是 10、到相鄰兩筆都 ≥50（＞`ORPHAN_MAX_DY`＝40），
 *   所以「靠 y 最近」與「靠列序（第一筆／最後一筆／前一列／後一列）」四種寫法在這份 fixture 上答案全不同。
 */
function bankStatementPdf() {
  /** 明細列：逆序（右→左）寫進內容串流，見上面 ①。 @param {{x:number,y:number,text:string}[]} segs */
  const detailRow = (segs) => [...segs].sort((a, b) => b.x - a.x);
  return makeTextPdf([[
    S(40, 900, '台新銀行綜合對帳單'),
    S(40, 880, '現值參考日：2026/01/31'),
    S(40, 860, '新臺幣帳戶概要區'),
    S(40, 840, '台幣活存'), S(200, 840, '900100****7788'), S(360, 840, '$100,000'),
    S(40, 820, '合計'),
    S(40, 800, '交易往來明細'),
    // 明細表頭：欄位 x ＝ 支票號碼 200／支出金額 300／存入金額 400／帳戶餘額 500／備註 620
    S(200, 780, '支票號碼'), S(300, 780, '支出金額'), S(400, 780, '存入金額'),
    S(500, 780, '帳戶餘額'), S(620, 780, '備註'),
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
    S(620, 480, '本頁小計說明'),   // 孤兒備註 C：離最近的第 3 筆 160 ＞ ORPHAN_MAX_DY(40) → 一段都不該黏上去
  ]]);
}

test('銀行主入口｜有效 PDF → 成功解析（不是一律 400），而且支出／存入靠 x 分欄、換行備註靠 y（不是列序）歸位', async () => {
  // ⚠️ r1 只有拒絕面，Codex 把主入口改成「抽完一律回同一個 400」全綠。這一題是成功面：
  //    ①主入口真的回得來 ②概要區的餘額 ③**第 1 筆的方向只有 x 判得出來**
  //    （它是該帳戶第一列，沒有前一列餘額可以拿來校正）④備註跨列歸位。
  //    ⑤（r2 補）明細列逆序進場＋兩段孤兒備註都不屬於最後一筆——見 `bankStatementPdf` 的說明。
  const r = await parseBankStatement(bankStatementPdf(), undefined);
  assert.equal(r.bank, '台新');
  assert.equal(r.referenceDate, '2026-01-31', '概要區的現值參考日要讀得到');
  assert.deepEqual(r.accounts.map(a => [a.masked, a.balance, a.currency, a.label]),
    [['900100****7788', 100000, 'TWD', '台幣活存']], '概要區帳戶（末碼／餘額／幣別／標籤）');
  assert.equal(r.transactions.length, 3,
    '明細要抽出三筆——列內少了依 x 排序的話 `c[0]` 會變成備註／餘額格，整張靜靜抽出 0 筆');
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
    + '而且離最近交易列 160 的那段（本頁小計說明）不可以黏上來（y 距離上限拿掉就會多出這一段）');
});

/** 一份合法的台新證券對帳單 fixture（雙層表頭；一筆成交跨兩行）。 */
function securitiesStatementPdf() {
  return makeTextPdf([[
    S(40, 900, '台新綜合證券'), S(300, 900, '115年1月'),
    S(40, 880, '帳號：9001-900100'),          // 明顯假值（合成測試不得用真實帳號）
    S(40, 860, '成交明細'),
    // 上層表頭（每筆第一行的欄名）
    S(40, 840, '成交日'), S(95, 840, '交割日'), S(150, 840, '證券代號'), S(240, 840, '數量'),
    S(300, 840, '成交價'), S(360, 840, '手續費'), S(430, 840, '應收付金額'),
    // 下層表頭（每筆第二行的欄名）
    S(40, 830, '交易類別'), S(150, 830, '證券名稱'), S(240, 830, '成交金額'),
    S(300, 830, '折讓'), S(360, 830, '證交稅'), S(430, 830, '幣別'),
    // 一筆成交的第一行／第二行
    S(40, 800, '115/01/13'), S(95, 800, '115/01/15'), S(150, 800, '0050'), S(240, 800, '1,000'),
    S(300, 800, '104.00'), S(360, 800, '148'), S(430, 800, '104,148'),
    S(40, 790, '現買'), S(150, 790, '元大台灣50'), S(240, 790, '104,000'),
    S(300, 790, '0'), S(360, 790, '0'), S(430, 790, 'TWD'),
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
  assert.deepEqual(
    [t.tradeDate, t.settlementDate, t.symbol, t.name, t.rawType,
      t.quantity, t.price, t.grossAmount, t.commission, t.tax, t.netSettlement, t.currency],
    ['2026-01-13', '2026-01-15', '0050', '元大台灣50', '現買',
      1000, 104, 104000, 148, 0, 104148, 'TWD']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、主入口的拒絕面：四條 fail-closed 接線各一題
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

test('銀行主入口｜明細表頭被逐字拆（湊不出完整欄名）→ 400，不可把欄位 x 靜默歸零', async () => {
  // 表頭辨識是「整列 squash 後比對」，但欄位 x 是「哪一格**正好等於**欄名」——台新把標題逐字拆開時
  // 前者仍然命中、後者全部拿到 0，於是每一筆的方向都會落到 x=0 的退路上。`parseBankDetail` 因此
  // 大聲擋下（status 400）；這一題驗那條 throw 真的接在主入口的路上。
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
//  ②本檔的 PDF 是合成的：欄位間距、字寬、頁面大小都是我挑的，**不是台新真實版面的量測值**。
//    它守得住「抽取層把座標弄丟／弄亂」，守不住「真實帳單的欄位比 fixture 更擠、更歪」。
//  ③信用卡那支刻意丟座標的 `extractLines` 不在本檔範圍。
//  ④**「列內依 x 排序」在證券端只被抽取層那一題撐著、沒有端到端的承重證明。**
//    銀行端有：`bankStatementPdf` 的明細列是逆序寫進去的，拿掉 `lib/bank-statement.js` 的 sort，
//    銀行成功題會直接掉到 0 筆。證券端的 `securitiesStatementPdf` 仍照 x 升冪寫，實測拿掉
//    `lib/taishin-securities.js` 的 sort 之後**證券成功題照樣綠**（它的表頭 token 在
//    `lib/taishin-securities.js:216` 又自己排了一次）——也就是說證券那行 sort 只有
//    「證券對帳單抽取器」那兩題在守，沒有考題說得出「拔掉它，證券會壞成什麼樣」。
//  ⑤孤兒備註的 y 距離上限（`ORPHAN_MAX_DY`）只被**這一份 fixture 的兩個實際距離**釘住
//    （10 要收、160 不可收；實測改成 1e9 或 5 都會轉紅）。40 這個數字本身沒有考題說它對——
//    改成 30 或 80 這種「還是 10<cap<160」的值，本檔不會轉紅。
