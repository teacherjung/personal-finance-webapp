// @ts-check

/**
 * 銀行收支頁的月份摘要。呼叫端先用 isCardTx 排除信用卡帳本；
 * 這裡只負責維持收入／支出／內轉的既有加總口徑。
 * @param {any[]} transactions
 * @param {string} month
 */
export function cashflowMonthSummary(transactions, month) {
  const monthRows = (Array.isArray(transactions) ? transactions : [])
    .filter(t => t?.date?.slice(0, 7) === month);
  const income = monthRows
    .filter(t => t.type === 'income')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const expense = monthRows
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  return { monthRows, income, expense, net: income - expense };
}

/**
 * 把月份鍵轉成頁面標題；壞值不硬猜月份。
 * @param {string} month
 */
export function cashflowPeriodLabel(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  const monthNumber = Number(match?.[2]);
  if (!match || monthNumber < 1 || monthNumber > 12) return '所選月份';
  return `${match[1]} 年 ${monthNumber} 月`;
}

// ---- 上傳銀行對帳單：密碼欄的告知文案（依模式分流）----
//
// 為什麼要分兩句（#437 r2 審查者抓到的 main 既有問題）：預覽與套用都是把 PDF 與密碼
// POST 給 app 伺服器（cashflow.js openBankUpload）。LOCAL 那台伺服器就是使用者這台電腦，
// 「只在這台電腦」成立；HOSTED 卻是營運方的遠端伺服器——舊文案「不會上傳」在那裡是
// **反方向誤導**（與 backup-export.js 的匯出告知同族病：講錯方向比不講更糟）。
// 伺服器端對密碼的規矩：解析當下只在記憶體使用；**預設用完即丟，只有使用者勾「記住」才持久化**
//（P0.5，使用者 2026-08-11 拍板；完整規矩見收支契約「匯入密碼池」節）。#438 埋的「不會儲存」絆線在此兌現——
// 句子改講真話：勾「記住」才儲存（LOCAL 存這台電腦／HOSTED 加密存雲端）、不勾＝只用這一次。
export const BANK_PW_NOTICE_LOCAL = '對帳單密碼（只在這台電腦解密，不會傳上網路；勾選「記住」才會儲存在這台電腦，下次自動嘗試）';
export const BANK_PW_NOTICE_HOSTED = '對帳單密碼（會跟 PDF 一起上傳到雲端伺服器解密；勾選「記住」會加密儲存在雲端，下次自動嘗試）';
/** 「記住這組密碼」勾選的標籤（**預設不勾**＝使用者拍板；密碼窗文案單一住所＝本檔）。 */
export const REMEMBER_PW_LABEL = '記住這組密碼（下次匯入自動嘗試；可到設定頁清除）';

// 上傳窗的文案（William 2026-08-12 逐點裁示）：
// ①欄位名不寫死銀行（原文「對帳單 PDF（台新綜合對帳單）」已過期）
// ②**不提台新**——未來內建讀取能力不會只有一家，點名反而會再過期一次
// ③說明**預設收起來**（想知道的人自己點開）：真正的隱私把關在**同意窗**（每次送出前都問、講得完整），
//   這裡只是預告，不必占畫面
// ④內容照 William 的版本，但**糾正兩處與事實不符**：
//   ・送出去的**不是 PDF 檔本身**，是伺服器在記憶體裡抽出來的**文字**（原檔不出去、也不落地）
//   ・不是「有可能」自動送——**只有按下同意的那一次**才送，沒按就完全不送（他自己拍板的「每次都問」）
//     寫成「有可能傳給」會讓人以為系統可能背著他送，那比事實更嚴重、也對不起這條路的設計。
export const BANK_UPLOAD_FILE_LABEL = '對帳單 PDF';
export const BANK_UPLOAD_NOTICE = `<details>
  <summary>上傳前想先知道的事</summary>
  <p style="margin:8px 0 0">請選取銀行寄給你的對帳單 PDF。</p>
  <p style="margin:6px 0 0">如果內建程式認不出您的對帳單版面，將詢問您要不要交給 AI 幫忙判讀。（沒按同意不會送出至 AI 公司）</p>
</details>`;
// 送出鈕：這個窗按下去是「上傳並預覽」，不是存檔——寫「儲存」會讓人以為當場寫進帳本了。
export const BANK_UPLOAD_SUBMIT_LABEL = '上傳並預覽';

