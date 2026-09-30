// @ts-check
// 開機自動更新：一步一步跑、每次向伺服器要東西有等待上限、結果寫在總覽最下面「開 App 自動更新檢查」那一塊。
// 裁示：2026-09-29「乙」（#649 留言 5893103735）；2026-09-30 兩則（#651 留言 5903711899＝不跳提示、改在網頁寫出狀態；
// 5903712093＝加等待上限、洞察等五步全部做完）；區塊格式與「開始記錄」上次的日期＝William 的指示（#653 留言 5905965930）。
//
// 為什麼依序：原本各段同時送出，雲端模式下會互相撞出 409，而每一段都把錯誤靜默吞掉。
// 為什麼上限掛在「每一次請求」而不是「每一步」：店名整理那一步中間可能跳確認視窗等使用者按，讀視窗的時間不算卡住。
// 為什麼區塊的畫法也放這裡（bootStatusHtml、createBootStatusWatcher）：`public/app.js`、`dashboard.js` 在 node 裡
// import 不進來；放在這個沒有依賴的模組才考得到（考題＝`test/boot-sequence.test.js`）。
// 為什麼**任何錯都算**出了問題、不分「連不上」：錯誤型別分不出有沒有收到回應（回應內容壞掉也會丟 TypeError，
// #651 r1 #1 實測），猜錯就會把真的失敗吞掉。
//
// 守不到的：另一個分頁／手機同時寫入仍會撞（只是現在看得到）；逾時不會取消請求，伺服器那邊可能還在跑；
// 出錯不等於沒寫進去——回應壞掉時寫入可能已成功，所以狀態只寫「沒有檢查成功」、不寫「沒做成」；30 秒合不合適沒量過。

export const BOOT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ key: string, run: () => Promise<unknown> }} BootStep
 * @typedef {{ ok: true, value: any } | { ok: false, error: unknown }} BootResult
 * @typedef {{ quotesLastAt: string|null, subsLastRolledAt: string|null, accountNamesLastAlignedAt: string|null,
 *   storeNamesLastNormalizedAt: string|null }} BootStamps 伺服器記的四個時間（ISO；沒記過或讀不到＝null）
 * @typedef {{ at: string, results: Record<string, BootResult>, stamps: BootStamps }} BootReport
 *   at＝這次開機檢查的時間（ISO）；stamps＝五步做完後從 /settings 讀到的時間
 * @typedef {{ state: 'pending' } | { state: 'ok', at: string } | { state: 'fail', error?: unknown }} InsightsStatus
 *   總覽抓 /insights 的結果；ok 的 at＝伺服器存書籤時回的 seenAt
 * @typedef {{ label: string, level: 'ok'|'warn'|'pending', text: string, note?: string }} BootStatusRow
 *   level：ok＝✓、warn＝⚠️、pending＝還在跑；note＝小字補充（上次真的做的日期）
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

const STAMP_KEYS = /** @type {const} */ (['quotesLastAt', 'subsLastRolledAt', 'accountNamesLastAlignedAt', 'storeNamesLastNormalizedAt']);

/**
 * 從 GET /settings 的回應挑出四個時間；不是字串（或空字串）就當沒有（null）。
 * @param {unknown} settings
 * @returns {BootStamps}
 */
