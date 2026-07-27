// @ts-check
// 帳號路由（C2）：只在 HOSTED 模式掛載（server.js 判 isHosted）——LOCAL 完全沒有這組路由＝現狀不變。
// CSRF（C0 威脅模型）：變更類請求驗 Origin（白名單制；沒帶 Origin 的非瀏覽器請求放行，
// SameSite=Lax cookie 已擋跨站帶 cookie，這道是雙保險）。
import { Router } from 'express';
import { originAllowed } from '../hosted.js';
import { signIn, signOut, currentUser, verifyEmailToken, setPassword } from '../services/auth.js';

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
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(Number(/** @type {any} */ (e)?.status) || 500).json({ error: String(/** @type {any} */ (e)?.message || '伺服器發生錯誤') }); }
};

authRoutes.post('/api/auth/login', wrap(async (req, res) => signIn(req, res, String(req.body?.email || ''), String(req.body?.password || ''))));
authRoutes.post('/api/auth/logout', wrap(async (req, res) => signOut(req, res)));
authRoutes.get('/api/auth/me', wrap(async (req, res) => ({ user: await currentUser(req, res) })));
// 邀請信／密碼重設回呼：/auth/confirm 頁把網址上的 token_hash 送來、換成 session cookie
authRoutes.post('/api/auth/confirm', wrap(async (req, res) => verifyEmailToken(req, res, String(req.body?.token_hash || ''), String(req.body?.type || 'invite'))));
authRoutes.post('/api/auth/set-password', wrap(async (req, res) => setPassword(req, res, String(req.body?.password || ''))));
