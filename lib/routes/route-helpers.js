// @ts-check
// 路由錯誤處理共用 helper（系統優化 U2）：statement 的 wrap／securities 的 fail／ib 的內聯
// 三份**語意相同**的複製收斂到這裡。慣例（Codex#10-6／#11-2）：
//   服務層 throw 帶 status＝「已知的使用者層錯誤」（密碼錯/找不到卡片/對帳單不合法…）→ 原味訊息回應，使用者要看得懂；
//   沒帶 status＝非預期內部錯誤 → 交全域錯誤中介（console.error＋500，口徑統一；不能拿 message 當判準）。
// **刻意不併**（Codex 修訂）：core.js 洞察的「失敗回平靜資料」與 market.js 的「報價失敗回退舊價」
// 是刻意的降級設計，不是同一語意；crud.js 的那份在個股研究 P2 預約窗內，待 P2 合併後再收。

/**
 * 帶 status 的錯誤 → JSON 回應；否則交 next（全域中介）。
 * @param {any} res @param {any} next @param {any} e
 * @param {Record<string, any>=} extra 額外掛進錯誤 body 的欄位（ib 同步沿用既有 {ok:false} 形狀——搬家不裝修）
 */
export function sendRouteError(res, next, e, extra) {
  const err = /** @type {any} */ (e);
  if (err && err.status) return res.status(err.status).json({ ...(extra || {}), error: String(err.message || err) });
  next(err);
}

/**
 * async route handler 包裝：try/await/catch → sendRouteError（sync throw 與 async reject 都接得住）。
 * @param {(req: any, res: any) => any} fn @param {Record<string, any>=} extra
 */
export const wrapRoute = (fn, extra) => async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
  try { await fn(req, res); }
  catch (e) { sendRouteError(res, next, e, extra); }
};
