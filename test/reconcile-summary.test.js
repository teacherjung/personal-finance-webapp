// @ts-check
// 匯入預覽「對帳驗算」就地說明的考題（P0 前端子項）：純函式吃裁決回 HTML，
// 銀行/信用卡兩頁共用同一份翻譯——這裡鎖住句意、計數、跳脫與「裁決缺席＝不長東西」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateSummaryHtml } from '../public/modules/reconcile-summary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 去註解掃描器（堆疊式；字串／樣板字串裡的 `//` 不算註解）。
 * 與 contract-split.test.js／cashflow-bank-upload.test.js 同源——本 repo 的考題**不共用 helper 檔**
 * （test/ 底下任何 .js 都會被 node --test 當考題跑），所以這裡是刻意的區域副本。
 * 為什麼需要：AGENTS 硬規則「掃原始碼的形狀考題要先去掉註解」——註解常逐字引用舊程式碼。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const nx = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && nx === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && nx === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
      if (c === '\'') stack.push('s1');
      else if (c === '"') stack.push('s2');
      else if (c === '`') stack.push('tpl');
      else if (st === 'interp') {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) { stack.pop(); interp.pop(); out += c; prev = c; continue; }
          interp[interp.length - 1]--;
        }
      }
      out += c; prev = c;
    } else if (st === 'line') {
      if (c === '\n') { stack.pop(); out += c; prev = ''; }
    } else if (st === 'block') {
      if (c === '*' && nx === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 's1' || st === 's2' || st === 'tpl') {
      out += c;
      if (c === '\\' && prev !== '\\') { prev = c; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"') || (st === 'tpl' && c === '`')) { if (prev !== '\\') stack.pop(); }
      else if (st === 'tpl' && c === '$' && nx === '{') { stack.push('interp'); interp.push(0); out += '{'; i++; }
      prev = prev === '\\' && c === '\\' ? '' : c;
    }
  }
  return out;
}

test('銀行｜驗算通過：講出驗了幾關、期末吻合幾戶、外幣跳過幾筆（數字來自裁決 stats）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [],
    stats: { pairsChecked: 29, endChecked: 4, foreignRowsSkipped: 2 } }, 'bank');
  assert.match(h, /✓ 帳單數學驗算通過/);
  assert.match(h, /逐筆餘額 29 關全部接上/);
  assert.match(h, /4 個帳戶期末與帳單概要吻合/);
  assert.match(h, /外幣明細 2 筆不驗算（也不會匯入）/);
});

test('銀行｜沒驗到期末/沒有外幣＝那兩句不出現（不可硬湊「0 個帳戶」這種句子）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 3, endChecked: 0, foreignRowsSkipped: 0 } }, 'bank');
  assert.match(h, /逐筆餘額 3 關/);
  assert.doesNotMatch(h, /期末/);
  assert.doesNotMatch(h, /外幣/);
});

test('銀行｜弱＝講「沒讀到」不講「帳單沒有」；匯入範圍照實講「全部非重複台幣明細」（r1#1＋r2#1）', () => {
  // r2#1：銀行預覽只顯示前 12 筆、確認後匯入全部——「只會匯入上面列出的」是錯的承諾，
  // 會讓使用者以為沒顯示的不會入帳。
  const h = gateSummaryHtml({ level: 'weak', advisories: [], stats: {} }, 'bank');
  assert.match(h, /△ 沒讀到足夠的餘額數字可驗算/);
  assert.match(h, /全部非重複台幣明細/);
  assert.match(h, /僅預覽前 12 筆/);
  assert.match(h, /核對筆數與金額/);
  assert.doesNotMatch(h, /帳單沒有/, '不可把降級講成帳單的鍋');
  assert.doesNotMatch(h, /只會匯入上面列出/, '不可暗示「沒顯示＝不匯入」');
});

test('銀行｜只驗到期末（餘額鏈 0 對）＝不可出現「逐筆餘額 0 關全部接上」（r1#2）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 0, endChecked: 2 } }, 'bank');
  assert.match(h, /✓ 帳單數學驗算通過/);
  assert.match(h, /2 個帳戶期末與帳單概要吻合/);
  assert.doesNotMatch(h, /0 關/, '驗到哪關講哪關，不可湊句');
});

