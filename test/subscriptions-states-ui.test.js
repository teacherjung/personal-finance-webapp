import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function stripComments(source) {
  let output = '';
  let previous = '';
  const stack = ['code'];
  const interpolationDepth = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    const state = stack[stack.length - 1];
    if (state === 'code' || state === 'interpolation') {
      if (char === '/' && next === '/' && previous !== '\\') { stack.push('line'); previous = ''; i++; continue; }
      if (char === '/' && next === '*' && previous !== '\\') { stack.push('block'); previous = ''; i++; continue; }
      if (char === "'") stack.push('single');
      else if (char === '"') stack.push('double');
      else if (char === '`') stack.push('template');
      else if (state === 'interpolation') {
        if (char === '{') interpolationDepth[interpolationDepth.length - 1]++;
        else if (char === '}') {
          if (interpolationDepth[interpolationDepth.length - 1] === 0) {
            stack.pop(); interpolationDepth.pop(); output += char; previous = char; continue;
          }
          interpolationDepth[interpolationDepth.length - 1]--;
        }
      }
      output += char; previous = char;
    } else if (state === 'line') {
      if (char === '\n') { stack.pop(); output += char; previous = ''; }
    } else if (state === 'block') {
      if (char === '*' && next === '/') { stack.pop(); i++; previous = ''; }
      else if (char === '\n') output += char;
    } else if (state === 'template') {
      output += char;
      if (char === '\\') { output += next ?? ''; i++; previous = ''; continue; }
      if (char === '`') stack.pop();
      else if (char === '$' && next === '{') { stack.push('interpolation'); interpolationDepth.push(0); output += next; i++; }
      previous = char;
    } else {
      output += char;
      if (char === '\\') { output += next ?? ''; i++; previous = ''; continue; }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) stack.pop();
      else if (char === '\n') stack.pop();
      previous = char;
    }
  }
  return output;
}

function namedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const nextByName = {
    subscriptionsPageHeadHtml: 'subscriptionNoticeHtml',
    subscriptionNoticeHtml: 'subscriptionsLoadingHtml',
    subscriptionsLoadingHtml: 'subscriptionsLoadErrorHtml',
    subscriptionsLoadErrorHtml: 'subscriptionsEmptyHtml',
    subscriptionsEmptyHtml: 'rerenderSubscriptionsAfterAction',
    toggleCancel: 'drawBreakdown',
    openSubForm: null,
  };
  const nextName = nextByName[name];
  assert.ok(Object.hasOwn(nextByName, name), `未登記 ${name} 的函式邊界`);
  const end = nextName ? source.indexOf(`\nfunction ${nextName}(`, start) : source.length;
  assert.ok(end > start, `${name} 缺少結束邊界`);
  return source.slice(start, end);
}

function renderFunction(source) {
  const start = source.indexOf('export async function renderSubscriptions(');
  assert.ok(start >= 0, '找不到 renderSubscriptions');
  const end = source.indexOf('\nfunction syncSubscriptionColumnWidths(', start);
  assert.ok(end > start, 'renderSubscriptions 缺少結束邊界');
  return source.slice(start, end);
}

function stateHelpers(source) {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const icon = name => `<svg data-icon="${name}"></svg>`;
  const pageHead = Function('icon', `${namedFunction(source, 'subscriptionsPageHeadHtml')}; return subscriptionsPageHeadHtml;`)(icon);
  const notice = Function('esc', 'icon', `${namedFunction(source, 'subscriptionNoticeHtml')}; return subscriptionNoticeHtml;`)(esc, icon);
  const build = name => Function('esc', 'icon', 'subscriptionsPageHeadHtml', 'subscriptionNoticeHtml',
    `${namedFunction(source, name)}; return ${name};`)(esc, icon, pageHead, notice);
  return {
    pageHead,
    notice,
    loading: build('subscriptionsLoadingHtml'),
    error: build('subscriptionsLoadErrorHtml'),
    empty: build('subscriptionsEmptyHtml'),
  };
}

