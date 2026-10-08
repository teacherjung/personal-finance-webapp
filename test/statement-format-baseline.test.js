// 合成檔案只驗文字層與欄位映射，不代表銀行真實版面已校準。
// 分類與店名顯示由既有專卷驗證；這裡不把它們寫入格式答案，以免無關調整迫使重錄版型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseStatement, parseStatementFromLines, parseStatementFromXlsx } from '../lib/statement.js';
import { cjkPdf } from './helpers/build-pdf.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/statements/card-formats.json', import.meta.url), 'utf8'));
// 清單獨立於資料檔，避免誤刪案例後迴圈少跑一題仍回報全部通過。
assert.deepEqual(cases.map((/** @type {any} */ c) => c.id), [
  'fubon-mail', 'fubon-web', 'taishin-mail', 'taishin-reprint', 'taishin-xlsx',
]);

/** @param {import('../lib/statement.js').StatementResult} parsed */
function formatResult(parsed) {
  const { bank, bankEvidence, lastFour, statementMonth, statementDue, statementTotals } = parsed;
  return {
    bank, bankEvidence, lastFour, statementMonth, statementDue, statementTotals,
    transactions: parsed.transactions.map(({ date, postDate, desc, amount, isPayment, isRefund }) =>
      ({ date, postDate, desc, amount, isPayment, isRefund })),
  };
}

for (const fixture of cases) {
  test(`格式基準｜${fixture.label}｜文字列逐欄對手寫答案`, () => {
    const rows = structuredClone(fixture.rows);
    const result = fixture.format === 'pdf'
      ? parseStatementFromLines(rows)
      : parseStatementFromXlsx(rows, rows.map((/** @type {any[]} */ r) => r.join(' ')).join('\n'));
    assert.deepEqual(formatResult(result), fixture.expected);
  });

  test(`格式基準｜${fixture.label}｜合成檔案走正式入口逐欄對手寫答案`, async () => {
    let data;
    if (fixture.format === 'pdf') {
      // 窄字級與格距讓外幣尾欄留在頁寬內；不拿這組等寬近似驗銀行座標分欄。
      data = cjkPdf(fixture.rows, { fontSize: 8, colGap: 24 });
    } else {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(fixture.rows), 'Synthetic');
      data = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
    }
    const result = await parseStatement(data);
    assert.deepEqual(formatResult(result), fixture.expected);
  });
}
