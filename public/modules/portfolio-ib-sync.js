// @ts-check
// 投資頁 IBKR 同步的純回報層：把後端旗標翻成使用者訊息，不碰 API、DOM 或持股異動。

/**
 * @typedef {{ message: string, error: boolean }} SyncFeedback
 * @typedef {{
 *   updated?: number,
 *   created?: number,
 *   cash?: Record<string, number>,
 *   skippedCurrencies?: string[],
 *   cashReportMissing?: boolean,
 *   cashDetailMissing?: boolean,
 *   cashFromSummary?: boolean,
 *   cashCollapsed?: number,
 *   cashBaseUnsupported?: string,
 *   cashDetailIncomplete?: boolean,
 *   cashSummaryMissing?: boolean,
 *   cashZeroed?: number
 * }} IbSyncResult
 */

/**
 * @param {IbSyncResult} result
 * @param {(value: number, currency: string) => string} formatCurrency
 * @returns {SyncFeedback[]}
 */
export function ibSyncFeedback(result, formatCurrency) {
  const feedback = [];
  const cashText = result.cash && Object.keys(result.cash).length
    ? '；現金 ' + Object.entries(result.cash).map(([currency, value]) => formatCurrency(value, currency)).join('、')
    : '';

  feedback.push({
    message: `IBKR 同步完成：更新 ${result.updated} 檔、新增 ${result.created} 檔${cashText}`,
    error: false
  });

  if (result.skippedCurrencies?.length) {
    feedback.push({
      message: `注意：這些項目因幣別尚未支援而跳過：${result.skippedCurrencies.join('、')}`,
      error: true
    });
  }
  if (result.cashReportMissing) {
    feedback.push({
      message: '注意：這份報表沒有 Cash Report 區塊——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Flex Query 有勾 Cash Report。',
      error: true
    });
  }
  if (result.cashDetailMissing) {
    feedback.push({
      message: '注意：Cash Report 只有彙總列、且無法判定基準幣別——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 的 Flex Query 勾選 Account Information。',
      error: true
    });
  }
  if (result.cashFromSummary) {
    feedback.push({
      message: '說明：這份報表的現金只有彙總列——已用基準幣別總額入帳' + (result.cashCollapsed ? `（${result.cashCollapsed} 個其他幣別帳戶已併入彙總顯示）` : '') + '。',
      error: false
    });
  }
  if (result.cashBaseUnsupported) {
    feedback.push({
      message: `注意：報表現金只有彙總列、且基準幣別 ${result.cashBaseUnsupported} 尚未支援——IB 現金沿用上次的舊值（可能過期）。`,
      error: true
    });
  }
  if (result.cashDetailIncomplete) {
    feedback.push({
      message: '注意：部分幣別的現金金額讀不到——讀得到的已更新，讀不到的沿用舊值（不歸零）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。',
      error: true
    });
  }
  if (result.cashSummaryMissing) {
    feedback.push({
      message: '注意：報表現金只有彙總列、且彙總列沒有可用金額——IB 現金沿用上次的舊值（可能過期）。請到 IBKR 確認 Cash Report 有勾 Ending Cash。',
      error: true
    });
  }
  if (result.cashZeroed) {
    feedback.push({
      message: `提醒：${result.cashZeroed} 個 IB 現金帳戶這次報表已無該幣別，餘額已歸零（現金提領/轉走後的正常結果）。`,
      error: false
    });
  }

  return feedback;
}
