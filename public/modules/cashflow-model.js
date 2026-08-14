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
// ③說明**預設收起來**（想知道的人自己點開）：完整的說明在**設定頁的 AI 鑰匙卡**與同意窗
//   （後者只在 aiAskBeforeSend 打開時出現——2026-08-13 起預設不問、直接送），這裡只是預告，不必占畫面
// ④內容照 William 的版本，但**糾正兩處與事實不符**：
//   ・送出去的**不是 PDF 檔本身**，是伺服器在記憶體裡抽出來的**文字**（原檔不出去、也不落地）
//   ・送出的時機講清楚：**只有內建範本認不得版面時**才會送；預設直接送（2026-08-13 拍板，
//     設定頁的 aiAskBeforeSend 打開＝每次先問、按同意才送）。
export const BANK_UPLOAD_FILE_LABEL = '對帳單 PDF';
// 送出鈕：這個窗按下去是「上傳並預覽」，不是存檔——寫「儲存」會讓人以為當場寫進帳本了。
/** 預覽窗確認鈕的字。⚠️ **讀不到現值參考日時不可再寫「更新餘額」**（r1#3）：那次不會更新餘額，
 * 鈕上卻寫著要更新＝按下去做的事跟鈕上寫的不一樣。這是這條線一路在修的同一種病。
 * @param {boolean} balancesSkipped */
export function bankApplyLabel(balancesSkipped) {
  return balancesSkipped ? '確認：只匯入交易（這次不更新餘額）' : '確認：更新餘額＋匯入交易';
}

/** 套用完成後的提示。⚠️ **餘額沒更新一定要講**——沒說＝使用者以為餘額是新的（畫面說謊）。
 * @param {{updated:number, created:number, skipped?:number, unsupported?:number, balancesSkipped?:boolean}} bal
 * @param {{imported:number, skipped?:number, similarSkipped?:number, foreign?:number}} tx */
export function bankApplyDoneText(bal, tx) {
  const acct = bal.balancesSkipped
    ? '帳戶餘額：這次沒有更新（帳單讀不到「現值參考日」，不知道新舊就不敢覆蓋）'
    : `帳戶：更新 ${bal.updated}、新建 ${bal.created}`
      + `${bal.skipped ? `、跳過 ${bal.skipped}` : ''}${bal.unsupported ? `、略過 ${bal.unsupported} 個不支援幣別` : ''}`;
  return `${acct}；交易：匯入 ${tx.imported}`
    + `${tx.skipped ? `、略過重複 ${tx.skipped}` : ''}${tx.similarSkipped ? `、依勾選跳過疑似重複 ${tx.similarSkipped}` : ''}${tx.foreign ? `、外幣 ${tx.foreign} 筆不計入` : ''}`;
}

/** 「這次不匯入 N 筆疑似重複」勾選框（William 2026-08-14：同期匯過另一版面時 48/57 筆重複——
 * 全放行＝現金流多算一份、全擋掉＝剩下的也進不來）。預設勾＝往「不多算錢」那邊倒；
 * tooltip 誠實講啟發式的代價：真的同帳戶同日同額刷兩次會被一起跳過（可事後手動補記）。
 * n＝預覽數出來的疑似重複筆數；0＝不畫（沒東西可跳過就不給開關）。 @param {number} n */
export function bankSkipSimilarOptionHtml(n) {
  if (!n) return '';
  return `<label class="skip-similar-opt" title="「疑似重複」是啟發式判斷（同帳戶＋同日＋同金額＋同方向）——真的刷兩次同額的也會被跳過，可事後手動補記"><input type="checkbox" id="skipSimilarChk" checked> 這次不匯入 ${Number(n)} 筆「疑似重複」</label>`;
}

export const BANK_UPLOAD_SUBMIT_LABEL = '上傳並預覽';
/** 送出後鈕上的字。⚠️ 講「上傳」不講「讀取」：按下去的第一件事就是把檔案送到 app 伺服器，
 * 之後才輪到解析（認不得時可能再送 AI）——寫「讀取」會讓人以為已經在解析了。 */
export const BANK_UPLOAD_BUSY_LABEL = '正在上傳…請稍候';

/** 疑似重複的統計區警語（整段 <p>，作者內容）。`n`＝疑似重複的筆數。
 *
 * ⚠️ 住在這裡的理由同 `bankBlockedWarningHtml`：形狀掃描守不住「加個 hidden 就看不見」
 * 這種等價繞法（r1#3 審查者實測），文案與可見性都要能直接行為測試。
 * ⚠️ **一律顯示，不可依 `blocked` 壓掉**：`blocked` 只代表「這次不更新餘額」，交易**照樣會進帳本**
 * ——壓掉這段提醒等於讓跨版式的重複交易**無聲入帳**。
 * @param {number} n
 */