export function pickStamps(settings) {
  const src = /** @type {Record<string, unknown>} */ (settings && typeof settings === 'object' ? settings : {});
  return /** @type {BootStamps} */ (Object.fromEntries(STAMP_KEYS.map((k) => [k, typeof src[k] === 'string' && src[k] ? src[k] : null])));
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** 字串轉成 Date；不是字串、或 Date 讀不出來（得到 NaN）回 null。 @param {unknown} iso */
function toDate(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日期：跟參考時間同一年寫「9/30」，不同年寫「2025/9/30」（上次的日期可能是好幾個月前）。 @param {Date} d @param {Date|null} ref */
function dayOf(d, ref) {
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return ref && ref.getFullYear() === d.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 時間字串 → 本地「9/30 13:38」；toDate 讀不出來回 null。 @param {unknown} iso @param {Date|null} ref */
function whenText(iso, ref) {
  const d = toDate(iso);
  return d ? `${dayOf(d, ref)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : null;
}

/** 時間字串 → 本地日期「9/15」；toDate 讀不出來回 null。 @param {unknown} iso @param {Date|null} ref */
function dateText(iso, ref) {
  const d = toDate(iso);
  return d ? dayOf(d, ref) : null;
}

/** @param {BootResult|undefined} r */
function problemText(r) {
  if (!r) return '這次沒有檢查';
  const e = /** @type {any} */ (r.ok ? null : r.error);
  return e?.name === 'BootTimeoutError' ? `這次${e.message}` : '這次沒有檢查成功';
}

/**
 * 「開 App 自動更新檢查」那一塊的標題與六行（零 DOM）。格式出處：#653 留言 5905965930（William 給的圖）。
 * ⚠️（warn）＝這一項這次沒有順利完成：出錯、逾時、只更新到一部分、被伺服器擋下、電腦日期比資料舊而沒紀錄；
 * 使用者在確認視窗自己選「先不套用」不算（那一行照樣寫出他的選擇，但標 ✓），對上底下那句「沒有檢查成功」。
 * 每日備份不列：它有自己的警告框，而且雲端版不做備份（列出來就等於暗示有備份）。
 * 訂閱／帳戶／店名三行在「這次沒有要改的」時，小字補上伺服器記的「上次真的做」的日期；沒記過就不寫（不拿別的日期頂替）。
 * 誠實劃界（這幾行的 ✓ 守不到的）：
 * - 「帳戶對齊」只看得到開 app 自動對齊那條路——銀行匯入交易的遮罩帳號剛好對到一個帳戶的才會被改；手動記帳、
 *   同一個帳號對到兩個帳戶的交易不在這條路裡（lib/services/bank-import.js reconcileBankTxAccountNames）。
 * - 「更新報價」只看持股漏抓（skipped），匯率全沒抓到但持股有抓到時仍是 ✓；一小時內再開寫「一小時內不重抓」，
 *   上一次漏抓了哪幾檔不會留下來。
 * - 「更新洞察」看的是 /insights 有沒有存好書籤回來；CAPE／實質殖利率抓不到而洞察照常回來時仍是 ✓——那兩個數字
 *   12 小時內用快取，過期又抓不到就退回手動填的值，沒填就缺值（market-data.js getCape／getRealYield）。
 * - 「紀錄快照」的時間是這次開機檢查的時間（日線在這次開機裡寫入），不是伺服器寫檔的那一刻；日線記成哪一天
 *   跟本地日期不同時（雲端伺服器時區）會在後面寫出來。
 * @param {BootReport} report
 * @param {InsightsStatus} [insights] 沒給＝還沒抓到
 * @returns {{ title: string, rows: BootStatusRow[] }}
 */
export function bootStatusView(report, insights = { state: 'pending' }) {
  const res = report.results || {};
  const stamps = report.stamps || pickStamps(null);
  const ref = toDate(report.at);
  /** @type {BootStatusRow[]} */
  const rows = [];
  /** @param {string} label @param {boolean} ok @param {string} text @param {string|null} [note] */
  const push = (label, ok, text, note) => rows.push({ label, level: ok ? 'ok' : 'warn', text, ...(note ? { note } : {}) });

  // 報價時間＝settings.quotesLastAt＝「上次自動更新抓到任何一筆報價或匯率」的時間（market-data.js），
  // 不代表每一檔持股都是那個時間的價格；讀不到就不寫時間（不拿這次開機的時間頂替，#651 r4 #2）。
  const lastQuote = whenText(stamps.quotesLastAt, ref);
  const q = res.quotes;
  if (!q?.ok) push('更新報價', false, problemText(q));
  else if (q.value?.refreshed) {
    const skipped = Number(q.value.skipped) || 0;   // 抓不到、或幣別對不上而沒更新價格的持股
    push('更新報價', !skipped, (lastQuote ? `${lastQuote} 已更新` : '已更新') + (skipped ? `，但有 ${skipped} 檔持股沒有更新價格` : ''));
  }
  else if (q.value?.reason === 'fresh') push('更新報價', true, lastQuote ? `${lastQuote} 已更新（一小時內不重抓）` : '一小時內已更新（不重抓）');
  else push('更新報價', false, `這次抓不到新報價（沿用${lastQuote ? ` ${lastQuote} ` : '舊'}的價格）`);

  const s = res.snapshot;
  const snap = s?.ok ? (s.value || {}) : null;
  if (!snap) {
    push('紀錄快照', false, problemText(s));
    push('更新訂閱', false, problemText(s));
  } else if (snap.skipped) {
    push('紀錄快照', false, '電腦日期比已紀錄的資料還早，這次沒有紀錄（請確認電腦時間）');
    push('更新訂閱', false, '這次沒有檢查（電腦日期比已紀錄的資料還早）');
  } else {
    const checked = whenText(report.at, ref);
    const snapDay = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(snap.snap?.date ?? ''));
    // 日線記在伺服器的「今天」（snapshot.js nowLocal，伺服器時區）；雲端伺服器不在台灣時區時，台灣清晨會記成前一天——
    // 跟這次檢查的本地日期不同就照實寫出記成哪一天（#653 複審後掃）。
    const dailyDay = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(snap.daily?.date ?? ''));
    const refDay = ref ? `${ref.getFullYear()}-${pad2(ref.getMonth() + 1)}-${pad2(ref.getDate())}` : '';
    const filedAs = dailyDay && snap.daily.date !== refDay ? `（記成 ${Number(dailyDay[1])}/${Number(dailyDay[2])} 那一天）` : '';
    push('紀錄快照', true, snap.daily && checked ? `${checked} 已紀錄${filedAs}`
      : (snapDay ? `本月快照 ${Number(snapDay[1])}/${Number(snapDay[2])}` : '本月還沒有快照'));
    // subsRolled＝這次真的推進的；即將停用、填了停用日等刻意不推的過期日期不在裡面（#651 r4 #4）
    const n = Array.isArray(snap.subsRolled) ? snap.subsRolled.length : 0;
    const last = dateText(stamps.subsLastRolledAt, ref);
    push('更新訂閱', true, n ? `續費日推進了 ${n} 筆` : '續費日沒有需要推進的', n || !last ? null : `上次推進 ${last}`);
  }

  // aligned＝這次帳戶名真的對齊了幾筆交易（說明與隱藏的 autoNote 修正不算，那些在 changed 裡）
  const a = res.accounts;
  if (!a?.ok) push('帳戶對齊', false, problemText(a));
  else {
    const n = Number(a.value?.aligned) || 0;
    const last = dateText(stamps.accountNamesLastAlignedAt, ref);
    push('帳戶對齊', true, n ? `更新了 ${n} 筆交易的帳戶名` : '所有帳戶名都已是最新', n || !last ? null : `上次對齊 ${last}`);
  }

  const st = res.storeNames;
  const o = st?.ok ? (st.value || {}) : null;
  const lastStore = dateText(stamps.storeNamesLastNormalizedAt, ref);
  if (!o) push('店名整理', false, problemText(st));
  else if (o.outcome === 'unchanged') {
    // forced＝使用者剛在確認視窗按了確定、伺服器卻說這版已經套用過（例如別的分頁先套用了）
    push('店名整理', true, o.forced ? '店名規則已經是最新的（不整理）' : '店名規則沒變（不整理）', lastStore ? `上次整理 ${lastStore}` : null);
  }
  else if (o.outcome === 'applied') {
    // bits 空＝已知的幾個計數都是 0，但不能據此說「沒有整理」（計數不一定涵蓋每一種改動，#651 r4 #5）
    const bits = Array.isArray(o.bits) ? o.bits : [];
    push('店名整理', true, bits.length ? `店名規則有更新，整理了 ${bits.join('、')}` : '店名規則有更新，已套用');
  }
  else if (o.outcome === 'declined') push('店名整理', true, '店名規則有更新，你選了先不套用（下次開 App 會再問你）');
  else if (o.outcome === 'blocked') push('店名整理', false, '店名規則這次沒有套用（確認過了仍被擋下），資料沒有變動');
  else push('店名整理', false, '店名規則這次沒有套用（伺服器回了一個目前看不懂的狀況），資料沒有變動');

  // 洞察不在開機這一串裡：總覽等 bootSettled 之後抓一次，結果由 createBootStatusWatcher 傳進來
  if (insights.state === 'pending') rows.push({ label: '更新洞察', level: 'pending', text: '更新中…' });
  else if (insights.state === 'ok') {
    const t = whenText(insights.at, ref);
    push('更新洞察', true, t ? `${t} 已更新` : '已更新');
  }
  else push('更新洞察', false, problemText({ ok: false, error: insights.error }));

  const day = ref ? `${ref.getFullYear()}-${pad2(ref.getMonth() + 1)}-${pad2(ref.getDate())}` : '';
  return { title: day ? `開 App 自動更新檢查（${day}）` : '開 App 自動更新檢查', rows };
}

/**
 * 總覽抓 /insights 的回應 → 狀態。成功＝伺服器存完書籤回的 seenAt（insights.js）；路由的 catch 回 200 但帶 error、沒有 seenAt＝沒成功。
 * @param {any} ins fetchInsightsOnce 的結果（網路錯誤時是 { error: true }）
 * @returns {InsightsStatus}
 */
export function insightsStatusOf(ins) {
  return ins && typeof ins.seenAt === 'string' && !('error' in ins) ? { state: 'ok', at: ins.seenAt } : { state: 'fail', error: ins?.error };
}

const MARKS = { ok: '✓', warn: '⚠️', pending: '…' };

/**
 * 那一塊的 HTML（開頭那句與結尾那句逐字照 #653 留言 5905965930）。report 還沒到＝「檢查中…」。
 * @param {BootReport|null} report
 * @param {InsightsStatus|undefined} insights
 * @param {(s: string) => string} esc 轉義（dashboard.js 傳 app.js 的 esc）
 * @returns {string}
 */
export function bootStatusHtml(report, insights, esc) {
  if (!report) return `<div class="boot-status-title">開 App 自動更新檢查</div><p class="muted boot-status-intro">檢查中…</p>`;
  const { title, rows } = bootStatusView(report, insights);
  return `<div class="boot-status-title">${esc(title)}</div>
    <p class="boot-status-intro">每次打開 App 會自動做這幾件事：</p>
    <ul class="boot-status-list">${rows.map((r) => `<li class="${r.level}"><span class="boot-status-mark">${MARKS[r.level]}</span><span class="boot-status-label">${esc(r.label)}</span><span class="boot-status-text">${esc(r.text)}${r.note ? `<small>${esc(r.note)}</small>` : ''}</span></li>`).join('')}</ul>
    <p class="muted boot-status-foot">標 ⚠️ 的是這次沒有檢查成功的項目。</p>`;
}

/**
 * 等開機落定、再等洞察，每次有新結果就叫 onChange（總覽拿去重畫那一塊）。start() 多叫幾次也只掛一次。
 * 洞察那一行有自己的等待上限：逾時先標 ⚠️，之後真的回來了就改成實際結果；上限只管這一行，不改 fetchInsights 本身。
 * @param {{ settled: Promise<BootReport>, fetchInsights: () => Promise<any>, timeoutMs: number, onChange: () => void }} deps
 */
export function createBootStatusWatcher({ settled, fetchInsights, timeoutMs, onChange }) {
  /** @type {{ report: BootReport|null, insights: InsightsStatus }} */
  const state = { report: null, insights: { state: 'pending' } };
  let started = false;
  return {
    state,
    start() {
      if (started) return;
      started = true;
      settled.then((r) => {
        state.report = r;
        onChange();
        const p = fetchInsights();
        withTimeout(p, timeoutMs).catch((e) => {
          if (state.insights.state === 'pending') { state.insights = { state: 'fail', error: e }; onChange(); }
        });
        p.then((ins) => { state.insights = insightsStatusOf(ins); onChange(); },
          (e) => { state.insights = { state: 'fail', error: e }; onChange(); });
      });
    },
  };
}
