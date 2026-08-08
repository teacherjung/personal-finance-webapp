import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function functionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `找不到正式函式：${startMarker}`);
  return source.slice(start, end);
}

function cssBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 CSS 區塊：${marker}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `CSS 區塊缺少左大括號：${marker}`);
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`CSS 區塊缺少右大括號：${marker}`);
}

function assertSubscriptionsStructure(source) {
  const render = functionBlock(source, 'export async function renderSubscriptions(', '\nfunction syncSubscriptionColumnWidths()');
  for (const marker of [
    'class="subscriptions-page"',
    'class="subscriptions-summary"',
    'class="subscriptions-section subscriptions-workspace"',
    'class="subscriptions-section subscriptions-lifecycle"',
    'class="subscriptions-section subscriptions-analysis"',
    'class="active-subscription-group"',
    'id="historySection"',
  ]) assert.ok(render.includes(marker), `缺少訂閱工作面結構：${marker}`);
  const head = functionBlock(source, 'function subscriptionsPageHeadHtml(', '\nfunction subscriptionNoticeHtml(');
  for (const marker of ['id="addSub"', 'id="printSubs"']) {
    assert.ok(head.includes(marker), `缺少訂閱頁首操作：${marker}`);
  }
  assert.match(render, /const thisMonth = sumMonth\(curMk\);/);
  assert.match(render, /const nextMonth = sumMonth\(nextMk\);/);
  assert.match(render, /fmtFee\(thisMonth \* 12\)/);
  assert.equal((render.match(/if \(seq !== currentRouteSeq\(\)\) return;/g) || []).length, 3,
    '讀取、自動更新與錯誤狀態的三道路由守衛都必須保留');
  assert.match(render, /renderHistorySection\(byId\('historySection'\)\);/);
}

function assertSubscriptionsCss(css, index) {
  const tablet = cssBlock(css, '@media (max-width: 1100px)');
  const mobile = cssBlock(css, '@media (max-width: 700px)');
  const phone = cssBlock(css, '@media (max-width: 430px)');
  assert.match(index, /<link rel="stylesheet" href="subscriptions\.css" \/>/);
  assert.match(css, /\.subscriptions-page button,[\s\S]*\.subscriptions-page \.btn-danger \{ border-radius: 8px; \}/);
  assert.match(css, /\.subscriptions-page-head \.page-eyebrow \{[^}]*color: var\(--accent-ink\);[^}]*font-weight: 700;/);
  assert.match(css, /\.subscriptions-summary \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.subscriptions-summary-item > small\.pos \{ color: var\(--pos\); \}/,
    '下月費用變便宜時必須保留正向財務語意色');
  assert.match(css, /\.subscriptions-summary-item > small\.neg \{ color: var\(--neg\); \}/,
    '下月費用變貴時必須保留負向財務語意色');
  assert.match(css, /\.subscriptions-attention-mark \{[^}]*background: rgba\(184, 74, 57, \.12\);/,
    '失效卡片提示要有可見的淡紅底色');
  assert.doesNotMatch(css, /var\(--neg-soft\)/, '不可引用未定義的色彩 token');
  assert.match(css, /\.subscriptions-page \.active-subscription-group \{[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(tablet, /\.subscriptions-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(mobile, /\.subscriptions-section-head \{ align-items: flex-start; flex-direction: column;/);
  assert.match(phone, /\.subscriptions-summary \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|action-hover|action-soft|pos|pos-soft)\)/,
    '綠色只由共用主要按鈕提供，訂閱頁容器維持米橘色');
}

test('訂閱追蹤 UI：費用摘要、使用中清單、停用流程與分析形成單一工作面', () => {
  assertSubscriptionsStructure(read('public/modules/subscriptions.js'));
});

test('訂閱追蹤 UI：獨立暖色樣式支援桌機、平板與手機摘要重排', () => {
  assertSubscriptionsCss(read('public/subscriptions.css'), read('public/index.html'));
});

test('訂閱追蹤 UI：破壞路由守衛、年化口徑、圓角或窄畫面配置時考題會紅', () => {
  const source = read('public/modules/subscriptions.js');
  const guard = "[raw, cards] = await Promise.all([api('/subscriptions'), api('/cards')]);\n    if (seq !== currentRouteSeq()) return;";
  assert.ok(source.includes(guard), '突變目標必須存在：讀取後路由守衛');
  assert.throws(() => assertSubscriptionsStructure(source.replace(guard,
    "[raw, cards] = await Promise.all([api('/subscriptions'), api('/cards')]);\n    // route guard removed")));
  const annual = 'fmtFee(thisMonth * 12)';
  assert.ok(source.includes(annual), '突變目標必須存在：年化固定支出口徑');
  assert.throws(() => assertSubscriptionsStructure(source.replace(annual, 'fmtFee(nextMonth * 12)')));

  const css = read('public/subscriptions.css');
  const index = read('public/index.html');
  const positiveDelta = '.subscriptions-summary-item > small.pos { color: var(--pos); }';
  assert.ok(css.includes(positiveDelta), '突變目標必須存在：下月費用正向語意色');
  assert.throws(() => assertSubscriptionsCss(css.replace(positiveDelta,
    '.subscriptions-summary-item > small.pos { color: var(--text-dim); }'), index));
  assert.throws(() => assertSubscriptionsCss(css.replace('border-radius: 8px;', 'border-radius: 0;'), index));
  assert.throws(() => assertSubscriptionsCss(css.replace('.subscriptions-summary { grid-template-columns: 1fr; }', '.subscriptions-summary { grid-template-columns: repeat(2, 1fr); }'), index));
  assert.throws(() => assertSubscriptionsCss(css, index.replace('<link rel="stylesheet" href="subscriptions.css" />', '')));
});
