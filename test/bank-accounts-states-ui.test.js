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
  const notice = Function('esc', 'icon', `${namedFunction(source, 'bankAccountNoticeHtml')}; return bankAccountNoticeHtml;`)(esc, icon);
  const error = Function('esc', 'icon', `${namedFunction(source, 'bankAccountLoadErrorHtml')}; return bankAccountLoadErrorHtml;`)(esc, icon);
  return { notice, error };
}

function assertStateBehavior(source) {
  const { notice, error } = stateHelpers(source);
  assert.equal(notice(''), '');
  const noticeHtml = notice('已新增 <帳戶>');
  assert.match(noticeHtml, /role="status"/);
  assert.match(noticeHtml, /aria-live="polite"/);
  assert.match(noticeHtml, /已新增 &lt;帳戶&gt;/);
  assert.doesNotMatch(noticeHtml, /已新增 <帳戶>/);

  const errorHtml = error('<script>alert(1)</script>');
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /data-icon="alert"/);
  assert.match(errorHtml, /id="retryBankAccounts"/);
  assert.match(errorHtml, /這次只讀取失敗，沒有修改任何帳戶資料/);
  assert.match(errorHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(errorHtml, /<script>alert/);
}

function assertStateWiring(source) {
  assert.match(source, /const seq = currentRouteSeq\(\);\s*const notice = bankAccountNotice;\s*bankAccountNotice = '';\s*let db;\s*try \{/,
    '成功訊息必須在非同步重讀前取出並清空，切頁時不可殘留到下一輪');
  assert.match(source, /try \{\s*db = await api\('\/db'\);\s*\} catch \(error\) \{/);
  assert.match(source, /if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = bankAccountLoadErrorHtml/);
  assert.match(source, /byId\('retryBankAccounts'\)\.onclick = \(\) => renderBankAccounts\(\);/);
  assert.match(source, /const notice = bankAccountNotice;\s*bankAccountNotice = '';[\s\S]*bankAccountNoticeHtml\(notice\)/);
  assert.match(source, /function rerenderBankAccountsAfterSave\(seq, message\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(source, /onDone: \(\) => rerenderBankAccountsAfterSave\(seq, '銀行帳戶已新增'\)/);
  assert.match(source, /onDone: \(\) => rerenderBankAccountsAfterSave\(seq, '銀行帳戶資料已更新'\)/);
  assert.match(source, /class="bank-empty-actions"/);
  assert.match(source, /id="addBankAccEmpty"/);
  assert.match(source, /class="btn-ghost" href="#cashflow"/);
}

function assertStateCss(css) {
  assert.match(css, /\.bank-account-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.bank-account-error \{[^}]*min-height: 330px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.bank-empty-actions \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /@media \(max-width: 520px\) \{[\s\S]*\.bank-empty-actions \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '狀態容器不可把頁面染成綠色');
  assert.doesNotMatch(css, /var\(--panel\)/, '銀行帳戶專屬樣式不可引用未定義的色票');
}

test('銀行帳戶狀態：成功與錯誤訊息可辨識，外部錯誤文字一律消毒', () => {
  assertStateBehavior(read('public/modules/assets.js'));
});

test('銀行帳戶狀態：失敗可重試，空白狀態同時保留新增與匯入兩條路', () => {
  assertStateWiring(read('public/modules/assets.js'));
});

test('銀行帳戶狀態：暖米橘容器與手機單欄操作由專屬樣式擁有', () => {
  assertStateCss(read('public/bank-accounts.css'));
});

test('銀行帳戶狀態：拿掉消毒、重試接線或手機操作排列時考題會紅', () => {
  const source = read('public/modules/assets.js');
  const css = read('public/bank-accounts.css');
  assert.throws(() => assertStateBehavior(source.replace("esc(message || '無法連線')", "message || '無法連線'")));
  assert.throws(() => assertStateWiring(source.replace("byId('retryBankAccounts').onclick = () => renderBankAccounts();", '// retry removed')));
  assert.throws(() => assertStateWiring(source.replaceAll('href="#cashflow"', 'href="#dashboard"')));
  const earlyNoticeCapture = "const notice = bankAccountNotice;\n  bankAccountNotice = '';\n  let db;";
  assert.ok(source.includes(earlyNoticeCapture), '成功訊息時序突變目標必須存在');
  assert.throws(() => assertStateWiring(source.replace(earlyNoticeCapture, 'let db;')));
  const mobileStack = 'width: 100%; align-items: stretch; flex-direction: column;';
  assert.ok(css.includes(mobileStack), '手機操作排列突變目標必須存在');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('column', 'row'))));
  const errorCodeSurface = 'background: var(--card-2); border: 1px solid var(--line);';
  assert.ok(css.includes(errorCodeSurface), '錯誤詳情色票突變目標必須存在');
  assert.throws(() => assertStateCss(css.replace(errorCodeSurface, errorCodeSurface.replace('--card-2', '--panel'))));
});
