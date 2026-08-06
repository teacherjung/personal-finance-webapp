import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

/**
 * 去註解後再掃正式程式；字串與樣板字串內容保留。
 * 本 repo 的 test/ 不放共用 helper，因為其中每支 .js 都會被 node --test 當成考題。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const n = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && n === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && n === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
      if (c === '\'') stack.push('s1');
      else if (c === '"') stack.push('s2');
      else if (c === '`') stack.push('tpl');
      else if (st === 'interp') {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) { stack.pop(); interp.pop(); out += c; prev = c; continue; }
          interp[interp.length - 1]--;
        }
      }
      out += c; prev = c;
    } else if (st === 'line') {
      if (c === '\n') { stack.pop(); out += c; prev = ''; }
    } else if (st === 'block') {
      if (c === '*' && n === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 'tpl') {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && n === '{') { stack.push('interp'); interp.push(0); out += n; i++; }
      prev = c;
    } else {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"')) stack.pop();
      else if (c === '\n') stack.pop();
      prev = c;
    }
  }
  return out;
}

function assertAssetsStructure(rawSource) {
  const source = stripComments(rawSource);
  const renderStart = source.indexOf('export async function renderAssets()');
  const renderEnd = source.indexOf('\nfunction accRow(', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, '找不到 renderAssets 正式函式範圍');
  const renderBlock = source.slice(renderStart, renderEnd);
  const accRowStart = renderEnd + 1;
  const accRowEnd = source.indexOf('\nfunction typeLabel(', accRowStart);
  assert.ok(accRowEnd > accRowStart, '找不到 accRow 正式函式範圍');
  const accRowBlock = source.slice(accRowStart, accRowEnd);
  assert.match(source, /<div class="assets-page">/);
  assert.match(source, /<aside class="assets-scope-note" aria-label="資產配置資料口徑">/);
  assert.match(source, /<section class="asset-kpi-frame" aria-label="資產摘要">/);
  assert.match(source, /<section class="assets-layout">/);
  assert.match(source, /class="asset-allocation-list"/);
  assert.match(source, /class="assets-account-table"/);

  for (const id of ['rebalBtn', 'editTargets', 'addAcc', 'pie']) {
    assert.match(source, new RegExp(`id="${id}"`), `${id} 接線不可因整理版面消失`);
  }
  assert.match(renderBlock, /if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(renderBlock, /esc\(r\.class\)/);
  assert.match(accRowBlock, /esc\(x\.name\)/);
  assert.match(source, /淨資產 <small>（含現金）<\/small>/);
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

function mutateAssetsCss(css, from, to) {
  const start = css.indexOf('/* ---------- 資產配置（UI5） ---------- */');
  const end = css.indexOf('/* ---------- 理財中心總覽（UI2） ---------- */');
  assert.ok(start >= 0 && end > start, '找不到資產配置專屬樣式區塊');
  const block = css.slice(start, end);
  assert.equal(block.split(from).length, 2, 'CSS 突變目標必須在資產配置區塊內精確出現一次');
  return css.slice(0, start) + block.replace(from, to) + css.slice(end);
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
  assert.throws(() => assertAssetsCss(mutateAssetsCss(css,
    'background: var(--card);\n  border: 1px solid var(--line);',
    'background: var(--pos-soft);\n  border: 1px solid var(--line);')));
});

test('資產配置 UI：把 route guard 或輸出消毒改成註解時考題會紅', () => {
  const source = read('public/modules/assets.js');
  const guard = 'if (seq !== currentRouteSeq()) return;';
  const escapedClass = 'esc(r.class)';
  const escapedName = 'esc(x.name)';
  for (const [target, replacement] of [
    [guard, `// 原本有 ${guard}`],
    [escapedClass, `r.class /* 原本有 ${escapedClass} */`],
    [escapedName, `x.name /* 原本有 ${escapedName} */`],
  ]) {
    assert.ok(source.includes(target), `找不到突變目標：${target}`);
    assert.throws(() => assertAssetsStructure(source.replace(target, replacement)), `${target} 失效時考題必須紅`);
  }
});
