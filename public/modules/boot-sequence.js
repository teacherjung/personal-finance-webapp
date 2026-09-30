// @ts-check
// 開機自動更新：一步一步跑、每次向伺服器要東西有等待上限、結果交給總覽寫出來。
// 裁示：2026-09-29「乙」（#649 留言 5893103735）；2026-09-30 兩則（#651 留言 5903711899＝不跳提示、改在網頁寫出狀態；
// 5903712093＝加等待上限、洞察等五步全部做完）。
//
// 為什麼依序：原本各段同時送出，雲端模式下會互相撞出 409，而每一段都把錯誤靜默吞掉。
// 為什麼上限掛在「每一次請求」而不是「每一步」：店名整理那一步中間可能跳確認視窗等使用者按，讀視窗的時間不算卡住。
// 為什麼獨立成純模組：`public/app.js` 在 node 裡 import 不進來；考題＝`test/boot-sequence.test.js`。
// 為什麼**任何錯都算**出了問題、不分「連不上」：錯誤型別分不出有沒有收到回應（回應內容壞掉也會丟 TypeError，
// #651 r1 #1 實測），猜錯就會把真的失敗吞掉。
//
// 守不到的：另一個分頁／手機同時寫入仍會撞（只是現在看得到）；逾時不會取消請求，伺服器那邊可能還在跑；
// 出錯不等於沒寫進去——回應壞掉時寫入可能已成功，所以狀態只寫「出了問題」、不寫「沒做成」；30 秒合不合適沒量過。

export const BOOT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ key: string, run: () => Promise<unknown> }} BootStep
 * @typedef {{ ok: true, value: any } | { ok: false, error: unknown }} BootResult
 * @typedef {{ at: string, results: Record<string, BootResult>, quotesLastAt: string|null }} BootReport
 *   at＝這次開機檢查的時間（ISO）；quotesLastAt＝五步做完後讀到的報價時間（讀不到＝null）
 * @typedef {{ label: string, ok: boolean, text: string }} BootStatusRow
 */

/**
 * 最多等 ms 毫秒；超過就以 name＝'BootTimeoutError' 的錯 reject（原本那個請求不會被取消）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<never>} */
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`等超過 ${ms / 1000} 秒沒有回應`), { name: 'BootTimeoutError' })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * 依序執行；某一步出錯不擋後面的步驟；最後一步結束才回傳。
 * @param {BootStep[]} steps
 * @returns {Promise<Record<string, BootResult>>} 以 key 查每一步的結果
 */
