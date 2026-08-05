// @ts-check
// 彈窗下拉「不可靜靜改掉使用者資料」的考題（#415，2026-08-05；William 拍板要修的通用坑）。
//
// ## 病根（已查證，不是假設）
//
// `public/app.js` 的 `openForm` 產生下拉時，只在「選項的值與現在的值完全相同」時才加 `selected`，
// 送出時直接讀 `select.value`。**現在的值不在選項清單裡 ⇒ 瀏覽器自動選第一項**，
// 使用者只是打開表單改個別的欄位按儲存，這一欄就被靜靜改掉、畫面零提示。
// 實害路徑：帳戶型別在 `lib/schema.js` 的 `FIELD_SCHEMA.accounts.type` 有九個合法值，
// 帳戶表單當時只列七個 ⇒ `liability`／`creditcard` 的帳戶打開改個名字按儲存就 PUT `type:'cash'`，
// 50 萬負債變 50 萬資產、淨資產一次跳 100 萬。
// 那兩個型別本身已由 `public/modules/accounts-model.js` 收成單一真相；**本檔守的是機制**——
// 幣別、分類、卡片、週期…每一個下拉都踩同一個坑。
//
// ## 為什麼考題打的是 `public/modules/form-options.js` 而不是 `openForm`
//
// `public/app.js` 模組頂層會碰 document／localStorage，node 裡 import 不進來（實測；
// `test/xss-id-escaping.test.js` 也是因此才只能抓原始碼現場 eval）。所以「產生選項 HTML」被抽成
// 零 DOM 純模組，考題直接 import 跑**行為級**斷言——不必用「讀原始碼文字」那種脆弱手法。
// 唯一還得看原始碼的是最後一題（`app.js` 有沒有真的用它），它自己寫了擋得住什麼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectOptionsHtml, UNLISTED_VALUE_NOTE } from '../public/modules/form-options.js';
import { esc } from '../public/modules/html-escape.js';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **舊寫法的參考實作（逐字照抄 #415 之前的 `openForm`）**——用來釘住「修這個坑沒有順手改壞既有表單」：
 * 只要現在的值命中了某個選項，新舊輸出必須**一個字元都不差**（含未選中時 `"` 與 `>` 之間那個空格）。
 * @param {any[]} options @param {any} v
 */
