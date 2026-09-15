// 守時間點契約（r3 High①）：沒帶時區的時間不收；同一份輸入在不同執行時區要判一樣。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseInstant } = require('../tools/time-point.js');

test('帶 Z 或明確 offset 才收；只有日期、沒時區、亂字都回 null', () => {
  assert.equal(parseInstant('2026-09-13T03:00:00Z'), Date.UTC(2026, 8, 13, 3));
  assert.equal(parseInstant('2026-09-13T05:00:00+02:00'), Date.UTC(2026, 8, 13, 3), 'offset 要折成同一個時間點');
  assert.equal(parseInstant('2026-09-13T03:00Z'), Date.UTC(2026, 8, 13, 3), '秒可省');
  assert.equal(parseInstant('2026-09-13T03:00:00.250Z'), Date.UTC(2026, 8, 13, 3, 0, 0, 250));
  for (const bad of ['2026-09-13T03:00:00', '2026-09-13', '2026-09-13 03:00:00Z', 'not-a-time', '', null, 42, '2026-13-40T00:00:00Z']) {
    assert.equal(parseInstant(bad), null, JSON.stringify(bad));
  }
});

test('不存在的日曆時間不收（r4 Medium①：轉換器會把 2 月 30 日進位成 3 月 2 日）；合法的閏日與跨日時區照收', () => {
  for (const bad of [
    '2026-02-29T03:00:00Z', '2026-02-30T03:00:00Z', '2026-04-31T03:00:00Z', '1900-02-29T00:00:00Z',   // 非閏年、不存在的日子、百年不閏
    '2026-00-10T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-32T00:00:00Z',
    '2026-09-13T24:00:00Z', '2026-09-13T23:60:00Z', '2026-09-13T23:59:60Z',                         // 24 點、60 分、閏秒
    '2026-09-13T03:00:00+24:00', '2026-09-13T03:00:00+05:60',                                         // 時區值域
  ]) assert.equal(parseInstant(bad), null, bad);
  assert.equal(parseInstant('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29), '四年一閏');
  assert.equal(parseInstant('2000-02-29T12:00:00Z'), Date.UTC(2000, 1, 29, 12), '四百年又閏');
  assert.equal(parseInstant('2026-12-31T23:30:00-02:00'), Date.UTC(2027, 0, 1, 1, 30), '跨日（跨年）的時區折算');
  assert.equal(parseInstant('2026-01-01T00:30:00+05:45'), Date.UTC(2025, 11, 31, 18, 45), '非整點時區往前跨年');
  // 對照值用語言規格明定的那一種寫法（三位毫秒＋Z）去讀，跟實作走不同的路
  assert.equal(parseInstant('0050-03-01T00:00:00Z'), Date.parse('0050-03-01T00:00:00.000Z'), '0〜99 年不可以被當成 1900 年代');
  assert.notEqual(parseInstant('0050-03-01T00:00:00Z'), Date.UTC(50, 2, 1), '控制組：Date.UTC 會把 50 年當 1950 年');
  assert.equal(parseInstant('2026-09-13T03:00:00.1239Z'), parseInstant('2026-09-13T03:00:00.123Z'), '毫秒以下截掉＝同一刻');
  assert.equal(parseInstant('2026-09-13T03:00:00.1Z'), Date.UTC(2026, 8, 13, 3, 0, 0, 100), '一位小數是 100 毫秒');
});

test('同一份輸入在 TZ=UTC 與 TZ=Asia/Taipei 判一樣（沒時區的一律 null，有時區的數值相同）', () => {
  const script = `const { parseInstant } = require(${JSON.stringify(require.resolve('../tools/time-point.js'))});
    process.stdout.write(JSON.stringify([parseInstant('2026-09-13T03:00:00'), parseInstant('2026-09-13T03:00:00Z'), parseInstant('2026-09-13T05:00:00+02:00')]));`;
  const outs = ['UTC', 'Asia/Taipei', 'America/Los_Angeles'].map((tz) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).stdout);
  assert.equal(new Set(outs).size, 1, `三個時區的結果不一樣：${outs.join(' | ')}`);
  assert.deepEqual(JSON.parse(outs[0]), [null, Date.UTC(2026, 8, 13, 3), Date.UTC(2026, 8, 13, 3)]);
});