export function bankSimilarWarningHtml(n) {
  return `<p style="margin:0 0 10px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--warn) 10%, transparent);border:1px solid color-mix(in srgb, var(--warn) 45%, transparent);font-size:13px;line-height:1.8">⚠️ 有 <b>${n}</b> 筆的「同一個帳戶＋同一天＋同金額＋同方向」在你的資料裡<b>已經有一筆</b>了（下表標「疑似重複」）。<br>常見原因：<b>同一期間的帳單匯入了兩種版面</b>——兩份對同一筆交易的文字寫法不同，系統的防重複認不出來。真的是兩筆不同的交易也可能（同一家店刷兩次）。<br>不確定就先按「了解」關掉，到收支頁看看那幾天是不是已經有了。</p>`;
}

/** 疑似重複的逐列標記（同上，作者內容）。 */
export function bankSimilarTagHtml() {
  return `<span class="flow-tag neg" title="同帳戶同一天同金額同方向的交易，你的資料裡已經有一筆——可能是同期間的另一種版面重複匯入">疑似重複</span>`;
}

/**
 * 讀不到「現值參考日」時的提醒（2026-08-13 起**不再是「擋下」**：餘額不更新、交易照匯）（整段 <p>，作者內容、呼叫端不 esc）。
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
  return `<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--warn) 10%, transparent);border:1px solid color-mix(in srgb, var(--warn) 45%, transparent);font-size:13px;line-height:1.8">⚠️ <b>這份讀不到「現值參考日」</b>（帳單上那個「資料截至某日」的日期）——所以<b>這次不會更新帳戶餘額</b>，「資產配置」頁會維持原本的數字。<br><b>交易明細照樣匯入</b>：那些交易本來就用不到這個日期，只有「這份帳單的餘額比 app 裡的新嗎」才需要它。<br>要回報的話，<b>不用傳帳單內容</b>——講「哪一家銀行、哪一種版面（例如綜合對帳單／金融卡明細）」就夠了。</p>`;
}

/**
 * 銀行預覽表格底下那句話（純文字，呼叫端自己包 HTML／esc）。
 *
 * ⚠️ **排掉的筆數在「一筆都不匯入」時最需要講**（r2#1）：原本那句只掛在「有東西可匯入」的分支上，
 * 整份只有外幣或只有重複時會落到「帳單裡沒有新交易」，使用者完全不知道那幾筆去哪了——
 * 而那正是**最容易誤以為程式讀漏了**的情況。收成單一實作＝兩個分支不可能再各說各話。
 *
 * ⚠️ **本來有個 `blocked` 參數，2026-08-13 連參數一起拿掉**：它原本用來在「讀不到現值參考日」
 * 時改口成「什麼都不會寫進去」。行為改成「餘額不更新、交易照匯」之後那個改口就是錯的，
 * 而留著一個沒人用的參數只會讓下一個人以為它還有意義（沒用到就刪）。
 * 餘額那件事由 `bankBlockedWarningHtml` 那段警語負責講。
 *
 * @param {{shown:number, duplicate?:number, foreign?:number, similar?:number, skipSimilarChecked?:boolean}} n
 *   shown＝按下確認真的會寫進去的筆數（已排除重複與外幣）
 */
export function bankPreviewFootnote({ shown, duplicate = 0, foreign = 0, similar = 0, skipSimilarChecked = false }) {
  // ⚠️ 2026-08-13 起 `blocked` 只代表「**餘額**不更新」，交易照樣匯入——所以腳註不再改口，
  //    照常講「以上 N 筆會匯入」。餘額那件事由 `bankBlockedWarningHtml` 那段警語負責講。
  // ⚠️ #459 r4：「這次不匯入疑似重複」勾著時，「以上 N 筆＝按確認會匯入的全部」是**假話**
  //    （57 標示、實匯 9）——腳註必須跟著勾選狀態改口，勾選一動就重算這句（cashflow.js 接線）。
  const parts = [];
  if (duplicate > 0) parts.push(`${duplicate} 筆之前已匯入過、這次不會重複記`);
  if (foreign > 0) parts.push(`${foreign} 筆外幣明細不會匯入（尚無歷史匯率口徑，不計入台幣收支）`);
  if (shown > 0) {
    if (similar > 0 && skipSimilarChecked === true) {
      return `以上 ${shown} 筆中有 ${similar} 筆標「疑似重複」——照左下的勾選這次會跳過，`
        + `實際匯入 ${shown - similar} 筆${parts.length ? `；另有 ${parts.join('；另有 ')}` : ''}。`;
    }
    return `以上 ${shown} 筆就是按下確認會匯入的全部內容${parts.length ? `；另有 ${parts.join('；另有 ')}` : ''}。`;
  }
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
