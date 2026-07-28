// @ts-check
// 投資頁 IBKR 同步的純回報層：把後端旗標翻成使用者訊息，不碰 API、DOM 或持股異動。

/**
 * @typedef {{ message: string, error: boolean }} SyncFeedback
 * @typedef {{
 *   updated?: number,
 *   created?: number,
 *   cash?: Record<string, number>,
 *   skippedCurrencies?: string[],
 *   skippedNoCurrency?: string[],
 *   incomeNoCurrency?: number,
 *   cashReportMissing?: boolean,
 *   cashDetailMissing?: boolean,
 *   cashFromSummary?: boolean,
 *   cashCollapsed?: number,
 *   cashBaseUnsupported?: string,
 *   cashDetailIncomplete?: boolean,
 *   cashSummaryMissing?: boolean,
 *   cashZeroed?: number,
 *   secTradesSkipped?: number,
 *   secSkippedReasons?: { badRow?: number, cancelOrUnknown?: number, missingAccount?: number, missingCurrency?: number, missingCore?: number, unsupportedCurrency?: number, unsupportedFeeCurrency?: number }
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
  // 缺幣別（2026-07-28）：與「幣別不支援」是**兩種病**，訊息必須分開講，使用者才修得到對的地方——
  // 前者是我們不支援那個幣別，後者是報表根本沒給幣別欄（去 Flex Query 勾一下就好）。
  if (result.skippedNoCurrency?.length) {
    feedback.push({
      message: `注意：這些新持股因為報表沒有幣別欄而沒有建立：${result.skippedNoCurrency.join('、')}。請到 IBKR 的 Flex Query 在 Open Positions 勾選 Currency 欄後重新同步（猜幣別會讓市值與淨資產算錯，所以寧可不建）。`,
      error: true
    });
  }
  if (result.incomeNoCurrency) {
    feedback.push({
      message: `注意：有 ${result.incomeNoCurrency} 筆股息／利息因為報表沒有幣別欄而未計入。請到 IBKR 的 Flex Query 在 Cash Transactions 勾選 Currency 欄後重新同步。`,
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
  // 證券交易集合的跳過回報（Codex S2r1#2：後端只寫 console＝使用者不知道查帳頁少了列；病因各自說對才修得對地方）
  if (result.secTradesSkipped) {
    const r = result.secSkippedReasons || {};
    const parts = [];
    if (r.cancelOrUnknown) parts.push(`取消/未知買賣別 ${r.cancelOrUnknown} 筆`);
    if (r.missingCurrency) parts.push(`缺幣別 ${r.missingCurrency} 筆（請在 Flex 的 Trades 勾 Currency——不會猜成 USD）`);
    if (r.missingCore) parts.push(`缺核心金額 ${r.missingCore} 筆（請勾 Trade Price／Trade Money／Net Cash）`);
    if (r.missingAccount) parts.push(`缺帳戶識別 ${r.missingAccount} 筆（請勾 Account ID）`);
    if (r.unsupportedCurrency) parts.push(`不支援幣別 ${r.unsupportedCurrency} 筆`);
    if (r.unsupportedFeeCurrency) parts.push(`不支援的手續費幣別 ${r.unsupportedFeeCurrency} 筆`);
    if (r.badRow) parts.push(`缺日期/代號/數量 ${r.badRow} 筆`);
    feedback.push({
      message: `注意：證券交易紀錄有 ${result.secTradesSkipped} 筆未納入查帳集合（${parts.join('；') || '原因不明'}）。投組持倉與淨值不受影響。`,
      error: true
    });
  }

  return feedback;
}
