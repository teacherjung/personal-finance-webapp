// @ts-check
// 退款歸屬（純函式積木，零相依）：信用卡費頁的「消費歸屬」統計與兩端標記用（使用者定 2026-07-27）。
// 口徑＝與總覽「月度回顧」一致：消費算在**消費當月**，配對成功的退款回頭抵減**原消費那個月的那一類**，
// 配不到的退款一律不計入（另外列出）。⚠️ 配對本身由後端 `derive.pairRefunds` 算（同步點：判準只有那一份），
// 這裡只負責「拿配對結果做這一頁的加總與標記」，不可在前端另寫一套配對規則。
// 為什麼不直接用退款自己的分類：退款的分類是它自己那一列的，原消費可能被歸在別的分類（使用者事後改過），
// 抵減必須落在**原消費的分類**上，否則會把某一類扣成負的、另一類永遠虛高。

/** @typedef {{refundId:string, purchaseId:string, purchaseMonth:string, amount:number}} RefundPair */

/**
 * 配對表 → 兩張查詢表：退款列要標的「原**消費日**」、消費列要標的「**退款日**」。
 * 使用者定 2026-07-27（第二版）：兩邊都標**日期**——月份看不出是同一天的哪一筆，
 * 金額則已經印在同一列的金額欄、標第二次是贅字。
 * @param {RefundPair[]|any} pairs
 * @returns {{purchaseDateOf: Map<string,string>, refundDateOf: Map<string,string>}}
 */
export function refundLookups(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  /** @type {Map<string,string>} 退款 id → 原消費的日期 */
  const purchaseDateOf = new Map();
  /** @type {Map<string,string>} 消費 id → 退款的日期 */
  const refundDateOf = new Map();
  for (const p of list) {
    if (!p) continue;
    const refundId = String(p.refundId || '');
    const purchaseId = String(p.purchaseId || '');
    if (refundId) purchaseDateOf.set(refundId, String(p.purchaseDate || ''));
    if (purchaseId) refundDateOf.set(purchaseId, String(p.refundDate || ''));
  }
  return { purchaseDateOf, refundDateOf };
}

/**
 * 本月各分類的消費金額（消費歸屬口徑）。
 * @param {any[]} monthRows 本月的交易列（已依月份篩選過的那一頁資料）
 * @param {any[]} allRows 這個帳本的全部交易（要用來查「被抵減的那筆消費」的分類——它可能不在本月）
 * @param {RefundPair[]|any} pairs 後端配對表
 * @param {string} month 'YYYY-MM'
 * @param {boolean} [attribute=true] false＝退回帳面口徑（配對表載不到時的降級路徑）
 * @returns {Record<string, number>}
 */
export function consumptionCategoryTotals(monthRows, allRows, pairs, month, attribute = true) {
  // Object.create(null)：分類名是使用者取的，取成 toString 這類原生屬性名時，
  // 普通物件的 `out[k] || 0` 會撈到原型上的函式 → 加總變成字串（Codex r5#5 的同一個坑）。
  /** @type {Record<string, number>} */
  const out = Object.create(null);
  const add = (/** @type {any} */ cat, /** @type {number} */ delta) => {
    const key = String(cat ?? '');
    out[key] = (Object.hasOwn(out, key) ? out[key] : 0) + delta;
  };
  const rows = Array.isArray(monthRows) ? monthRows : [];
  if (!attribute) {
    for (const t of rows) add(t?.category, Number(t?.amount) || 0);
    return out;
  }
  for (const t of rows) {
    const amount = Number(t?.amount) || 0;
    if (amount > 0) add(t?.category, amount);   // 退款（負數）不在這裡算，改由下面依「原消費月份」抵減
  }
  const byId = new Map((Array.isArray(allRows) ? allRows : []).map(t => [String(t?.id ?? ''), t]));
  for (const p of (Array.isArray(pairs) ? pairs : [])) {
    if (!p || String(p.purchaseMonth || '') !== String(month || '')) continue;
    const purchase = byId.get(String(p.purchaseId || ''));
    if (!purchase) continue;   // 原消費不在這個帳本（例：現金流那本的退款）→ 不干擾這一頁
    add(purchase.category, -Math.abs(Number(p.amount) || 0));
  }
  return out;
}

/**
 * 分類加總 → 畫面要畫的長條（金額絕對值大的在前，最多 limit 條）。
 * **淨額 0 的分類不畫**（Codex 複審 2026-07-27）：整筆消費被退款完全抵掉時會留下 `{娛樂: 0}`，
 * 畫出來是一條沒有資訊量的空長條，而且與月度回顧不一致——後端 `derive.js` 輸出分類時就有
 * `Number(row.total) > 0` 的過濾。全部被抵掉時回空陣列，畫面自然落到「本月尚無消費」空狀態。
 * ⚠️ **負數要留著**：帳面口徑（配對表載不到的降級路徑）下，某類淨負代表「這個月淨收回」，是真資訊。
 * @param {Record<string, number>|any} totals
 * @param {number} [limit=6]
 * @returns {[string, number][]}
 */
export function topSpendCategories(totals, limit = 6) {
  return Object.entries(totals && typeof totals === 'object' ? totals : {})
    .map(([name, value]) => /** @type {[string, number]} */ ([name, Number(value) || 0]))
    .filter(([, value]) => value !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, Math.max(0, Number(limit) || 0));
}

/**
 * 本月「配不到原消費」的退款（只留這個帳本裡的）＝統計裡看不到的錢，畫面必須明講。
 * @param {any[]|any} unmatched 後端回的未對應清單
 * @param {any[]} allRows 這個帳本的全部交易
 * @param {string} month 'YYYY-MM'
 * @returns {any[]}
 */
export function unmatchedRefundsForMonth(unmatched, allRows, month) {
  const ids = new Set((Array.isArray(allRows) ? allRows : []).map(t => String(t?.id ?? '')));
  return (Array.isArray(unmatched) ? unmatched : [])
    .filter(u => u && String(u.date || '').slice(0, 7) === String(month || '') && ids.has(String(u.id || '')));
}