/**
 * 讀不到「現值參考日」時的擋下警語（整段 <p>，作者內容、呼叫端不 esc）。
 *
 * ⚠️ 為什麼住在這裡而不是就地寫在 `cashflow.js`（r5#2）：原本用形狀掃描守這段文案，
 * 但那種考題**守的是拼字、不是行為**——把接線寫成 `r["blocked"]`、或在前面插一段
 * 隱藏的合規分支，正則就抓不到，畫面上照樣可以要求使用者外送帳單截圖（Codex 實測示範）。
 * 搬到純函式＝**文案本身可以直接行為測試**，形狀題只剩「有沒有接上」這件小事。
 *
 * ⚠️ 誠實劃界：考題守的是「這段文案的內容」＋「cashflow.js 有接它」；
 * 有人**另外**硬插一段自己的警語 HTML，這兩題都看不到。
 */
export function bankBlockedWarningHtml() {
  return `<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--warn) 10%, transparent);border:1px solid color-mix(in srgb, var(--warn) 45%, transparent);font-size:13px;line-height:1.8">⚠️ <b>這份讀不到「現值參考日」</b>（帳單上那個「資料截至某日」的日期）——<b>整份已經被擋下來了</b>，不會寫進去任何東西（所以下面沒有確認鈕）。<br>這份請改用手動記帳。要回報的話，<b>不用傳帳單內容</b>——講「哪一家銀行、哪一種版面（例如綜合對帳單／金融卡明細）」就夠了。</p>`;
}

/**
 * 銀行預覽表格底下那句話（純文字，呼叫端自己包 HTML／esc）。
 *
 * ⚠️ **排掉的筆數在「一筆都不匯入」時最需要講**（r2#1）：原本那句只掛在「有東西可匯入」的分支上，
 * 整份只有外幣或只有重複時會落到「帳單裡沒有新交易」，使用者完全不知道那幾筆去哪了——
 * 而那正是**最容易誤以為程式讀漏了**的情況。收成單一實作＝兩個分支不可能再各說各話。
 *
 * ⚠️ **`blocked` 優先於一切**（r3#1）：讀不到「現值參考日」的帳單按下確認會**整份失敗**，
 * 這時候還說「以上 N 筆就是會匯入的全部內容」＝同一個畫面上兩句話互相打架
 * （上面的警語才剛說「什麼都不會寫進去」）。畫面說的必須跟實際會發生的一致。
 *
 * @param {{shown: number, duplicate?: number, foreign?: number, blocked?: boolean}} n
 *   shown＝按下確認真的會寫進去的筆數（已排除重複與外幣）
 */
export function bankPreviewFootnote({ shown, duplicate = 0, foreign = 0, blocked = false }) {
  if (blocked) {
    return shown > 0
      ? `上面這 ${shown} 筆都不會寫進去——這份缺「現值參考日」，整份會被擋下。`
      : '這份會被擋下，什麼都不會寫進去。';
  }
  const parts = [];
  if (duplicate > 0) parts.push(`${duplicate} 筆之前已匯入過、這次不會重複記`);
  if (foreign > 0) parts.push(`${foreign} 筆外幣明細不會匯入（尚無歷史匯率口徑，不計入台幣收支）`);
  if (shown > 0) return `以上 ${shown} 筆就是按下確認會匯入的全部內容${parts.length ? `；另有 ${parts.join('；另有 ')}` : ''}。`;
  if (parts.length) return `這份帳單沒有新交易要匯入：${parts.join('；')}。`;
  return '帳單裡沒有新交易。';
}