const legacyOptionsHtml = (options, v) => (options || []).map(o => {
  const ov = typeof o === 'string' ? o : o.value;
  const ol = typeof o === 'string' ? o : o.label;
  return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`;
}).join('');

/** 取出所有帶 selected 的選項值。 @param {string} html */
const selectedValues = (html) => [...html.matchAll(/<option value="([^"]*)"\s+selected>/g)].map(m => m[1]);

/** 取出所有選項的值（依出現順序）。 @param {string} html */
const optionValues = (html) => [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);

// 帳戶型別下拉的真實形狀（資產頁那張表單）：漏列 liability／creditcard 時的樣子
const ACCOUNT_TYPE_OPTS = [
  { value: 'cash', label: '現金 / 存款' },
  { value: 'investment', label: '投資（股票/ETF/IB）' },
  { value: 'property', label: '房地產' },
];

test('現值不在選項裡 ⇒ 必須保留它（擺最前面、帶看得懂的提示字），不可靜靜換成第一項', () => {
  const html = selectOptionsHtml(ACCOUNT_TYPE_OPTS, 'liability');

  assert.ok(optionValues(html).includes('liability'),
    '現在的值不在選項清單裡就被丟掉了——按儲存會靜靜把它改成第一項（50 萬負債變 50 萬資產的病根）');
  assert.equal(optionValues(html)[0], 'liability', '保留下來的現值要擺在最前面，使用者一打開就看得到');
  assert.equal(optionValues(html).length, ACCOUNT_TYPE_OPTS.length + 1, '只補一項，不可重複或吃掉原本的選項');
  assert.match(html, new RegExp(`>liability（${UNLISTED_VALUE_NOTE}）<`),
    '保留下來的那一項要有白話提示，讓使用者知道「這是你現在的設定、它不在標準選項裡」');
});

test('保留下來的現值必須是**被選取**的那一個（渲染出來卻沒選＝按儲存照樣被改掉）', () => {
  const html = selectOptionsHtml(ACCOUNT_TYPE_OPTS, 'liability');
  assert.deepEqual(selectedValues(html), ['liability'],
    '被 selected 的必須剛好是現在的值：沒標＝瀏覽器仍然選第一項，這個修法等於沒做');
});

test('提示文案是給沒有程式背景的人看的：白話中文、不出現英文技術詞', () => {
  assert.equal(/[A-Za-z]/.test(UNLISTED_VALUE_NOTE), false,
    `提示字裡不可以有英文（使用者無程式背景）：現在是「${UNLISTED_VALUE_NOTE}」`);
  assert.ok(UNLISTED_VALUE_NOTE.includes('目前的設定'), '提示字要講清楚「這是目前的設定」，不然使用者不知道那一項是什麼');
});

test('現值在選項裡 ⇒ 輸出與舊寫法**逐字相同**（修這個坑不可以改壞既有的每一張表單）', () => {
  /** @type {[any[], any][]} */
  const cases = [
    [ACCOUNT_TYPE_OPTS, 'cash'],                                    // 命中第一項
    [ACCOUNT_TYPE_OPTS, 'property'],                                // 命中最後一項
    [['TWD', 'USD', 'GBP', 'JPY'], 'USD'],                          // 純字串選項
    [[{ value: '', label: '（不指定）' }, { value: '玉山', label: '玉山' }], ''],   // 空字串是合法選項值
    [[{ value: 'a', label: 'A' }], 'a'],
  ];
  for (const [opts, v] of cases) {
    assert.equal(selectOptionsHtml(opts, v), legacyOptionsHtml(opts, v),
      `現值命中選項時輸出必須與舊寫法一模一樣（options=${JSON.stringify(opts)} value=${JSON.stringify(v)}）`);
  }
});

test('空值（空字串／null／undefined）不算「值」⇒ 不可因此長出一個空白選項', () => {
  const expected = legacyOptionsHtml(ACCOUNT_TYPE_OPTS, '');
  for (const empty of ['', null, undefined]) {
    const html = selectOptionsHtml(ACCOUNT_TYPE_OPTS, empty);
    assert.equal(html, expected, `${JSON.stringify(empty)} ＝「還沒選」，原本「選第一項」就是對的行為，不可多長一項`);
    assert.equal(optionValues(html).length, ACCOUNT_TYPE_OPTS.length, '選項數量必須與舊行為相同');
  }
});

test('惡意的現值必須被跳脫（鐵則 3：插進 innerHTML 前一律過 esc）', () => {
  const payload = '"><img src=x onerror="document.body.dataset.x=1"><button data-tail="';
  const html = selectOptionsHtml(ACCOUNT_TYPE_OPTS, payload);

  assert.equal(html.includes('<img'), false, '消毒後不可以還有真正的 <img> 元素（innerHTML 插入 <img onerror> 會立刻執行）');
  assert.equal(/<option value="[^"]*"[^>]*onerror/.test(html), false, '不可以有可執行的 onerror 屬性溜進標籤裡');
  assert.match(html, /&lt;img src=x/, '角括號要被轉成實體');
  assert.match(html, /&quot;/, '雙引號要被轉成實體（否則提前關掉 value 屬性）');
  // 保留機制本身仍要成立：跳脫過後那一項還是被選取的
  assert.deepEqual(selectedValues(html), [esc(payload)], '跳脫之後仍必須是被選取的那一項');
});

test('惡意的選項標籤／選項值也必須被跳脫（既有路徑的回歸）', () => {
  const html = selectOptionsHtml([{ value: '<b>v</b>', label: '<img src=x onerror="1">' }], '');
  assert.equal(html.includes('<img'), false, '選項標籤沒過 esc');
  assert.equal(html.includes('<b>'), false, '選項值沒過 esc');
  assert.match(html, /&lt;img/, '角括號要被轉成實體');
});

test('沒給 options（或給了非陣列）不整頁掛掉；但現在的值仍要被保留', () => {
  for (const bad of [undefined, null, /** @type {any} */ ('不是陣列')]) {
    assert.equal(selectOptionsHtml(bad, ''), '', '忘給 options 時顯示空下拉、不丟例外（沿用舊行為）');
    assert.deepEqual(selectedValues(selectOptionsHtml(bad, 'liability')), ['liability'],
      '沒有任何選項時更不能把值弄丟——那一存檔就是空字串');
  }
});

test('多個選項同值時沿用舊行為（全部標 selected，瀏覽器取最後一個）', () => {
  const opts = [{ value: 'x', label: '一' }, { value: 'x', label: '二' }];
  assert.equal(selectOptionsHtml(opts, 'x'), legacyOptionsHtml(opts, 'x'));
  assert.deepEqual(selectedValues(selectOptionsHtml(opts, 'x')), ['x', 'x']);
});

test('數字型的現值與字串選項互相對得上（沿用舊的 String() 比對口徑）', () => {
  const opts = [{ value: '1', label: '一' }, { value: '2', label: '二' }];
  assert.equal(selectOptionsHtml(opts, 2), legacyOptionsHtml(opts, 2), '數字 2 要命中字串選項 "2"，不可多補一項');
  assert.deepEqual(selectedValues(selectOptionsHtml(opts, 9)), ['9'], '沒命中的數字一樣要被保留');
});

/**
 * 去註解掃描器（堆疊式；字串／樣板字串／樣板插值裡的 `//` 不當註解）。
 * 演算法與 `test/hosted-auth.test.js` 那支同源——本 repo 的考題不共用 helper 檔
 *（`test/` 底下任何 .js 都會被 `node --test` 當考題跑），所以這裡是刻意的區域副本。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const n = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && n === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && n === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
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
      if (c === '*' && n === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 'tpl') {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && n === '{') { stack.push('interp'); interp.push(0); out += n; i++; }
      prev = c;
    } else {   // s1 / s2
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"')) stack.pop();
      else if (c === '\n') stack.pop();   // 一般字串不跨行＝未終結防呆
      prev = c;
    }
  }
  return out;
}

