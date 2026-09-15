#!/usr/bin/env node
// 「時間點」的契約只有這一份（里程碑 3 r3 High①、r4 Medium①）：平台給的時間，要是**合法的日曆時間、帶時區**才收。
//
// 為什麼：三支工具（真考卷閘、結論聯集閘、待裁清單）都拿平台的時間判先後。「Date.parse 讀得出」不夠——
// ①沒有時區的日期時間，語言規格明定照**執行機器的本機時區**解讀，於是同一份資料在 TZ=UTC 放行、
//   在 TZ=Asia/Taipei 擋下；平台回的字串一個字都沒變。
// ②轉換器會把不存在的日子「進位」成另一個真的日子（2 月 30 日變成 3 月 2 日），於是一筆壞資料
//   被當成比較晚的可靠依據（r4 實測三支都放行）。所以值域自己驗、時間值自己算，不問轉換器收不收。
//
// 收件：完整的日期＋時間、秒可省、小數最多九位，結尾一定是 Z 或明確的 ±HH:MM。
//   月 01〜12、日不超過那個月真有的天數（閏年照格里曆：四年一閏、百年不閏、四百年又閏）、
//   時 00〜23、分 00〜59、秒 00〜59、時區的時 00〜23 與分 00〜59。其餘（只有日期、沒有時區、
//   不存在的日子、24 點、閏秒 60、亂字）一律回 null，消費端當「查不清楚」退 2。
// 回值是毫秒：小數第四位以後直接截掉，所以只差在毫秒以下的兩個時間算**同一刻**。
'use strict';

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, mo) => (mo === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31);

/** 回毫秒數；不是合法的日曆時間、或沒帶時區＝null。 */
function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const m = INSTANT.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return null;
  let offsetMin = 0;
  if (m[8]) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[8] === '+' ? 1 : -1) * (oh * 60 + om);
  }
  // 用 setUTCFullYear 不用 Date.UTC：後者把 0〜99 年當成 1900 年代
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  return t.getTime() - offsetMin * 60000;
}

module.exports = { parseInstant, INSTANT };
