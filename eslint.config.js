// 格式糾察（ESLint）：抓「沒用到的變數、危險寫法、跑不到的程式碼」這類校對員（tsc）管不到的小毛病。
// 跑法：npm run lint。dev-only 工具、不影響 app 執行。
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'public/vendor/**', 'data/**'] },   // vendor 與資料檔不糾察
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
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['lib/statement.js', 'test/**'],
    rules: {
      // 靜態引入（含 `import 'xlsx'` 純副作用形、`export … from 'xlsx'`）。
      // ⚠️ **`patterns` 是必要的**：`paths` 只比對完全相同的模組名，
      //    `import X from 'xlsx/xlsx.mjs'` 這種**子路徑**引入（SheetJS 自己也這樣發佈）會整個漏掉。
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'xlsx',
          message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（HOSTED 走子行程隔離）。'
        + '別處直接引入會繞過隔離——見 AGENTS.md「解析器資源上限」那一列。',
        }],
        patterns: [{
          group: ['xlsx', 'xlsx/*'],
          message: 'XLSX 只能由 lib/statement.js 的 readXlsxForIsolation 讀（子路徑引入一樣不行）。',
        }],
      }],
      // 動態引入與 require——`no-restricted-imports` 不看這兩種，改用 AST 選擇器（一樣是 parser）
      'no-restricted-syntax': ['error',
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
        { selector: "CallExpression[callee.name='createRequire']",
          message: '本專案是純 ESM，不需要 createRequire；它也是繞過 xlsx 收斂點護欄的唯一已知路徑。'
        + '確實需要時請在 eslint.config.js 開例外並寫明理由。' },
      ],
    }
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
