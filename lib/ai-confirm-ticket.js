// @ts-check
// AI 預覽確認票（P1b-1 r4#1）。病根：**AI 不是確定性解析器**——模板解析器同一份 PDF 解兩次結果相同，
// 所以 preview／apply 各自重新解析是安全的；AI 不是。Codex r4 端到端實測：preview 顯示金額 500、
// apply 那次模型回 400，兩份**各自都過強閘**，於是使用者確認的是 A、實際入帳的是 B、全程無錯誤。
//
// 修法＝**apply 不再自己跑模型**：preview 把「已驗收＋已過閘」的那份答案留在**伺服器記憶體**，發一張
// 不可預測的票給前端；apply 憑票取回同一份答案寫入。三條性質：
//   ①**一次性**（取出即銷毀）＝重放無效、也防「按兩次套用寫兩次」
//   ②**短效**（TTL）＝帳單內文不在記憶體久留
//   ③**張數上限**（超過丟最舊）＝防記憶體膨脹（每次上傳一張，正常用不到上限）
// ⚠️ 票裡有帳單內文（已解析的交易列）＝**只在記憶體、不落 db、不落 log**（同「原始 PDF 不持久化」
//    既有鐵則）；程序重啟即失效——使用者重新預覽一次即可，這是刻意的取捨。
// ⚠️ 票**不是**「跳過閘」的通行證：apply 憑票取回答案後，仍用 fresh db 重過閘（見 applyBankStatement）。
// ⏰ **解除 HOSTED 停止線前的硬條件（r5 提醒）**：票匣是**模組層全域 Map、沒有綁租戶/session**——
//    今天 AI 在 HOSTED 寫死停用、LOCAL 是單一使用者，所以不是可達的漏洞；但 P3 開放多人時，
//    票必須綁定「已驗證的 tenant/session」再核對，**不可以把持票本身當成授權**（bearer ticket）。
import { randomUUID } from 'node:crypto';

/** 10 分鐘：夠使用者看完預覽再按套用，又不讓帳單內文在記憶體久留。 */
export const AI_TICKET_TTL_MS = 10 * 60 * 1000;
/** 同時最多幾張（一次上傳一張；超過＝丟最舊）。 */
export const AI_TICKET_MAX = 5;

/** @typedef {{parsed:any, aiModel:string, suspectRecipeIds?:string[], recipeUse?:{id:string, usedVersion:'current'|'previous', currentMatched?:boolean, usedRecipe:object}, issuedAt?:string, exp:number, timer?:any}} Ticket */
/** @type {Map<string, Ticket>} */
const tickets = new Map();

/** 清掉過期票（存取時順手跑）。 @param {number} now */
function purge(now) {
  for (const [id, t] of tickets) if (t.exp <= now) drop(id);
}

/** 銷毀一張票：清計時器＋移出票匣（單一出口＝內容一定跟著走）。 @param {string} id */
function drop(id) {
  const t = tickets.get(id);
  if (t?.timer) clearTimeout(t.timer);
  tickets.delete(id);
}

/**
 * 發票：把 preview 已驗收的答案留在記憶體，回一張不可預測的票號。
 * @param {{parsed:any, aiModel:string}} payload @param {number} [now]
 * @returns {string}
 */
/** 把票匣壓到「再放一張也不超過上限」——`issueAiTicket` 與 `restoreAiTicket` **共用**（r1#3：
 * restore 原本直接 set，實測「發 5 張→全部兌走→再發 5 張→前 5 張放回」會累積到 10 張，
 * 而每一張都含帳單交易內容＝繞過「張數上限防記憶體膨脹」那條紀律）。 @param {number} now */
function evictToCapacity(now) {
  purge(now);
  while (tickets.size >= AI_TICKET_MAX) {
    const oldest = tickets.keys().next().value;   // Map 保插入序＝丟最舊
    if (oldest === undefined) break;
    drop(oldest);
  }
}

