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
 * 開上傳窗前的把關（可注入、可執行——r1 阻擋③：挑句流程要是行為題打得到的純函式，
 * cashflow.js 只剩接線）：問一次模式（帶等待上限、問不到＝保守），並回報「等待期間
 * 路由變了沒」——晚回的視窗不可以開在別的頁面上（r1 阻擋①的切頁那一半）。
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
