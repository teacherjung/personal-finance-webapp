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
  const bodyMarker = source.indexOf(') {', start);
  assert.ok(bodyMarker >= 0, `${name} 找不到函式本體`);
  const open = bodyMarker + 2;
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
    notice: build('securitiesNoticeHtml'),
    loading: build('securitiesLoadingHtml'),
    error: build('securitiesLoadErrorHtml'),
    empty: build('securitiesEmptyHtml'),
    filteredEmpty: build('securitiesFilteredEmptyHtml'),
  };
}

function assertStateBehavior(source) {
  const { notice, loading, error, empty, filteredEmpty } = stateHelpers(source);
  assert.equal(notice(''), '');
  const noticeHtml = notice('已匯入 <交易>');
  assert.match(noticeHtml, /role="status"/);
  assert.match(noticeHtml, /aria-live="polite"/);
  assert.match(noticeHtml, /已匯入 &lt;交易&gt;/);
  assert.doesNotMatch(noticeHtml, /已匯入 <交易>/);

  const loadingHtml = loading();
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /正在讀取證券交易/);
  assert.match(loadingHtml, /不會同步、匯入、刪除或修改任何資料/);

  const errorHtml = error('<script>alert(1)</script>');
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /id="retrySecurities"/);
  assert.match(errorHtml, /操作可能已經成功/);
  assert.match(errorHtml, /避免重複操作/);
  assert.match(errorHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(errorHtml, /<script>alert/);

  const emptyHtml = empty();
  assert.match(emptyHtml, /先選擇你的證券資料來源/);
  assert.match(emptyHtml, /id="emptySecIbSync"/);
  assert.match(emptyHtml, /id="emptySecUpload"/);
  assert.match(emptyHtml, /不會混進銀行收支/);

  const filteredHtml = filteredEmpty();
  assert.match(filteredHtml, /目前條件找不到成交紀錄/);
  assert.match(filteredHtml, /原始交易仍然保留/);
  assert.match(filteredHtml, /id="resetSecFilters"/);
}

function assertStateWiring(source) {
  const render = namedFunction(source, 'renderSecurities');
  assert.match(render, /const seq = currentRouteSeq\(\);\s*const notice = securitiesNotice;\s*securitiesNotice = '';\s*if \(showLoading\) view\(\)\.innerHTML = securitiesLoadingHtml\(\);/);
  assert.match(render, /try \{\s*\[secRes, settings\] = await Promise\.all\(\[api\('\/securities'\), api\('\/settings'\)\]\);\s*\} catch \(error\) \{/);
  assert.match(render, /if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = securitiesLoadErrorHtml/);
  assert.match(render, /byId\('retrySecurities'\)\.onclick = \(\) => renderSecurities\(\);/);
  assert.match(render, /securitiesNoticeHtml\(notice\)/);
  assert.match(render, /!all\.length \? securitiesEmptyHtml\(\)/);
  assert.match(render, /rows\.length \? secTableHtml\(rows, th, FMT\) : securitiesFilteredEmptyHtml\(\)/);
  assert.match(render, /byId\('emptySecUpload'\)\.onclick = \(\) => openSecUpload\(pwSet\);/);
  assert.match(render, /byId\('emptySecIbSync'\)\.onclick = .*syncIbFromSecurities/);
  assert.match(render, /if \(reset\) reset\.onclick = \(\) => resetSecuritiesFilters\(\);/);
  assert.match(render, /renderSecurities\(\{ showLoading: false \}\)/);

  const reset = namedFunction(source, 'resetSecuritiesFilters');
  for (const value of ["preset: 'all'", "source: 'all'", "account: 'all'", "side: 'all'", "currency: 'all'", "q: ''"]) {
    assert.match(reset, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(namedFunction(source, 'syncIbFromSecurities'), /securitiesNotice = 'IBKR 同步完成/);
  assert.match(namedFunction(source, 'openSecPreview'), /securitiesNotice = message;\s*renderSecurities\(\);/);
  assert.match(namedFunction(source, 'openSecBatches'), /securitiesNotice = message;[\s\S]*renderSecurities\(\);/);
}

function assertStateCss(css) {
  assert.match(css, /\.securities-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.securities-state \{[^}]*min-height: 330px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.securities-error code \{[^}]*background: var\(--card-2\);[^}]*border: 1px solid var\(--line\);/);
  assert.match(css, /\.securities-filter-empty \{[^}]*min-height: 180px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.securities-state \{[^}]*flex-direction: column;/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.securities-filter-empty \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '狀態容器不可把頁面染成綠色');
  assert.doesNotMatch(css, /var\(--panel\)/, '證券頁專屬樣式不可引用未定義的色票');
}

test('證券交易狀態：載入、成功、錯誤、首次空白與篩選空白各自說清楚', () => {
  assertStateBehavior(read('public/modules/securities.js'));
});

test('證券交易狀態：失敗可重試，兩種空白狀態與三種成功操作都有接線', () => {
  assertStateWiring(read('public/modules/securities.js'));
});

test('證券交易狀態：暖米橘容器與手機單欄操作由專屬樣式擁有', () => {
  assertStateCss(read('public/securities.css'));
});

test('證券交易狀態：破壞消毒、重試、空白入口、清除條件或手機排列時考題會紅', () => {
  const source = read('public/modules/securities.js');
  const css = read('public/securities.css');

  const safeError = "esc(message || '無法連線')";
  assert.ok(source.includes(safeError), '突變目標必須存在：錯誤訊息輸出消毒');
  assert.throws(() => assertStateBehavior(source.replace(safeError, "message || '無法連線'")));

  const retry = "byId('retrySecurities').onclick = () => renderSecurities();";
  assert.ok(source.includes(retry), '突變目標必須存在：錯誤重試接線');
  assert.throws(() => assertStateWiring(source.replace(retry, "byId('retrySecurities').onclick = () => {};")));

  const emptyUpload = "byId('emptySecUpload').onclick = () => openSecUpload(pwSet);";
  assert.ok(source.includes(emptyUpload), '突變目標必須存在：首次空白上傳入口');
  assert.throws(() => assertStateWiring(source.replace(emptyUpload, "byId('emptySecUpload').onclick = () => {};")));

  const reset = "if (reset) reset.onclick = () => resetSecuritiesFilters();";
  assert.ok(source.includes(reset), '突變目標必須存在：篩選空白清除條件');
  assert.throws(() => assertStateWiring(source.replace(reset, 'if (reset) reset.onclick = () => {};')));

  const mobileStack = 'display: flex; align-items: center;\n    flex-direction: column; text-align: center;';
  assert.ok(css.includes(mobileStack), '突變目標必須存在：手機狀態排列');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('column', 'row'))));
});