export async function runBootSteps(steps) {
  /** @type {Record<string, BootResult>} */
  const results = {};
  for (const step of steps) {
    try { results[step.key] = { ok: true, value: await step.run() }; }
    catch (error) { results[step.key] = { ok: false, error }; }
  }
  return results;
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** ISO 時間 → 本地「9/30 14:03」；讀不懂回 null。 @param {unknown} iso */
function whenText(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM-DD → 「9/1」（照字面，不經時區）；讀不懂回 null。 @param {unknown} ymd */
function dayText(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
}

/** @param {BootResult|undefined} r */
function problemText(r) {
  if (!r) return '這次沒有檢查';
  const e = /** @type {any} */ (r.ok ? null : r.error);
  return e?.name === 'BootTimeoutError' ? `這次${e.message}` : '這次出了問題';
}

/**
 * 總覽最下面「開 App 自動更新」那一塊的文字（零 DOM；dashboard.js 負責畫）。
 * 每日備份不列：它有自己的警告框，而且雲端版不做備份（列出來就等於暗示有備份）。
 * ok:false（畫面標 ⚠）＝這次沒有照常做完：出錯、逾時、只做了一部分、或使用者在確認視窗選了先不套用——不全是「出錯」（#651 r4 #7）。
 * 訂閱續費日、帳戶名、店名規則寫的是**這次開 App 檢查的結果**，不是跨次的歷史（裁示操作化，#651 留言 5903711899）。
 * @param {BootReport} report
 * @returns {{ checkedAt: string, rows: BootStatusRow[] }}
 */
export function bootStatusView(report) {
  const res = report.results || {};
  const lastQuote = whenText(report.quotesLastAt);
  /** @type {BootStatusRow[]} */
  const rows = [];

  // 報價時間＝settings.quotesLastAt＝「上次自動更新抓到任何一筆報價或匯率」的時間（market-data.js），
  // 不代表每一檔持股都是那個時間的價格；讀不到就不寫時間（不拿這次開機的時間頂替，#651 r4 #2）。
  const q = res.quotes;
  const lastNote = lastQuote ? `（上次自動更新是 ${lastQuote}）` : '';
  if (!q?.ok) rows.push({ label: '報價', ok: false, text: problemText(q) + lastNote });
  else if (q.value?.refreshed) {
    const skipped = Number(q.value.skipped) || 0;   // 抓不到、或幣別對不上而沒更新價格的持股
    rows.push({ label: '報價', ok: !skipped,
      text: (lastQuote ? `已自動更新（${lastQuote}）` : '已自動更新') + (skipped ? `；有 ${skipped} 檔持股這次沒有更新價格` : '') });
  }
  else if (q.value?.reason === 'fresh') rows.push({ label: '報價', ok: true, text: lastQuote ? `${lastQuote} 自動更新過，一小時內不重抓` : '一小時內自動更新過，不重抓' });
  else rows.push({ label: '報價', ok: false, text: `這次抓不到新報價，沿用舊的價格${lastNote}` });

  const s = res.snapshot;
  const snap = s?.ok ? (s.value || {}) : null;
  if (!snap) {
    rows.push({ label: '快照', ok: false, text: problemText(s) });
    rows.push({ label: '訂閱續費日', ok: false, text: problemText(s) });
  } else if (snap.skipped) {
    rows.push({ label: '快照', ok: false, text: '電腦日期比已記錄的資料還早，這次沒有記（請確認電腦時間）' });
    rows.push({ label: '訂閱續費日', ok: false, text: '這次沒有檢查（電腦日期比已記錄的資料還早）' });
  } else {
    const d = dayText(snap.snap?.date);
    rows.push({ label: '快照', ok: true, text: (d ? `本月快照 ${d}` : '本月還沒有快照') + (snap.daily ? '；今天的淨資產已記' : '') });
    const n = Array.isArray(snap.subsRolled) ? snap.subsRolled.length : 0;
    // subsRolled＝這次真的推進的；即將停用、填了停用日等刻意不推的過期日期不在裡面（#651 r4 #4）
    rows.push({ label: '訂閱續費日', ok: true, text: n ? `這次把 ${n} 筆過期的推到下一期` : '這次沒有需要自動推進的' });
  }

  const a = res.accounts;
  if (!a?.ok) rows.push({ label: '帳戶名', ok: false, text: problemText(a) });
  else {
    // changed＝改動的處數，不是交易筆數：同一筆交易的帳戶名與說明都改會算兩處（bank-import.js；#651 r4 #3）
    const n = Number(a.value?.changed) || 0;
    rows.push({ label: '帳戶名', ok: true, text: n ? `這次做了 ${n} 處更新（帳戶名或交易說明）` : '都已是最新' });
  }

  const st = res.storeNames;
  const o = st?.ok ? (st.value || {}) : null;
  if (!o) rows.push({ label: '店名規則', ok: false, text: problemText(st) });
  else if (o.outcome === 'unchanged') rows.push({ label: '店名規則', ok: true, text: '規則沒變，不用整理' });
  else if (o.outcome === 'applied') {
    const bits = Array.isArray(o.bits) ? o.bits : [];
    // bits 空＝已知的幾個計數都是 0，但不能據此說「沒有整理」（計數不一定涵蓋每一種改動，#651 r4 #5）
    rows.push({ label: '店名規則', ok: true, text: bits.length ? `規則有更新，整理了 ${bits.join('、')}` : '規則有更新，已套用' });
  }
  else if (o.outcome === 'declined') rows.push({ label: '店名規則', ok: false, text: '規則有更新，你選了先不套用（下次開 App 會再問你）' });
  else if (o.outcome === 'blocked') rows.push({ label: '店名規則', ok: false, text: '這次沒有套用（確認過了仍被擋下），資料沒有變動' });
  else rows.push({ label: '店名規則', ok: false, text: '這次沒有套用（伺服器回了一個目前看不懂的狀況），資料沒有變動' });

  return { checkedAt: whenText(report.at) ?? '', rows };
}
