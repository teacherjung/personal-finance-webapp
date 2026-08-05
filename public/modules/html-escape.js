// @ts-check
// HTML 跳脫的**單一真相**（零依賴純模組；鐵則 3 的實作本體）。
//
// 為什麼要從 `public/app.js` 搬出來（#415，2026-08-05）：
// `app.js` 模組頂層就會碰 document／localStorage，**node 裡 import 不進來**（實測；
// `test/xss-id-escaping.test.js` 原本因此只能把那一行原始碼抓出來現場 eval）。
// 於是任何「需要跟正式環境用同一份跳脫」的零 DOM 純模組（第一個是 `form-options.js`）都拿不到它，
// 只剩下自己抄一份這條路——而抄出來的第二份會漂，跳脫走散＝XSS 缺口。
//
// 搬家對呼叫端零影響：`app.js` 仍原樣 `export { esc }`，全站二十幾處
// `import { esc } from '../app.js'` 一行都不用改；AGENTS 鐵則 3 寫的「app.js 提供」也仍然成立。

/**
 * 插入 innerHTML 前必過（鐵則 3）。
 * 連單引號一起跳脫（`&#39;`）：目前全站屬性都用雙引號、尚未被利用，但補上後單/雙引號屬性都安全（多人化前的預防）。
 * @param {unknown} s @returns {string}
 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
