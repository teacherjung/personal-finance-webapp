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

const pageLayout = {
  pos: days => 7 + days / 30 * 86,
  topLevels: [8, 46],
  bottomLevels: [122],
  labelH: 42,
  groupLabelH: 82,
  labelSpan: 13,
  groupLabelSpan: 34,
  groupBadgeSpan: 3,
  edgeAware: true,
  bottomStep: 46,
};

function overlap(a, b) {
  return a.labelLeft < b.labelRight + 1 && a.labelRight > b.labelLeft - 1
    && a.labelTop < b.labelTop + b.labelHeight + 4
    && a.labelTop + a.labelHeight > b.labelTop - 4;
}

function stemHitsLabel(point, label) {
  const stemBottom = point.lineTop + point.lineHeight;
  return point.left > label.labelLeft && point.left < label.labelRight
    && point.lineTop < label.labelTop + label.labelHeight
    && stemBottom > label.labelTop;
}

function assertClear(points) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      assert.equal(overlap(points[i], points[j]), false,
        `${points[i].name} 不可與 ${points[j].name} 重疊`);
      assert.equal(stemHitsLabel(points[i], points[j]), false,
        `${points[i].name} 的連線不可穿過 ${points[j].name}`);
      assert.equal(stemHitsLabel(points[j], points[i]), false,
        `${points[j].name} 的連線不可穿過 ${points[i].name}`);
    }
  }
}

test('續費時間線：同一天三筆合成一個節點，保留逐筆內容與正確合計', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const result = timelinePoints(sampleSubscriptions(), pageLayout);

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
  const result = timelinePoints([sampleSubscriptions()[0]], pageLayout);

  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].grouped, false);
  assert.equal(result.points[0].name, 'Claude Pro');
  assert.equal(result.points[0].amount, 6990);
  assert.equal(result.points[0].items.length, 1);
});

test('續費時間線：邊緣雙群組與鄰近單筆依矩形錯開，不靠天數猜距離', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const rows = [
    { name: 'A1', amount: 100, nextCharge: 'day-2', category: '工具' },
    { name: 'A2', amount: 200, nextCharge: 'day-2', category: '工具' },
    { name: 'B1', amount: 300, nextCharge: 'day-12', category: '工具' },
    { name: 'B2', amount: 400, nextCharge: 'day-12', category: '工具' },
    { name: '附近單筆', amount: 500, nextCharge: 'day-13', category: '工具' },
  ];
  const result = timelinePoints(rows, pageLayout);

  assertClear(result.points);
  assert.ok(result.points.some(point => point.grouped && point.side === 'bottom'), '第二張群組卡須讓到下方');
  assert.equal(result.points.find(point => point.name === '附近單筆')?.lineHeight, 0,
    '上下都被卡片封住時，連線須隱藏而非穿過金額');
});

test('續費時間線：四筆以上維持固定卡高，新增下層時容器跟著增高', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const rows = [
    ...['A', 'B', 'C', 'D'].map((name, index) => ({ name, amount: 100 + index, nextCharge: 'day-2', category: '工具' })),
    { name: 'E1', amount: 500, nextCharge: 'day-12', category: '工具' },
    { name: 'E2', amount: 600, nextCharge: 'day-12', category: '工具' },
    { name: '附近單筆', amount: 700, nextCharge: 'day-13', category: '工具' },
  ];
  const result = timelinePoints(rows, pageLayout);
  const bottom = result.points.filter(point => point.side === 'bottom');
  const deepest = Math.max(...bottom.map(point => point.labelTop + point.labelHeight));

  assert.equal(result.points.find(point => point.days === 2)?.labelHeight, 82);
  assert.ok(result.timelineHeight >= deepest + 14, '最深標籤下方須保留空間');
  assert.ok(result.timelineHeight > 224, '需要額外層級時不得塞回固定高度');
});

test('續費時間線：群組筆數徽章納入右側避讓範圍', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const withBadge = timelinePoints(sampleSubscriptions(), pageLayout);
  const withoutBadge = timelinePoints(sampleSubscriptions(), { ...pageLayout, groupBadgeSpan: 0 });
  const grouped = withBadge.points.find(point => point.days === 28);
  const groupedWithoutBadge = withoutBadge.points.find(point => point.days === 28);

  assert.equal(grouped.labelRight, groupedWithoutBadge.labelRight + pageLayout.groupBadgeSpan,
    '群組右界須包含筆數徽章，附近標籤才會避開');
  assertClear(withBadge.points);
});

test('續費時間線：列印版依最深標籤增高，不覆蓋下一個區塊', () => {
  const timelinePoints = loadTimelinePoints(read('public/modules/subscriptions.js'));
  const reportLayout = {
    pos: days => Math.max(5, Math.min(95, 5 + days / 30 * 90)),
    topLevels: [12, 44], bottomLevels: [122, 154, 186], labelH: 40, minHeight: 210,
  };
  const sparse = timelinePoints([sampleSubscriptions()[0]], reportLayout);
  const rows = Array.from({ length: 8 }, (_, day) => ({
    name: `服務 ${day + 1}`, amount: 100 + day, nextCharge: `day-${day + 10}`, category: '工具'
  }));
  const result = timelinePoints(rows, reportLayout);
  const deepest = Math.max(...result.points.filter(point => point.side === 'bottom')
    .map(point => point.labelTop + point.labelHeight));

  assert.equal(sparse.timelineHeight, 210, '疏鬆的列印時間線維持原本高度');
  assert.ok(result.timelineHeight >= deepest + 14);
  assert.ok(result.timelineHeight > 210, '密集列印時間線須比固定底高更高');

  const report = read('public/modules/subscriptions-report.js');
  assert.match(report, /labelH: 40, minHeight: 210/);
  assert.match(report, /--report-timeline-height:\$\{timelineHeight\}px/);
  assert.match(report, /\.report-timeline \{[^}]*height: var\(--report-timeline-height, 210px\)/s,
    '列印時間線容器須接上動態高度');
  assert.match(report, /\.report-tl-point \{[^}]*height: var\(--report-timeline-height, 210px\)/s,
    '列印時間點須與容器使用同一高度');
});

test('續費時間線：頁面使用群組卡、筆數徽章與右緣防溢位樣式', () => {
  const source = read('public/modules/subscriptions.js');
  const css = read('public/styles.css');
  assert.match(source, /class="tl-label tl-group-card/);
  assert.match(source, /p\.items\.slice\(0, p\.items\.length > 3 \? 2 : 3\)/);
  assert.match(source, /class="tl-dot-count">\$\{p\.items\.length\}<\/span>/);
  assert.match(source, /groupBadgeSpan: 3/);
  assert.match(source, /--timeline-height:\$\{timelineHeight\}px/);
  assert.match(css, /\.timeline \{[^}]*height: var\(--timeline-height, 224px\)/s);
  assert.match(css, /\.tl-group-card\.edge-right \{ transform: translateX\(-94%\); \}/);
  assert.match(css, /height: 82px;/);
  assert.match(css, /\.tl-dot-count \{/);
});
