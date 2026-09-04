// @ts-check
// 彈窗下拉「不可靜靜改掉使用者資料」的考題（#409，2026-08-05；William 拍板要修的通用坑）。
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
// 幣別、卡別、訂閱週期…每一個「由 `openForm` 的 `options` 餵出來」的下拉都踩同一個坑。
// ⚠️ **分類／子類下拉不在那句話裡面**：它們是 `openForm` 之後由 `onMount` 整段覆寫 innerHTML 的，
// 走不到那條路（#409 自審抓到，當時檔頭把分類算成已修好）。那一族由本檔最後三題守，
// 誠實劃界寫在 `public/modules/form-options.js` 檔頭。
//
// ## 為什麼考題打的是 `public/modules/form-options.js` 而不是 `openForm`
//
// `public/app.js` 模組頂層會碰 document／localStorage，node 裡 import 不進來（實測；
// `test/xss-id-escaping.test.js` 也是因此才只能抓原始碼現場 eval）。所以「產生選項 HTML」被抽成
// 零 DOM 純模組，考題直接 import 跑**行為級**斷言——不必用「讀原始碼文字」那種脆弱手法。
// 還得看原始碼的是三題「架構｜…」（`app.js` 與三個頁面模組有沒有真的用它、餵進去的是不是現在的值），
// 每一題自己寫了擋得住／擋不住什麼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectOptionsHtml, effectiveSelectValue, subcategoryOptionsHtml, UNLISTED_VALUE_NOTE } from '../public/modules/form-options.js';
import { esc } from '../public/modules/html-escape.js';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **舊寫法的參考實作（逐字照抄 #409 之前的 `openForm`）**——用來釘住「修這個坑沒有順手改壞既有表單」：
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
  { value: 'investment', label: '證券 / 投資' },
  { value: 'property', label: '房產 / 財產' },
];

test('現值不在選項裡 ⇒ 必須保留它（擺最前面、帶看得懂的提示字），不可靜靜換成第一項', () => {
  const html = selectOptionsHtml(ACCOUNT_TYPE_OPTS, 'liability');

  assert.ok(optionValues(html).includes('liability'),
    '現在的值不在選項清單裡就被丟掉了——按儲存會靜靜把它改成第一項（50 萬負債變 50 萬資產的病根）');
  assert.equal(optionValues(html)[0], 'liability', '保留下來的現值要擺在最前面，使用者一打開就看得到');
  assert.equal(optionValues(html).length, ACCOUNT_TYPE_OPTS.length + 1, '只補一項，不可重複或吃掉原本的選項');
  assert.match(html, new RegExp(`>liability（${UNLISTED_VALUE_NOTE}）<`),
    '保留下來的那一項要有白話提示，讓使用者知道「這是你現在的設定、清單裡沒有這一項」');
});