function assertStateBehavior(source) {
  const { pageHead, notice, loading, error, empty } = stateHelpers(source);
  assert.match(pageHead(), /id="printSubs"/);
  assert.match(pageHead(), /id="addSub"/);
  const passiveHead = pageHead({ showPrint: false, showAdd: false });
  assert.doesNotMatch(passiveHead, /id="printSubs"|id="addSub"/);

  assert.equal(notice(''), '');
  const noticeHtml = notice('已新增 <訂閱>');
  assert.match(noticeHtml, /role="status"/);
  assert.match(noticeHtml, /aria-live="polite"/);
  assert.match(noticeHtml, /已新增 &lt;訂閱&gt;/);
  assert.doesNotMatch(noticeHtml, /已新增 <訂閱>/);

  const loadingHtml = loading();
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /正在整理訂閱狀態/);
  assert.match(loadingHtml, /依停用日期校正狀態/);
  assert.doesNotMatch(loadingHtml, /id="addSub"|id="printSubs"/);

  const errorHtml = error('<script>alert(1)</script>');
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /id="retrySubscriptions"/);
  assert.match(errorHtml, /部分操作可能已經成功/);
  assert.match(errorHtml, /避免重複操作/);
  assert.match(errorHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(errorHtml, /<script>alert/);
  assert.doesNotMatch(errorHtml, /id="addSub"|沒有新增、修改或刪除/);

  const emptyHtml = empty('訂閱已刪除');
  assert.match(emptyHtml, /尚無訂閱紀錄/);
  assert.match(emptyHtml, /每月攤提、下一次扣款、續費卡片與停用進度/);
  assert.match(emptyHtml, /id="emptyAddSub"/);
  assert.match(emptyHtml, /新增第一筆訂閱/);
  assert.match(emptyHtml, /id="historySection"/);
  assert.match(emptyHtml, /訂閱已刪除/);
}

function assertStateWiring(source) {
  source = stripComments(source);
  const render = renderFunction(source);
  const toggle = namedFunction(source, 'toggleCancel');
  const form = namedFunction(source, 'openSubForm');
  const emptyStart = render.indexOf('if (!raw.length) {');
  const emptyEnd = render.indexOf('const subs = raw.slice();', emptyStart);
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart, '找不到空白狀態分支邊界');
  const emptyBranch = render.slice(emptyStart, emptyEnd);

  assert.match(render, /export async function renderSubscriptions\(\{ showLoading = true \} = \{\}\)/);
  assert.match(render, /const seq = currentRouteSeq\(\);\s*const notice = subscriptionNotice;\s*subscriptionNotice = '';\s*destroyCharts\(\);\s*if \(showLoading\) view\(\)\.innerHTML = subscriptionsLoadingHtml\(\);/);
  assert.match(source, /try \{\s*\[raw, cards\] = await Promise\.all\(\[api\('\/subscriptions'\), api\('\/cards'\)\]\);/);
  assert.match(source, /\} catch \(e\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = subscriptionsLoadErrorHtml/);
  assert.match(source, /if \(retry\) retry\.onclick = \(\) => renderSubscriptions\(\);/);
  assert.match(emptyBranch, /byId\('emptyAddSub'\)\.onclick = \(\) => openSubForm\(null, creditCards\);/);
  assert.match(emptyBranch, /renderHistorySection\(byId\('historySection'\)\);/);
  assert.match(render, /\$\{subscriptionsPageHeadHtml\(\)\}\s*\$\{subscriptionNoticeHtml\(notice\)\}/,
    '一般成功頁必須呈現一次性通知，不可被空白 helper 裡的同名呼叫假滿足');
  assert.match(render, /if \(expired\) \{\s*subscriptionNotice = notice;\s*return renderSubscriptions\(\{ showLoading: false \}\);/,
    '自動校正後重載必須把尚未顯示的通知接回下一輪');
  assert.match(render, /view\(\)\.querySelectorAll\('th\.sortable'\)[\s\S]*?renderSubscriptions\(\{ showLoading: false \}\);\s*\}\);/,
    '表頭排序只能原地更新，不可把整頁清成載入狀態');
  assert.match(source, /function rerenderSubscriptionsAfterAction\(seq, message\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*subscriptionNotice = message;\s*renderSubscriptions\(\{ showLoading: false \}\);/);
  assert.match(source, /async function deleteSubscription\(s\) \{\s*if \(!window\.confirm\(`確定要刪除「\$\{s\.name\}」嗎？此動作無法復原。`\)\) return;\s*const seq = currentRouteSeq\(\);\s*try \{\s*await api\('\/subscriptions\/' \+ s\.id, \{ method: 'DELETE' \}\);\s*rerenderSubscriptionsAfterAction\(seq, '訂閱已刪除'\);/);
  assert.match(source, /async function applyOrder\(ids, listKey\) \{\s*const seq = currentRouteSeq\(\);\s*await Promise\.all[\s\S]*?if \(seq !== currentRouteSeq\(\)\) return;\s*setListSort\(listKey, 'manual', 'asc'\);\s*renderSubscriptions\(\{ showLoading: false \}\);\s*\}/,
    '拖曳排序後只能在原路由原地更新');
  assert.match(toggle, /const message = s\.considerCancel \? '已取消「考慮停用」標記' : '已標記為考慮停用';\s*rerenderSubscriptionsAfterAction\(seq, message\);/);
  assert.doesNotMatch(toggle, /toast\(message\)/, '標記成功不可同時顯示 toast 與頁內通知');
  assert.match(form, /const message = sub \? '訂閱資料已更新' : '訂閱已新增';\s*rerenderSubscriptionsAfterAction\(seq, message\);/);
  assert.doesNotMatch(form, /toast\(message\)/, '儲存成功不可同時顯示 toast 與頁內通知');
}

function assertStateCss(css) {
  assert.match(css, /\.subscriptions-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.subscriptions-state \{[^}]*grid-template-columns: 116px minmax\(0, 520px\);[^}]*min-height: 330px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.subscriptions-state code \{[^}]*background: var\(--card-2\);[^}]*border: 1px solid var\(--line\);/);
  assert.match(css, /\.subscriptions-page \.subscriptions-analysis \.two-col > \* \{ min-width: 0; \}/,
    '圖表卡必須允許收窄，否則 Chart canvas 會把手機頁面撐寬');
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.subscriptions-state \{[^}]*grid-template-columns: 1fr;/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.subscriptions-page \.subscriptions-analysis \.two-col \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '狀態容器不可把頁面染成綠色');
  assert.doesNotMatch(css, /var\(--panel\)/, '訂閱頁專屬樣式不可引用未定義的色票');
}

