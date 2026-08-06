// @ts-check
// 帳號路由（C2）：只在 HOSTED 模式掛載（server.js 判 isHosted）——LOCAL 完全沒有這組路由＝現狀不變。
// CSRF（C0 威脅模型）：變更類請求驗 Origin（白名單制、判準**完全相等**；沒帶 Origin 的非瀏覽器請求放行）。
// ⚠️ **不可讀成「SameSite=Lax 已擋跨站，這道只是雙保險」**（2026-08-05 複審抓到的失真）：
//    Lax 只擋**真跨站**，而 `evil.noteasy.com.tw` 這種**同站子網域**對瀏覽器算 same-site、
//    照樣會帶上受害者 cookie——那時 Origin 白名單是**唯一那道防線**。
//    完整理由與考題見 `lib/hosted.js` 的 `originAllowed`。
import { Router } from 'express';
import { originAllowed } from '../hosted.js';
import { signIn, signOut, currentUser, currentSession, verifyEmailToken, setPassword } from '../services/auth.js';
import { runWithTenant } from '../tenant.js';

// C3 auth gate（C0 P1-1 契約）：HOSTED 下 gate「全部 /api/*」＋「/finance」，白名單只放行
// /api/auth/*（登入本身）與 /health（機器檢查、不在 /api 下天然不經此牆）。
// 身分判定＝services/auth.js currentSession（getUser 到 Supabase 驗簽，不是讀 cookie 面值）。
//
// **C4b 起，這道牆同時是「身分交棒點」**（C0 契約 P1-2）：驗完身分之後，接下來的整條請求鏈
// 都跑在 `runWithTenant({userId, supabase}, next)` 裡——資料層（lib/store-pg.js）從這個
// AsyncLocalStorage context 拿身分與 client，**絕不從請求參數拿 user_id**（那是 IDOR 的正門）。
// 三件事要一起理解：
//   ①**必須包住 `next`**：Express 是同步呼叫下一個中介層，包住 next 才能讓整條鏈（含之後所有 await）
//     都在 context 裡。用 `als.enterWith()` 會污染同一 tick 之後的所有東西，正是要防的事。
//   ②**沒過牆的請求沒有 context**：資料層的 `requireTenant()` 因此會 throw＝fail-closed，
//     結構上不存在「未登入卻讀到某個共用帳本」的路徑。
//   ③C3 當時**只宣稱 401、不宣稱 A/B 隔離**（那時仍是單一全域庫，誠實劃界）；
//     **C4b 起隔離才成立**（Postgres 按 user_id 分家＋RLS），由 test/hosted-store-pg.test.js
//     逐集合列舉驗收——不是抽樣。
/** @type {import('express').RequestHandler} */
export async function authGate(req, res, next) {
  // ⚠️ 一律小寫比對（Codex #302 阻擋，實測重現）：Express 路由**大小寫不敏感**（/API/summary 命中
  // /api/summary 的 route），gate 若用大小寫敏感的 startsWith，/API/、/Finance/ 變體就直接繞過牆。
  const path = String(req.path || '').toLowerCase();
  const isApi = path.startsWith('/api/');
  const isFinance = path === '/finance' || path.startsWith('/finance/');
  if (!isApi && !isFinance) return next();                      // 公開站不經牆
  if (path.startsWith('/api/auth/')) return next();             // 白名單：登入功能本身
  let session;
  try { session = await currentSession(req, res); }
  catch { session = null; }                                     // 驗證服務出錯＝當未登入（fail-closed，絕不放行）
  if (session?.user?.id) {
    return runWithTenant({ userId: session.user.id, supabase: session.supabase }, next);
  }
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
