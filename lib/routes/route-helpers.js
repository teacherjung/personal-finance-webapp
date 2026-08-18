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
/**
 * NDJSON 串流回應（2026-08-18 上傳進度；全 repo 第一支串流端點）。
 * 形狀：一行一個 JSON——`{t:'stage',…}`＊N → 最後一行 `{t:'done',r:…}` 或 `{t:'error',error,code?}`。
 * ⚠️ **錯誤口徑不能沿用 wrapRoute**：第一行推出去 headers 就送出了，之後 `res.status().json()` 無效、
 *    全域錯誤中介也會因 `res.headersSent` 放棄（server.js 既有判斷）——所以錯誤一律轉成**最後一行的
 *    error frame**（帶原 message 與 code＝前端 `e.code` 機器判準通道照舊可用）。HTTP 狀態碼一律 200：
 *    真正的成敗看最後一行，前端 reader 自己還原成 Error（含 code）。
 * ⚠️ 進度 frame 只由服務層的 stage sink 產生（`lib/progress-stages.js` 封閉列舉、零插值）。
 * @param {any} res @param {(onStage:(f:any)=>void)=>Promise<any>} run
 */
export async function streamNdjson(res, run) {
  res.status(200);
  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Accel-Buffering', 'no');   // 代理層（HOSTED）不要緩衝——否則進度一次全到＝等於沒有
  const send = (/** @type {any} */ o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* 連線已斷：主流程照跑完 */ } };
  try {
    const r = await run((f) => send(f));
    send({ t: 'done', r });
  } catch (e) {
    const err = /** @type {any} */ (e);
    send({ t: 'error', error: String(err?.message || err), ...(err?.code ? { code: String(err.code) } : {}) });
  } finally {
    try { res.end(); } catch { /* 已斷線 */ }
  }
}

export function sendRouteError(res, next, e, extra) {
  const err = /** @type {any} */ (e);
  // code＝機器判準通道（P0.5）：前端據它決定行為（如 'pdf_password' → 跳密碼窗），不 regex 訊息字面
  //（訊息是給人看的、會改字；機械判準只認欄位——同「結論字串/基準版本」教訓）。有才帶欄位。
  if (err && err.status) return res.status(err.status).json({ ...(extra || {}), error: String(err.message || err), ...(err.code ? { code: String(err.code) } : {}) });
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

/**
 * async route handler 包裝：**任何錯誤一律交 next（全域錯誤中介）**——與 Express 4 對「同步 handler
 * 同步 throw」的原生行為 byte-for-byte 等價（帶 status 的錯由全域中介回「請求格式不正確」泛用訊息）。
 * C4a 的理由：Express 4 **不會**接 async handler 的 rejection（Express 5 才會）——repo 改 async 後
 * 原本的同步 handler 全變 async，不包這層的話 throw 直接變 unhandled rejection、請求掛死。
 * 與 wrapRoute 的差別：wrapRoute 會把帶 status 的錯轉成**原味訊息** JSON（statement/ib 路由的既有慣例）；
 * 這裡是給 core/crud/securities 那些**原本就走全域中介**的路由用的——包裝不可順手改變錯誤口徑。
 * @param {(req: any, res: any) => any} fn
 */
export const asyncRoute = (fn) => async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
  try { await fn(req, res); }
  catch (e) { next(e); }
};
