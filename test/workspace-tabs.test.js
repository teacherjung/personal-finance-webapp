import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { workspaceTabsHtml } from '../public/modules/workspace-tabs.js';

const ROOT = new URL('../', import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL('public/', ROOT));
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

async function allCssText(dir = PUBLIC_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const chunks = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allCssText(path);
    return entry.isFile() && entry.name.endsWith('.css') ? readFile(path, 'utf8') : '';
  }));
  return chunks.join('\n');
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
  assert.doesNotMatch(html, /workspace-tab__join|preserveAspectRatio/);
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

  const inheritedIcon = workspaceTabsHtml({
    tabs: [{ key: 'safe', label: '安全', icon: 'toString' }],
    activeKey: 'safe',
    ariaLabel: '原型鍵測試',
    idPrefix: 'demo',
    hrefFor: () => '#safe'
  }, { esc });
  assert.doesNotMatch(inheritedIcon, /native code|function toString/);
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

test('共用頁籤｜森林標籤、分離工作面與手機收合都由單一樣式檔擁有', async () => {
  const [css, stockCss, index, styles, everyCss] = await Promise.all([
    readFile(new URL('public/workspace-tabs.css', ROOT), 'utf8'),
    readFile(new URL('public/stock-research.css', ROOT), 'utf8'),
    readFile(new URL('public/index.html', ROOT), 'utf8'),
    readFile(new URL('public/styles.css', ROOT), 'utf8'),
    allCssText()
  ]);
  const mobileAt = css.indexOf('@media (max-width: 680px)');

  assert.match(cssRule(css, '.workspace-tabs-shell'), /--workspace-tabs-active-text:\s*var\(--accent-hover\)/);
  assert.match(cssRule(css, '.workspace-tabs-shell'), /--workspace-tabs-accent-soft:\s*var\(--accent-soft\)/);
  assert.match(cssRule(css, '.workspace-tabs'), /scrollbar-width:\s*none/);
  assert.match(cssRule(css, '.workspace-tabs__track'), /gap:\s*4px/);
  assert.match(cssRule(css, '.workspace-tabs__track'), /padding:\s*0 10px 9px/);
  assert.match(cssRule(css, '.workspace-tabs__track'), /border-bottom:\s*2px solid var\(--workspace-tabs-frame, var\(--frame\)\)/);
  assert.match(cssRule(css, '.workspace-tab'), /border:\s*1px solid transparent/);
  assert.match(cssRule(css, '.workspace-tab'), /border-radius:\s*8px/);
  assert.match(cssRule(css, '.workspace-tabs__track > .workspace-tab'), /min-width:\s*104px/);
  assert.match(cssRule(css, '.workspace-tab:hover'), /border-color:\s*var\(--line-2\)/);
  assert.match(cssRule(css, '.workspace-tab.is-active'), /border-color:\s*var\(--workspace-tabs-accent, var\(--accent\)\)/);
  assert.match(cssRule(css, '.workspace-tab.is-active'), /background:\s*var\(--workspace-tabs-accent-soft, var\(--accent-soft\)\)/);
  assert.match(cssRule(css, '.workspace-tabs-panel'), /margin-top:\s*10px/);
  assert.match(cssRule(css, '.workspace-tabs-panel'), /border:\s*2px solid var\(--workspace-tabs-frame, var\(--frame\)\)/);
  assert.match(cssRule(css, '.workspace-tabs-panel'), /border-radius:\s*8px/);
  assert.doesNotMatch(css, /workspace-tab__join|clip-path|mask-image/);
  assert.doesNotMatch(everyCss, /\.stock-tabs(?:-track)?(?![\w-])|\.stock-tab(?:-ear)?(?![\w-])/);
  assert.doesNotMatch(stockCss, /\.stock-tab-panel\s*\{[^}]*border-radius/s);
  for (const token of ['frame', 'card', 'card-2', 'accent', 'accent-hover', 'text', 'text-dim', 'shadow-lg']) {
    assert.match(styles, new RegExp(`--${token}:\\s*[^;]+;`), `missing shared token --${token}`);
  }
  assert.notEqual(mobileAt, -1);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab', mobileAt), /flex:\s*0 0 52px/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab.is-active', mobileAt), /flex-basis:\s*132px/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab__label', mobileAt), /display:\s*none/);
  assert.match(cssRule(css, '.workspace-tabs--compact-mobile .workspace-tab.is-active .workspace-tab__label', mobileAt), /display:\s*inline/);
  assert.ok(index.indexOf('workspace-tabs.css') < index.indexOf('stock-research.css'));
});
