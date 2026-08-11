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
// 伺服器端兩種模式相同的部分：密碼只在記憶體用來解 PDF、不落檔（收支契約
//「帳戶完整帳號與餘額匯入」節），銀行對帳單密碼目前單次使用、不儲存。
// ⚠️ 日後若把銀行對帳單密碼改成可選儲存（docs/parser-generalization-plan.md §五 P0.5，
// 已拍板入計畫、尚未實作），「不會儲存」要跟著那支 PR 一起改——別讓這兩句變成下一個舊文案。
export const BANK_PW_NOTICE_LOCAL = '對帳單密碼（只在這台電腦解密，不會傳上網路；用完即丟、不會儲存）';
export const BANK_PW_NOTICE_HOSTED = '對帳單密碼（會跟 PDF 一起上傳到雲端伺服器解密；用完即丟、不會儲存）';

/**
 * 依 `GET /api/mode` 的回應挑句子。
 *
 * ⚠️ 保守預設的方向與 `exportNotice`（backup-export.js）**相反**，但守的是同一條原則
 * （cloud-security 契約「匯出前告知的模式分流」規則 3：問不到就往安全的方向錯）：
 * 那邊猜錯若是「以為不含機密」＝檔案被轉寄；這邊猜錯若是「以為沒上傳」＝使用者被
 * 這句話騙著把密碼送上雲——正是本次要修的病。反方向猜錯只是把本機使用者多嚇一跳。
 * 所以只有伺服器明確回 `hosted: false` 才講「這台電腦」，其他一律當雲端講。
 * @param {{hosted?: unknown} | null | undefined} mode `GET /api/mode` 的回應（拿不到就傳 null）
 */
export const bankPasswordLabel = (mode) => (mode && mode.hosted === false ? BANK_PW_NOTICE_LOCAL : BANK_PW_NOTICE_HOSTED);
