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

function assertCardsStructure(source) {
  const render = functionBlock(source, 'export async function renderCards()', '\nfunction cardSection(');
  const panel = functionBlock(source, 'function cardPanel(', '\n\nfunction openCardForm(');
  const form = source.slice(source.indexOf('function openCardForm('));
  for (const marker of [
    'class="cards-page"',
    'class="card-tracker-summary"',
    'class="card-privacy-note"',
    "cardSection('信用卡'",
    "cardSection('會員卡'",
    'id="addCard"',
  ]) assert.match(render, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(render, /catch \(error\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = cardsLoadErrorHtml/,
    '載入失敗晚到時不可蓋掉新頁面');
  assert.match(render, /\}\s*if \(seq !== currentRouteSeq\(\)\) return;[^\n]*\n\s*const summary/,
    '載入成功晚到時不可蓋掉新頁面');
  assert.match(render, /wan\(summary\.annualFees\)/);
  assert.match(panel, /esc\(c\.name\)/);
  assert.match(panel, /c\.lastFour/);
  assert.match(panel, /esc\(expiry\.text\)/);
  assert.doesNotMatch(panel, /pdfPassword/, '卡片工作面不可讀取或顯示帳單密碼');
  assert.match(form, /\.\.\.\(c\?\.pdfPasswordSet \?/);
  assert.match(form, /if \(c && clearPw\) data\.pdfPassword = '';/);
  assert.match(form, /else if \(c && \(data\.pdfPassword == null \|\| data\.pdfPassword === ''\)\) delete data\.pdfPassword;/);
  assert.match(form, /if \(seq === currentRouteSeq\(\)\) \{[\s\S]*rerenderCardsAfterSave\(seq, message\);/);
}

function assertCardsCss(css, index) {
  const tablet = cssBlock(css, '@media (max-width: 1100px)');
  const mobile = cssBlock(css, '@media (max-width: 700px)');
  assert.match(index, /<link rel="stylesheet" href="cards\.css" \/>/);
  assert.match(css, /\.cards-page button,[\s\S]*\.cards-page \.btn-danger \{ border-radius: 8px; \}/);
  assert.match(css, /\.card-tracker-summary \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.card-tracker-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(tablet, /\.card-tracker-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(mobile, /\.cards-page-head \.page-actions \.btn \{ width: 100%; \}/);
  assert.match(mobile, /\.card-facts \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(css, /@media \(max-width: 420px\)[\s\S]*\.card-tracker-summary \{ grid-template-columns: 1fr; \}/,
    '手機摘要維持 2×2，不把四個數字拉成四層');
  assert.doesNotMatch(css, /var\(--(?:action|action-hover|action-soft|pos|pos-soft)\)/,
    '綠色只由共用主要按鈕提供，卡片頁容器維持米橘色');
}

test('卡片追蹤 UI：摘要、隱私提醒與兩類卡片形成單一工作面', () => {
  assertCardsStructure(read('public/modules/cards.js'));
});

test('卡片追蹤 UI：獨立暖色樣式支援雙欄桌機與單欄窄畫面', () => {
  assertCardsCss(read('public/cards.css'), read('public/index.html'));
});

test('卡片追蹤 UI：到期摘要沿用月底判準，年費仍走共用萬格式器', () => {
  const source = read('public/modules/cards.js');
  const summary = functionBlock(source, 'function cardSummary(', '\n\nfunction expiryMeta(');
  assert.match(summary, /daysUntil\(expiryEnd\(c\.expiry\)\)/);
  assert.match(summary, /days >= 0 && days <= 30/);
  assert.match(summary, /Number\(c\.annualFee \|\| 0\)/);
  assert.match(source, /wan\(summary\.annualFees\)/);
});

test('卡片追蹤 UI：拿掉路由守衛、機密保護、圓角或手機配置時考題會紅', () => {
  const source = read('public/modules/cards.js');
  const errorGuard = "catch (error) {\n    if (seq !== currentRouteSeq()) return;\n    view().innerHTML = cardsLoadErrorHtml";
  const successGuard = "}\n  if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁";
  assert.ok(source.includes(errorGuard), '失敗路徑守衛突變目標必須存在');
  assert.ok(source.includes(successGuard), '成功路徑守衛突變目標必須存在');
  assert.throws(() => assertCardsStructure(source.replace(errorGuard, errorGuard.replace('if (seq !== currentRouteSeq()) return;', '// route guard removed'))));
  assert.throws(() => assertCardsStructure(source.replace(successGuard, successGuard.replace('if (seq !== currentRouteSeq()) return;', '// route guard removed'))));
  assert.ok(source.includes('c.lastFour'), '突變目標必須存在：末四碼');
  assert.throws(() => assertCardsStructure(source.replace('c.lastFour', 'c.pdfPassword')));
  assert.throws(() => assertCardsStructure(source.replace('esc(expiry.text)', 'expiry.text')));
  const clear = "if (c && clearPw) data.pdfPassword = '';";
  assert.ok(source.includes(clear), '突變目標必須存在：明確清除機密');
  assert.throws(() => assertCardsStructure(source.replace(clear, '// explicit clear removed')));

  const css = read('public/cards.css');
  const index = read('public/index.html');
  assert.throws(() => assertCardsCss(css.replace('border-radius: 8px;', 'border-radius: 0;'), index));
  assert.throws(() => assertCardsCss(css.replace('.card-tracker-grid { grid-template-columns: 1fr; }', '.card-tracker-grid { grid-template-columns: repeat(2, 1fr); }'), index));
  assert.throws(() => assertCardsCss(css, index.replace('<link rel="stylesheet" href="cards.css" />', '')));
});
