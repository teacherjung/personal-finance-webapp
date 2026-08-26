// @ts-check
// AI 成本護欄（解析器計畫 P3 的成本護欄切片；William 2026-08-26 拍板：單張 6 發、單日 20 發、
// 超限＝擋下＋白話說明）。單位＝「發」（一次模型呼叫）——NT$ 實際費用要看 Anthropic 帳單才準
// （ai-consent.js 的費用級距絆線），所以上限**刻意不用金額計**、用發數計。
// 擋點＝ai-transport 的 transport closure**進入處**（每一發先過 take()）：那是全 repo 唯一打 AI
// 供應商的地方——雙讀／仲裁／單讀升級／配方生成四條路都收斂在那裡，未來新路徑也繞不開。
// 兩個範圍：
//   - **單張（perBill）**：一份帳單從 preview 到 apply 的所有發數。preview 期間在記憶體計，
//     發確認票時把數字寫進票（aiCalls），apply 兌票後 loadBill() 續數——票匣本來就是
//     「一份帳單」的伺服器端身分（TTL／一次性／綁租戶都現成）。
//   - **單日（perDay）**：落 db 的 {date, n}（settings.aiUsage，server-owned），跨程序重啟仍在；
//     日期用**本地日曆日**（呼叫端帶 nowLocal().date——UTC 會讓台北 00:00–07:59 早一天）。
//     這是防暴走保險絲（程式出錯狂重試），不是日常預算——正常一天匯一兩份帳單用不到 10 發。
const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/** 預設上限（William 2026-08-26 拍板）。現行結構每次上傳至多 4 發（server.js OUTBOUND 註解）＝
 * 單張 6 留了裕度；撞到上限通常代表版面有問題或程式出錯，不是「差一發就成」。 */
export const AI_BUDGET_DEFAULTS = Object.freeze({ perBill: 6, perDay: 20 });

/** 非法／缺值＝回退預設；合法＝取整、至少 1（0 或負數＝把 AI 整條路關死，那是拔鑰匙的事、不是上限的事）。
 * @param {any} v @param {number} fallback */
function capOf(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 讀使用者設定的兩個上限（設定頁可調；讀不到＝預設）。 @param {any} settings */
export function budgetCaps(settings) {
  return {
    perBill: capOf(settings?.aiCapPerBill, AI_BUDGET_DEFAULTS.perBill),
    perDay: capOf(settings?.aiCapPerDay, AI_BUDGET_DEFAULTS.perDay),
  };
}

/** 每日用量滾動：同一天＝沿用計數、換日＝歸零。形狀永遠回 {date, n}（壞資料當 0 重來）。
 * @param {any} usage @param {string} today */
export function rollDaily(usage, today) {
  const n = Number(usage?.n);
  return { date: today, n: (usage?.date === today && Number.isFinite(n) && n > 0) ? Math.floor(n) : 0 };
}

/** @param {'bill'|'day'} kind @param {number} cap */
function budgetError(kind, cap) {
  if (kind === 'bill') {
    return apiError(400, `這份帳單已經讓 AI 讀了 ${cap} 發（你設的單張上限）。讀到這個數通常是版面有問題，不是再試一次就會成——這份請先改用手動記帳；確定要再試的話，到設定頁「AI 帳單解析」把單張上限調高。`, 'ai_budget_exceeded');
  }
  return apiError(400, `今天已經讓 AI 讀滿 ${cap} 發（你設的單日上限）。這道保險絲是防程式出錯狂重試、把費用燒掉的；明天會自動恢復，急用的話到設定頁「AI 帳單解析」把單日上限調高。`, 'ai_budget_exceeded');
}

/**
 * 建一份預算（**每個 HTTP 請求一份**，路由層組、閉包進 engine 工廠）。
 * - take()：要一發名額。超限＝throw（400、code `ai_budget_exceeded`、訊息已白話含下一步）。
 *   ⚠️ **內部嚴格序列化**：雙讀是 Promise.all 兩發並發——不序列化的話，邊界上（例如已用 5、上限 6）
 *   兩發會同時看到「還有 1 個名額」一起擠過去＝上限被超過。序列化＝一次只裁一發，裁完才輪下一發。
 * - updateUsage 的 updater 必須**純**（不碰 bill 計數）：櫃檯 CAS 衝突時 updater 會對 fresh 重跑，
 *   副作用放裡面＝重跑一次多算一發（updateRecipeBirthStats 同款規矩）。
 * - loadBill(n)：apply 兌票後把票上的已用發數載入（preview 與 apply 是兩個請求、兩份預算物件，
 *   靠票把單張計數接起來）。
 * - HOSTED 不設防：AI 路線在 HOSTED 有停止線（ai_hosted_off，排在一切之前）＝這裡不可達；
 *   萬一未來停止線搬走，updateUsage 走租戶 db、計數自然分租戶——但**單日上限語意是單人版設計**，
 *   多人前置（P3 其餘）要重裁，不是沿用。
 * @param {{ updateUsage: (updater: (settings: any) => any) => Promise<any>, today: string, billUsed?: number }} deps
 */
export function makeAiBudget({ updateUsage, today, billUsed = 0 }) {
  const bill = { used: capOf(billUsed, 0) };
  /** @type {Promise<void>} */ let chain = Promise.resolve();
  async function doTake() {
    /** @type {'ok'|'bill'|'day'} */ let verdict = 'ok';
    /** @type {{perBill:number, perDay:number}} */ let caps = { ...AI_BUDGET_DEFAULTS };
    await updateUsage((settings) => {
      caps = budgetCaps(settings);
      const u = rollDaily(settings?.aiUsage, today);
      if (bill.used + 1 > caps.perBill) { verdict = 'bill'; return u; }   // 單張先擋＝不白佔每日名額
      if (u.n + 1 > caps.perDay) { verdict = 'day'; return u; }
      verdict = 'ok';
      return { date: u.date, n: u.n + 1 };
    });
    if (verdict !== 'ok') throw budgetError(verdict, verdict === 'bill' ? caps.perBill : caps.perDay);
    bill.used += 1;   // 每日名額真的拿到了才佔單張名額（updater 純、副作用只在這裡）
  }
  return {
    /** 目前這份帳單已用的發數（發票時寫進票）。 */
    used: () => bill.used,
    /** apply 兌票後載入票上的已用發數。 @param {any} n */
    loadBill(n) { bill.used = capOf(n, 0); },
    /** 要一發名額；超限＝throw ai_budget_exceeded。 */
    take() {
      const p = chain.then(doTake);
      chain = p.catch(() => {});   // 失敗不斷鏈：上一發被擋，下一發仍要自己被裁一次
      return p;
    },
  };
}
