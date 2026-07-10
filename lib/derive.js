// 從原始資料推導出「總覽」需要的數字與提醒。
// 這裡是整個網頁的大腦：把各模組的資料整合成你對財務的掌握。

const LIABILITY_TYPES = new Set(['loan', 'liability', 'mortgage', 'creditcard']);

// ETF 成分穿透（近似權重）——與 public/modules/portfolio.js 的 COMPOSITION 同步維護
const COMPOSITION = {
  CSPX:   { type: 'equity', regions: { 美國: 1 } },
  QQQM:   { type: 'equity', regions: { 美國: 1 } },
  GOOGL:  { type: 'equity', regions: { 美國: 1 } },
  AAPL:   { type: 'equity', regions: { 美國: 1 } },
  TSLA:   { type: 'equity', regions: { 美國: 1 } },
  SPACEX: { type: 'equity', regions: { 美國: 1 } },
  EIMI:   { type: 'equity', regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 } },
  XUSE:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  ICHN:   { type: 'equity', regions: { 中國: 1 } },
  KWEB:   { type: 'equity', regions: { 中國: 1 } },
  CSKR:   { type: 'equity', regions: { 韓國: 1 } },
  SJPA:   { type: 'equity', regions: { 日本: 1 } },
  '0050':   { type: 'equity', regions: { 台灣: 1 } },
  '006208': { type: 'equity', regions: { 台灣: 1 } },
  SMH:      { type: 'equity', regions: { 美國: 1 } },
  SPCX:     { type: 'equity', regions: { 美國: 1 } },
  SGLD:     { type: 'gold', regions: {} },
  '00719B': { type: 'bond', regions: {} },
  '00720B': { type: 'bond', regions: {} }
};
const compOf = (h) => COMPOSITION[(h.symbol || '').toUpperCase()]
  || { type: h.layer === 'bond' ? 'bond' : h.layer === 'gold' ? 'gold' : 'equity', regions: { 其他: 1 } };