test('**純字串選項**也要保留現值——實務上多數下拉是這一型（幣別／卡別／分類…）', () => {
  // #409 自審實測的繞法：只讓「清單全是字串」那一型退回舊行為
  //（`if (hit || cur === '' || list.every(o => typeof o === 'string')) return html;`）
  // ⇒ 當時全套 1518 題 pass / 0 fail、本檔 12 題一顆都沒紅。因為原本 12 題裡的字串案例
  // 只有「命中」那一種（`['TWD','USD','GBP','JPY']` + `'USD'`），沒有任何「字串選項＋值不在裡面」。
  // 而純字串正是實務上的多數：`accounts-model.js` 的 `ACCOUNT_CURRENCIES`、投資頁的
  // `PORTFOLIO_CURRENCIES`、`cards.js` 的 `NETWORKS`、訂閱的分類與 email 選項、
  // 信用卡明細的 `allCategories()`、設定頁店家編輯的 `catOpts` 全是字串陣列。
  const fx = selectOptionsHtml(['TWD', 'USD', 'GBP', 'JPY'], 'EUR');

  assert.equal(optionValues(fx)[0], 'EUR',
    '幣別下拉就是純字串選項：這一類漏掉＝「帳戶幣別被靜靜換成 TWD、之後每次換算都用錯匯率」那條路根本沒被守到');
  assert.deepEqual(selectedValues(fx), ['EUR'],
    '保留了卻沒標 selected＝瀏覽器仍選第一項（TWD），錢照樣用錯匯率換算');
  assert.match(fx, new RegExp(`>EUR（${UNLISTED_VALUE_NOTE}）<`), '字串選項那一型也要有白話提示');

  // 同一型的第二個實例：支出大類（`allCategories()` 回傳字串陣列），現值是被刪掉的舊分類
  const cat = selectOptionsHtml(['飲食', '交通', '居住'], '已刪掉的舊分類');
  assert.deepEqual(selectedValues(cat), ['已刪掉的舊分類'], '被刪掉的舊分類要留著，不可被靜靜歸到「飲食」');
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

test('架構｜openForm 的下拉真的是這支純模組產的，而且餵進去的是「這一欄現在的值」', () => {
  // ⚠️ 這一題靠讀原始碼（`app.js` import 不進 node，前面所有行為級斷言到不了它）。
  // 誠實劃界：它擋得住「把舊的產生器複製回 app.js」「悄悄拔掉 import」「把第二個參數餵成別的東西」
  // 這三種真實走樣；擋不住刻意混淆（字串拼接組出標籤名），也不宣稱「瀏覽器實際跑的就是這條路」。
  const raw = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const src = stripComments(raw);

  // 反空轉：剝離器若吃掉真程式碼，下面的斷言會變成「什麼都沒檢查卻通過」
  assert.ok(src.includes('export function openForm'), '去註解後找不到 openForm——剝離器把程式碼吃掉了，本題失去意義');
  assert.ok(src.includes('modal-bg'), '去註解後找不到彈窗樣板——剝離器把程式碼吃掉了，本題失去意義');

  assert.match(src, /import\s*\{[^}]*\bselectOptionsHtml\b[^}]*\}\s*from\s*['"]\.\/modules\/form-options\.js['"]/,
    'app.js 必須從 modules/form-options.js 取 selectOptionsHtml（換寫法就來改本題，讓改動被看見）');

  // ⚠️ 只釘「有呼叫」是不夠的（#409 自審實測）：把呼叫改成 `selectOptionsHtml(f.options, '')`
  //（import 與呼叫都原樣留著）⇒ 每個下拉又回到「選第一項」、整支修法對使用者的效果完全消失，
  // 而全套 1518 題 pass / 0 fail、本檔的行為級考題一顆都沒紅。所以要釘住**呼叫的形狀**。
  assert.match(src, /selectOptionsHtml\s*\(\s*f\.options\s*,\s*v\s*\)/,
    '第二個參數必須是「這一欄現在的值」（openForm 的 v）：餵空字串或任何常數，等於這支 PR 沒做——'
    + '每個下拉都回到「值不在選項裡就選第一項」，而所有行為級考題照樣全綠');
  assert.match(src, /const\s+v\s*=\s*values\[\s*f\.key\s*\]\s*\?\?/,
    'v 必須從這筆資料現在的值算起（values[f.key] ?? …）——否則上一條只是釘住一個名字叫 v 的常數');

  // 除了 checkbox 那個自製的是／否下拉，app.js 不准再自己拼選項標籤（那就是把病根抄回來）
  const offenders = src.split('\n')
    .map((line, i) => ({ no: i + 1, line }))
    .filter(({ line }) => line.includes('<option'))
    .filter(({ line }) => !(line.includes('value="true"') && line.includes('value="false"')));
  assert.deepEqual(offenders.map(o => o.no), [],
    `app.js 這幾行又自己拼選項了（應該交給 form-options.js）：\n${offenders.map(o => `${o.no}: ${o.line.trim()}`).join('\n')}`);
});

test('架構｜esc 的 re-export 接線（字面釘：只掃 app.js 的 import／export 字串；「同一個函式」由同檔題名關鍵字「app.js 匯出的 esc 就是 html-escape.js 的那一個函式」那題用行為守）', () => {
  const raw = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const src = stripComments(raw);
  assert.match(src, /from\s*['"]\.\/modules\/html-escape\.js['"]/,
    'app.js 必須從 modules/html-escape.js 取 esc——它自己再長一份，跳脫就會與純模組走散');
  assert.match(src, /export\s*\{\s*esc\s*(?:,[^}]*)?\}/,
    'app.js 必須把 esc 原樣 re-export（全站二十幾個模組都從 app.js 取）');
});

// ---------------------------------------------------------------------------
// 以下四題守「onMount 事後重建的下拉」（#409 自審抓到的第三個洞）
//
// openForm 產完之後，收支／信用卡明細／設定頁會在 onMount 裡把分類、子類那個 <select> 的
// innerHTML **整段覆寫**——那些下拉走不到 openForm 那條路，上面的保留機制對它們零效果。
// 當時檔頭卻把「分類」寫成已經修好的下拉，而其中兩處仍是同一個病（舊病，不是 #409 弄壞的）：
//   ・cashflow.js 的父分類：`parents.includes(curCat) ? curCat : (parents[0] || '')`
//     ⇒ 分類事後被刪過、或匯入資料帶著舊分類時，一打開表單就被靜靜換成第一個父分類、按儲存寫進去。
//   ・transactions.js 的子類：沒把清單外的現值補回去 ⇒ 子類被刪掉後編輯任一筆就被靜靜清成空白。
// ---------------------------------------------------------------------------

test('連動用的「使用者不動就會送出的值」與保留機制同一套判準', () => {
  // 呼叫端拼完 HTML 還得知道「現在選中的是誰」才能連動下一層（分類→子類）。
  // 兩份判準走散就會長出「HTML 保留了現值、連動卻拿第一項去算」這種半修好的狀態。
  assert.equal(effectiveSelectValue(['飲食', '交通'], '已刪掉的舊分類'), '已刪掉的舊分類',
    '現值不在清單裡時，選中的是被保留的那一項（不是第一項）——這裡答錯，子類會依「飲食」去填');
  assert.equal(effectiveSelectValue(['飲食', '交通'], '交通'), '交通', '現值命中時就是它');
  assert.equal(effectiveSelectValue(['飲食', '交通'], ''), '飲食', '空值＝還沒選 ⇒ 瀏覽器選第一項（與 selectOptionsHtml 同口徑）');
  assert.equal(effectiveSelectValue([], ''), '', '沒有任何選項也不可回 undefined／爆掉');
  assert.equal(effectiveSelectValue([{ value: 'a', label: 'A' }], ''), 'a', '物件選項取 value');
  assert.equal(effectiveSelectValue(null, 'liability'), 'liability', '忘給 options 時更不能把值弄丟');
  assert.equal(effectiveSelectValue(['x'], 2), '2', '沿用 String() 口徑（數字現值）');
});

test('子類下拉：清單外的現值必須保留（子類被刪掉後，編輯任一筆不可被靜靜清成空白）', () => {
  const subs = ['', '早餐', '午餐'];

  // 現值還在樹裡＝完全照舊
  assert.equal(subcategoryOptionsHtml(subs, '午餐'),
    `<option value="" >（不分子類）</option><option value="早餐" >早餐</option><option value="午餐" selected>午餐</option>`,
    '命中時的輸出（含「（不分子類）」標籤與 `"` 與 `>` 之間那個空格）必須與收斂前三份抄本逐字相同');

  // 現值被刪掉／改名了＝孤兒，要補在最前面並選中
  const orphan = subcategoryOptionsHtml(subs, '宵夜');
  assert.equal(optionValues(orphan)[0], '宵夜', '清單外的現值要補在最前面');
  assert.deepEqual(selectedValues(orphan), ['宵夜'],
    '沒保留＝<select> 選第一項（空字串），使用者只改個金額按儲存，子類就被靜靜清成空白');
  assert.equal(optionValues(orphan).length, subs.length + 1, '只補一項');

  // 空的現值＝還沒選，不可多補一項空白
  assert.deepEqual(selectedValues(subcategoryOptionsHtml(subs, '')), [''], '空現值選中的是「（不分子類）」那一項');
  assert.equal(optionValues(subcategoryOptionsHtml(subs, '')).length, subs.length, '空現值不可多長一項');

  // 內轉刻意不放空選項的情形（cashflow.js subOptionsFor 的 allowBlank=false）
  const noBlank = subcategoryOptionsHtml(['內轉出', '內轉入'], '交割');
  assert.deepEqual(selectedValues(noBlank), ['交割'], '沒有空選項時，孤兒現值一樣要保留');

  // 鐵則 3：惡意子類名要跳脫
  const evil = subcategoryOptionsHtml(['', 'a'], '<img src=x onerror="1">');
  assert.equal(evil.includes('<img'), false, '子類名沒過 esc（innerHTML 插入 <img onerror> 會立刻執行）');
  assert.match(evil, /&lt;img/, '角括號要被轉成實體');
});

test('架構｜onMount 事後重建的分類／子類下拉都改走本模組（分類這條路原本完全沒被守到）', () => {
  // ⚠️ 讀原始碼題（這三個檔都 import app.js，node 裡 import 不進來）。誠實劃界：它擋得住
  // 「把舊的寫法貼回去」與「拔掉 import」；擋不住刻意混淆，也不宣稱瀏覽器實際跑的就是這條路。
  const read = (/** @type {string} */ rel) => {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    assert.ok(src.includes('openForm({'), `${rel} 去註解後找不到 openForm 呼叫——剝離器把程式碼吃掉了，本題失去意義`);
    return src;
  };

  const cash = read('public/modules/cashflow.js');
  assert.match(cash, /import\s*\{[^}]*\bselectOptionsHtml\b[^}]*\}\s*from\s*['"]\.\/form-options\.js['"]/,
    'cashflow.js 的父分類下拉必須從 form-options.js 取產生器');
  assert.match(cash, /catSel\.innerHTML\s*=\s*selectOptionsHtml\(\s*parents\s*,\s*curCat\s*\)/,
    '父分類下拉要用「這筆交易現在的分類」去產選項：貼回 `parents.map(...)` 那份舊寫法，'
    + '分類被刪過的交易一打開就被靜靜換成第一個父分類');
  assert.match(cash, /effectiveSelectValue\(\s*parents\s*,\s*curCat\s*\)/,
    '連動子類要用 effectiveSelectValue（舊寫法 `parents.includes(curCat) ? curCat : parents[0]` 會把孤兒分類算成第一項）');
  assert.doesNotMatch(cash, /parents\.includes\(\s*curCat\s*\)/,
    'cashflow.js 又出現「現值不在清單裡就換第一項」那個判準了（舊病的形狀）');

  const tx = read('public/modules/transactions.js');
  assert.match(tx, /import\s*\{[^}]*\bsubcategoryOptionsHtml\b[^}]*\}\s*from\s*['"]\.\/form-options\.js['"]/,
    'transactions.js 的子類下拉必須從 form-options.js 取產生器');
  assert.match(tx, /const subOptions = \([^)]*\)\s*=>\s*\n?\s*(?:\/\/[^\n]*\n\s*)?subcategoryOptionsHtml\(/,
    'transactions.js 的 subOptions 必須整支交給 subcategoryOptionsHtml——自己 map 那份漏了保留現值，'
    + '子類被刪掉後編輯任一筆就被靜靜清成空白');

  const st = read('public/modules/settings.js');
  assert.match(st, /import\s*\{[^}]*\bsubcategoryOptionsHtml\b[^}]*\}\s*from\s*['"]\.\/form-options\.js['"]/,
    'settings.js 店家編輯的子類下拉必須從 form-options.js 取產生器');
  assert.match(st, /subSel\.innerHTML\s*=\s*subcategoryOptionsHtml\(\s*subs\s*,\s*curSub\s*\)/,
    'settings.js 的 fill 必須交給 subcategoryOptionsHtml（它本來就有保留現值，收成一份是為了不再有第二份會漏）');

  // 「保留現值」不可以再有第二份抄本：帶 selected 的子類選項只能由純模組拼。
  // 帳務體檢那兩處下拉不帶 selected（替**未分類**項目挑新分類、沒有現值可保留），所以不在本網內——
  // 這是刻意劃界，寫在 form-options.js 檔頭。
  for (const rel of ['public/modules/cashflow.js', 'public/modules/transactions.js', 'public/modules/settings.js']) {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    const offenders = src.split('\n')
      .map((line, i) => ({ no: i + 1, line }))
      .filter(({ line }) => line.includes('（不分子類）') && line.includes('selected'));
    assert.deepEqual(offenders.map(o => o.no), [],
      `${rel} 這幾行又自己拼一份「保留現值」的子類選項了（應該交給 form-options.js）：\n`
      + offenders.map(o => `${o.no}: ${o.line.trim()}`).join('\n'));
  }
});

