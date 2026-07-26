// @ts-check
// 訂閱的每日維護：把「已經過期的續費日」自動推到下一期（使用者定 2026-07-26）。
//
// 病根（使用者 2026-07-26 回報「怎麼都沒有即將扣款的訂閱」）：`nextCharge` 是使用者手填的固定日期、
// 不會自己走。日期一過就從「未來 30 天」的續費時間線上消失——當時 26 筆訂閱有 5 筆卡在過去。
//
// ⚠️ 只改「下一次要扣款的日子」這一個欄位，**不碰任何金額**：訂閱攤提（costForMonth／subCostForMonth）
// 看的是 since／endsOn／amount／cycle，與 nextCharge 無關（考題鎖住：推日期前後每月金額一模一樣）。
// ⚠️ 使用者手動填了停用日（endsOn）或標成「即將停用」＝**不自動推**（使用者原話：「除非我手動輸入停用日」）。
// 判準與回傳新日期的規則全部在 public/modules/subscriptions-model.js 的 rolledNextCharge（純函式、有考題）。
import { getDb, saveDb } from '../repo.js';
import { rolledNextCharge } from '../../public/modules/subscriptions-model.js';

/**
 * 把所有「該推」的訂閱續費日推到下一期。沒有任何一筆要推就**不寫檔**
 *（省下每次開 app 白寫一次全庫，也不必要地推進 __dbUpdatedAt＝舊 JSON 搬家衝突偵測的依據）。
 * ⚠️ 今天的日期由呼叫端傳入（與日線／月快照共用同一次擷取的時間）——**刻意不自己取**：
 * snapshot.js 的 nowLocal 是那支檔案的私有函式，從這裡反向 import 會做出循環相依（AGENTS 鐵則）。
 * @param {string} todayIso 今天 YYYY-MM-DD
 * @returns {{rolled: {id:string, name:string, from:string, to:string}[]}}
 */
export function rollDueSubscriptions(todayIso) {
  const db = getDb();
  const today = String(todayIso || '');
  /** @type {{id:string, name:string, from:string, to:string}[]} */
  const rolled = [];
  for (const sub of db.subscriptions || []) {
    const next = rolledNextCharge(sub, today);
    if (!next) continue;
    rolled.push({ id: String(sub.id || ''), name: String(sub.name || ''), from: String(sub.nextCharge || ''), to: next });
    sub.nextCharge = next;
  }
  if (rolled.length) saveDb(db);
  return { rolled };
}
