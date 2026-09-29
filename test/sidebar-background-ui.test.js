import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

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
  assert.ok(ruleBodies('#nav a').some(body => /text-decoration:\s*none/.test(body)),
    '真正的導覽連結仍要維持原本無底線的側欄樣式');
  const active = ruleBodies('#nav a.active');
  assert.equal(active.length, 1);
  assert.match(active[0], /background:\s*var\(--card\)/);
  assert.match(active[0], /color:\s*var\(--accent-ink\)/);
  assert.match(active[0], /border-color:\s*var\(--frame\)/);
  assert.match(active[0], /box-shadow:\s*3px 3px 0 rgba\(126, 101, 43, \.28\)/);
  assert.doesNotMatch(active[0], /var\(--action(?:-hover)?\)/, '側欄選取是品牌橘色，不是主要按鈕綠');
});

test('側邊導覽是可由鍵盤直接啟用的真正連結，並標出目前頁面', () => {
  assert.match(html, /<nav id="nav" aria-label="主要功能">/);
  const links = [...html.matchAll(/<a href="#([a-z]+)" data-route="([a-z]+)"([^>]*)>/g)];
  assert.equal(links.length, 11, '十一個主導覽項目都要有 href，不能只靠滑鼠 click 事件');
  for (const [, href, route] of links) assert.equal(href, route, `#${route} 的 href 要與 data-route 相同`);
  assert.match(links.find(([, , route]) => route === 'dashboard')?.[3] || '', /aria-current="page"/,
    '靜態首屏的總覽要先標成目前頁，避免路由尚未完成時語意空白');
});

test('接線｜路由有 active、aria-current 與手機可視化呼叫；完整行為另由真 DOM 題守', () => {
  assert.match(app, /a\.setAttribute\('aria-current', 'page'\)/, '目前頁要同步 aria-current=page');
  assert.match(app, /a\.removeAttribute\('aria-current'\)/, '離開的頁面要移除 aria-current');
  assert.equal((app.match(/keepActiveNavVisible\(activeNav\)/g) || []).length, 2,
    'keepActiveNavVisible 應宣告一次、由路由呼叫一次；只剩宣告不算有接線');
  assert.doesNotMatch(app, /document\.querySelectorAll\('#nav a'\)[\s\S]{0,180}?addEventListener\('click'/,
    '導覽應交給原生連結，不再以只處理滑鼠的 click 接線冒充連結');
});
