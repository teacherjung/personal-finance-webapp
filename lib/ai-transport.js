// @ts-check
// AI 傳輸層（P1b-1）：**全 repo 唯一會打 AI 供應商的檔案**（字面 fetch 只住這裡，入外連登記閘
// hosted-auth「反向對帳」的 ALLOWED＋server.js OUTBOUND_ENDPOINTS）。誰能 import 它＝誰有外連能力，
// 所以只有**全靜態路徑的路由檔**（lib/routes/statement.js）import 它組 engineFactory；服務層
// （bank-import.js，被 crud.js 等動態路徑路由檔 import）刻意拿不到。
// 刻意用原生 fetch、不裝 SDK：主目錄的重啟捷徑只 pull 不 npm install，多一個依賴＝合併後
// app 起不來的一類事故（#419 前例）；本傳輸只用一個端點、一種請求形狀，fetch 足矣。
// 錯誤分類成 code、**訊息絕不含帳單內文或鑰匙**；本檔零 console（機密不落 log，考題釘住）。
import { AI_BANK_MODELS, AI_ARBITER_MODEL, AI_BANK_SCHEMA, buildBankSystem, RECIPE_SCHEMA, buildRecipeSystem } from './ai-parse.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/**
 * Anthropic Messages API 傳輸（結構化輸出；請求形狀＝官方 output_config.format，2026-08-12 文件核對）。
 * @param {string} apiKey
 * @returns {(req: {model:string, system:string, user:string, schema:object}) => Promise<any>}
 */
export function anthropicTransport(apiKey) {
  return async ({ model, system, user, schema }) => {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        // 逾時上界（r1#4）：兌票後的生成把票的 lines 抓在 async frame 裡——沒有逾時＝pending fetch
        // 讓帳單原文躲過票匣的 TTL/容量治理（發滿→兌走→卡住可無限累積）。90 秒＝Opus 長帳單的寬裕
        // 上界；逾時＝AbortError→ai_unavailable，frame 結束＝原文參照釋放。
        // ⚠️ 仲裁那發（Fable，P2-4 預審 W1）另給 300 秒：Fable 的 thinking 永遠開、困難輸入單一請求
        // 可跑數分鐘——沿用 90 秒＝最需要仲裁的長帳單（兩讀不一致是版面性、會重現）反而最容易匯不進去。
        signal: AbortSignal.timeout(model === AI_ARBITER_MODEL ? 300_000 : 90_000),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        // ⚠️ 刻意**不帶 temperature**（r1#2）：Sonnet 5 家族對非預設 temperature/top_p/top_k 回 400
        //（官方 whats-new-sonnet-5 文件），階梯升級那一發會直接壞掉——決定論讓位相容性；
        // 輸出格式已由結構化輸出 schema 鎖住，不靠 sampling 參數。
        // max_tokens 與 thinking 同池（2026-08-15 官方 API 參考核對）：Sonnet 5／Opus 5 省略
        // thinking 參數＝預設開 adaptive thinking，思考 token 與答案卷**共搶 max_tokens**——
        // 8192 是為舊主力 Haiku（不思考）定的，沿用會讓長帳單 stop_reason:max_tokens＝ai_truncated
        // 且不升級照實丟。官方建議「與其關 thinking 不如開著調低 effort」（關掉在 Opus 5 有
        // 已記載的失效模式），故：上限 16000（非串流的建議天花板）＋ effort:medium（抄錄型任務
        // 夠用、控思考開銷；Sonnet 5 的 medium ≈ 上一代 high）。
        body: JSON.stringify({
          model, max_tokens: 16000, system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
        }),
      });
    } catch {
      throw apiError(502, '連不上 AI 服務或等太久沒回（網路不穩，或這份帳單太難算），稍後再試', 'ai_unavailable');
    }
    if (res.status === 401 || res.status === 403) throw apiError(400, 'AI 解析鑰匙無效或已停用，請到設定頁重新設定', 'ai_auth');
    if (res.status === 429) throw apiError(502, 'AI 服務目前繁忙（額度或流量限制），稍後再試', 'ai_unavailable');
    if (!res.ok) throw apiError(502, `AI 服務回應異常（HTTP ${res.status}），稍後再試`, 'ai_unavailable');
    /** @type {any} */
    let body;
    try { body = await res.json(); } catch { throw apiError(502, 'AI 服務回應不是有效格式', 'ai_unavailable'); }
    if (body?.stop_reason === 'refusal') throw apiError(400, 'AI 拒絕解析這份內容', 'ai_refusal');
    if (body?.stop_reason === 'max_tokens') throw apiError(400, '這份帳單太長，AI 答案卷被截斷（先用手動記帳，或回報讓我們調整上限）', 'ai_truncated');
    const text = Array.isArray(body?.content) ? body.content.find((/** @type {any} */ b) => b?.type === 'text')?.text : null;
    if (typeof text !== 'string' || !text) throw apiError(400, 'AI 沒有交回答案卷', 'ai_bad_answer');
    try { return JSON.parse(text); } catch { throw apiError(400, 'AI 答案卷不是有效的 JSON', 'ai_bad_answer'); }
  };
}

/**
 * 真引擎工廠（唯一組裝點；路由層拿它當 aiEngineFactory 注入服務層）。回傳的 parseOnce 交**未驗收的
 * 原始答案**——逐欄驗收（normalizeAiBank）由服務層自己做（縱深防禦：服務層不信任何引擎實作）。
 * @param {string} apiKey
 */
export function makeAnthropicBankEngine(apiKey) {
  const transport = anthropicTransport(apiKey);
  return {
    models: AI_BANK_MODELS,
    /** @param {string} text @param {string} model */
    parseOnce: (text, model) => transport({ model, system: buildBankSystem(), user: String(text || ''), schema: AI_BANK_SCHEMA }),
    /** 配方生成（P2-3）：同一條傳輸、換答案卷與提示詞；模型由呼叫端帶（裁示⑥＝RECIPE_MODEL 一律 Opus）。 @param {string} text @param {string} model */
    generateRecipe: (text, model) => transport({ model, system: buildRecipeSystem(), user: String(text || ''), schema: RECIPE_SCHEMA }),
  };
}
