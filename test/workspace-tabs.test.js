import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { workspaceTabsHtml } from '../public/modules/workspace-tabs.js';

const ROOT = new URL('../', import.meta.url);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function cssRule(css, selector, startAt = 0) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleStart = new RegExp(`^\\s*${escapedSelector}\\s*\\{`, 'gm');
  ruleStart.lastIndex = startAt;
  const match = ruleStart.exec(css);
  assert.ok(match, `missing CSS selector: ${selector}`);
  const openAt = css.indexOf('{', match.index);
  const closeAt = css.indexOf('}', openAt);
  return css.slice(openAt + 1, closeAt);
}

const TABS = Object.freeze([
  Object.freeze({ key: 'summary', label: '總覽', icon: 'dashboard' }),
  Object.freeze({ key: 'detail', label: '詳細資料', icon: 'file' }),
  Object.freeze({ key: 'notes', label: '筆記', icon: 'edit' })
]);

test('共用頁籤｜產生可直達連結、唯一目前頁與完整可存取名稱', () => {
  const html = workspaceTabsHtml({
    tabs: TABS,
    activeKey: 'detail',
    ariaLabel: '測試分頁',
    idPrefix: 'demo-tab',
    hrefFor: tab => `#demo?tab=${tab.key}`
  }, { esc });

  assert.match(html, /<nav class="workspace-tabs workspace-tabs--compact-mobile" aria-label="測試分頁">/);
  assert.equal((html.match(/class="workspace-tab(?: is-active)?"/g) || []).length, 3);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /id="demo-tab-detail" class="workspace-tab is-active"[^>]*href="#demo\?tab=detail"[^>]*aria-current="page"/);
  assert.equal((html.match(/aria-label="[^"]+" title="[^"]+"/g) || []).length, 3);
  assert.equal((html.match(/class="workspace-tab__join workspace-tab__join--start"/g) || []).length, 3);
  assert.equal((html.match(/class="workspace-tab__join workspace-tab__join--end"/g) || []).length, 3);
  assert.equal((html.match(/preserveAspectRatio="none" aria-hidden="true" focusable="false"/g) || []).length, 6);
});

test('共用頁籤｜所有外部文字與網址都經過 esc', () => {
  const html = workspaceTabsHtml({
    tabs: [{ key: '<bad>', label: '<img src=x>', icon: 'file' }],
    activeKey: '<bad>',
    ariaLabel: '頁籤"名稱',
    idPrefix: 'demo',
    hrefFor: () => '#x&y="bad"'
  }, { esc });

  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /aria-label="頁籤&quot;名稱"/);
  assert.match(html, /id="demo-&lt;bad&gt;"/);
  assert.match(html, /href="#x&amp;y=&quot;bad&quot;"/);
});

test('共用頁籤｜缺少必要格式器時明確失敗', () => {
  const options = {
    tabs: TABS,
    activeKey: 'summary',
    ariaLabel: '測試分頁',
    idPrefix: 'demo-tab',
    hrefFor: tab => `#${tab.key}`
  };
  assert.throws(() => workspaceTabsHtml(options, /** @type {any} */ ({})), /esc/);
  assert.throws(() => workspaceTabsHtml({ ...options, hrefFor: /** @type {any} */ (null) }, { esc }), /hrefFor/);
});

test('共用頁籤｜向量接角、共線邊界與手機收合都由單一樣式檔擁有', async () => {
  const [css, stockCss, index] = await Promise.all([
    readFile(new URL('public/workspace-tabs.css', ROOT), 'utf8'),
    readFile(new URL('public/stock-research.css', ROOT), 'utf8'),
    readFile(new URL('public/index.html', ROOT), 'utf8')
  ]);
  const mobileAt = css.indexOf('@media (max-width: 680px)');

  assert.match(cssRule(css, '.workspace-tabs-shell'), /--workspace-tabs-border:\s*2px/);
  assert.match(cssRule(css, '.workspace-tabs-shell'), /--workspace-tabs-active-text:\s*var\(--accent-hover\)/);
  assert.match(cssRule(css, '.workspace-tabs__track'), /border-bottom:\s*var\(--workspace-tabs-border\) solid var\(--workspace-tabs-frame\)/);
  assert.match(cssRule(css, '.workspace-tab'), /border:\s*var\(--workspace-tabs-border\) solid var\(--workspace-tabs-frame\)/);
  assert.match(cssRule(css, '.workspace-tab'), /border-bottom:\s*0/);
  assert.match(cssRule(css, '.workspace-tab'), /border-radius:\s*16px 16px 0 0/);
  assert.match(cssRule(css, '.workspace-tab__join'), /bottom:\s*0/);
  assert.match(cssRule(css, '.workspace-tab__join'), /width:\s*22px/);
  assert.match(cssRule(css, '.workspace-tab__join-line'), /vector-effect:\s*non-scaling-stroke/);
  assert.match(cssRule(css, '.workspace-tab__join-line'), /stroke-width:\s*var\(--workspace-tabs-border\)/);
  assert.match(cssRule(css, '.workspace-tab.is-active .workspace-tab__join,\n.workspace-tab:first-child .workspace-tab__join--start,\n.workspace-tab:last-child .workspace-tab__join--end'), /display:\s*block/);
  assert.match(cssRule(css, '.workspace-tabs-panel'), /margin-top:\s*calc\(-1 \* var\(--workspace-tabs-border\)\)/);
  assert.match(cssRule(css, '.workspace-tabs-panel'), /border:\s*var\(--workspace-tabs-border\) solid var\(--workspace-tabs-frame\)/);
  assert.doesNotMatch(css, /radial-gradient|clip-path|mask-image/);
  assert.doesNotMatch(stockCss, /stock-tab-ear|\.stock-tab\s*\{|\.stock-tabs\s*\{/);
  assert.notEqual(mobileAt, -1);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab', mobileAt), /flex:\s*0 0 52px/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab.is-active', mobileAt), /flex-basis:\s*108px/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab__label', mobileAt), /display:\s*none/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab.is-active .workspace-tab__label', mobileAt), /display:\s*inline/);
  assert.ok(index.indexOf('workspace-tabs.css') < index.indexOf('stock-research.css'));
});