test('不認得的 level＝形狀不對＝空字串（r1#3：level:bogus 不可誤套弱級句）', () => {
  assert.equal(gateSummaryHtml(/** @type {any} */ ({ level: 'bogus', advisories: [], stats: {} }), 'bank'), '');
  assert.equal(gateSummaryHtml(/** @type {any} */ ({ level: 'strong', advisories: [], stats: {} }), 'card'), '',
    'strong 不是卡片畫面的合法級別——後端形狀變動時寧可不顯示');
});

test('信用卡｜摘要驗算通過＝講等式本人；零提醒＝不長清單', () => {
  const h = gateSummaryHtml({ level: 'medium', advisories: [], stats: {} }, 'card');
  assert.match(h, /✓ 帳單摘要驗算通過/);
  assert.match(h, /上期應繳 − 已繳款 ＋ 本期新增 ＝ 本期應繳/);
  assert.doesNotMatch(h, /<ul/);
});

test('信用卡｜影子提醒原文列出、不擋匯入；訊息內容一律跳脫（advisory 文字進 HTML 的唯一通道）', () => {
  const h = gateSummaryHtml({ level: 'medium', stats: {},
    advisories: [{ message: '差 100——可能漏讀' }, { message: '<img src=x onerror=alert(1)>' }] }, 'card');
  assert.match(h, /⚠ 差 100——可能漏讀/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/, '惡意字串要以跳脫後的樣子出現');
  assert.doesNotMatch(h, /<img/, '不可有未跳脫的原始標籤');
});

test('信用卡｜弱＝講「沒讀到」、XLSX 只當例子；匯入承諾限縮在「讀到且勾選」（r1#1）', () => {
  const h = gateSummaryHtml({ level: 'weak', advisories: [], stats: {} }, 'card');
  assert.match(h, /△ 沒讀到可交叉驗算的總額/);
  assert.match(h, /例如官網下載的 XLSX/, '不可斷言這份就是 XLSX——裁決裡看不出檔案格式');
  assert.match(h, /只會匯入下面讀到且勾選的明細/);
  assert.match(h, /核對筆數與金額/);
});

test('裁決缺席/形狀不對＝回空字串（舊回應/降級時畫面不多長東西、不炸）', () => {
  assert.equal(gateSummaryHtml(null, 'bank'), '');
  assert.equal(gateSummaryHtml(undefined, 'card'), '');
  assert.equal(gateSummaryHtml(/** @type {any} */ ({}), 'bank'), '', '沒有 level＝不認得的形狀');
  assert.equal(gateSummaryHtml(/** @type {any} */ ('strong'), 'card'), '', '字串不是物件');
});

test('接線｜兩個預覽窗都真的呼叫 gateSummaryHtml（去註解原始碼形狀——cashflow.js 頂層 import app.js、node 載不動整頁，形狀掃描＝家規核可的接線驗法；顯示型接線被拔＝功能靜靜消失）', () => {
  // 鎖**插值形狀** `${gateSummaryHtml(…)}` 而非只鎖呼叫（r1#4）：`${(gateSummaryHtml(…), '')}` 這種
  // 逗號運算子寫法「有呼叫、沒插進畫面」——只鎖名稱的正規式會放它過、功能靜靜消失。
  const cashflow = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(cashflow, /from '\.\/reconcile-summary\.js'/, '銀行頁要 import 本模組');
  assert.match(cashflow, /\$\{gateSummaryHtml\(r\.reconcile, 'bank'\)\}/, '銀行預覽窗要把翻譯結果插進畫面');
  const txImport = stripComments(readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8'));
  assert.match(txImport, /from '\.\/reconcile-summary\.js'/, '卡片頁要 import 本模組');
  assert.match(txImport, /\$\{gateSummaryHtml\(curR\.reconcile, 'card'\)\}/, '卡片預覽窗（draw 內＝換卡重算也會刷新）要插進畫面');
});

test('advisories 不是陣列＝當空處理、stats 缺席＝計數當 0（防禦：後端形狀變動不炸畫面）', () => {
  const h = gateSummaryHtml(/** @type {any} */ ({ level: 'medium', advisories: 'x' }), 'card');
  assert.match(h, /✓ 帳單摘要驗算通過/);
  assert.doesNotMatch(h, /<ul/);
  const b = gateSummaryHtml(/** @type {any} */ ({ level: 'strong' }), 'bank');
  assert.match(b, /✓ 帳單數學驗算通過/, 'stats 缺席仍給結論');
  assert.doesNotMatch(b, /0 關/, '不可湊出「0 關」（r1#2）');
  assert.doesNotMatch(b, /：。/, '不可留空冒號句');
});
