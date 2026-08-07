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

function annualPremiumOf(source) {
  const block = functionBlock(source, 'const PREMIUM_MULTIPLIER', '\n\nfunction paymentMeta(');
  return Function(`${block}; return annualPremiumOf;`)();
}

function policyCardOf(source) {
  const cycles = functionBlock(source, 'const CYCLES =', '\nconst PREMIUM_MULTIPLIER');
  const payment = functionBlock(source, 'function paymentMeta(', '\n\nfunction coverageMeta(');
  const coverage = functionBlock(source, 'function coverageMeta(', '\n\nexport async function renderInsurance()');
  const card = functionBlock(source, 'function policyCard(', '\n\nfunction openInsForm(');
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const daysUntil = value => String(value).startsWith('next') ? -3 : String(value).startsWith('end') ? 40 : Infinity;
  return Function('daysUntil', 'esc', 'money', 'icon', `${cycles}${payment}${coverage}${card}; return policyCard;`)(
    daysUntil, esc, value => `MONEY:${value}`, () => 'ICON'
  );
}

function assertPolicyCardBehavior(source) {
  const html = policyCardOf(source)({
    id: 'id"><script>ID_PAYLOAD</script>',
    policyName: '<img src=x onerror=NAME_PAYLOAD>',
    insurer: '<b>INSURER_PAYLOAD</b>',
    policyholder: '<i>HOLDER_PAYLOAD</i>',
    insured: '<u>INSURED_PAYLOAD</u>',
    beneficiary: '<em>BENEFICIARY_PAYLOAD</em>',
    premium: 1200,
    premiumCycle: '<strong>CYCLE_PAYLOAD</strong>',
    nextPayment: 'next"><img src=x onerror=DATE_PAYLOAD>',
    startDate: '<q>START_PAYLOAD</q>',
    endDate: 'end"><svg onload=END_PAYLOAD>',
    cashValue: 3400,
    coverage: '<textarea>COVERAGE_PAYLOAD</textarea>',
  });

  for (const raw of [
    '<img', '<script', '<b>INSURER', '<i>HOLDER', '<u>INSURED',
    '<em>BENEFICIARY', '<strong>CYCLE', '<q>START', '<svg onload=END', '<textarea>COVERAGE',
  ]) {
    assert.doesNotMatch(html, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `使用者文字不可原樣插入：${raw}`);
  }
  for (const marker of [
    'NAME_PAYLOAD', 'INSURER_PAYLOAD', 'HOLDER_PAYLOAD', 'INSURED_PAYLOAD',
    'BENEFICIARY_PAYLOAD', 'CYCLE_PAYLOAD', 'DATE_PAYLOAD', 'START_PAYLOAD',
    'END_PAYLOAD', 'COVERAGE_PAYLOAD',
  ]) assert.match(html, new RegExp(marker));
  assert.match(html, /insurance-payment-status danger/);
  assert.match(html, /已過 3 天/);
  assert.match(html, /insurance-coverage-status warning/);
  assert.match(html, /40 天後到期/);
  assert.match(html, /data-edit="id&quot;&gt;&lt;script&gt;ID_PAYLOAD/);
  assert.match(html, /data-del="id&quot;&gt;&lt;script&gt;ID_PAYLOAD/);
}

function assertInsuranceStructure(source) {
  const render = functionBlock(source, 'export async function renderInsurance()', '\nfunction policyCard(');
  const card = functionBlock(source, 'function policyCard(', '\n\nfunction openInsForm(');
  const form = source.slice(source.indexOf('function openInsForm('));
  for (const marker of [
    'class="insurance-page"',
    'class="insurance-summary"',
    'class="insurance-attention',
    'class="insurance-policy-section"',
    'class="insurance-policy-grid"',
    'class="insurance-empty"',
    'id="addIns"',
  ]) assert.match(render, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(render, /if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(render, /const annual = annualPremiumOf\(list\);/);
  assert.match(render, /return d >= 0 && d <= 30;/);
  assert.match(render, /wan\(annual\)/);
  assert.match(card, /esc\(p\.policyName\)/);
  assert.match(card, /esc\(p\.coverage \|\| '尚未填寫保障內容'\)/);
  assert.match(form, /if \(seq === currentRouteSeq\(\)\) renderInsurance\(\);/);
}

function assertInsuranceCss(css, index) {
  const tablet = cssBlock(css, '@media (max-width: 1100px)');
  const mobile = cssBlock(css, '@media (max-width: 700px)');
  assert.match(index, /<link rel="stylesheet" href="insurance\.css" \/>/);
  assert.match(css, /\.insurance-page button,[\s\S]*\.insurance-page \.btn-danger \{ border-radius: 8px; \}/);
  assert.match(css, /\.insurance-page-head \.page-eyebrow \{[^}]*color: var\(--accent-ink\);[^}]*font-weight: 700;/);
  assert.match(css, /\.insurance-summary \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.insurance-policy-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.insurance-policy \{[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(tablet, /\.insurance-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(tablet, /\.insurance-policy-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(mobile, /\.insurance-page-head \.page-actions \.btn \{ width: 100%; \}/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|action-hover|action-soft|pos|pos-soft)\)/,
    '綠色只由共用主要按鈕提供，保險頁容器維持米橘色');
}

test('保險追蹤 UI：摘要、時程提醒與保單清單形成單一工作面', () => {
  assertInsuranceStructure(read('public/modules/insurance.js'));
});

test('保險追蹤 UI：年化保費維持既有週期換算，躉繳不重複計入', () => {
  const calculate = annualPremiumOf(read('public/modules/insurance.js'));
  assert.equal(calculate([
    { premium: 100, premiumCycle: 'yearly' },
    { premium: 100, premiumCycle: 'semiannual' },
    { premium: 100, premiumCycle: 'quarterly' },
    { premium: 100, premiumCycle: 'monthly' },
    { premium: 100, premiumCycle: 'single' },
    { premium: 100, premiumCycle: 'legacy' },
  ]), 2000);
});

test('保單卡片：所有可輸入文字與操作 id 都經輸出消毒，狀態標示可辨識', () => {
  assertPolicyCardBehavior(read('public/modules/insurance.js'));
});

test('保險追蹤 UI：獨立暖色樣式支援雙欄桌機、單欄窄畫面與 2×2 摘要', () => {
  assertInsuranceCss(read('public/insurance.css'), read('public/index.html'));
});

test('保險追蹤 UI：破壞安全輸出、路由守衛、圓角或窄畫面配置時考題會紅', () => {
  const source = read('public/modules/insurance.js');
  const routeGuard = 'if (seq !== currentRouteSeq()) return;';
  assert.ok(source.includes(routeGuard), '突變目標必須存在：讀取後路由守衛');
  assert.throws(() => assertInsuranceStructure(source.replace(routeGuard, '// route guard removed')));

  const saveGuard = 'if (seq === currentRouteSeq()) renderInsurance();';
  assert.ok(source.includes(saveGuard), '突變目標必須存在：儲存後路由守衛');
  assert.throws(() => assertInsuranceStructure(source.replace(saveGuard, 'renderInsurance();')));

  const safeName = '${esc(p.policyName)}';
  assert.ok(source.includes(safeName), '突變目標必須存在：保單名稱輸出消毒');
  assert.throws(() => assertPolicyCardBehavior(source.replace(safeName, '${p.policyName}')));
  const safeCoverage = "${esc(p.coverage || '尚未填寫保障內容')}";
  assert.ok(source.includes(safeCoverage), '突變目標必須存在：保障內容輸出消毒');
  assert.throws(() => assertPolicyCardBehavior(source.replace(safeCoverage, "${p.coverage || '尚未填寫保障內容'}")));

  const css = read('public/insurance.css');
  const index = read('public/index.html');
  assert.throws(() => assertInsuranceCss(css.replace('border-radius: 8px;', 'border-radius: 0;'), index));
  const eyebrowInk = 'color: var(--accent-ink);';
  assert.ok(css.includes(eyebrowInk), '突變目標必須存在：頁首眉標深橘文字');
  assert.throws(() => assertInsuranceCss(css.replace(eyebrowInk, 'color: var(--text-dim);'), index));
  assert.throws(() => assertInsuranceCss(css.replace('.insurance-policy-grid { grid-template-columns: 1fr; }', '.insurance-policy-grid { grid-template-columns: repeat(2, 1fr); }'), index));
  assert.throws(() => assertInsuranceCss(css.replace('.insurance-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }', '.insurance-summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }'), index));
  assert.throws(() => assertInsuranceCss(css, index.replace('<link rel="stylesheet" href="insurance.css" />', '')));
});
