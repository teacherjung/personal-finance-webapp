// Interactive Brokers Flex Query（唯讀報表服務）串接。
// 只會「讀取」你的持倉與現金，完全不涉及任何下單/轉帳權限。
//
// 設定方式（在 IB Client Portal 內）：
//   Performance & Reports → Flex Queries → 建立一個 "Activity Flex Query"
//   勾選 Open Positions 與 Cash Report，格式選 XML。
//   再到 Settings → 取得 Flex Web Service Token。
//   把 Token 與 Query ID 填到網頁的「IB 投資組合 → 設定」。
import { XMLParser } from 'fast-xml-parser';

const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

async function getText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'rxs-finance/0.1' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`IB 連線失敗 (HTTP ${res.status})`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('IB 連線逾時，請稍後再試');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 第一步：送出請求，拿到 reference code
async function sendRequest(token, queryId) {
  const xml = await getText(`${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  const j = parser.parse(xml);
  const r = j.FlexStatementResponse || {};
  if (r.Status !== 'Success') {
    throw new Error(`IB 拒絕請求：${r.ErrorMessage || r.ErrorCode || '未知錯誤（請檢查 Token 與 Query ID）'}`);
  }
  return { code: r.ReferenceCode, url: r.Url || `${BASE}/GetStatement` };
}

// 第二步：用 reference code 取回報表（可能需要重試，IB 在準備資料）
async function getStatement(token, code, url) {
  for (let i = 0; i < 15; i++) {   // 年度報表產生較慢，最多等 ~45 秒
    const xml = await getText(`${url}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(code)}&v=3`);
    const j = parser.parse(xml);
    // 還在產生中會回 FlexStatementResponse + Warn
    if (j.FlexStatementResponse) {
      const r = j.FlexStatementResponse;
      if (r.ErrorCode && r.ErrorCode !== '1019') {
        throw new Error(`IB 取得報表失敗：${r.ErrorMessage || r.ErrorCode}`);
      }
      await new Promise(s => setTimeout(s, 3000)); // 等 IB 準備好
      continue;
    }
    return j; // FlexQueryResponse
  }
  throw new Error('IB 報表準備逾時，請稍後再試');
}

function parseStatement(j) {
  const stmts = asArray(j?.FlexQueryResponse?.FlexStatements?.FlexStatement);
  const positions = [];
  const cashByCurrency = {};
  let account = '';

  for (const s of stmts) {
    account = s.accountId || account;
    // 持倉
    for (const p of asArray(s?.OpenPositions?.OpenPosition)) {
      const qty = Number(p.position || 0);
      if (!qty) continue;
      const costMoney = Number(p.costBasisMoney ?? (Number(p.costBasisPrice || 0) * qty));
      positions.push({
        symbol: p.symbol,
        description: p.description || '',
        currency: p.currency || '',
        quantity: qty,
        avgCost: Number(p.costBasisPrice || (qty ? costMoney / qty : 0)),  // 購買均價
        marketPrice: Number(p.markPrice || 0)
      });
    }
    // 現金（負值＝融資借款）。優先期末現金，沒勾該欄位就退回期初現金
    for (const c of asArray(s?.CashReport?.CashReportCurrency)) {
      const cur = (c.currency || '').toUpperCase();
      if (!cur || cur === 'BASE_SUMMARY') continue;   // BASE_SUMMARY 是彙總列，非實際幣別
      cashByCurrency[c.currency] = Number(c.endingCash ?? c.endingSettledCash ?? c.startingCash ?? 0);
    }
  }
  // 淨值摘要（基準幣別）：cash 負值＝融資、stock＝持股市值 → 算槓桿用
  let equity = null;
  for (const s of stmts) {
    const rows = asArray(s?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
    if (rows.length) {
      const e = rows[rows.length - 1];
      equity = { cash: Number(e.cash || 0), stock: Number(e.stock || 0), date: String(e.reportDate || '') };
    }
  }
  // 現金交易彙總（股息／替代股息／預扣稅／融資利息，基準幣別）＋ 成交紀錄
  let income = null;
  const trades = [];
  let period = null;
  for (const s of stmts) {
    if (s.fromDate) period = { from: String(s.fromDate), to: String(s.toDate || '') };
    const ct = asArray(s?.CashTransactions?.CashTransaction);
    if (ct.length) {
      income = income || { dividends: 0, paymentInLieu: 0, withholdingTax: 0, interestPaid: 0, interestReceived: 0, other: 0, count: 0 };
      for (const c of ct) {
        // 換算成基準幣別（USD）再加總，避免多幣別（如 GBP 股息）直接相加造成錯誤
        const amt = Number(c.amount || 0) * Number(c.fxRateToBase || 1);
        income.count++;
        const ty = String(c.type || '');
        if (ty === 'Dividends') income.dividends += amt;
        else if (ty === 'Payment In Lieu Of Dividends') income.paymentInLieu += amt;
        else if (ty === 'Withholding Tax') income.withholdingTax += amt;
        else if (ty === 'Broker Interest Paid') income.interestPaid += amt;
        else if (ty === 'Broker Interest Received') income.interestReceived += amt;
        else income.other += amt;
      }
    }
    for (const t of asArray(s?.Trades?.Trade)) {
      const currency = t.currency || 'USD';
      const fxRaw = t.fxRateToBase;
      const fxRateToBase = fxRaw == null || fxRaw === '' ? null : Number(fxRaw);
      const pnl = Number(t.fifoPnlRealized || 0);
      trades.push({
        symbol: t.symbol, date: String(t.tradeDate || ''), buySell: t.buySell,
        quantity: Number(t.quantity || 0), price: Number(t.tradePrice || 0),
        netCash: Number(t.netCash || 0), pnl,
        currency, fxRateToBase,
        pnlBase: Number.isFinite(fxRateToBase) ? pnl * fxRateToBase : (currency === 'USD' ? pnl : null)
      });
    }
  }
  return { account, positions, cashByCurrency, equity, income, trades, period };
}

export async function fetchFlex(token, queryId) {
  if (!token || !queryId) throw new Error('尚未設定 IB Flex Token 或 Query ID');
  const { code, url } = await sendRequest(token, queryId);
  const stmt = await getStatement(token, code, url);
  return parseStatement(stmt);
}
