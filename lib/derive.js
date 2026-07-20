// @ts-check
// 從原始資料推導出「總覽」需要的數字與提醒。
// 這裡是整個網頁的大腦：把各模組的資料整合成你對財務的掌握。
/** @typedef {import('./types.js').Db} Db */
/** @typedef {import('./types.js').Subscription} Subscription */
/** @typedef {import('./types.js').Holding} Holding */
/** @typedef {import('./types.js').Reminder} Reminder */

const LIABILITY_TYPES = new Set(['loan', 'liability', 'mortgage', 'creditcard']);

// ETF 成分穿透（近似權重）——與 public/modules/portfolio.js 的 COMPOSITION 同步維護
/** @type {Record<string, { type: 'equity'|'bond'|'gold', regions: Record<string, number> }>} */
const COMPOSITION = {
  CSPX:   { type: 'equity', regions: { 美國: 1 } },
  QQQM:   { type: 'equity', regions: { 美國: 1 } },
  VUAA:   { type: 'equity', regions: { 美國: 1 } },
  SPY:    { type: 'equity', regions: { 美國: 1 } },
  VOO:    { type: 'equity', regions: { 美國: 1 } },
  GOOGL:  { type: 'equity', regions: { 美國: 1 } },
  GOOG:   { type: 'equity', regions: { 美國: 1 } },
  AAPL:   { type: 'equity', regions: { 美國: 1 } },
  TSLA:   { type: 'equity', regions: { 美國: 1 } },
  SPACEX: { type: 'equity', regions: { 美國: 1 } },
  EIMI:   { type: 'equity', regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 } },
  XUSE:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  EXUS:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  ICHN:   { type: 'equity', regions: { 中國: 1 } },
  KWEB:   { type: 'equity', regions: { 中國: 1 } },
  CSKR:   { type: 'equity', regions: { 韓國: 1 } },
  SJPA:   { type: 'equity', regions: { 日本: 1 } },
  '0050':   { type: 'equity', regions: { 台灣: 1 } },
  '006208': { type: 'equity', regions: { 台灣: 1 } },
  SMH:      { type: 'equity', regions: { 美國: 1 } },
  SPCX:     { type: 'equity', regions: { 美國: 1 } },
  SGLD:     { type: 'gold', regions: {} },
  GLD:      { type: 'gold', regions: {} },
  IAU:      { type: 'gold', regions: {} },
  '00719B': { type: 'bond', regions: {} },
  '00720B': { type: 'bond', regions: {} }
};
/** ETF/持股 → 成分（型別、區域穿透）。未知代號 fallback 到 layer。 @param {Holding} h */
const compOf = (h) => COMPOSITION[(h.symbol || '').toUpperCase()]
  || { type: h.layer === 'bond' ? 'bond' : h.layer === 'gold' ? 'gold' : 'equity', regions: { 其他: 1 } };

// 解析 YYYY-MM-DD 為「本地時區」的 Date：new Date('YYYY-MM-DD') 會被當 UTC，在 UTC 以西時區差一天。
/** @param {Date|string|number} d @returns {Date} */
function parseLocalDate(d) {
  if (d instanceof Date) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
}