/**
 * 依 `GET /api/mode` 的回應挑句子。
 *
 * ⚠️ 保守預設的方向與 `exportNotice`（backup-export.js）**相反**，但守的是同一條原則
 * （cloud-security 契約「匯出前告知的模式分流」規則 3：問不到就往安全的方向錯）：
 * 那邊猜錯若是「以為不含機密」＝檔案被轉寄；這邊猜錯若是「以為沒上傳」＝使用者被
 * 這句話騙著把密碼送上雲——正是本次要修的病。反方向猜錯只是把本機使用者多嚇一跳。
 * 所以只有回應的**自有**欄位明確是 `hosted: false` 才講「這台電腦」，其他一律當雲端講
 * （`Object.hasOwn`＝鐵則 3.5：`Object.create({hosted:false})` 這種掛在原型鏈上的值
 * 不可以放行本機句——r1 阻擋②實測繼承屬性會騙出本機句）。
 * @param {{hosted?: unknown} | null | undefined} mode `GET /api/mode` 的回應（拿不到就傳 null）
 */
export const bankPasswordLabel = (mode) =>
  (mode && Object.hasOwn(mode, 'hosted') && mode.hosted === false ? BANK_PW_NOTICE_LOCAL : BANK_PW_NOTICE_HOSTED);

/**
 * 開上傳窗前的把關（零 app／DOM import、相依注入、行為題可直接執行——審查 r1 抓到
 * 挑句流程只躺在頁面模組裡就只考得到字面）：問一次模式（帶等待上限、問不到＝保守），
 * 並回報「等待期間路由變了沒」——晚回的視窗不可以開在別的頁面上。它呼叫的是注入的
 * 網路／計時／路由相依＝有副作用、不是純函式；開窗時序歸 runBankUpload、表單內容與
 * 上傳流程歸 cashflow.js，這裡都不管。
 * @param {{ fetchMode: () => Promise<any>,
 *           withTimeout: (work: Promise<any>, ms: number) => Promise<any>,
 *           timeoutMs: number, navSeq: () => number }} deps
 * @returns {Promise<{ label: string, stale: boolean }>}
 */
export async function bankUploadGate({ fetchMode, withTimeout, timeoutMs, navSeq }) {
  const seq = navSeq();
  let mode = null;
  try { mode = await withTimeout(fetchMode(), timeoutMs); }
  catch { /* 問不到／逾時＝保守：bankPasswordLabel(null) 回雲端那句 */ }
  return { label: bankPasswordLabel(mode), stale: navSeq() !== seq };
}

/**
 * 開上傳窗的**編排函式**（零 app／DOM import、相依全部注入，所以行為題可以直接執行它；
 * 它本身有副作用——動鎖、開視窗——不是純函式。審查 r2 抓到：busy／stale 只靠字面掃描＝
 * 「刪掉上鎖那行」「把作廢檢查搬到開窗後」都抓不到，所以連同時序一起收進來直接測。
 * 本函式只管**開窗前的時序**；表單內容與上傳流程仍歸 cashflow.js）。
 *
 * 順序是承重的，不可對調：
 * 1. busy 在 await **之前**檢查並上鎖（審查 r1 抓到：不鎖的話 await 窗口內連點開出兩條
 *    流程，晚回的那條重開視窗、把使用者已選的檔案洗掉）；已上鎖＝整段不做、**不碰鎖**
 *    （被擋下的那一下若順手解鎖，第三下就闖進來了——鎖的所有權屬於第一條流程）。
 *    ⚠️ 鎖是注入的讀寫對，**不掛在按鈕元素上**（審查 r3 抓到：月份／金流篩選會同路由
 *    重繪整頁、換掉按鈕元素，掛在元素上的鎖跟著蒸發，兩顆新舊按鈕可以同時各開一窗）。
 * 2. 把關（問模式）回來後**先看 stale 再開窗**——等待期間切了頁，這一窗不屬於眼前的
 *    畫面，一個窗都不准開。
 * 3. finally 解鎖——把關丟錯也要解，否則按鈕永久啞掉。
 * @param {{ busy: { get: () => boolean, set: (v: boolean) => void },
 *           gate: () => Promise<{ label: string, stale: boolean }>,
 *           openUploadForm: (label: string) => void,
 *           watchModal?: () => () => boolean }} deps
 * @returns {Promise<'busy' | 'stale' | 'opened'>} 走到哪一步（考題斷言用；呼叫端不需要）
 */
