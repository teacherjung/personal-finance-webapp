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
  { // 後端／維護腳本／測試：Node 環境
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { globals: globals.node }
  },
  { // 前端：瀏覽器環境＋Chart 全域（<script> 載入的本機 vendor）
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.browser, Chart: 'readonly' } }
  }
];