test('訂閱追蹤狀態：載入、成功、錯誤與空白引導都能明確辨識', () => {
  assertStateBehavior(read('public/modules/subscriptions.js'));
});

test('訂閱追蹤狀態：失敗可重試，空白歷史保留，增刪改成功只在原頁接續', () => {
  assertStateWiring(read('public/modules/subscriptions.js'));
});

test('訂閱追蹤狀態：暖米橘容器與手機單欄由頁面專屬樣式擁有', () => {
  assertStateCss(read('public/subscriptions.css'));
});

test('訂閱追蹤狀態：破壞消毒、重試、空白接線、路由守衛或手機排列時考題會紅', () => {
  const source = read('public/modules/subscriptions.js');
  const css = read('public/subscriptions.css');

  const safeError = 'esc(String(message))';
  assert.ok(source.includes(safeError), '突變目標必須存在：錯誤訊息輸出消毒');
  assert.throws(() => assertStateBehavior(source.replace(safeError, 'String(message)')));

  const retry = "if (retry) retry.onclick = () => renderSubscriptions();";
  assert.ok(source.includes(retry), '突變目標必須存在：錯誤重試接線');
  assert.throws(() => assertStateWiring(source.replace(retry, `if (retry) retry.onclick = () => {}; // ${retry}`)));

  const emptyCta = "byId('emptyAddSub').onclick = () => openSubForm(null, creditCards);";
  assert.ok(source.includes(emptyCta), '突變目標必須存在：空白引導接線');
  assert.throws(() => assertStateWiring(source.replace(emptyCta, `byId('emptyAddSub').onclick = () => {}; // ${emptyCta}`)));

  const catchGuard = 'if (seq !== currentRouteSeq()) return;\n    view().innerHTML = subscriptionsLoadErrorHtml';
  assert.ok(source.includes(catchGuard), '突變目標必須存在：失敗狀態路由守衛');
  assert.throws(() => assertStateWiring(source.replace(catchGuard, `/* ${catchGuard} */\n    view().innerHTML = subscriptionsLoadErrorHtml`)));

  const saveGuard = 'if (seq !== currentRouteSeq()) return;\n  subscriptionNotice = message;';
  assert.ok(source.includes(saveGuard), '突變目標必須存在：成功狀態路由守衛');
  assert.throws(() => assertStateWiring(source.replace(saveGuard, 'subscriptionNotice = message;')));

  const emptyHistory = "byId('emptyAddSub').onclick = () => openSubForm(null, creditCards);\n    renderHistorySection(byId('historySection'));";
  assert.ok(source.includes(emptyHistory), '突變目標必須存在：空白狀態歷史接線');
  assert.throws(() => assertStateWiring(source.replace(emptyHistory,
    "byId('emptyAddSub').onclick = () => openSubForm(null, creditCards);")));

  const successNotice = '${subscriptionsPageHeadHtml()}\n    ${subscriptionNoticeHtml(notice)}';
  assert.ok(source.includes(successNotice), '突變目標必須存在：一般成功頁通知');
  assert.throws(() => assertStateWiring(source.replace(successNotice, '${subscriptionsPageHeadHtml()}')));

  const expireNotice = 'subscriptionNotice = notice;\n      return renderSubscriptions({ showLoading: false });';
  assert.ok(source.includes(expireNotice), '突變目標必須存在：自動校正通知接力');
  assert.throws(() => assertStateWiring(source.replace(expireNotice,
    'return renderSubscriptions({ showLoading: false });')));

  const conditionalLoading = 'if (showLoading) view().innerHTML = subscriptionsLoadingHtml();';
  assert.ok(source.includes(conditionalLoading), '突變目標必須存在：只有首次進頁才清成載入狀態');
  assert.throws(() => assertStateWiring(source.replace(conditionalLoading,
    'view().innerHTML = subscriptionsLoadingHtml();')));

  const deleteRefresh = "rerenderSubscriptionsAfterAction(seq, '訂閱已刪除');";
  assert.ok(source.includes(deleteRefresh), '突變目標必須存在：刪除成功原地確認');
  assert.throws(() => assertStateWiring(source.replace(deleteRefresh,
    'renderSubscriptions({ showLoading: false });')));

  const sortRefresh = 'renderSubscriptions({ showLoading: false });\n  });\n  view().querySelectorAll(\'[data-edit]\')';
  assert.ok(source.includes(sortRefresh), '突變目標必須存在：表頭排序原地更新');
  assert.throws(() => assertStateWiring(source.replace(sortRefresh,
    "renderSubscriptions();\n  });\n  view().querySelectorAll('[data-edit]')")));

  const orderRefresh = "setListSort(listKey, 'manual', 'asc');\n  renderSubscriptions({ showLoading: false });";
  assert.ok(source.includes(orderRefresh), '突變目標必須存在：拖曳排序原地更新');
  assert.throws(() => assertStateWiring(source.replace(orderRefresh,
    "setListSort(listKey, 'manual', 'asc');\n  renderSubscriptions();")));

  const orderGuard = 'if (seq !== currentRouteSeq()) return;\n  setListSort(listKey, \'manual\', \'asc\');';
  assert.ok(source.includes(orderGuard), '突變目標必須存在：拖曳排序路由守衛');
  assert.throws(() => assertStateWiring(source.replace(orderGuard,
    "setListSort(listKey, 'manual', 'asc');")));

  const toggleNoticeOnly = 'const message = s.considerCancel ? \'已取消「考慮停用」標記\' : \'已標記為考慮停用\';\n    rerenderSubscriptionsAfterAction(seq, message);';
  assert.ok(source.includes(toggleNoticeOnly), '突變目標必須存在：標記成功單一通知');
  assert.throws(() => assertStateWiring(source.replace(toggleNoticeOnly,
    toggleNoticeOnly.replace('rerenderSubscriptionsAfterAction', 'toast(message);\n    rerenderSubscriptionsAfterAction'))));

  const saveNoticeOnly = "const message = sub ? '訂閱資料已更新' : '訂閱已新增';\n      rerenderSubscriptionsAfterAction(seq, message);";
  assert.ok(source.includes(saveNoticeOnly), '突變目標必須存在：儲存成功單一通知');
  assert.throws(() => assertStateWiring(source.replace(saveNoticeOnly,
    saveNoticeOnly.replace('rerenderSubscriptionsAfterAction', 'toast(message);\n      rerenderSubscriptionsAfterAction'))));

  const mobileStack = 'grid-template-columns: 1fr; gap: 18px; min-height: 390px;';
  assert.ok(css.includes(mobileStack), '突變目標必須存在：手機狀態排列');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('1fr', '116px minmax(0, 520px)'))));

  const chartShrink = '.subscriptions-page .subscriptions-analysis .two-col > * { min-width: 0; }';
  assert.ok(css.includes(chartShrink), '突變目標必須存在：手機圖表收窄');
  assert.throws(() => assertStateCss(css.replace(chartShrink, chartShrink.replace('0', 'auto'))));
});
