// 格式糾察（ESLint）：抓「沒用到的變數、危險寫法、跑不到的程式碼」這類校對員（tsc）管不到的小毛病。
// 跑法：npm run lint。dev-only 工具、不影響 app 執行。
import js from '@eslint/js';
import globals from 'globals';

// ⚠️ **選擇器抽成常數，是因為 flat config 的同名規則「後面整組覆蓋前面」，不是合併**
//    （2026-08-03 實際踩到：我把進入點守衛寫成獨立一組放在 xlsx 那組前面，
//    lint 全綠、`--print-config` 一看才發現我的選擇器整個被蓋掉了——
//    **「看起來裝好了、其實沒在跑」**）。所以下面只能有**一處** `no-restricted-syntax`，
//    豁免用「重新宣告一份少了某幾條的清單」表達，而清單本身共用同一個常數、不重複寫。
//    考題 `test/entry-guard.test.js` 會實際跑 ESLint 驗這些選擇器真的會開火。

/** xlsx 收斂點護欄：動態引入與 require（`no-restricted-imports` 看不到這兩種）。 */
const XLSX_SELECTORS = [
      { selector: "ImportExpression[source.value=/^xlsx(\\/|$)/]",
        message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（HOSTED 走子行程隔離）。'
      + '別處直接引入會繞過隔離——見 AGENTS.md「解析器資源上限」那一列。' },
      { selector: "CallExpression[callee.name='require'][arguments.0.value=/^xlsx(\\/|$)/]",
        message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（HOSTED 走子行程隔離）。'
      + '別處直接引入會繞過隔離——見 AGENTS.md「解析器資源上限」那一列。' },
      // 非字面量的動態 import（`const s = 'xlsx'; await import(s)`）：靜態分析**判不出來**，
      // 是上面幾條唯一還繞得過的路。production 全樹的動態 import 都是字面量，所以連同關掉。
      { selector: "ImportExpression:not([source.type='Literal'])",
        message: '動態 import 的模組名必須是字面量——非字面量會讓 xlsx 收斂點護欄（以及所有同類靜態檢查）失效。'
      + '真的需要時請在 eslint.config.js 開例外並寫明理由。' },
      // `createRequire` 是上面幾條唯一繞得過的路（取個別名再呼叫，AST 上看不出是 require）。
      // 本專案是純 ESM（package.json type: module），production／測試**全樹零使用**，
      // 所以直接關掉：成本是零，而洞就補上了。真的需要時再開，並在此處寫明理由。
      // 動態引入 node:module／module＝把上面那道門從側邊繞開
      { selector: "ImportExpression[source.value=/^(node:)?module$/]",
        message: '本專案是純 ESM，production 不動態引入 node:module——那是繞過 xlsx 收斂點護欄的門。' },
      // CJS 側：`module.require('xlsx')` 與非字面量的 require
      //（⚠️ `const r = require; r('xlsx')` 語法上堵不住——那條靠「production 不准有 .cjs」關掉，
      //   見 test/xlsx-isolate.test.js 的純 ESM 題）
      { selector: "CallExpression[callee.property.name='require']",
        message: 'production 不使用 module.require——本專案是純 ESM，這是繞過 xlsx 收斂點護欄的門。' },
      { selector: "CallExpression[callee.name='require']:not([arguments.0.type='Literal'])",
        message: 'require 的模組名必須是字面量：非字面量會讓 xlsx 收斂點護欄失效。' },
      { selector: "CallExpression[callee.property.name='getBuiltinModule']",
        message: 'production 不使用 process.getBuiltinModule——它可以取到 createRequire、繞過護欄。' },
      { selector: "CallExpression[callee.name='createRequire']",
        message: '本專案是純 ESM，不需要 createRequire；它也是繞過 xlsx 收斂點護欄的唯一已知路徑。'
      + '確實需要時請在 eslint.config.js 開例外並寫明理由。' },
];

/** 進入點守衛：「這支是不是被直接執行」只准 `lib/is-main.js` 判斷。
 *  ⚠️ **具名匯出是給考題用的**：`test/entry-guard.test.js` 拿這份清單的 message 逐字比對，
 *     才知道「剛剛那個錯是進入點護欄報的」。之前它用關鍵字猜，猜漏了兩條。 */
