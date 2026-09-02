// @ts-check
// 卡側末四碼的**安全字串化**——前後端共用的單一實作（前例＝card-issuers.js：lib 可 import
// public/modules、反向不行）。為什麼要它（Codex #541 r3#1＋r4#1）：`cards.lastFour` 在 CRUD
// 白名單、FIELD_SCHEMA 沒有它的型別收斂 ⇒ `{toString:null}` 這族「連 String() 都炸」的值可經
// 櫃檯**原樣落庫**；對它裸跑 String()／模板插值會丟 TypeError——r3 抓到後端 hit 炸掉整份預覽，
// r4 抓到後端安全了、預覽窗選卡下拉吃 /api/cards 原始資料**換到前端炸**。單一實作＝兩端同一把尺。
//
// 語意（兩種用途共用）：
// - **比對**（statement-import 的 hit）：炸不出字串＝''＝比不上任何非空訊號；`['5678']` 攤平＝'5678'
//   照字串化答案命中（#520 裁定「壞型別的答案＝字串化的答案」）。
// - **顯示**（預覽窗標籤／回應欄位）：''＝不顯示；壞值照字串化顯示（'0'、'[object Object]'——
//   使用者看得到垃圾，才會想去修它）。
//
// ⚠️ 這支只管「字串化不炸」；「有沒有登記末四碼」的判準（缺欄／null／空字串＝沒登記）刻意
//    **不做任何轉換**、直接比原值——住在 statement-import 的守門處，不在這裡。

/** @param {any} v 卡片的 lastFour 原值 @returns {string} 字串化結果；null／undefined／''／炸不出＝'' */
export function cardLastFourText(v) {
  if (v == null || v === '') return '';
  try { return String(v); } catch { return ''; }
}
