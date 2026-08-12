// @ts-check
// AI 傳輸層（P1b-1）：**全 repo 唯一會打 AI 供應商的檔案**（字面 fetch 只住這裡，入外連登記閘
// hosted-auth「反向對帳」的 ALLOWED＋server.js OUTBOUND_ENDPOINTS）。誰能 import 它＝誰有外連能力，
// 所以只有**全靜態路徑的路由檔**（lib/routes/statement.js）import 它組 engineFactory；服務層
// （bank-import.js，被 crud.js 等動態路徑路由檔 import）刻意拿不到。
// 刻意用原生 fetch、不裝 SDK：主目錄的重啟捷徑只 pull 不 npm install，多一個依賴＝合併後
// app 起不來的一類事故（#419 前例）；本傳輸只用一個端點、一種請求形狀，fetch 足矣。
// 錯誤分類成 code、**訊息絕不含帳單內文或鑰匙**；本檔零 console（機密不落 log，考題釘住）。
import { AI_BANK_MODELS, AI_BANK_SCHEMA, buildBankSystem } from './ai-parse.js';

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
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        // ⚠️ 刻意**不帶 temperature**（r1#2）：Sonnet 5 家族對非預設 temperature/top_p/top_k 回 400
        //（官方 whats-new-sonnet-5 文件），階梯升級那一發會直接壞掉——決定論讓位相容性；
        // 輸出格式已由結構化輸出 schema 鎖住，不靠 sampling 參數。
        body: JSON.stringify({
          model, max_tokens: 8192, system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema } },
        }),
      });
    } catch {
      throw apiError(502, '連不上 AI 服務（網路問題），稍後再試', 'ai_unavailable');
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
  };
}
