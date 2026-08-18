// @ts-check
/**
 * 上傳進度的**白話文案**（2026-08-18）：後端只推階段代碼（`lib/progress-stages.js`，零插值＝機密
 * 機械化），句子住這裡＝純函式、可直接行為測（同 cashflow-model 的既有慣例）。
 *
 * ⚠️ 文案誠實鐵則（延續 #455 那課）：只講**已經發生**的事，用進行式描述當下那一步；
 *    **不得**出現預估剩餘時間、不得宣稱「快好了」、不得暗示還有幾步（步數由資料決定）。
 * ⚠️ 不得回聲任何帳單內容／密碼池大小／規則卡張數——那些後端本來就不推，這裡也不得自己編。
 */

/** 階段代碼 → 畫面句（未知代碼＝不畫，前端沿用上一句：新後端配舊前端時不吐亂碼）。 */
const TEXT = Object.freeze({
  read_db: '正在讀取你的帳戶設定…',
  open_pdf: '正在開啟 PDF（如果有密碼會自動試你存過的）…',
  template_try: '正在用內建範本認這份版面…',
  template_hit: '內建範本認得這個版面，正在整理…',
  template_miss: '內建範本認不得這個版面，換下一招…',
  recipe_try: '正在試之前學會的版面規則卡（零費用、內容不外送）…',
  recipe_hit: '規則卡讀成功，正在整理…',
  recipe_miss: '沒有合用的規則卡，要送 AI 讀…',
  ai_start: '正在送給 AI 讀…',
  ai_dual: '兩個 AI 各自獨立讀一遍（互相核對）…',
  ai_single: '請 AI 讀一次…',
  ai_escalate: '讀出來的結果不夠好，換更強的模型再讀一次…',
  ai_compare: '兩份都讀完了，正在比對會影響錢的欄位…',
  ai_arbitrate: '兩份讀得不一樣，正在請第三個 AI 獨立仲裁…',
  verify: '正在驗算（餘額鏈與合計）…',
  build_preview: '驗算通過，正在整理預覽…',
});

/** @param {any} frame 後端推來的 frame（{t:'stage', s, model?}）
 *  @returns {string} 要顯示的句子；未知代碼／壞形狀＝空字串（呼叫端沿用上一句） */
export function progressText(frame) {
  if (!frame || frame.t !== 'stage') return '';
  const base = /** @type {any} */ (TEXT)[String(frame.s)] || '';
  if (!base) return '';
  // 模型名只在後端有帶時附上（它本來就會出現在預覽徽章＝不是新洩漏面）
  return frame.model ? base.replace(/…$/, `（${frame.model}）…`) : base;
}

/** 這張表涵蓋的代碼（考題用：與後端 STAGES 互扣，少一個就紅）。 */
export function progressTextCodes() { return Object.keys(TEXT).sort(); }
