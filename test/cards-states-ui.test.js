import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function namedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} 缺少右大括號`);
}

function stateHelpers(source) {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const icon = name => `<svg data-icon="${name}"></svg>`;
  const build = name => Function('esc', 'icon', `${namedFunction(source, name)}; return ${name};`)(esc, icon);
  return {
    notice: build('cardNoticeHtml'),
    loading: build('cardsLoadingHtml'),
    error: build('cardsLoadErrorHtml'),
    section: build('cardSection'),
  };
}

function assertStateBehavior(source) {
  const { notice, loading, error, section } = stateHelpers(source);
  assert.equal(notice(''), '');
  const noticeHtml = notice('已新增 <卡片>');
  assert.match(noticeHtml, /role="status"/);
  assert.match(noticeHtml, /aria-live="polite"/);
  assert.match(noticeHtml, /已新增 &lt;卡片&gt;/);
  assert.doesNotMatch(noticeHtml, /已新增 <卡片>/);

  const loadingHtml = loading();
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /正在讀取卡片資料/);
  assert.match(loadingHtml, /不會修改任何資料/);

  const errorHtml = error('<script>alert(1)</script>');
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /id="retryCards"/);
  assert.match(errorHtml, /沒有新增、刪除或修改任何卡片/);
  assert.match(errorHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(errorHtml, /<script>alert/);

  const creditEmpty = section('信用卡', '帳務與繳款', [], 'credit');
  assert.match(creditEmpty, /data-add-type="credit"/);
  assert.match(creditEmpty, /新增後可一起查看結帳日、繳款日、年費與效期/);
  const memberEmpty = section('會員卡', '會籍與權益', [], 'membership');
  assert.match(memberEmpty, /data-add-type="membership"/);
  assert.match(memberEmpty, /新增後可記錄會員編號、等級、權益與效期/);
}

function assertStateWiring(source) {
  assert.match(source, /const seq = currentRouteSeq\(\);\s*const notice = cardNotice;\s*cardNotice = '';\s*view\(\)\.innerHTML = cardsLoadingHtml\(\);/);
  assert.match(source, /try \{\s*list = await api\('\/cards'\);\s*\} catch \(error\) \{/);
  assert.match(source, /if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = cardsLoadErrorHtml/);
  assert.match(source, /byId\('retryCards'\)\.onclick = \(\) => renderCards\(\);/);
  assert.match(source, /cardNoticeHtml\(notice\)/);
  assert.match(source, /function rerenderCardsAfterSave\(seq, message\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(source, /querySelectorAll\('\[data-add-type\]'\)[\s\S]*openCardForm\(null, \{ defaultType: b\.dataset\.addType \}\)/);
  assert.match(source, /values: c \? \{ \.\.\.c, expiry:[^\n]+\} : \{ type: defaultType \}/);
  assert.match(source, /await api\('\/cards\/' \+ c\.id, \{ method: 'DELETE' \}\);\s*cardNotice = '卡片已刪除';/);
  assert.match(source, /const message = c \? '卡片資料已更新' : `\$\{TYPE_LABEL\[data\.type\] \|\| '卡片'\}已新增`;/);
}

function assertStateCss(css) {
  assert.match(css, /\.card-tracker-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.card-tracker-state \{[^}]*min-height: 330px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.card-tracker-error code \{[^}]*background: var\(--card-2\);[^}]*border: 1px solid var\(--line\);/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.card-tracker-state \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '狀態容器不可把頁面染成綠色');
  assert.doesNotMatch(css, /var\(--panel\)/, '卡片頁專屬樣式不可引用未定義的色票');
}

test('卡片追蹤狀態：載入、成功與錯誤都能辨識，外部錯誤文字一律消毒', () => {
  assertStateBehavior(read('public/modules/cards.js'));
});

test('卡片追蹤狀態：失敗可重試，兩種空白狀態都會開對應卡別', () => {
  assertStateWiring(read('public/modules/cards.js'));
});

test('卡片追蹤狀態：暖米橘容器與手機單欄操作由專屬樣式擁有', () => {
  assertStateCss(read('public/cards.css'));
});

test('卡片追蹤狀態：拿掉消毒、重試、卡別接線或手機排列時考題會紅', () => {
  const source = read('public/modules/cards.js');
  const css = read('public/cards.css');
  assert.throws(() => assertStateBehavior(source.replace("esc(message || '無法連線')", "message || '無法連線'")));
  assert.throws(() => assertStateWiring(source.replace("byId('retryCards').onclick = () => renderCards();", '// retry removed')));
  assert.throws(() => assertStateWiring(source.replace('openCardForm(null, { defaultType: b.dataset.addType })', 'openCardForm()')));
  const mobileStack = 'display: flex; align-items: center;\n    flex-direction: column; text-align: center;';
  assert.ok(css.includes(mobileStack), '手機狀態排列突變目標必須存在');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('column', 'row'))));
  const errorCodeSurface = 'background: var(--card-2); border: 1px solid var(--line);';
  assert.ok(css.includes(errorCodeSurface), '錯誤詳情色票突變目標必須存在');
  assert.throws(() => assertStateCss(css.replace(errorCodeSurface, errorCodeSurface.replace('--card-2', '--panel'))));
});