export const ENTRY_GUARD_SELECTORS = [
      { // process.argv 上只准 `[2]`（第一個使用者參數）與 `.slice(`
        selector: 'MemberExpression[object.object.name="process"][object.property.name="argv"]'
          + ':not([property.value=2]):not([property.name="slice"])',
        message: '不要自己取 process.argv 的進入點欄位——「是不是被直接執行」一律用 lib/is-main.js 的 isMainModule()。'
      },
      { // `.slice(1)[0]` 也是取進入點；只准 slice(2)
        selector: 'CallExpression[callee.object.object.name="process"][callee.object.property.name="argv"]'
          + '[callee.property.name="slice"]:not([arguments.0.value=2])',
        message: 'process.argv.slice() 只准 slice(2)（使用者參數）。要判斷進入點請用 lib/is-main.js 的 isMainModule()。'
      },
      { // process["argv"] 這種算出來的存取
        selector: 'MemberExpression[object.name="process"][computed=true]',
        message: '不要用算出來的方式存取 process 的欄位——那會繞過本節的護欄。'
      },
      { // const { argv } = process
        selector: 'VariableDeclarator[init.name="process"] > ObjectPattern',
        message: '不要把 process 解構——argv 一旦被解構出去，護欄就看不到它了。'
      },
      { // 一層別名：`const here = import.meta.url`（Codex #388 r5 示範的繞法）
    selector: 'VariableDeclarator[init.type="MemberExpression"][init.object.type="MetaProperty"]',
    message: '不要把 import.meta 的欄位存進變數——那是繞過下面那條門的第一步。要判斷進入點請用 lib/is-main.js 的 isMainModule(import.meta.url)。'
  },
  { // 一層別名：`const p = process`
    selector: 'VariableDeclarator[init.name="process"]',
    message: '不要把 process 存進變數——argv 一旦透過別名取用，護欄就看不到它了。'
  },
  { // 一層別名：`const a = process.argv`
    selector: 'VariableDeclarator[init.object.name="process"][init.property.name="argv"]',
    message: '不要把 process.argv 存進變數——要判斷進入點請用 lib/is-main.js 的 isMainModule()。'
  },
  { // ★ 真正的門：任何拿 import.meta 去比對的式子＝手寫的進入點守衛
        selector: 'BinaryExpression:has(MetaProperty)',
        message: '把 import.meta 拿來比對＝自己寫了一份進入點守衛。一律改用 lib/is-main.js 的 isMainModule(import.meta.url)。'
      }
];

