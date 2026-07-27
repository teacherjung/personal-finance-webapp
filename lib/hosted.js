// @ts-check
// 雙模式開關（C2，裁決①）：LOCAL＝預設＝現狀零改動；HOSTED＝Render 上的 noteasy.com.tw。
// 契約（C0 五之二）：判準只認環境變數 NOTEASY_HOSTED=1——**不用「有沒有 SUPABASE_URL」推斷**
//（本機測 HOSTED 也會設那些變數，用推斷會讓模式跟著環境變數漂移、LOCAL 突然變 HOSTED）。
/** @returns {boolean} */
export function isHosted() { return process.env.NOTEASY_HOSTED === '1'; }

/**
 * HOSTED 模式的必要設定。**fail-fast**：開了 HOSTED 卻缺任何一項＝啟動即 throw——
 * 缺設定的服務「看起來有開但登入永遠壞」比開不起來更難查（C0 fail-closed 原則）。
 * @returns {{url: string, anonKey: string, siteOrigin: string}}
 */
export function hostedConfig() {
  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  // 允許的瀏覽器來源（CSRF Origin 驗證用；逗號分隔可多個，如正式網域＋本機測試）
  const siteOrigin = process.env.SITE_ORIGIN || '';
  const missing = [!url && 'SUPABASE_URL', !anonKey && 'SUPABASE_ANON_KEY', !siteOrigin && 'SITE_ORIGIN'].filter(Boolean);
  if (missing.length) throw new Error(`[hosted] NOTEASY_HOSTED=1 但缺環境變數：${missing.join('、')}——HOSTED 模式缺設定必須開不起來（fail-fast），不可默默用壞掉的半套`);
  return { url, anonKey, siteOrigin };
}

/** CSRF Origin 白名單判定：Origin **有帶且不在白名單**＝拒絕；沒帶（curl/同源 GET）＝放行
 *（SameSite=Lax cookie 已擋跨站帶 cookie，這道是雙保險）。 @param {string|undefined} origin @returns {boolean} */
export function originAllowed(origin) {
  if (!origin) return true;
  const allow = (process.env.SITE_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  return allow.includes(origin);
}