// 「同一份實作」要比同一物件：只比對 import／export 字串，app.js 若 import 成別名再自長一份不跳脫的 esc 並 export，字串看不出來，
// 而全站從 app.js 拿 esc 的模組會一起失去跳脫。用 DOM 假件把 app.js 載進 node。
test('app.js 匯出的 esc 就是 html-escape.js 的那一個函式（行為：同一物件、會跳脫；不看原始碼字串）', async () => {
  // DOM 假件：只為讓 app.js 模組頂層載得進來（hydrateIcons(document) 等）；不驗任何頁面行為
  const mk = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') ? () => '' : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : k === 'length' ? 0 : mk(),
    apply: () => mk(), construct: () => mk(), set: () => true, has: () => true, deleteProperty: () => true,
  });
  const g = /** @type {any} */ (globalThis);
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0, clear() {} };
  // 用完要還原：記下原本就存在的全域（描述子）與本題新裝的鍵，finally 逐一復原／刪除——假 DOM 不可留給同行程的別題
  /** @type {Record<string, PropertyDescriptor|undefined>} */ const prev = {};
  /** @type {string[]} */ const added = [];
  const install = (/** @type {string} */ k, /** @type {any} */ v) => { if (k in g) prev[k] = Object.getOwnPropertyDescriptor(g, k); else added.push(k); g[k] = v; };
  install('localStorage', storage); install('sessionStorage', storage); install('window', globalThis);
  for (const k of ['document', 'location', 'history', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'alert', 'confirm', 'scrollTo', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'Chart', 'innerWidth', 'innerHeight', 'screen']) if (!(k in g)) install(k, mk());
  const realFetch = g.fetch;
  g.fetch = async () => ({ ok: false, status: 599, statusText: 'stub', json: async () => ({}), text: async () => '', body: null });
  try {
    const app = await import('../public/app.js');
    assert.equal(app.esc, esc, 'app.js 匯出的 esc 必須就是 html-escape.js 那一個函式物件——app.js 自己再長一份＝跳脫與純模組走散');
    assert.equal(app.esc('"><img src=x>'), '&quot;&gt;&lt;img src=x&gt;', '而且它真的會跳脫');
  } finally {
    g.fetch = realFetch;
    for (const k of added) delete g[k];
    for (const [k, d] of Object.entries(prev)) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
  assert.ok(!('document' in globalThis) && !('window' in globalThis), '假 DOM 用完要拿掉（同行程的別題不可吃到）');
});