/** 月份鍵 YYYY-MM。日期字串直接取前 7 碼、免受時區影響。 @param {Date|string=} d @returns {string} */
export function monthKey(d = new Date()) {
  if (typeof d === 'string') { const m = /^(\d{4})-(\d{2})/.exec(d); if (m) return `${m[1]}-${m[2]}`; }
  const dt = parseLocalDate(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/** 距今幾天（負數＝已過期）；無日期回 Infinity。 @param {string=} dateStr @returns {number} */
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = parseLocalDate(dateStr); target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function formatDateWithWeekday(dateStr) {
  const d = parseLocalDate(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr || '';
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${dateStr} (${weekdays[d.getDay()]})`;
}

// 距離「每月某日」還有幾天（用於信用卡繳款日）
/** @param {number|string=} day @returns {number} */
function daysUntilDayOfMonth(day) {
  const dd = Number(day);
  if (!dd || dd < 1 || dd > 31) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();   // 該月最後一天（m 可溢位，Date 自動進位年份）
  const clamped = (y, m) => new Date(y, m, Math.min(dd, lastDay(y, m)));   // 繳款日 31 在小月＝月底（銀行慣例）
  let target = clamped(today.getFullYear(), today.getMonth());
  if (target < today) target = clamped(today.getFullYear(), today.getMonth() + 1);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// 把訂閱換算成「每月平均」成本
/** @param {Subscription} sub @returns {number} */
function monthlyCost(sub) {
  const amt = Number(sub.amount || 0);
  if (sub.cycle === 'lifetime') return 0;
  if (sub.cycle === 'yearly') return amt / 12;
  if (sub.cycle === 'semiannual') return amt / 6;
  if (sub.cycle === 'quarterly') return amt / 3;
  return amt;
}

// 訂閱是否仍在使用（active 或 ending）——與前端 subscriptions.js subStatus 同口徑（同步點）。
// 停用日已過（daysUntil ≤ 0）或明確停用＝不算；用於總覽「每月固定訂閱」項數，避免與訂閱頁打架。
/** @param {Subscription} sub @returns {boolean} */
function subActive(sub) {
  if (sub.status === 'ended' || sub.active === false) return false;
  if (sub.status === 'ending' || sub.endsOn) return daysUntil(sub.endsOn) > 0;
  return true;
}

// 某訂閱在指定月份實際應計入的攤提（與前端 subscriptions.js costForMonth 同口徑）：
// 停用當月的月繳不計、季/年繳按停用日天數比例。（同步點：兩處邏輯須一致）
/** @param {Subscription} sub @param {string} mk 月份 YYYY-MM @returns {number} */
export function subCostForMonth(sub, mk) {   // export 供 Q4 攤提直測（自主體檢）
  if (sub.cycle === 'lifetime') return 0;
  if (sub.since && mk < sub.since) return 0;
  const base = monthlyCost(sub);
  const endsOn = sub.endsOn || '';
  if (!endsOn) return (sub.active === false || sub.status === 'ended') ? 0 : base;
  const endMk = endsOn.slice(0, 7);
  if (endMk < mk) return 0;
  if (sub.cycle === 'monthly') return endMk === mk ? 0 : base;
  if (endMk === mk) {
    // 停用當月按天數比例：分母用**該月實際天數**（自主體檢，使用者定 2026-07-22）——
    // 舊寫死 30 天讓 2/28 滿月停用被算成 28/30≈93%（該月都在用卻打折）。同步點：subscriptions.js costForMonth／公式文案。
    const [ey, em] = mk.split('-').map(Number);
    const dim = new Date(ey, em, 0).getDate();
    return base * Math.min(Number(endsOn.slice(8, 10)) || dim, dim) / dim;
  }
  return base;
}

// 匯率表（兌台幣）。usdTwd 為主匯率，其他幣別在 settings.fxTwd
/** @param {Db} db @returns {Record<string, number>} */
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
/** @param {Holding} h @returns {number} */
function holdingCost(h) {
  if (h.avgCost != null && h.avgCost !== '') return Number(h.avgCost) * Number(h.quantity || 0);
  return Number(h.cost || 0);
}

/** @param {Db} db */
export function computeAssets(db) {
  const rates = fxRates(db);
  let assets = 0, liabilities = 0;
  /** @type {Record<string, number>} */
  const byClass = Object.create(null);   // 資產類別是使用者文字：class='toString' 時普通物件的 || 0 撈到原型函式、金額變字串（Codex r6#3）
  // 帳戶（現金/黃金等，各幣別換算台幣）
  for (const a of db.accounts || []) {
    const fx = rates[a.currency || 'TWD'] || 1;
    const bal = Number(a.balance || 0) * fx;
    if (LIABILITY_TYPES.has(a.type || '') || bal < 0) {
      liabilities += Math.abs(bal);
    } else {
      assets += bal;
      const cls = a.class || a.type || '其他';
      byClass[cls] = (byClass[cls] || 0) + bal;
    }
  }
  // 投資組合持股自動併入，避免手動重複記帳。
  // 股/債/金分類走 COMPOSITION（compOf，與投組頁同口徑）；未知代號 compOf 內部才 fallback 到 layer。
  for (const h of db.holdings || []) {
    const fx = rates[h.currency || 'TWD'] || 1;   // 缺 currency 預設台幣（與帳戶端一致），避免台股被當美元灌 32 倍
    const v = Number(h.price || 0) * Number(h.quantity || 0) * fx;
    const type = compOf(h).type;
    const cls = type === 'bond' ? '債券' : type === 'gold' ? '黃金' : '股票';
    byClass[cls] = (byClass[cls] || 0) + v;
    assets += v;
  }
  return { assets, liabilities, netWorth: assets - liabilities, byClass };
}

/** @param {Db} db @param {string=} mk @returns {{month:string, income:number, expense:number, net:number}} */
function computeCashflow(db, mk = monthKey()) {
  let income = 0, expense = 0;
  for (const t of db.transactions || []) {
    if (!t.date) continue;                    // 沒日期的交易不歸入任何月份（否則 monthKey() 會誤算進當月）
    if (monthKey(t.date) !== mk) continue;
    if (t.type === 'income') income += Number(t.amount || 0);
    else if (t.type === 'expense') expense += Number(t.amount || 0);   // 只算明確支出，轉帳等其他型別不計入
  }
  return { month: mk, income, expense, net: income - expense };
}

// 過去幾個月的平均支出（給緊急預備金計算用）
/** @param {Db} db @param {number=} months @returns {number} */
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
    // 與總覽「本月固定訂閱」同口徑（subCostForMonth：已停用/停用當月月繳/超期都計 0），避免把已停用訂閱算進緊急預備金
    const nowMk = monthKey();
    const subs = (db.subscriptions || []).reduce((s, x) => s + subCostForMonth(x, nowMk), 0);
    return Math.max(computeCashflow(db).expense, subs);
  }
  return total / counted;
}

/** @param {Db} db @returns {Reminder[]} */
function computeReminders(db) {
  /** @type {Reminder[]} */
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
  const cash = (byClass['現金'] || 0) + (byClass['cash'] || 0);   // 兩種 class key 都要算（帳戶 class 是自由文字，未填時退回 type='cash'）
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
    if (!subActive(sub)) continue;   // 與訂閱頁/項數同口徑：status:'ended' 或停用日已過都不提醒
    if (sub.cycle === 'lifetime') continue;
    const endDays = daysUntil(sub.endsOn);
    if (endDays >= 0 && endDays <= 7) {
      out.push({ level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內停用`,
        detail: `「停用日」為 ${formatDateWithWeekday(sub.endsOn)}` });
    }

    // 即將停用的訂閱不會再續費（停用時 nextCharge 被設成＝endsOn），跳過續費提醒避免重複
    const chargeDays = daysUntil(sub.nextCharge);
    if (chargeDays >= 0 && chargeDays <= 7 && sub.status !== 'ending' && !sub.endsOn) {
      out.push({ level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內續費`,
        detail: `「續費日」為 ${formatDateWithWeekday(sub.nextCharge)}` });
    } else if (chargeDays < 0 && chargeDays >= -30 && sub.status !== 'ending' && !sub.endsOn && sub.nextCharge) {
      // 續費日已過、nextCharge 未更新（自主體檢）：多半已扣款但日期沒推——提醒使用者更新到下一期
      out.push({ level: 'warn', module: '訂閱',
        title: `「${sub.name}」續費日已過 ${-chargeDays} 天`,
        detail: `原續費日 ${formatDateWithWeekday(sub.nextCharge)}。多半已自動扣款，請到訂閱頁把「下次續費日」更新到下一期。` });
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

  // 5) 保險：繳費將至（30 天內）＋**已過期未更新**（自主體檢，使用者定 2026-07-22）：
  // nextPayment 是手動欄位、系統不會自動往後推，繳費日一過提醒就無聲消失——最需要提醒的「漏繳」反而零訊號。
  // 加負天數視窗（過期 60 天內）出 danger，逾 60 天不再洗（多半是忘了更新的舊資料）。
  for (const p of db.insurance || []) {
    const d = daysUntil(p.nextPayment);
    if (d >= 0 && d <= 30) {
      out.push({ level: d <= 7 ? 'warn' : 'info', module: '保險',
        title: `${p.policyName} ${d === 0 ? '今天' : d + ' 天後'}繳費`,
        detail: `保費 ${fmt(p.premium)} / ${cycleLabel(p.premiumCycle)}，被保險人 ${p.insured || '—'}` });
    } else if (d < 0 && d >= -60) {
      out.push({ level: 'danger', module: '保險',
        title: `${p.policyName} 繳費日已過 ${-d} 天`,
        detail: `原繳費日 ${formatDateWithWeekday(p.nextPayment)}。若已繳，請到保險頁把「下次繳費日」更新到下一期；若漏繳請盡快處理。` });
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
    /** @type {Record<string, number>} */
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

  // 7) IB 融資槓桿（computeLeverage 單一真相；上限任何時期一體適用——生存優先原則）
  const ratesLev = fxRates(db);
  const { leverage: lev, loan, mcDist, maintPct } = computeLeverage(db, ib);
  if (loan > 0 && !Number.isFinite(lev)) {
    // 淨值 ≤ 0（借款超過總市值）：比斷頭更慘的狀態，不能讓標題印出「Infinityx」（自主體檢）
    out.push({ level: 'danger', module: '投資', title: 'IB 淨值已為負（借款已超過持股市值）',
      detail: '帳戶可能已被強制平倉或即將被強平。請立即登入 IBKR 確認狀態。' });
  } else if (loan > 0 && lev > 1) {
    const levCap = Number(s.levCapPct || 1.3);
    if (lev >= 1.1) {
      const inc = db.settings?.ib?.income;
      const intTxt = inc && inc.interestPaid ? `近一年融資利息 ${fmt(Math.abs(inc.interestPaid) * ratesLev.USD)}。` : '';
      out.push({ level: mcDist < 40 ? 'danger' : lev > levCap ? 'warn' : 'info', module: '投資',
        title: lev > levCap
          ? `IB 融資槓桿 ${lev.toFixed(2)}x（超過上限 ${levCap}x，停借新錢）`
          : `IB 融資槓桿 ${lev.toFixed(2)}x（借款 ${fmt(loan)}）`,
        detail: (lev > levCap
          ? `依投資原則（上限任何時期適用，訊號期加碼只用新資金）：新資金優先償還融資，直到回到 ${levCap}x 內。`
          : '使用融資中：波動會被放大。')
          + `斷頭距離約 ${mcDist.toFixed(0)}%（市場再跌這麼多會觸及 IB 強平線，維持率 ${maintPct}%）。` + intTxt });
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

/** @param {Db} db */
function computeAllocation(db) {
  const { byClass, assets } = computeAssets(db);
  /** @type {Record<string, number>} */
  const targets = Object.create(null);   // 同 byClass：目標類別名是使用者文字（Codex r6#3 掃蕩同型）
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
/** @param {Db} db */
export function computeIb(db) {
  const rates = fxRates(db);
  const positions = (db.holdings || []).map(h => {
    const fx = rates[h.currency || 'TWD'] || 1;   // 缺 currency 預設台幣（與帳戶端一致），避免台股被當美元灌 32 倍
    const marketValue = Number(h.price || 0) * Number(h.quantity || 0) * fx;
    const costBasis = holdingCost(h) * fx;
    return { ...h, marketValue, costBasis, unrealizedPnl: marketValue - costBasis, weight: 0, pnlPct: 0 };
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

// IB 融資槓桿與斷頭距離（單一真相）：優先用 IB 官方淨值摘要 settings.ib.lastEquity
// （同步時更新、基準幣別 USD），沒有才自算（source:'ib' 持倉 ÷ 淨值、融資＝ibCashCur 負餘額）。
// 提醒規則 7 與 buildSummary 都用它；與前端 public/modules/portfolio.js 為同步點（AGENTS.md）。
/** @param {Db} db @param {ReturnType<typeof computeIb>} ib */
export function computeLeverage(db, ib) {
  const s = db.settings || {};
  const rates = fxRates(db);
  const eqIb = s.ib?.lastEquity;
  let ibValue, negCash;
  // 官方淨值摘要：持股>0、**或**現金為負（欠款）就採用（Codex r10#1）——原本只看 stock>0，
  // 全部持股遭平倉後只剩欠款（stock=0, cash<0）會被判成「沒有官方資料」退回本機自算，
  // 而本機帳戶此時多半也清空 → 融資訊號整個消失、淨值歸負卻不警告（最壞情境反而無感）。
  if (eqIb && (Number(eqIb.stock) > 0 || Number(eqIb.cash) < 0)) {
    ibValue = Number(eqIb.stock) * rates.USD;
    negCash = Math.min(Number(eqIb.cash) || 0, 0) * rates.USD;
  } else {
    ibValue = (ib.positions || []).filter(p => p.source === 'ib').reduce((sum, p) => sum + p.marketValue, 0);
    negCash = (db.accounts || []).filter(a => a.ibCashCur).reduce((sum, a) => {
      const v = Number(a.balance || 0) * (rates[a.currency || 'TWD'] || 1);
      return v < 0 ? sum + v : sum;
    }, 0);
  }
  const hasLoan = negCash < 0;   // 有欠款就成立（Codex r10#1）——不再要求 ibValue>0，否則持股歸零只剩欠款時判不出融資
  const net = ibValue + negCash;
  const leverage = hasLoan ? (net > 0 ? ibValue / net : Infinity) : 1;
  const maintPct = Number(s.ibMaintenancePct ?? 25);
  const mcDist = (hasLoan && ibValue > 0)
    ? Math.max(0, 1 - (-negCash) / ((1 - maintPct / 100) * ibValue)) * 100 : 100;
  return { leverage, loan: -negCash, ibValue, mcDist, maintPct, hasLoan };
}

/** @param {Db} db 從 data/store.json 載入的整個資料庫 */
export function buildSummary(db) {
  const assets = computeAssets(db);
  const cashflow = computeCashflow(db);
  const reminders = computeReminders(db);
  const allocation = computeAllocation(db);
  const ib = computeIb(db);
  const lev = computeLeverage(db, ib);
  // 本月固定訂閱：與訂閱頁同口徑（停用當月的月繳不計），避免總覽與訂閱頁數字打架
  const nowMk = monthKey();
  const subsMonthly = (db.subscriptions || []).reduce((s, x) => s + subCostForMonth(x, nowMk), 0);
  return {
    netWorth: assets.netWorth, assets: assets.assets, liabilities: assets.liabilities,
    byClass: assets.byClass, cashflow, reminders, allocation,
    // computeIb 已換算為台幣；leverage 為 IB 融資槓桿（無融資時為 1）
    // leverage=Infinity（淨值≤0）經 res.json 會變 null、前端 Number(null)=0 顯示成「0.00x」——
    // 最危險的狀態被畫成幾乎無槓桿（自主體檢）。序列化前轉明確訊號：equityWiped 旗標＋null。
    ib: { totalValue: ib.totalValue, totalPnl: ib.totalPnl, count: ib.positions.length,
      leverage: Number.isFinite(lev.leverage) ? lev.leverage : null,
      equityWiped: lev.hasLoan && !Number.isFinite(lev.leverage),
      loan: lev.loan, mcDist: lev.mcDist, hasLoan: lev.hasLoan },
    subscriptions: { monthly: subsMonthly, yearly: subsMonthly * 12,
      count: (db.subscriptions || []).filter(subActive).length },
    insuranceCount: (db.insurance || []).length,
    snapshots: db.snapshots || []
  };
}

// 明細金額：整數 + 千分位 +「元」後綴（與前端 app.js money() 一致；負號用 U+2212）
function fmt(n) { const v = Number(n || 0); return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('en-US') + ' 元'; }
function cycleLabel(c) {
  return { monthly: '月', quarterly: '季', semiannual: '半年', yearly: '年', single: '躉繳' }[c] || c || '—';
}
