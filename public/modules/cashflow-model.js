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
// 伺服器端對密碼的規矩（記憶體內解、不落檔）＝收支契約「帳戶完整帳號與餘額匯入」節；
// 「要不要開放儲存銀行密碼」的裁決落點＝#437 計畫的 P0.5——那支若把它改成可選儲存，
// 這兩句的「不會儲存」要跟著同一支 PR 改（test/cashflow-bank-upload.test.js 的絆線會逼著改）。
export const BANK_PW_NOTICE_LOCAL = '對帳單密碼（只在這台電腦解密，不會傳上網路；只用於這次預覽與匯入，不會儲存）';
export const BANK_PW_NOTICE_HOSTED = '對帳單密碼（會跟 PDF 一起上傳到雲端伺服器解密；只用於這次預覽與匯入，不會儲存）';

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
 *           timeoutMs: number, routeSeq: () => number }} deps
 * @returns {Promise<{ label: string, stale: boolean }>}
 */
export async function bankUploadGate({ fetchMode, withTimeout, timeoutMs, routeSeq }) {
  const seq = routeSeq();
  let mode = null;
  try { mode = await withTimeout(fetchMode(), timeoutMs); }
  catch { /* 問不到／逾時＝保守：bankPasswordLabel(null) 回雲端那句 */ }
  return { label: bankPasswordLabel(mode), stale: routeSeq() !== seq };
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
 *           openUploadForm: (label: string) => void }} deps
 * @returns {Promise<'busy' | 'stale' | 'opened'>} 走到哪一步（考題斷言用；呼叫端不需要）
 */
export async function runBankUpload({ busy, gate, openUploadForm }) {
  if (busy.get()) return 'busy';
  busy.set(true);
  try {
    const g = await gate();
    if (g.stale) return 'stale';
    openUploadForm(g.label);
    return 'opened';
  } finally { busy.set(false); }
}
