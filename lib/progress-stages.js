// @ts-check
/**
 * 上傳進度的**階段代碼表**（2026-08-18；William：「畫面停頓太久像當掉，能不能即時寫出背景在跑什麼」）。
 *
 * ⚠️ **設計的第一鐵則＝零插值**（機密機械化，比「請小心不要洩漏」可考）：後端**只推這張表裡的代碼**，
 * 絕不推自由文字、也不帶帳單欄值／密碼池大小／規則卡張數／檔案 metadata——白話句子住前端
 * （`public/modules/progress-text.js`，可直接行為測）。唯一容許的附帶值＝**已在預覽徽章揭露過的模型
 * 顯示名**（`model`，`modelDisplayName` 的輸出），因為它本來就會出現在畫面上。
 *
 * ⚠️ **第二鐵則＝只在事情真的發生後才推**（#455 假進度那一課的正解方向）：每個代碼都掛在「該動作
 * 已經開始／已經完成」的那一行，前端收到才寫字。**禁止**時間驅動的假動畫、禁止 ETA（預估＝猜測）。
 *
 * ⚠️ **第三鐵則＝階段序列由資料決定**（有沒有規則卡、雙讀開不開、要不要仲裁都不一樣），
 * 前端不得寫死一份清單去跑。
 */

/** 封閉列舉：後端能推的每一個階段代碼。新增代碼要同時補前端文案與考題（互扣）。 */
export const STAGES = Object.freeze({
  READ_DB: 'read_db',                     // 讀你目前的帳戶／設定
  OPEN_PDF: 'open_pdf',                   // 開啟 PDF（含逐一試已存密碼——**不報第幾組／共幾組**）
  TEMPLATE_HIT: 'template_hit',           // 內建範本認得＝整理中
  TEMPLATE_MISS: 'template_miss',         // 內建範本認不得（分岔點）
  RECIPE_TRY: 'recipe_try',               // 試存過的版面規則卡（零費用、內容不外送）
  RECIPE_HIT: 'recipe_hit',               // 規則卡讀成功
  RECIPE_MISS: 'recipe_miss',             // 規則卡沒有／都不合用
  AI_START: 'ai_start',                   // 準備送 AI（**只在停止線/鑰匙檢查都過、真的要送之後**）
  AI_DUAL: 'ai_dual',                     // 兩個 AI 各自獨立讀一遍（雙讀開啟）
  AI_SINGLE: 'ai_single',                 // 先請一個 AI 讀（雙讀關閉＝單讀階梯）
  AI_ESCALATE: 'ai_escalate',             // 讀不好，換更強的模型再讀一次（單讀階梯的第二發）
  AI_COMPARE: 'ai_compare',               // 兩份讀完，正在比對會影響錢的欄位
  AI_ARBITRATE: 'ai_arbitrate',           // 兩份**都有效但不一致**，請第三個 AI 獨立仲裁
  AI_ATTEST: 'ai_attest',                 // 只有一讀有效（另一讀沒讀出合法答案）＝請第三個 AI 補一份獨立答案來互證
  VERIFY: 'verify',                       // 驗算（餘額鏈／合計／逐帳戶覆蓋）
  BUILD_PREVIEW: 'build_preview',         // 整理預覽（比對既有帳戶、算重複）
});

const VALID = new Set(/** @type {string[]} */ (Object.values(STAGES)));

/** 進度 frame 的建構器（伺服器端唯一出口）：非表列代碼一律丟掉（fail-closed，防未來有人推自由文字）。
 * @param {string} stage @param {{model?: string}} [extra]
 * @returns {{t:'stage', s:string, model?:string}|null} */
export function stageFrame(stage, extra = {}) {
  if (!VALID.has(stage)) return null;
  // ⚠️ model 是唯一容許的附帶值，但**必須長得像 modelDisplayName 的輸出**（Grok r0：只檢查「非空
  // 字串」＝把帳單全文塞進 model 就能當「模型名」出門＝預留側溝）。形狀白名單＋長度上限，兩者都不
  // 合就整個丟掉（fail-closed）。
  const raw = typeof extra.model === 'string' ? extra.model.trim() : '';
  const model = raw.length <= 40 && /^Claude [A-Za-z]+ [0-9](\.[0-9])?$/.test(raw) ? raw : '';
  return { t: /** @type {const} */ ('stage'), s: stage, ...(model ? { model } : {}) };
}

/** 服務層用的 sink 包裝：呼叫端沒給 onStage 就是「不推進度」（現行行為零位移）。
 * 推進度**絕不可讓主流程失敗**——sink 自己爆掉（連線已斷等）只吞掉。
 * @param {((f: any) => void)|undefined} onStage */
export function makeStageSink(onStage) {
  if (typeof onStage !== 'function') return () => {};
  return (/** @type {string} */ stage, /** @type {{model?:string}} */ extra = {}) => {
    const f = stageFrame(stage, extra);
    if (!f) return;
    try { onStage(f); } catch { /* 進度是附屬品：推不出去也不能影響解析與匯入 */ }
  };
}
