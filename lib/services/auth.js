// @ts-check
// Supabase Auth 接線（C2）。契約（C0 P1-4）：**用 @supabase/ssr 的標準流程、不自寫 token 邏輯**——
// session 的存放/續期/輪替全交給官方 createServerClient，我們只提供「cookie 怎麼讀寫」的轉接頭。
// Cookie 旗標（C0 威脅模型＋P2）：HttpOnly（JS 讀不到）＋SameSite=Lax＋Path=/＋不設 Domain；
// Secure 在 HOSTED 正式環境＝一律開（Render 全 HTTPS）、本機 http 測試用 NOTEASY_INSECURE_COOKIE=1 關（僅測試）。
import { createServerClient } from '@supabase/ssr';
import { hostedConfig } from '../hosted.js';

/** 測試注入口（比照 STORE_FILE 的隔離慣例）：考題塞假 client、不打真 Supabase。 @type {null | ((req:any,res:any)=>any)} */
let factoryOverride = null;
/** @param {null | ((req:any,res:any)=>any)} fn 測試專用；正式程式碼絕不可呼叫 */
export function setSupabaseFactoryForTest(fn) { factoryOverride = fn; }

/** 解析 request 的 Cookie header → [{name,value}]。零依賴（不為這個裝 cookie-parser）。 @param {any} req */
function parseCookies(req) {
  const raw = String(req.headers?.cookie || '');
  return raw.split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: decodeURIComponent(p.slice(i + 1)) };
  });
}

/** 序列化 Set-Cookie（旗標見檔頭）。 @param {string} name @param {string} value @param {Record<string, any>} [opts] */
function serializeCookie(name, value, opts = {}) {
  const secure = process.env.NOTEASY_INSECURE_COOKIE !== '1';
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join('; ');
}

/**
 * 每請求一個 server client（@supabase/ssr 官方形狀：getAll/setAll 轉接 Express req/res）。
 * @param {any} req @param {any} res
 */
export function supabaseFor(req, res) {
  if (factoryOverride) return factoryOverride(req, res);
  const { url, anonKey } = hostedConfig();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => parseCookies(req),
      setAll: (list) => { for (const { name, value, options } of list) res.append('Set-Cookie', serializeCookie(name, value, options || {})); },
    },
  });
}

/** 登入。回 { user } 或 throw {status,message}。 @param {any} req @param {any} res @param {string} email @param {string} password */
export async function signIn(req, res, email, password) {
  const { data, error } = await supabaseFor(req, res).auth.signInWithPassword({ email, password });
  if (error) throw Object.assign(new Error('信箱或密碼不正確'), { status: 401 });   // 不轉傳 Supabase 原文＝不洩漏「帳號存在與否」
  return { user: projectUser(data.user) };
}

/** 登出（撤銷 session＋清 cookie，交給官方 signOut）。 @param {any} req @param {any} res */
export async function signOut(req, res) {
  await supabaseFor(req, res).auth.signOut();
  return { ok: true };
}

/** 目前使用者（**getUser＝到 Supabase 驗簽**，不是只讀 cookie 面值）。未登入回 null。 @param {any} req @param {any} res */
export async function currentUser(req, res) {
  const { data } = await supabaseFor(req, res).auth.getUser();
  return data?.user ? projectUser(data.user) : null;
}

/** 邀請信回呼：驗 token_hash（type=invite/recovery 同一條路）→ 建立 session cookie。 @param {any} req @param {any} res @param {string} tokenHash @param {string} type */
export async function verifyEmailToken(req, res, tokenHash, type) {
  const t = type === 'recovery' ? 'recovery' : 'invite';
  const { data, error } = await supabaseFor(req, res).auth.verifyOtp({ token_hash: tokenHash, type: t });
  if (error) throw Object.assign(new Error('連結無效或已過期，請聯絡站長重寄邀請'), { status: 400 });
  return { user: projectUser(data.user) };
}

/** 設定密碼（受邀完成註冊；需已有 session）。 @param {any} req @param {any} res @param {string} password */
export async function setPassword(req, res, password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw Object.assign(new Error('密碼至少 10 個字'), { status: 400 });
  }
  const { error } = await supabaseFor(req, res).auth.updateUser({ password });
  if (error) throw Object.assign(new Error('密碼設定失敗，請重試或聯絡站長'), { status: 400 });
  return { ok: true };
}

/** 只吐前端需要的欄位（不整包 Supabase user＝不洩漏內部 metadata）。 @param {any} u */
function projectUser(u) { return { id: String(u?.id || ''), email: String(u?.email || '') }; }
