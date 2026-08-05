// @ts-check
// PDF 座標抽取層與「主入口真的擋下來」考題（夜班稽核第四批C，2026-08-05）
//
// 夜班稽核在這一片找到兩族問題：
//
// 一、**契約說有考題、實際零考題**：銀行與證券的 PDF 座標抽取器
//    （`extractBankLines`／`extractSecuritiesLines`）。契約明文寫著「改 pdfjs 版本或抽取邏輯時
//    三份都要過各自的合成座標考題」，實測把橫向座標全部改成 0（等於座標資訊全毀）1487 題全綠——
//    三份抽取器裡只有信用卡帳單那一支真的被守著。座標是分欄的唯一依據：橫向決定「支出／存入」，
//    縱向決定「換行備註歸哪一列」。哪天升級 pdfjs，銀行與證券的匯入可能整片壞掉而測試不出聲。
//
// 二、**空包彈考題**（題目寫了保證、斷言只碰旁邊的零件）：
//    `test/taishin-securities.test.js` 兩題的名稱寫著「主入口據此 throw 400，不靜默回 0 筆」
//    「主入口 400 阻擋，防去重鍵毒化」，但斷言只驗解析器回的旗標、沒驗主入口真的擋。
//    實務後果＝對帳單版面一變就靜靜匯入 0 筆、回你成功，使用者以為當月沒有交易。
//    本檔補上「主入口」那一半（同一族還有 `parseBankStatement` 的型別守衛，第二批B 已註明移來這裡）。
//
// 手法：手工造**最小的合法 PDF**（沿用 `test/pdf-limits-wiring.test.js` 的 makePdf 思路並擴充成
// 「可指定每段文字的座標」），這樣不需要真實帳單（真 PDF 絕不進版控——裡面是真的財務資料）。
// LOCAL 模式下 `extractPdfLines` 不繞子行程，所以直接呼叫抽取器就是真實路徑。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { extractBankLines, parseBankStatement } = await import('../lib/bank-statement.js');
const { extractSecuritiesLines, parseTaishinSecuritiesPdf } = await import('../lib/taishin-securities.js');

/**
 * 手工造一份最小的合法 PDF，內容是「指定座標的文字段」。
 * @param {{x:number,y:number,text:string}[][]} pages 每頁一個陣列
 */
