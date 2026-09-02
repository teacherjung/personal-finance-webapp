import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function functionSource(source, name, endMarker) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `找不到正式函式：${name}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `找不到正式函式結尾：${name}`);
  return source.slice(start, end).trim().replace('export ', '');
}

function loadTimelinePoints(source) {
  const fn = functionSource(source, 'timelinePoints', '// 續費時間線卡片（頁面版）');
  return Function('subStatus', 'isLifetimeSub', 'daysUntil', `${fn}; return timelinePoints;`)(
    () => 'active',
    () => false,
    value => Number(String(value).replace('day-', '')),
  );
}

function sampleSubscriptions() {
  return [
    { name: 'Claude Pro', amount: 6990, nextCharge: 'day-12', category: '工具' },
    { name: 'ChatGPT Pro', amount: 3300, nextCharge: 'day-20', category: '工具' },
    { name: '健身工廠', amount: 1088, nextCharge: 'day-25', category: '健康' },
    { name: 'YouTube', amount: 630, nextCharge: 'day-28', category: '娛樂' },
    { name: 'iCloud 2TB', amount: 300, nextCharge: 'day-28', category: '工具' },
    { name: 'Grok AI', amount: 9999, nextCharge: 'day-28', category: '工具' },
  ];
}

test('續費時間線：同一天三筆合成一個節點，保留逐筆內容與正確合計', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const result = timelinePoints(sampleSubscriptions(), {
    pos: days => days,
    topLevels: [10, 42],
    bottomLevels: [122, 154, 186],
    labelH: 42,
    groupLabelH: 72,
  });

  assert.equal(result.upcoming.length, 6, '合計仍須使用原本六筆續費，不能因分組少算');
  assert.equal(result.points.length, 4, '同日三筆只佔一個時間點');
  const grouped = result.points.find(point => point.days === 28);
  assert.ok(grouped?.grouped);
  assert.equal(grouped.name, '3 筆續費');
  assert.equal(grouped.amount, 10929);
  assert.deepEqual(grouped.items.map(item => item.name), ['YouTube', 'iCloud 2TB', 'Grok AI']);
  assert.equal(grouped.side, 'top', '群組卡優先放上方，附近單筆移到另一側');
  assert.equal(result.points.find(point => point.days === 25)?.side, 'bottom');
});

test('續費時間線：單筆日期維持原本標籤資料，不被誤包成群組', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const result = timelinePoints([sampleSubscriptions()[0]], {
    pos: days => days,
    topLevels: [10, 42],
    bottomLevels: [122, 154, 186],
    labelH: 42,
  });

  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].grouped, false);
  assert.equal(result.points[0].name, 'Claude Pro');
  assert.equal(result.points[0].amount, 6990);
  assert.equal(result.points[0].items.length, 1);
});

test('續費時間線：頁面使用群組卡、筆數徽章與右緣防溢位樣式', () => {
  const source = read('public/modules/subscriptions.js');
  const css = read('public/styles.css');
  assert.match(source, /class="tl-label tl-group-card/);
  assert.match(source, /p\.items\.slice\(0, 3\)/);
  assert.match(source, /class="tl-dot-count">\$\{p\.items\.length\}<\/span>/);
  assert.match(css, /\.tl-group-card\.edge-right \{ transform: translateX\(-94%\); \}/);
  assert.match(css, /\.tl-dot-count \{/);
});
