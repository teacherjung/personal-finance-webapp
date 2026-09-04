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
  const declarationStart = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
  const bodyMarker = source.indexOf(') {', start);
  assert.ok(bodyMarker >= 0, `${name} 找不到函式本體`);
  const open = bodyMarker + 2;
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(declarationStart, i + 1);
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
  const warningHtml = notice('同步部分完成', true);
  assert.match(warningHtml, /class="securities-notice warning"/);
  assert.match(warningHtml, /data-icon="alert"/);
  assert.match(warningHtml, /同步部分完成/);

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
  assert.match(render, /const seq = currentRouteSeq\(\);\s*const notice = securitiesNotice;\s*const syncWarning = securitiesSyncWarning;\s*if \(showLoading\) view\(\)\.innerHTML = securitiesLoadingHtml\(\);/);
  assert.match(render, /try \{\s*\[secRes, settings\] = await Promise\.all\(\[api\('\/securities'\), api\('\/settings'\)\]\);\s*\} catch \(error\) \{/);
  assert.match(render, /if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = securitiesLoadErrorHtml/);
  assert.match(render, /byId\('retrySecurities'\)\.onclick = \(\) => renderSecurities\(\);/);
  const fetchAt = render.indexOf('await Promise.all');
  const consumeNoticeAt = render.indexOf("securitiesNotice = '';");
  assert.ok(fetchAt >= 0 && consumeNoticeAt > fetchAt, '成功訊息只能在資料重載成功後消費');
  assert.doesNotMatch(render, /securitiesSyncWarning\s*=/, '頁內重畫不可清除 IBKR 部分同步警告');
  assert.match(render, /securitiesNoticeHtml\(syncWarning, true\)/);
  assert.match(render, /securitiesNoticeHtml\(notice\)/);
  assert.match(render, /!all\.length \? securitiesEmptyHtml\(\)/);
  assert.match(render, /rows\.length \? secTableHtml\(rows, th, FMT\) : securitiesFilteredEmptyHtml\(\)/);
  assert.match(render, /byId\('emptySecUpload'\)\.onclick = \(\) => openSecUpload\(pwSet\);/);
  assert.match(render, /byId\('emptySecIbSync'\)\.onclick = \(\) => syncIbFromSecurities\(\)/);
  assert.match(render, /if \(reset\) reset\.onclick = \(\) => resetSecuritiesFilters\(\);/);
  assert.match(render, /renderSecurities\(\{ showLoading: false \}\)/);

  const reset = namedFunction(source, 'resetSecuritiesFilters');
  for (const value of ["preset: 'all'", "source: 'all'", "account: 'all'", "side: 'all'", "currency: 'all'", "q: ''"]) {
    assert.match(reset, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(source, /nextSecSort\(listSort, el\.dataset\.sort \|\| 'tradeDate'\)/, '表頭排序要走 securities-view 的 nextSecSort（方向規則的行為題在 securities-ui）——這一行是接線字面釘');
  const sync = namedFunction(source, 'syncIbFromSecurities');
  assert.match(sync, /setSecuritiesSyncButtonsBusy\(true\);/);
  assert.match(sync, /const feedback = ibSyncFeedback\(result, moneyCur\);/);
  assert.match(sync, /const hasSyncWarning = feedback\.some\(\(f\) => f\.error\) \|\| !!notice;/);
  assert.match(sync, /securitiesSyncWarning = hasSyncWarning[\s\S]*IBKR 同步部分完成[\s\S]*: '';/);
  assert.match(sync, /securitiesNotice = hasSyncWarning \? '' : 'IBKR 同步完成/);
  assert.match(sync, /securitiesNotice = hasSyncWarning[\s\S]*if \(seqAtStart === currentRouteSeq\(\)\) renderSecurities\(\);/);
  assert.match(sync, /catch \(err\)[\s\S]*if \(seqAtStart === currentRouteSeq\(\)\) setSecuritiesSyncButtonsBusy\(false\);/);
  assert.match(namedFunction(source, 'openSecBatches'), /securitiesNotice = message;[\s\S]*renderSecurities\(\);/);
}

// openSecPreview 用行為釘（真的呼叫、按確認鈕），不用正則釘那兩行：正則只看得到「兩行相鄰存在」，分不出守門條件反轉
// （`===`→`!==`）或訊息拿錯欄位（skippedDup 當匯入筆數）。
async function assertPreviewImportBehavior(source) {
  const fn = namedFunction(source, 'openSecPreview');
  const createHarness = ({ routeSeq, reject = null, out = { imported: 2, skippedDup: 1 } }) => {
    const btn = { disabled: false, onclick: null };
    const cancel = { onclick: null };
    const toasts = []; let closes = 0; let renders = 0;
    const openModalShell = () => ({ root: { querySelector: () => cancel }, close: () => { closes++; } });
    const api = async () => { if (reject) throw reject; return out; };
    const factory = Function('canImportPreview', 'openModalShell', 'previewBodyHtml', 'FMT', 'byId', 'currentRouteSeq', 'api', 'toast', 'renderSecurities', `
      let securitiesNotice = '';
      ${fn}
      return { run: openSecPreview, state: () => ({ securitiesNotice }) };
    `);
    const instance = factory(() => true, openModalShell, () => '', {}, () => btn, () => routeSeq(), api,
      (/** @type {string} */ m, /** @type {boolean} */ bad) => { toasts.push({ m, bad: !!bad }); }, () => { renders++; });
    instance.run({ counts: { importable: 2 } }, 'b64', '');
    assert.equal(typeof btn.onclick, 'function', '確認鈕要接上');
    return { btn, toasts, instance, press: () => btn.onclick(), closes: () => closes, renders: () => renders };
  };

  const ok = createHarness({ routeSeq: () => 10 });
  await ok.press();
  assert.equal(ok.btn.disabled, true, '送出後按鈕保持鎖住（防雙擊）');
  assert.equal(ok.closes(), 1, '成功要關窗');
  assert.equal(ok.instance.state().securitiesNotice, '已匯入 2 筆證券交易（略過已存在 1 筆）', '通知逐字：匯入筆數是 imported、括號是 skippedDup');
  assert.equal(ok.renders(), 1, '留在原頁要重畫一次');
  assert.deepEqual(ok.toasts, [{ m: '已匯入 2 筆證券交易（略過已存在 1 筆）', bad: false }]);

  let calls = 0;
  const switched = createHarness({ routeSeq: () => (++calls === 1 ? 10 : 11) });
  await switched.press();
  assert.equal(switched.closes(), 1);
  assert.equal(switched.renders(), 0, '等待匯入期間切走頁：不可蓋掉新頁');
  assert.equal(switched.instance.state().securitiesNotice, '', '切走頁也不留通知給下一次');

  const failed = createHarness({ routeSeq: () => 20, reject: new Error('密碼錯') });
  await failed.press();
  assert.equal(failed.btn.disabled, false, '失敗要解鎖按鈕讓人重試');
  assert.equal(failed.closes(), 0, '失敗不關窗');
  assert.equal(failed.renders(), 0);
  assert.equal(failed.instance.state().securitiesNotice, '');
  assert.deepEqual(failed.toasts, [{ m: '匯入失敗：密碼錯', bad: true }]);
}

async function assertSyncBehavior(source) {
  const helper = namedFunction(source, 'setSecuritiesSyncButtonsBusy');
  const sync = namedFunction(source, 'syncIbFromSecurities');
  const createHarness = ({ routeSeq, feedback, missing = [], reject = null, initialWarning = '' }) => {
    const buttons = [{ disabled: false, textContent: '', innerHTML: '' }, { disabled: false, textContent: '', innerHTML: '' }];
    let resolveApi;
    let rejectApi;
    let renders = 0;
    const api = () => new Promise((resolve, rejectPromise) => { resolveApi = resolve; rejectApi = rejectPromise; });
    const currentRouteSeq = () => routeSeq();
    const document = { querySelectorAll: selector => selector.includes('emptySecIbSync') ? buttons : [buttons[0]] };
    const ibSyncFeedback = () => feedback;
    const missingHoldingsNotice = () => missing.length ? '可能已出清' : '';
    const moneyCur = () => '';
    const toast = () => {};
    const icon = () => '<svg></svg>';
    const renderSecurities = () => { renders++; };
    const factory = Function('api', 'currentRouteSeq', 'document', 'ibSyncFeedback', 'missingHoldingsNotice',
      'moneyCur', 'toast', 'icon', 'renderSecurities', 'initialWarning', `
        let securitiesSyncWarning = initialWarning;
        let securitiesNotice = '';
        ${helper}
        ${sync}
        return {
          run: syncIbFromSecurities,
          state: () => ({ securitiesSyncWarning, securitiesNotice }),
        };
      `);
    const instance = factory(api, currentRouteSeq, document, ibSyncFeedback, missingHoldingsNotice,
      moneyCur, toast, icon, renderSecurities, initialWarning);
    return {
      buttons,
      instance,
      complete: () => reject ? rejectApi(reject) : resolveApi({ missing }),
      renders: () => renders,
    };
  };

  let routeCalls = 0;
  const switched = createHarness({
    routeSeq: () => (++routeCalls === 1 ? 10 : 11),
    feedback: [{ message: '部分失敗', error: true }],
  });
  const switchedRun = switched.instance.run();
  assert.deepEqual(switched.buttons.map(btn => btn.disabled), [true, true], '同步開始要同時鎖住兩個入口');
  switched.complete();
  await switchedRun;
  assert.match(switched.instance.state().securitiesSyncWarning, /同步部分完成/);
  assert.equal(switched.renders(), 0, '切頁後不可重畫舊頁，但仍要保存同步結果');

  const complete = createHarness({ routeSeq: () => 20, feedback: [], initialWarning: '舊警告' });
  const completeRun = complete.instance.run();
  complete.complete();
  await completeRun;
  assert.equal(complete.instance.state().securitiesSyncWarning, '', '下一次完整成功同步要清除舊警告');
  assert.match(complete.instance.state().securitiesNotice, /同步完成/);
  assert.equal(complete.renders(), 1);

  const failed = createHarness({ routeSeq: () => 30, feedback: [], reject: new Error('同步失敗') });
  const failedRun = failed.instance.run();
  failed.complete();
  await failedRun;
  assert.deepEqual(failed.buttons.map(btn => btn.disabled), [false, false], '同步失敗要恢復兩個入口');
}

function assertStateCss(css) {
  assert.match(css, /\.securities-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.securities-notice\.warning \{[^}]*color: var\(--warn\);[^}]*border-color: var\(--warn\);/);
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

test('證券交易狀態：失敗可重試，兩種空白狀態與三種成功操作都有接線', async () => {
  const source = read('public/modules/securities.js');
  assertStateWiring(source);
  await assertPreviewImportBehavior(source);
  await assertSyncBehavior(source);
});

test('證券交易狀態：暖米橘容器與手機單欄操作由專屬樣式擁有', () => {
  assertStateCss(read('public/securities.css'));
  assert.match(read('public/modules/icons.js'), /\bcheck:\s*'<path/);
  assert.match(read('public/styles.css'), /--warn:\s*#[0-9A-Fa-f]{6}/);
});

test('證券交易狀態：破壞消毒、重試、空白入口、清除條件、警告保存或手機排列時考題會紅', async () => {
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

  const syncWarning = 'const hasSyncWarning = feedback.some((f) => f.error) || !!notice;';
  assert.ok(source.includes(syncWarning), '突變目標必須存在：同步部分失敗的持久警示');
  assert.throws(() => assertStateWiring(source.replace(syncWarning, 'const hasSyncWarning = false;')));

  const consumeNotice = "securitiesNotice = '';\n  const all = secRes.trades || [];";
  assert.equal(source.split(consumeNotice).length - 1, 1, '突變目標必須唯一：成功載入後的訊息消費點');
  assert.throws(() => assertStateWiring(source.replace(consumeNotice,
    "securitiesNotice = '';\n  securitiesSyncWarning = '';\n  const all = secRes.trades || [];")));

  const syncButtons = "document.querySelectorAll('#secIbSync, #emptySecIbSync')";
  assert.ok(source.includes(syncButtons), '突變目標必須存在：同步時鎖住兩個入口');
  await assert.rejects(() => assertSyncBehavior(source.replace(syncButtons,
    "document.querySelectorAll('#secIbSync')")));

  const warningAssignment = 'securitiesSyncWarning = hasSyncWarning';
  assert.equal(source.split(warningAssignment).length - 1, 1, '突變目標必須唯一：切頁後仍保存同步結果');
  await assert.rejects(() => assertSyncBehavior(source.replace(warningAssignment,
    'if (seqAtStart === currentRouteSeq()) securitiesSyncWarning = hasSyncWarning')));

  const mobileStack = 'display: flex; align-items: center;\n    flex-direction: column; text-align: center;';
  assert.ok(css.includes(mobileStack), '突變目標必須存在：手機狀態排列');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('column', 'row'))));
});