function makeTextPdf(pages) {
  /** @type {string[]} */
  const objs = [];
  const pageCount = pages.length;
  // 物件配置：1 Catalog／2 Pages／3+2i 內容串流／4+2i 頁
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] >>`;
  pages.forEach((segs, i) => {
    const body = segs.map(s => `BT /F1 10 Tf ${s.x} ${s.y} Td (${s.text.replace(/([()\\])/g, '\\$1')}) Tj ET`).join('\n');
    objs[3 + i * 2] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
    objs[4 + i * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + `/Contents ${3 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`;
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

/** 一列三段文字，x 遞增（模擬「帳號｜日期｜金額」那種表格列）。 */
const ROW = (y, a, b, c) => [
  { x: 50, y, text: a }, { x: 200, y, text: b }, { x: 400, y, text: c },
];

// ─────────────────────────────────────────────────────────────────────────────
// 一、座標真的被抽出來（橫向分欄、縱向歸列的唯一依據）
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, extract] of /** @type {const} */ ([
  ['銀行對帳單', extractBankLines],
  ['證券對帳單', extractSecuritiesLines],
])) {
  test(`${name}抽取器｜同一列的橫向座標必須互異且遞增（座標全毀＝分欄整片壞掉）`, async () => {
    // ⚠️ 把 x 全部改成 0（或全部相同）時，「支出／存入」分欄、支票號碼排除、備註欄判定
    //    全部失效——而這正是夜班實測「1487 題全綠」的那個突變。
    const pdf = makeTextPdf([ROW(700, 'AAA', 'BBB', 'CCC')]);
    const lines = await extract(pdf, undefined);
    assert.ok(Array.isArray(lines) && lines.length > 0, '要抽得出至少一列');
    const row = lines.find((/** @type {any} */ l) => (l.cells || []).length >= 3);
    assert.ok(row, `抽不到有三個儲存格的列（實際：${JSON.stringify(lines).slice(0, 200)}）`);
    const xs = row.cells.map((/** @type {any} */ c) => c.x);
    assert.equal(new Set(xs).size, xs.length,
      `同一列的 x 座標必須互異（實際 ${JSON.stringify(xs)}）——全部相同＝欄位資訊已經毀掉`);
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] > xs[i - 1],
        `x 座標要依版面順序遞增（實際 ${JSON.stringify(xs)}）——順序亂掉會讓分欄判斷整片錯`);
    }
    assert.ok(xs[0] > 0, 'x 不可全歸零（歸零＝座標資訊消失，卻不會有任何錯誤訊息）');
  });

  test(`${name}抽取器｜跨頁的縱向座標必須單調遞減（換行備註才歸得回正確那一列）`, async () => {
    // ⚠️ 縱向座標決定「孤兒備註黏到哪一筆交易」。跨頁時若 y 沒有做位移，
    //    第 2 頁的列會與第 1 頁的列混在同一個 y 區間，備註歸位就會亂掉
    //    （備註是內轉／劃撥／繳卡費的分箱判準）。
    const pdf = makeTextPdf([
      ROW(700, 'P1-A', 'P1-B', 'P1-C'),
      ROW(700, 'P2-A', 'P2-B', 'P2-C'),   // 第 2 頁刻意用同一個頁內 y
    ]);
    const lines = await extract(pdf, undefined);
    const ys = lines.map((/** @type {any} */ l) => l.y);
    assert.ok(lines.length >= 2, `跨頁應抽出兩列以上（實際 ${lines.length}）`);
    assert.equal(new Set(ys).size, ys.length,
      `不同頁的列不可落在同一個 y（實際 ${JSON.stringify(ys)}）——混在一起備註就會黏錯交易`);
    for (let i = 1; i < ys.length; i++) {
      assert.ok(ys[i] < ys[i - 1],
        `y 要單調遞減（先出現的在上面；實際 ${JSON.stringify(ys)}）`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、主入口真的擋下來（補既有考題只驗「解析器旗標」的那一半）
// ─────────────────────────────────────────────────────────────────────────────

test('銀行主入口｜餵一份不是台新綜合對帳單的 PDF → 明確 400，不可靜靜回 0 筆', async () => {
  // ⚠️ 這是第二批B 註明移來本檔的那一題（需要真 PDF）。守衛拿掉之後，把信用卡帳單
  //    餵進銀行端點不再明確拒絕，而是靜靜解析出 0 筆或錯誤分欄的結果——使用者以為匯進去了。
  const notBank = makeTextPdf([[
    { x: 50, y: 700, text: 'Some other document' },
    { x: 50, y: 680, text: 'nothing to do with bank statements' },
  ]]);
  const err = await parseBankStatement(notBank, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '不是銀行對帳單的 PDF 必須被擋下來（靜靜回 0 筆＝使用者以為匯進去了）');
  assert.equal(err.status, 400, '要回 400（可修的輸入錯誤），不是 500');
  assert.match(err.message, /台新銀行綜合對帳單/,
    '訊息要說清楚「這份看起來不是台新銀行綜合對帳單」，使用者才知道自己上傳錯檔案');
});

test('證券主入口｜不是證券對帳單的 PDF → 明確 400（型別守衛那一道）', async () => {
  const notSec = makeTextPdf([[
    { x: 50, y: 700, text: 'Some other document' },
    { x: 50, y: 680, text: 'nothing here' },
  ]]);
  const err = await parseTaishinSecuritiesPdf(notSec, undefined).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '不是證券對帳單的 PDF 必須擋下來');
  assert.equal(err.status, 400);
  assert.match(err.message, /不是台新證券對帳單/, '要說清楚上傳錯檔案');
});

// ⚠️ 誠實劃界：**「通過型別守衛、但欄位表頭讀不到」那一半，這套 harness 打不到。**
//    型別守衛要求文字裡有「證券」「成交明細」等中文字樣，而手工的最小 PDF 只帶得了
//    Type1／latin1 字型——中文要 CID 字型才嵌得進去（做得到，但那是另一套工程）。
//    所以現況是：
//      ✅ 主入口「不是這種對帳單就 400」＝上面兩題已經真的走到主入口驗過；
//      ✅ 解析器層「表頭讀不到 → headerFound=false」＝既有 test/taishin-securities.test.js 有守；
//      ❌ 「主入口拿 headerFound 去 throw 400」這條接線＝**仍然沒有考題**（需要中文 PDF）。
//    對應處置：既有那兩題的**題目名稱**原本宣稱「主入口據此 throw 400」＝過度宣稱，
//    已在同一支 PR 改成只講它實際驗的事（保證要有考題撐著）。