export default [
  { ignores: [
    // ⚠️ 這裡**不要**加「退役／封存資料夾」的豁免（2026-08-03 加過又拿掉）：
    //    沒用到的程式碼的規則是**直接刪**（AGENTS.md），不是搬到一個工具都不看的角落。
    //    豁免一加下去，糾察就照不到那裡，「藏起來」在機制上就變得比「刪掉」容易。
    'node_modules/**', 'public/vendor/**', 'data/**'] },   // vendor 與資料檔不糾察
  js.configs.recommended,
  {
    rules: {
      // 校對員（tsc）在所有檔案已開，重複的交給它；這裡調成貼合本專案慣例：
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],   // catch (e) 未用 e 是本專案慣例
      'no-empty': ['error', { allowEmptyCatch: true }],                            // try{...}catch{} 靜默容錯是刻意寫法
      'no-irregular-whitespace': ['error', { skipTemplates: true }],              // 模板字串裡的全形空白＝中文顯示排版，放行
      eqeqeq: ['error', 'smart'],   // 一律用 ===（== null 檢查 null/undefined 例外，本專案有意使用）
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  { // ⚠️ **xlsx 收斂點護欄**（Codex #374 r1 High：正規表示式解析不了 JS）
    //
    // 一份 468KB 的**合法** .xlsx 解壓後可以吃掉 856MB，所以讀 XLSX 一律要走
    // `lib/pdf-isolate.js` 的子行程（#373）。收斂點只有 `lib/statement.js` 一個——
    // 別的檔案自己 import xlsx，那條路就不經隔離，攻擊檔會直接打在主行程上。
    //
    // 這道護欄**刻意交給 ESLint 的 parser**，不是自己寫 regex 掃字串：註解在 JS 語法上
    // 等同空白，`import XLSX from /* 註解 */ 'xlsx'`、`import 'xlsx'`、`require /* 註解 */ ('xlsx')`
    // 全都是合法寫法，手寫 regex 一個一個補永遠補不完（實測七種寫法漏掉五種）。
    // parser 看的是語法樹，這些寫法對它是同一件事。
    //
    // ⚠️ **第二次教訓（Codex #374 r2）：改用 AST 選擇器之後，我又在打同一種地鼠**——
    //    只是從「列舉字串寫法」變成「列舉語法形狀」。`createRequire` 取別名、
    //    用 namespace 引入、先存進變數再呼叫，六種合法寫法照樣穿過去。
    //    正解是**堵住通往 require 機制的門，而不是列舉走過去的姿勢**：
    //    禁止 production 引入 `createRequire`（`importNames` 比對的是**被引入的名字**，
    //    取別名沒有用）、禁止動態引入 `node:module`、禁止 `.cjs`。
    //
    // ⚠️ **誠實劃界**：這是靜態護欄，防的是**正常寫法與不小心**。
    //    刻意的規避（`eval`、`process.getBuiltinModule`、算出來的成員存取…）擋不住，
    //    也不打算擋——真正的防線是「要繞過它得刻意寫出一眼看得出在繞的程式」。
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['lib/statement.js', 'test/**'],
    rules: {
      // 靜態引入（含 `import 'xlsx'` 純副作用形、`export … from 'xlsx'`）。
      // ⚠️ **`patterns` 是必要的**：`paths` 只比對完全相同的模組名，
      //    `import X from 'xlsx/xlsx.mjs'` 這種**子路徑**引入（SheetJS 自己也這樣發佈）會整個漏掉。
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'xlsx',
            message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（HOSTED 走子行程隔離）。'
          + '別處直接引入會繞過隔離——見 AGENTS.md「解析器資源上限」那一列。' },
          // ⚠️ **整個模組都禁，不是只禁 createRequire 這個名字**（Codex #374 r3 High）：
          //    只列 `importNames: ['createRequire']` 的話，`import mod from 'node:module'`
          //    （default）與 `import { Module } from 'node:module'` 都拿得到 `createRequire`，
          //    而且都是正常 ESM 寫法、不是刻意規避。**這是我第三次在同一件事上列舉而不是關門**：
          //    先是列舉字串寫法、再是列舉語法形狀、這次是列舉名字。
          //    本專案 production 對 node:module／module 是**零使用**，整個禁掉成本是零。
          { name: 'node:module',
            message: '本專案是純 ESM，production 不引入 node:module——它是繞過 xlsx 收斂點護欄的門'
          + '（createRequire 可由 default／具名／namespace 三種方式取得）。'
          + '確實需要時請在 eslint.config.js 開具名例外並寫明理由。' },
          { name: 'module',
            message: '本專案是純 ESM，production 不引入 module——它是繞過 xlsx 收斂點護欄的門。' },
        ],
        patterns: [{
          group: ['xlsx', 'xlsx/*'],
          message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（子路徑引入一樣不行）。',
        }],
      }],
      // 動態引入與 require——`no-restricted-imports` 不看這兩種，改用 AST 選擇器（一樣是 parser）
      'no-restricted-syntax': ['error',
        ...XLSX_SELECTORS,
        // ⚠️ 進入點守衛接在同一個陣列裡——**不可以另開一組**（會被覆蓋，見檔頭常數的說明）
        ...ENTRY_GUARD_SELECTORS,
      ],
    }
  },
  { // xlsx 收斂點的豁免檔：**進入點守衛照樣適用**
    //    （這一組存在的唯一理由是「同名規則整組覆蓋」——只能重新宣告一份少了 xlsx 那幾條的）
    files: ['lib/statement.js', 'test/**/*.js', 'test/**/*.mjs'],
    rules: { 'no-restricted-syntax': ['error', ...ENTRY_GUARD_SELECTORS] }
  },
  { // 進入點守衛的唯一實作：它當然要碰 process.argv 與 import.meta.url
    //    ⚠️ 只豁免進入點那幾條，**xlsx 護欄照舊適用**（整組關掉會順手開一個沒人要的洞）
    files: ['lib/is-main.js'],
    rules: { 'no-restricted-syntax': ['error', ...XLSX_SELECTORS] }
  },
  { // 後端／維護腳本／測試：Node 環境
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { globals: globals.node }
  },
  { // 前端：瀏覽器環境＋Chart 全域（<script> 載入的本機 vendor）
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.browser, Chart: 'readonly' } }
  }
];