export async function runBankUpload({ busy, gate, openUploadForm, watchModal }) {
  if (busy.get()) return 'busy';
  busy.set(true);
  const modalOk = watchModal ? watchModal() : () => true;   // 問 /mode 之前先看一眼共用彈窗格（唯讀）
  try {
    const g = await gate();
    // 等待期間別人接管了 #modal-root（使用者關掉這個窗、改開別的窗）＝這一窗不可以蓋上去（r16）
    if (g.stale || !modalOk()) return 'stale';
    openUploadForm(g.label);
    return 'opened';
  } finally { busy.set(false); }
}

/**
 * 「等 modal-root 清空後開下一窗」的**切頁作廢版排程**（P0.5 r4：把散寫的 `if (!onPage())` 收成
 * 一個可注入、可測的 helper——散寫的守門①蓋不全每條路②形狀考題證明不了每條路都守）。
 * **兩處都核對路由序號**：排程當下（切頁後不排）＋ callback 執行當下（排完到執行前切頁也不開）。
 * `onPage()` 回 true＝還在同一頁；`schedule` 預設 setTimeout(…,0)（等 openForm 清空 modal-root），測試可注入。
 * @param {() => boolean} onPage @param {() => void} open @param {(fn: () => void) => void} [schedule]
 */
export function openWhenOnPage(onPage, open, schedule = (fn) => setTimeout(fn, 0)) {
  if (!onPage()) return;                       // 排程前先看：已切頁＝根本不排
  schedule(() => { if (onPage()) open(); });   // callback 執行時再看：排完到執行前切頁＝不開
}

/**
 * 信用卡上傳的開窗編排（P0.5 r1#5）：與銀行同款「連點鎖＋切頁作廢＋finally 解鎖」——審查者不接受
 * 「卡片線沒有 jsdom 題」當劃界，因為時序缺陷已可重現（載入 `/cards` 的 await 窗內連點＝兩條流程）。
 * 卡片線開窗前沒有模式把關（密碼窗才 lazy 問模式），所以這裡只顧「載卡片名單」那段 await 的時序。
 * 順序同 runBankUpload：①busy 在 await 前上鎖、被擋下不碰鎖 ②載完卡片先看 stale 再開窗
 *（等待期間切頁＝一個窗都不開）③finally 解鎖。鎖是注入的讀寫對、不掛按鈕元素（同 #438 r3 教訓）。
 * @param {{ busy: { get: () => boolean, set: (v: boolean) => void },
 *           navSeq: () => number,
 *           loadCards: () => Promise<any[]>,
 *           openUploadForm: (cards: any[]) => void,
 *           watchModal?: () => () => boolean }} deps
 * @returns {Promise<'busy' | 'stale' | 'nocards' | 'opened'>}
 */
export async function runCardUpload({ busy, navSeq, loadCards, openUploadForm, watchModal }) {
  if (busy.get()) return 'busy';
  busy.set(true);
  const seq = navSeq();
  const modalOk = watchModal ? watchModal() : () => true;   // 載卡片之前先看一眼共用彈窗格（唯讀）
  try {
    const cards = await loadCards();
    if (navSeq() !== seq) return 'stale';   // 載入卡片名單時切了頁＝這一窗不屬於眼前畫面
    if (!modalOk()) return 'stale';         // 等待期間別人接管了 #modal-root＝不可以蓋上去（r16）
    if (!cards.length) return 'nocards';       // 沒有信用卡＝呼叫端提示去新增（不開窗）
    openUploadForm(cards);
    return 'opened';
  } finally { busy.set(false); }
}
