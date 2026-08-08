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
  };
  const nextName = nextByName[name];
  assert.ok(nextName, `未登記 ${name} 的下一個函式`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(end > start, `${name} 缺少結束邊界`);
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
  assert.match(source, /const seq = currentRouteSeq\(\);\s*const notice = subscriptionNotice;\s*subscriptionNotice = '';\s*destroyCharts\(\);\s*view\(\)\.innerHTML = subscriptionsLoadingHtml\(\);/);
  assert.match(source, /try \{\s*\[raw, cards\] = await Promise\.all\(\[api\('\/subscriptions'\), api\('\/cards'\)\]\);/);
  assert.match(source, /\} catch \(e\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = subscriptionsLoadErrorHtml/);
  assert.match(source, /if \(retry\) retry\.onclick = \(\) => renderSubscriptions\(\);/);
  assert.match(source, /if \(!raw\.length\) \{[\s\S]*byId\('emptyAddSub'\)\.onclick = \(\) => openSubForm\(null, creditCards\);[\s\S]*renderHistorySection\(byId\('historySection'\)\);/);
  assert.match(source, /subscriptionNoticeHtml\(notice\)/);
  assert.match(source, /function rerenderSubscriptionsAfterAction\(seq, message\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*subscriptionNotice = message;\s*renderSubscriptions\(\);/);
  assert.match(source, /await api\('\/subscriptions\/' \+ s\.id, \{ method: 'DELETE' \}\);\s*if \(actionSeq === currentRouteSeq\(\)\) subscriptionNotice = '訂閱已刪除';/);
  assert.match(source, /const message = s\.considerCancel \? '已取消「考慮停用」標記' : '已標記為考慮停用';\s*toast\(message\);\s*rerenderSubscriptionsAfterAction\(seq, message\);/);
  assert.match(source, /const message = sub \? '訂閱資料已更新' : '訂閱已新增';\s*toast\(message\);\s*rerenderSubscriptionsAfterAction\(seq, message\);/);
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

  const mobileStack = 'grid-template-columns: 1fr; gap: 18px; min-height: 390px;';
  assert.ok(css.includes(mobileStack), '突變目標必須存在：手機狀態排列');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('1fr', '116px minmax(0, 520px)'))));

  const chartShrink = '.subscriptions-page .subscriptions-analysis .two-col > * { min-width: 0; }';
  assert.ok(css.includes(chartShrink), '突變目標必須存在：手機圖表收窄');
  assert.throws(() => assertStateCss(css.replace(chartShrink, chartShrink.replace('0', 'auto'))));
});