export function issueAiTicket(payload, now = Date.now()) {
  evictToCapacity(now);
  const id = randomUUID();   // 不可預測：前端猜不到別人的票（單機自用仍照規矩來）
  // ⚠️ **到期自我清除**（r5#1）：只靠「下次有人碰票匣才 purge」的話，最後一次預覽後沒人再操作＝
  // 帳單內文被 Map 強參照到程序結束（TTL 只擋得了「不能兌」、擋不住「還留著」）。計時器 unref＝
  // 不因為它而讓 node 程序不肯退出。
  const timer = setTimeout(() => drop(id), AI_TICKET_TTL_MS);
  timer?.unref?.();
  // suspectRecipeIds（P2-2）：預覽時「配方有中版面、但閘紅」的配方 id——apply 兌票寫入成功後標疑似過期
  //（預覽全程唯讀不變量不可破，標記延到真的完成匯入那一刻；使用者不套用＝不標，誠實劃界在收支契約）
  // recipeUse（P2-2 預審 G2）：配方路線也發票＝「所見即所得」對配方同樣成立（apply 憑票取回
  // preview 那份 parsed 與選中的版本，不重跑選版——選版依 db 現況、不是 PDF 的純函數）。
  // issuedAt（預審 A4）：suspect 標記的世代檢查用——票是 preview 時刻的快照，其後已自證的配方不可被舊快照蓋回。
  tickets.set(id, { parsed: payload.parsed, aiModel: payload.aiModel, suspectRecipeIds: payload.suspectRecipeIds || [],
    ...(payload.recipeUse ? { recipeUse: payload.recipeUse } : {}), issuedAt: new Date(now).toISOString(),
    exp: now + AI_TICKET_TTL_MS, timer });
  return id;
}

/**
 * 兌票：取回那份答案並**當場銷毀**（一次性）。查無／過期＝null（呼叫端 fail-closed 要求重新預覽）。
 * @param {any} id @param {number} [now] @returns {Ticket|null}
 */
export function redeemAiTicket(id, now = Date.now()) {
  purge(now);
  const key = typeof id === 'string' ? id : '';
  if (!key) return null;
  const t = tickets.get(key);
  if (!t) return null;
  drop(key);   // 一次性：取出即銷毀（同步、在任何 await 之前＝並發兩次只有一次拿得到）
  return t;
}

/**
 * **把票放回去**（2026-08-12，William 實測踩到）：`redeemAiTicket` 為了擋並發是**同步取走**的，
 * 但如果 apply 後續失敗（getDb 掛掉／對帳閘紅／saveDb 櫃檯清理擋下），票就這樣沒了——
 * AI 路線重來等於**再花一次錢**。所以呼叫端在寫入失敗時要把票放回：
 * - **保留原 id 與原到期時間**（不延長：票的短效是機密紀律，不能因為重試而變長）
 * - 已過期就不放回（回 false，呼叫端不必處理：使用者本來就得重新預覽）
 * - 並發保護不受影響：第一個請求仍是同步取走，第二個在它失敗前拿不到票
 * @param {string} id @param {Ticket} ticket @param {number} [now] @returns {boolean}
 */
export function restoreAiTicket(id, ticket, now = Date.now()) {
  const key = typeof id === 'string' ? id : '';
  if (!key || !ticket || !(ticket.exp > now)) return false;
  evictToCapacity(now);   // r1#3：放回也要守張數上限（否則兌走再補新票就能無限累積帳單內文）
  const timer = setTimeout(() => drop(key), Math.max(0, ticket.exp - now));
  timer?.unref?.();
  // 放回＝**整份**放回（預審 A1：原本只挑三欄＝suspectRecipeIds/recipeUse/issuedAt 在「失敗→重試」
  // 路上被靜默丟掉——疑似過期永不標、配方票退化成 AI 票；靜靜通過最危險的教科書案例）。
  tickets.set(key, { ...ticket, timer });
  return true;
}

/** 考題專用：清空票匣（跨題互不干擾，比照 resetRateLimitsForTest 的慣例）。 */
export function clearAiTicketsForTest() {
  for (const id of [...tickets.keys()]) drop(id);
}

/** 考題專用：票匣現在留著幾份帳單內文（r5#1 的「到期真的被釋放」要看得到才驗得了）。 */
export function aiTicketCountForTest() {
  return tickets.size;
}
