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
    notice: build('insuranceNoticeHtml'),
    loading: build('insuranceLoadingHtml'),
    error: build('insuranceLoadErrorHtml'),
    empty: build('insuranceEmptyHtml'),
  };
}

function assertStateBehavior(source) {
  const { notice, loading, error, empty } = stateHelpers(source);
  assert.equal(notice(''), '');
  const noticeHtml = notice('已新增 <保單>');
  assert.match(noticeHtml, /role="status"/);
  assert.match(noticeHtml, /aria-live="polite"/);
  assert.match(noticeHtml, /已新增 &lt;保單&gt;/);
  assert.doesNotMatch(noticeHtml, /已新增 <保單>/);

  const loadingHtml = loading();
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /正在讀取保單資料/);
  assert.match(loadingHtml, /不會新增、刪除或修改任何資料/);

  const errorHtml = error('<script>alert(1)</script>');
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /id="retryInsurance"/);
  assert.match(errorHtml, /操作可能已經成功/);
  assert.match(errorHtml, /避免重複操作/);
  assert.match(errorHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(errorHtml, /<script>alert/);

  const emptyHtml = empty();
  assert.match(emptyHtml, /尚無保單/);
  assert.match(emptyHtml, /仍在繳費或需要續期的保單/);
  assert.match(emptyHtml, /id="emptyAddIns"/);
  assert.match(emptyHtml, /新增第一張保單/);
}

function assertStateWiring(source) {
  source = stripComments(source);
  assert.match(source, /const seq = currentRouteSeq\(\);\s*const notice = insuranceNotice;\s*insuranceNotice = '';\s*view\(\)\.innerHTML = insuranceLoadingHtml\(\);/);
  assert.match(source, /try \{\s*list = \(await api\('\/insurance'\)\)\.slice\(\)\.sort/);
  assert.match(source, /\} catch \(error\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*view\(\)\.innerHTML = insuranceLoadErrorHtml/);
  assert.match(source, /byId\('retryInsurance'\)\.onclick = \(\) => renderInsurance\(\);/);
  assert.match(source, /if \(emptyAdd\) emptyAdd\.onclick = \(\) => openInsForm\(\);/);
  assert.match(source, /insuranceNoticeHtml\(notice\)/);
  assert.match(source, /function rerenderInsuranceAfterSave\(seq, message\) \{\s*if \(seq !== currentRouteSeq\(\)\) return;\s*insuranceNotice = message;\s*return renderInsurance\(\);/);
  assert.match(source, /await api\('\/insurance\/' \+ p\.id, \{ method: 'DELETE' \}\);\s*if \(seq === currentRouteSeq\(\)\) insuranceNotice = '保單已刪除';/);
  assert.match(source, /const message = p \? '保單資料已更新' : '保單已新增';\s*toast\(message\);\s*rerenderInsuranceAfterSave\(seq, message\);/);
}

function assertStateCss(css) {
  assert.match(css, /\.insurance-notice \{[^}]*background: var\(--accent-soft\);[^}]*border: 1px solid var\(--accent\);/);
  assert.match(css, /\.insurance-state \{[^}]*min-height: 330px;[^}]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.insurance-error code \{[^}]*background: var\(--card-2\);[^}]*border: 1px solid var\(--line\);/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.insurance-state \{[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '狀態容器不可把頁面染成綠色');
  assert.doesNotMatch(css, /var\(--panel\)/, '保險頁專屬樣式不可引用未定義的色票');
}

test('保險追蹤狀態：載入、成功、錯誤與空白引導都能明確辨識', () => {
  assertStateBehavior(read('public/modules/insurance.js'));
});

test('保險追蹤狀態：失敗可重試，增刪改成功訊息只在原頁面接續', () => {
  assertStateWiring(read('public/modules/insurance.js'));
});

test('保險追蹤狀態：暖米橘容器與手機單欄操作由專屬樣式擁有', () => {
  assertStateCss(read('public/insurance.css'));
});

test('保險追蹤狀態：破壞消毒、重試、路由守衛或手機排列時考題會紅', () => {
  const source = read('public/modules/insurance.js');
  const css = read('public/insurance.css');

  const safeError = "esc(message || '無法連線')";
  assert.ok(source.includes(safeError), '突變目標必須存在：錯誤訊息輸出消毒');
  assert.throws(() => assertStateBehavior(source.replace(safeError, "message || '無法連線'")));

  const retry = "byId('retryInsurance').onclick = () => renderInsurance();";
  assert.ok(source.includes(retry), '突變目標必須存在：錯誤重試接線');
  const inertRetry = `byId('retryInsurance').onclick = () => {}; // ${retry}`;
  assert.throws(() => assertStateWiring(source.replace(retry, inertRetry)));

  const emptyCta = "if (emptyAdd) emptyAdd.onclick = () => openInsForm();";
  assert.ok(source.includes(emptyCta), '突變目標必須存在：空白引導接線');
  const inertEmptyCta = `if (emptyAdd) emptyAdd.onclick = () => {}; // ${emptyCta}`;
  assert.throws(() => assertStateWiring(source.replace(emptyCta, inertEmptyCta)));

  const catchGuard = 'if (seq !== currentRouteSeq()) return;\n    view().innerHTML = insuranceLoadErrorHtml';
  assert.ok(source.includes(catchGuard), '突變目標必須存在：失敗狀態路由守衛');
  const commentedCatchGuard = `/* ${catchGuard} */\n    view().innerHTML = insuranceLoadErrorHtml`;
  assert.throws(() => assertStateWiring(source.replace(catchGuard, commentedCatchGuard)));

  const saveGuard = 'if (seq !== currentRouteSeq()) return;\n  insuranceNotice = message;';
  assert.ok(source.includes(saveGuard), '突變目標必須存在：成功狀態路由守衛');
  assert.throws(() => assertStateWiring(source.replace(saveGuard, 'insuranceNotice = message;')));

  const mobileStack = 'display: flex; align-items: center;\n    flex-direction: column; text-align: center;';
  assert.ok(css.includes(mobileStack), '突變目標必須存在：手機狀態排列');
  assert.throws(() => assertStateCss(css.replace(mobileStack, mobileStack.replace('column', 'row'))));
});
