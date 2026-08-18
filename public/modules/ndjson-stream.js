// @ts-check
/**
 * NDJSON 串流的**協議解讀**（2026-08-18 上傳進度）：從位元組流還原成 frame，並判定最終成敗。
 * 抽成純模組的理由＝`app.js` 拉得進瀏覽器模組、node 測不動（本專案「純函式才測得動」的既有慣例）；
 * 這一層是整條路唯一會出錯的地方（半行、壞行、斷線、error frame 的 code 通道），必須直測。
 *
 * 契約（與 `api()` 一致，不得偷換）：
 * - 成功＝回 `{ok:true, result}`（`done` frame 的 r）
 * - 失敗＝回 `{ok:false, error, code?}`（`error` frame；code 由呼叫端掛成 Error 的**自有屬性**）
 * - 斷線（沒有終端 frame）＝`{ok:false, error:'連線中斷…', truncated:true}`——**不得假裝成功**
 */

/** 建立一個增量解析器：餵字串片段、逐行吐 frame。 */
export function makeNdjsonParser() {
  let buf = '';
  /** @param {string} chunk @returns {any[]} 這次餵入後可完整解讀的 frame（壞行直接丟掉） */
  const push = (chunk) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    return parts.map(parseLine).filter((f) => f !== null);
  };
  /** 收尾：把最後一截（沒有換行結尾的那行）也試著解讀。 */
  const end = () => { const f = parseLine(buf); buf = ''; return f === null ? [] : [f]; };
  return { push, end };
}

/** @param {string} line @returns {any|null} 壞行＝null（不讓半行/代理雜訊毀掉整趟） */
function parseLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 把一串 frame 收斂成最終結果（stage 交給 onStage、done/error 決定成敗）。
 * @param {any[]} frames @param {(f:any)=>void} onStage
 * @returns {{ok:true, result:any}|{ok:false, error:string, code?:string}|null} null＝還沒到終端 frame */
export function reduceFrames(frames, onStage) {
  /** @type {any} */ let out = null;
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    if (f.t === 'stage') { try { onStage(f); } catch { /* 進度不得影響結果 */ } continue; }
    if (f.t === 'done') { out = { ok: /** @type {const} */ (true), result: f.r }; continue; }
    if (f.t === 'error') out = { ok: /** @type {const} */ (false), error: String(f.error || '匯入失敗'), ...(f.code ? { code: String(f.code) } : {}) };
  }
  return out;
}

/** 斷線（讀完了卻沒有終端 frame）的統一結果——誠實說沒收到，不假裝成功。 */
export const TRUNCATED = Object.freeze({ ok: /** @type {const} */ (false), error: '連線中斷了（沒有收到完整結果）——請再試一次', truncated: true });