test('架構｜openForm 的下拉真的是這支純模組產的，不是 app.js 自己又抄一份', () => {
  // ⚠️ 這是**唯一**一題靠讀原始碼（`app.js` import 不進 node，前面所有行為級斷言到不了它）。
  // 誠實劃界：它擋得住「把舊的產生器複製回 app.js」與「悄悄拔掉 import」這兩種真實走樣；
  // 擋不住刻意混淆（字串拼接組出標籤名），也不宣稱「瀏覽器實際跑的就是這條路」。
  const raw = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const src = stripComments(raw);

  // 反空轉：剝離器若吃掉真程式碼，下面的斷言會變成「什麼都沒檢查卻通過」
  assert.ok(src.includes('export function openForm'), '去註解後找不到 openForm——剝離器把程式碼吃掉了，本題失去意義');
  assert.ok(src.includes('modal-bg'), '去註解後找不到彈窗樣板——剝離器把程式碼吃掉了，本題失去意義');

  assert.match(src, /import\s*\{[^}]*\bselectOptionsHtml\b[^}]*\}\s*from\s*['"]\.\/modules\/form-options\.js['"]/,
    'app.js 必須從 modules/form-options.js 取 selectOptionsHtml（換寫法就來改本題，讓改動被看見）');
  assert.match(src, /selectOptionsHtml\s*\(/, 'import 了卻沒呼叫＝下拉還是舊的產生器在做');

  // 除了 checkbox 那個自製的是／否下拉，app.js 不准再自己拼選項標籤（那就是把病根抄回來）
  const offenders = src.split('\n')
    .map((line, i) => ({ no: i + 1, line }))
    .filter(({ line }) => line.includes('<option'))
    .filter(({ line }) => !(line.includes('value="true"') && line.includes('value="false"')));
  assert.deepEqual(offenders.map(o => o.no), [],
    `app.js 這幾行又自己拼選項了（應該交給 form-options.js）：\n${offenders.map(o => `${o.no}: ${o.line.trim()}`).join('\n')}`);
});

test('架構｜esc 只有一份實作：app.js 原樣 re-export，純模組與頁面用的是同一個函式', () => {
  const raw = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const src = stripComments(raw);
  assert.match(src, /from\s*['"]\.\/modules\/html-escape\.js['"]/,
    'app.js 必須從 modules/html-escape.js 取 esc——它自己再長一份，跳脫就會與純模組走散');
  assert.match(src, /export\s*\{\s*esc\s*(?:,[^}]*)?\}/,
    'app.js 必須把 esc 原樣 re-export（全站二十幾個模組都從 app.js 取）');
});
