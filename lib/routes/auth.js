// @ts-check
// 帳號路由（C2）：只在 HOSTED 模式掛載（server.js 判 isHosted）——LOCAL 完全沒有這組路由＝現狀不變。
// CSRF（C0 威脅模型）：變更類請求驗 Origin（白名單制；沒帶 Origin 的非瀏覽器請求放行，
// SameSite=Lax cookie 已擋跨站帶 cookie，這道是雙保險）。
import { Router } from 'express';
import { originAllowed } from '../hosted.js';
import { signIn, signOut, currentUser, verifyEmailToken, setPassword } from '../services/auth.js';

// C3 auth gate（C0 P1-1 契約）：HOSTED 下 gate「全部 /api/*」＋「/finance」，白名單只放行
// /api/auth/*（登入本身）與 /health（機器檢查、不在 /api 下天然不經此牆）。
// **只宣稱「未登入 401／轉登入」，不宣稱 A/B 隔離**——此時資料仍是單一全域庫，隔離歸 C4 驗收（C0 誠實劃界）。
// 身分判定＝services/auth.js currentUser（getUser 到 Supabase 驗簽，不是讀 cookie 面值）。
/** @type {import('express').RequestHandler} */
export async function authGate(req, res, next) {
  // ⚠️ 一律小寫比對（Codex #302 阻擋，實測重現）：Express 路由**大小寫不敏感**（/API/summary 命中
  // /api/summary 的 route），gate 若用大小寫敏感的 startsWith，/API/、/Finance/ 變體就直接繞過牆。
  const path = String(req.path || '').toLowerCase();
  const isApi = path.startsWith('/api/');
  const isFinance = path === '/finance' || path.startsWith('/finance/');
  if (!isApi && !isFinance) return next();                      // 公開站不經牆
  if (path.startsWith('/api/auth/')) return next();             // 白名單：登入功能本身
  let user;
  try { user = await currentUser(req, res); }
  catch { user = null; }                                        // 驗證服務出錯＝當未登入（fail-closed，絕不放行）
  if (user) return next();
  if (isApi) { res.status(401).json({ error: '請先登入' }); return; }
  res.redirect('/login');                                       // /finance 頁面＝轉登入
}

export const authRoutes = Router();

/** 變更類請求的 CSRF Origin 牆（HOSTED 全站中介層；GET/HEAD 天然略過）。 @type {import('express').RequestHandler} */
export function csrfOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!originAllowed(/** @type {string|undefined} */ (req.headers.origin))) {
    res.status(403).json({ error: '請求來源不被允許' });
    return;
  }
  next();
}

/** async 端點的統一錯誤口徑（status 缺省 500；訊息皆為我們自己寫的白話中文）。 @param {(req:any,res:any)=>Promise<any>} fn */
const wrap = (fn) => async (/** @type {any} */ req, /** @type {any} */ res) => {
  // 雙保險（Codex #301 r2）：auth 回應一律 no-store——即使 @supabase/ssr 沒傳 headers（如 getUser 讀路徑），
  // 登入狀態/使用者資訊也絕不該被 CDN/代理快取。
  res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(Number(/** @type {any} */ (e)?.status) || 500).json({ error: String(/** @type {any} */ (e)?.message || '伺服器發生錯誤') }); }
};

authRoutes.post('/api/auth/login', wrap(async (req, res) => signIn(req, res, String(req.body?.email || ''), String(req.body?.password || ''))));
authRoutes.post('/api/auth/logout', wrap(async (req, res) => signOut(req, res)));
authRoutes.get('/api/auth/me', wrap(async (req, res) => ({ user: await currentUser(req, res) })));
// 邀請信／密碼重設回呼：/auth/confirm 頁把網址上的 token_hash 送來、換成 session cookie
authRoutes.post('/api/auth/confirm', wrap(async (req, res) => verifyEmailToken(req, res, String(req.body?.token_hash || ''), String(req.body?.type || 'invite'))));
authRoutes.post('/api/auth/set-password', wrap(async (req, res) => setPassword(req, res, String(req.body?.password || ''))));
