// @ts-check
// 圖表色主題（獨立模組、零依賴——各模組直接 import，避免經由 app.js 的循環 import TDZ）
// 柔和分類色盤（2026-07-10 使用者選定，已通過 dataviz validate_palette：亮度帶/彩度/CVD/對比）
// ⚠️ **色數以下面的 `CHART`／`PALETTE` 為準，這裡不寫死。** 為什麼要特別講：出生那顆 commit
//    （`17df0ff`，標題與內文都寫「六色盤」「CHART 六色」）當場加進來的就已經是 `CHART` 七鍵、
//    `PALETTE` 八色——**那個數字從第一天就對不上**，不是慢慢漂掉的；重抄一份在這裡只會再錯一次。
// 分類色只從這裡取；獲利/虧損等語意色仍走 CSS 的 --pos/--neg/--warn，兩者不混用。
export const CHART = { red: '#D96352', blue: '#5A8FD3', yellow: '#D2A038', green: '#6FA75F', orange: '#E8944A', brown: '#B07C3F', gray: '#A3937C' };
export const PALETTE = [CHART.red, CHART.blue, CHART.yellow, CHART.green, CHART.orange, CHART.brown, CHART.gray, '#8AA0A0'];
export const AXIS = '#8a887f', GRID = '#ece9e0';
// 品牌珊瑚色（趨勢線/單色漸層專用；分類請用 CHART，語意請用 --pos/--neg/--warn）
export const ACCENT = '#C96442', ACCENT_SOFT = 'rgba(201,100,66,.10)';
