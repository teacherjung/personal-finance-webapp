import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function assertAssetsStructure(source) {
  assert.match(source, /<div class="assets-page">/);
  assert.match(source, /<aside class="assets-scope-note" aria-label="資產配置資料口徑">/);
  assert.match(source, /<section class="asset-kpi-frame" aria-label="資產摘要">/);
  assert.match(source, /<section class="assets-layout">/);
  assert.match(source, /class="asset-allocation-list"/);
  assert.match(source, /class="assets-account-table"/);

  for (const id of ['rebalBtn', 'editTargets', 'addAcc', 'pie']) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} 接線不可因整理版面消失`);
  }
  assert.match(source, /if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(source, /esc\(r\.class\)/);
  assert.match(source, /esc\(x\.name\)/);
  assert.doesNotMatch(source, /CHART\.green/);
  assert.doesNotMatch(source, /class="tag \$\{liab \? 'amber' : 'blue'\}"/);
}

function assertAssetsCss(css) {
  const start = css.indexOf('/* ---------- 資產配置（UI5） ---------- */');
  const end = css.indexOf('/* ---------- 理財中心總覽（UI2） ---------- */');
  assert.ok(start >= 0 && end > start, '找不到資產配置專屬樣式區塊');
  const block = css.slice(start, end);

  assert.match(block, /\.asset-kpi-frame \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(block, /\.assets-layout \{[^}]*grid-template-columns: minmax\(300px, \.82fr\) minmax\(460px, 1\.18fr\);/);
  assert.match(block, /\.asset-allocation-track \{[^}]*border: 1px solid var\(--frame\);/);
  assert.match(block, /\.asset-allocation-fill \{[^}]*background: var\(--accent\);/);
  assert.match(block, /@media \(max-width: 1000px\) \{[\s\S]*\.assets-layout \{ grid-template-columns: 1fr; \}/);
  assert.match(block, /@media \(max-width: 700px\) \{[\s\S]*\.asset-kpi-frame \{ grid-template-columns: 1fr; \}/);
  assert.match(block, /\.assets-account-table \{ min-width: 660px; \}/);

  assert.doesNotMatch(block, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '綠色不可成為資產配置頁容器底色');
}

test('資產配置 UI：摘要、配置檢查與帳戶明細形成單一工作面，既有操作接線完整保留', () => {
  assertAssetsStructure(read('public/modules/assets.js'));
});

test('資產配置 UI：只使用專屬暖色版面，桌機雙欄與手機單欄都有固定規則', () => {
  assertAssetsCss(read('public/styles.css'));
});

test('資產配置 UI：拿掉根節點、手機堆疊或改回綠色容器時考題會紅', () => {
  const source = read('public/modules/assets.js');
  assert.throws(() => assertAssetsStructure(source.replace('<div class="assets-page">', '<div>')));

  const css = read('public/styles.css');
  assert.throws(() => assertAssetsCss(css.replace('.asset-kpi-frame { grid-template-columns: 1fr; }', '.asset-kpi-frame { display: block; }')));
  assert.throws(() => assertAssetsCss(css.replace('background: var(--card);\n  border: 1px solid var(--line);', 'background: var(--pos-soft);\n  border: 1px solid var(--line);')));
});
