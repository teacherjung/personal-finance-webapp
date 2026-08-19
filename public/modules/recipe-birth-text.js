// @ts-check
/**
 * 規則卡出生結果的**白話文案**（2026-08-19）：後端只記封閉代碼（`lib/recipe-birth.js`），句子住這裡＝
 * 純函式、可直接行為測（同 progress-text 的既有慣例）。
 *
 * ⚠️ 文案原則：**講「發生了什麼」與「對你的影響」，不編原因、不承諾下次會成功**。
 *   規則卡誕生後，下次同版面**會先用它讀，讀得過才不花 AI**（對不上版面、拒解或驗算沒過都會退回 AI）。
 *   而它能不能誕生，取決於另一發 AI 寫出的規則能否把使用者剛確認的那份答案**逐欄重現**——不是我們
 *   控制得了的事，所以文案不得寫「下次應該就會成功」，也不得寫「免費自動讀」。
 */

/** 代碼 → 給使用者看的一句話（未知代碼＝空字串，畫面不吐亂碼）。 */
const TEXT = Object.freeze({
  ok: '已經學會這個版面（下次同版面會先用這張規則卡讀，讀得過就不花 AI 費用；讀不過會自動退回 AI）',
  recipe_engine_missing: '沒有去學（沒設定 AI 鑰匙，或這次沒走 AI 讀取）',
  recipe_gen_failed: '學習過程本身失敗了（模型出錯或這張票沒有原文）',
  recipe_birth_strict: '學出來的規則不合格（欄位太長、混進數字之類）',
  recipe_birth_match: '學出來的規則對不上這份帳單的版面（找不到它說的定位詞）',
  recipe_birth_parse: '用學到的規則回頭讀這份帳單時讀不動',
  recipe_birth_statement: '學到的定位詞其實是帳單內容（會把交易文字當成版面標題）',
  recipe_birth_reproduce: '學到的規則讀出來的結果，跟你剛才確認過的那份對不起來',
});

/** @param {string} code @returns {string} */
export function birthText(code) {
  // ⚠️ 家規 3.5：用**自有屬性**查表——裸的 `TEXT[code]` 對 `toString`／`constructor`／`__proto__`
  //    會撈到原型上的內建東西，完成提示就會把 native function 的文字印給使用者（Codex #489 r3#2 實測）。
  const k = String(code);
  return Object.hasOwn(TEXT, k) ? /** @type {any} */ (TEXT)[k] : '';
}

/** 這張表涵蓋的代碼（考題用：與後端 BIRTH_CODES 互扣）。 */
export function birthTextCodes() { return Object.keys(TEXT).sort(); }

/** 設定頁的摘要區塊（純字串，呼叫端負責插入）。
 * @param {any} stats settings.recipeBirthStats @param {{total:number, ok:number, failed:number, top:{code:string,n:number}|null}} summary
 * @param {(s:string)=>string} esc @returns {string} */
export function birthStatsHtml(stats, summary, esc) {
  if (!summary || !summary.total) {
    return '<p class="muted" style="margin:0;font-size:12px">還沒有紀錄——<b>用 AI 讀過一次帳單並按下套用之後</b>，這裡會開始累積「有沒有學會這個版面、卡在哪一關」。</p>';
  }
  const rows = Object.entries(stats || {})
    .filter(([, v]) => v && Number(v.n) > 0)
    .sort((a, b) => Number(b[1].n) - Number(a[1].n))
    .map(([code, v]) => {
      const t = birthText(code) || code;
      const when = v.lastAt ? `｜最後一次 ${esc(String(v.lastAt))}` : '';
      const who = v.lastBank ? `（${esc(String(v.lastBank))}）` : '';
      return `<li style="margin:2px 0">${esc(t)}${who}：<b>${Number(v.n)}</b> 次${when}</li>`;
    }).join('');
  const head = `<p style="margin:0 0 6px;font-size:13px">試著學了 <b>${summary.total}</b> 次，學會 <b>${summary.ok}</b> 次、沒學成 <b>${summary.failed}</b> 次。</p>`;
  return `${head}<ul class="muted" style="margin:0;padding-left:18px;font-size:12px;line-height:1.8">${rows}</ul>`;
}

/** 摘要（與 lib/recipe-birth.js 的 birthSummary 同語意；前端不 import lib/，各自一份、由考題互扣）。
 * @param {any} stats @returns {{total:number, ok:number, failed:number, top:{code:string,n:number}|null}} */
export function birthSummary(stats) {
  let total = 0, ok = 0;
  /** @type {{code:string, n:number}|null} */ let top = null;
  for (const [k, v] of Object.entries(stats || {})) {
    const n = Number(v && /** @type {any} */ (v).n);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;
    if (k === 'ok') { ok += n; continue; }
    if (!top || n > top.n) top = { code: k, n };
  }
  return { total, ok, failed: total - ok, top };
}
