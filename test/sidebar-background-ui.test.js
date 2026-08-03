import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function ruleBodies(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(match => match[1]);
}

test('側邊導覽只使用奶油紙白專用底色，舊色票不外溢', () => {
  assert.match(css, /--sidebar-bg:\s*#fff8e5;/);
  assert.match(css, /--bg-2:\s*#eadb9c;/, '不可改動仍由唯讀分類欄使用的共用色票');
  assert.ok(ruleBodies('.sidebar').some(body => /background:\s*var\(--sidebar-bg\)/.test(body)));
  assert.ok(ruleBodies('.nav-more').some(body => /background:\s*var\(--sidebar-bg\)/.test(body)),
    '手機導覽右緣提示條要與側欄同色');
  assert.ok(ruleBodies('.cat-name[readonly]').some(body => /background:\s*var\(--bg-2\)/.test(body)),
    '唯讀分類欄仍應使用原本的共用底色');
});

test('側邊導覽選取標籤維持原有卡片樣式', () => {
  const active = ruleBodies('#nav a.active');
  assert.equal(active.length, 1);
  assert.match(active[0], /background:\s*var\(--card\)/);
  assert.match(active[0], /color:\s*var\(--accent-hover\)/);
  assert.match(active[0], /border-color:\s*var\(--frame\)/);
  assert.match(active[0], /box-shadow:\s*3px 3px 0 rgba\(126, 101, 43, \.28\)/);
});