export function monthKey(d = new Date()) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function formatDateWithWeekday(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr || '';
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${dateStr} (${weekdays[d.getDay()]})`;
}

// 距離「每月某日」還有幾天（用於信用卡繳款日）
function daysUntilDayOfMonth(day) {
  const dd = Number(day);
  if (!dd || dd < 1 || dd > 31) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let target = new Date(today.getFullYear(), today.getMonth(), dd);
  if (target < today) target = new Date(today.getFullYear(), today.getMonth() + 1, dd);
  return Math.round((target - today) / 86400000);
}

// 把訂閱換算成「每月平均」成本
function monthlyCost(sub) {
  const amt = Number(sub.amount || 0);
  if (sub.cycle === 'lifetime') return 0;
  if (sub.cycle === 'yearly') return amt / 12;
  if (sub.cycle === 'semiannual') return amt / 6;
  if (sub.cycle === 'quarterly') return amt / 3;
  return amt;
}

// 匯率表（兌台幣）。usdTwd 為主匯率，其他幣別在 settings.fxTwd
function fxRates(db) {
  const s = db.settings || {};
  return {
    TWD: 1,
    USD: Number(s.usdTwd || 32),
    GBP: Number(s.fxTwd?.GBP || 40.8),
    JPY: Number(s.fxTwd?.JPY || 0.215)
  };
}
// 持股成本：優先用「均價 × 股數」，沒有均價才退回舊的總成本欄位
function holdingCost(h) {
  if (h.avgCost != null && h.avgCost !== '') return Number(h.avgCost) * Number(h.quantity || 0);
  return Number(h.cost || 0);
}

export function computeAssets(db) {
  const rates = fxRates(db);
  let assets = 0, liabilities = 0;
  const byClass = {};
  // 帳戶（現金/黃金等，各幣別換算台幣）
  for (const a of db.accounts || []) {
    const fx = rates[a.currency || 'TWD'] || 1;
    const bal = Number(a.balance || 0) * fx;
    if (LIABILITY_TYPES.has(a.type) || bal < 0) {
      liabilities += Math.abs(bal);
    } else {
      assets += bal;
      const cls = a.class || a.type || '其他';
      byClass[cls] = (byClass[cls] || 0) + bal;
    }
  }
  // 投資組合持股自動併入（債券層→債券、黃金層→黃金，其餘→股票），避免手動重複記帳
  for (const h of db.holdings || []) {
    const fx = rates[h.currency || 'USD'] || rates.USD;
    const v = Number(h.price || 0) * Number(h.quantity || 0) * fx;
    const cls = h.layer === 'bond' ? '債券' : h.layer === 'gold' ? '黃金' : '股票';
    byClass[cls] = (byClass[cls] || 0) + v;
    assets += v;
  }
  return { assets, liabilities, netWorth: assets - liabilities, byClass };
}

function computeCashflow(db, mk = monthKey()) {
  let income = 0, expense = 0;
  for (const t of db.transactions || []) {
    if (monthKey(t.date) !== mk) continue;
    if (t.type === 'income') income += Number(t.amount || 0);
    else if (t.type === 'expense') expense += Number(t.amount || 0);   // 只算明確支出，轉帳等其他型別不計入
  }
  return { month: mk, income, expense, net: income - expense };
}

// 過去幾個月的平均支出（給緊急預備金計算用）
function avgMonthlyExpense(db, months = 3) {
  const now = new Date();
  const keys = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(monthKey(d));
  }
  let total = 0, counted = 0;
  for (const k of keys) {
    const cf = computeCashflow(db, k);
    // 有任何收支紀錄的月份才算（含真正零支出月）；完全沒資料的月份（開始記帳前）才略過
    if (cf.income > 0 || cf.expense > 0) { total += cf.expense; counted++; }
  }
  // 沒有歷史資料時，退而求其次用訂閱+本月支出估
  if (counted === 0) {
    const subs = (db.subscriptions || []).filter(s => s.active !== false)
      .reduce((s, x) => s + monthlyCost(x), 0);
    return Math.max(computeCashflow(db).expense, subs);
  }
  return total / counted;
}

function computeReminders(db) {
  const out = [];
  const s = db.settings || {};

  // 1) 現金流：本月淨現金流為負
  const cf = computeCashflow(db);
  if (cf.net < 0) {
    out.push({ level: 'warn', module: '收支', title: '本月現金流為負',
      detail: `本月支出比收入多 ${fmt(-cf.net)}，注意控制。` });
  }

  // 2) 緊急預備金不足
  const { byClass, netWorth } = computeAssets(db);
  const cash = byClass['現金'] || byClass['cash'] || 0;
  const avgExp = avgMonthlyExpense(db);
  if (avgExp > 0) {
    const months = cash / avgExp;
    const target = s.emergencyFundMonths || 6;
    if (months < target) {
      out.push({ level: months < target / 2 ? 'danger' : 'warn', module: '收支',
        title: '緊急預備金不足',
        detail: `目前現金約可支撐 ${months.toFixed(1)} 個月，低於目標 ${target} 個月。` });
    }
  }

  // 3) 資產配置偏離目標
  const drift = computeAllocation(db);
  for (const row of drift.rows) {
    if (Math.abs(row.diff) >= (s.allocationDriftPct || 5)) {
      out.push({ level: 'info', module: '資產配置',
        title: `${row.class} 偏離目標 ${row.diff > 0 ? '+' : ''}${row.diff.toFixed(1)}%`,
        detail: `實際 ${row.actualPct.toFixed(1)}% vs 目標 ${row.targetPct}%，可考慮再平衡。` });
    }
  }

  // 4) 訂閱：即將停用 / 續費（7 天內）
  for (const sub of db.subscriptions || []) {
    if (sub.active === false) continue;
    if (sub.cycle === 'lifetime') continue;
    const endDays = daysUntil(sub.endsOn);
    if (endDays >= 0 && endDays <= 7) {
      out.push({ level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內停用`,
        detail: `「停用日」為 ${formatDateWithWeekday(sub.endsOn)}` });
    }

    const chargeDays = daysUntil(sub.nextCharge);
    if (chargeDays >= 0 && chargeDays <= 7) {
      out.push({ level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內續費`,
        detail: `「續費日」為 ${formatDateWithWeekday(sub.nextCharge)}` });
    }
  }

  // 4b) 信用卡：繳款日將至（7 天內）
  for (const c of db.cards || []) {
    if ((c.type || 'credit') !== 'credit' || !c.dueDay) continue;
    const d = daysUntilDayOfMonth(c.dueDay);
    if (d <= 7) {
      out.push({ level: d <= 3 ? 'warn' : 'info', module: '卡片',
        title: `${c.name} ${d === 0 ? '今天' : d + ' 天後'}繳款`,
        detail: `每月 ${c.dueDay} 日為繳款日${c.statementDay ? `（結帳日 ${c.statementDay} 日）` : ''}。` });
    }
  }

  // 5) 保險：繳費將至（30 天內）
  for (const p of db.insurance || []) {
    const d = daysUntil(p.nextPayment);
    if (d >= 0 && d <= 30) {
      out.push({ level: d <= 7 ? 'warn' : 'info', module: '保險',
        title: `${p.policyName} ${d === 0 ? '今天' : d + ' 天後'}繳費`,
        detail: `保費 ${fmt(p.premium)} / ${cycleLabel(p.premiumCycle)}，被保險人 ${p.insured || '—'}` });
    }
    // 保單保障即將停用
    const de = daysUntil(p.endDate);
    if (de >= 0 && de <= 90) {
      out.push({ level: 'warn', module: '保險', title: `${p.policyName} 保障即將停用`,
        detail: `${p.endDate} 停用（約 ${de} 天後）。` });
    }
  }

  // 6) 投資原則 v1：口徑一律「% 淨資產」、區域穿透計算、軟上限（超標＝凍結加碼，不強制賣）
  const ib = computeIb(db);
  if (ib.totalValue > 0 && netWorth > 0) {
    const pctNw = (v) => v / netWorth * 100;
    // 6a) 單一個股 ≤ ibConcentrationPct（預設 5%）
    const stockCap = Number(s.ibConcentrationPct || 5);
    for (const p of ib.positions) {
      if (p.layer === 'stock' && pctNw(p.marketValue) > stockCap) {
        out.push({ level: 'warn', module: '投資',
          title: `${p.symbol} ${pctNw(p.marketValue).toFixed(1)}%（超過個股上限 ${stockCap}%，凍結加碼）`,
          detail: '佔淨資產比例超出單一個股上限（軟上限）：禁止加碼，讓部位自然稀釋。' });
      }
    }
    // 6b) 股票總曝險 ≤ equityCapPct（預設 90%，＝動態股債比 90:10 的天花板）
    const eqCap = Number(s.equityCapPct || 90);
    const eqTotal = ib.positions.filter(p => compOf(p).type === 'equity').reduce((t, p) => t + p.marketValue, 0);
    if (pctNw(eqTotal) > eqCap) {
      out.push({ level: 'warn', module: '投資',
        title: `股票總曝險 ${pctNw(eqTotal).toFixed(1)}%（超過上限 ${eqCap}%，凍結加碼）`,
        detail: '股票合計佔淨資產超出天花板（軟上限）：僅重壓訊號期才允許接近此上限。' });
    }
    // 6c) 各國曝險（穿透，美國與「其他」不設限）≤ countryCapPct（預設 15%）；中國可獨立設 chinaCapPct
    const cCap = Number(s.countryCapPct || 15);
    const capFor = (rg) => rg === '中國' ? Number(s.chinaCapPct ?? cCap) : cCap;
    const region = {};
    for (const p of ib.positions) {
      const c = compOf(p);
      if (c.type !== 'equity') continue;
      for (const [rg, w] of Object.entries(c.regions)) region[rg] = (region[rg] || 0) + p.marketValue * w;
    }
    for (const [rg, v] of Object.entries(region)) {
      if (rg === '美國' || rg === '其他') continue;
      if (pctNw(v) > capFor(rg)) {
        out.push({ level: 'warn', module: '投資',
          title: `${rg} ${pctNw(v).toFixed(1)}%（超過國家上限 ${capFor(rg)}%，凍結加碼）`,
          detail: `${rg}曝險（穿透含 ETF 成分）佔淨資產超出單一國家上限（軟上限）：禁止加碼。` });
      }
    }
  }

  // 7) IB 融資槓桿：優先用 IB 官方淨值摘要（settings.ib.lastEquity，同步時更新、基準幣別 USD），
  //    沒有同步資料才退回自算（source:'ib' 持倉 ÷ 淨值、融資＝ibCashCur 負餘額）。
  //    與 public/modules/portfolio.js 的槓桿計算為同步點（AGENTS.md）。
  const ratesLev = fxRates(db);
  const eqIb = s.ib?.lastEquity;
  let ibValLev, negCash;
  if (eqIb && Number(eqIb.stock) > 0) {
    ibValLev = Number(eqIb.stock) * ratesLev.USD;
    negCash = Math.min(Number(eqIb.cash) || 0, 0) * ratesLev.USD;
  } else {
    ibValLev = ib.positions.filter(p => p.source === 'ib').reduce((sum, p) => sum + p.marketValue, 0);
    negCash = (db.accounts || []).filter(a => a.ibCashCur).reduce((sum, a) => {
      const v = Number(a.balance || 0) * (ratesLev[a.currency || 'TWD'] || 1);
      return v < 0 ? sum + v : sum;
    }, 0);
  }
  if (negCash < 0 && ibValLev > 0) {
    const net = ibValLev + negCash;
    const lev = net > 0 ? ibValLev / net : Infinity;
    const levCap = Number(s.levCapPct || 1.3), levCapSig = Number(s.levCapSignalPct || 1.6);
    if (lev >= 1.1) {
      const inc = db.settings?.ib?.income;
      const intTxt = inc && inc.interestPaid ? `近一年融資利息 ${fmt(Math.abs(inc.interestPaid) * ratesLev.USD)}。` : '';
      out.push({ level: lev > levCapSig ? 'danger' : lev > levCap ? 'warn' : 'info', module: '投資',
        title: lev > levCap
          ? `IB 融資槓桿 ${lev.toFixed(2)}x（超過平時上限 ${levCap}x，停借新錢）`
          : `IB 融資槓桿 ${lev.toFixed(2)}x（借款 ${fmt(-negCash)}）`,
        detail: (lev > levCap
          ? `依投資原則：新資金優先償還融資，直到回到 ${levCap}x 內${lev > levCapSig ? `；已超過訊號期上限 ${levCapSig}x，留意維持保證金` : ''}。`
          : '使用融資中：波動會被放大。') + intTxt });
    }
  }

  // 7b) IB 閒置現金：正餘額（未投入）合計超過門檻 → 提醒安排投入
  const idleCap = Number(s.ibIdleCashAlert || 5000);
  const idleUsd = (db.accounts || []).filter(a => a.ibCashCur && Number(a.balance) > 0)
    .reduce((sum, a) => sum + Number(a.balance) * (ratesLev[a.currency || 'USD'] || 1), 0) / ratesLev.USD;
  if (idleCap > 0 && idleUsd >= idleCap) {
    out.push({ level: 'info', module: '投資',
      title: `IB 閒置現金約 ${Math.round(idleUsd).toLocaleString('en-US')} USD`,
      detail: `超過提醒門檻 ${idleCap.toLocaleString('en-US')} USD：閒置資金可依估值訊號與紀律安排投入。` });
  }

  // 8) 匯率：美元/台幣進入分批換匯區間
  const usdTwd = ratesLev.USD;   // 沿用規則 7 已算好的匯率表
  const fxHigh = Number(s.fxHigh || 32), fxLow = Number(s.fxLow || 28);
  if (usdTwd >= fxHigh) {
    out.push({ level: 'info', module: '匯率', title: `美元/台幣 ${usdTwd} 已達 ${fxHigh} 以上`,
      detail: '進入「美元→台幣」分批區：可考慮把部分美元分 2–3 批換回台幣，而非一次全換。' });
  } else if (usdTwd <= fxLow) {
    out.push({ level: 'info', module: '匯率', title: `美元/台幣 ${usdTwd} 已低於 ${fxLow}`,
      detail: '進入「台幣→美元」分批區：可考慮分批換美元，補足海外投資的銀彈。' });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}

function computeAllocation(db) {
  const { byClass, assets } = computeAssets(db);
  const targets = {};
  for (const t of db.assetTargets || []) targets[t.class] = Number(t.targetPct || 0);
  const classes = new Set([...Object.keys(byClass), ...Object.keys(targets)]);
  const rows = [];
  for (const c of classes) {
    const val = byClass[c] || 0;
    const actualPct = assets > 0 ? (val / assets) * 100 : 0;
    const targetPct = targets[c] || 0;
    rows.push({ class: c, value: val, actualPct, targetPct, diff: actualPct - targetPct });
  }
  rows.sort((a, b) => b.value - a.value);
  return { rows, total: assets };
}

// 投資組合：從 holdings（核心/債券/衛星/個股/投機）計算，各幣別換算成台幣
export function computeIb(db) {
  const rates = fxRates(db);
  const positions = (db.holdings || []).map(h => {
    const fx = rates[h.currency || 'USD'] || rates.USD;
    const marketValue = Number(h.price || 0) * Number(h.quantity || 0) * fx;
    const costBasis = holdingCost(h) * fx;
    return { ...h, marketValue, costBasis, unrealizedPnl: marketValue - costBasis };
  });
  const totalMv = positions.reduce((s, p) => s + p.marketValue, 0);
  for (const p of positions) {
    p.weight = totalMv > 0 ? (p.marketValue / totalMv) * 100 : 0;
    p.pnlPct = p.costBasis ? (p.unrealizedPnl / Math.abs(p.costBasis)) * 100 : 0;
  }
  positions.sort((a, b) => b.marketValue - a.marketValue);
  return {
    positions, totalValue: totalMv,
    totalCost: positions.reduce((s, p) => s + p.costBasis, 0),
    totalPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0)
  };
}

export function buildSummary(db) {
  const assets = computeAssets(db);
  const cashflow = computeCashflow(db);
  const reminders = computeReminders(db);
  const allocation = computeAllocation(db);
  const ib = computeIb(db);
  const subsMonthly = (db.subscriptions || []).filter(s => s.active !== false)
    .reduce((s, x) => s + monthlyCost(x), 0);
  return {
    netWorth: assets.netWorth, assets: assets.assets, liabilities: assets.liabilities,
    byClass: assets.byClass, cashflow, reminders, allocation,
    // computeIb 已換算為台幣
    ib: { totalValue: ib.totalValue, totalPnl: ib.totalPnl, count: ib.positions.length },
    subscriptions: { monthly: subsMonthly, yearly: subsMonthly * 12,
      count: (db.subscriptions || []).filter(s => s.active !== false).length },
    insuranceCount: (db.insurance || []).length,
    snapshots: db.snapshots || []
  };
}

// 明細金額：整數 + 千分位 +「元」後綴（與前端 app.js money() 一致；負號用 U+2212）
function fmt(n) { const v = Number(n || 0); return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('en-US') + ' 元'; }
function cycleLabel(c) {
  return { monthly: '月', quarterly: '季', semiannual: '半年', yearly: '年', single: '躉繳' }[c] || c || '—';
}
