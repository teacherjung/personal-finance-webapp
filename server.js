// 本機伺服器：只在你的 Mac 上的 127.0.0.1 監聽，不對外開放。
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, uid, emptyDb } from './lib/store.js';
import { fetchFlex } from './lib/ib.js';
import { buildSummary, computeIb, monthKey, computeAssets } from './lib/derive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));
// 把 Chart.js 從 node_modules 對外提供（離線可用）
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules/chart.js/dist/chart.umd.js')));

const COLLECTIONS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance', 'cards', 'history',
  'holdings', 'watchlist', 'research'];
// 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET（不開放 POST/PUT/DELETE）
const READONLY_COLLECTIONS = ['portfolioSnapshots', 'ibTrades'];

// ---- 整份資料 ----
app.get('/api/db', (req, res) => res.json(load()));
app.get('/api/summary', (req, res) => res.json(buildSummary(load())));

app.get('/api/settings', (req, res) => res.json(load().settings));
app.put('/api/settings', (req, res) => {
  const db = load();
  db.settings = {
    ...db.settings, ...req.body,
    ib: { ...db.settings.ib, ...(req.body.ib || {}) },
    fxTwd: { ...db.settings.fxTwd, ...(req.body.fxTwd || {}) }
  };
  save(db);
  res.json(db.settings);
});

// ---- 通用 CRUD ----
for (const col of COLLECTIONS) {
  app.get(`/api/${col}`, (req, res) => res.json(load()[col] || []));
  app.post(`/api/${col}`, (req, res) => {
    const db = load();
    const item = { id: uid(), ...req.body };
    (db[col] ||= []).push(item);
    save(db);
    res.json(item);
  });
  app.put(`/api/${col}/:id`, (req, res) => {
    const db = load();
    const list = db[col] || [];
    const i = list.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'not found' });
    list[i] = { ...list[i], ...req.body, id: req.params.id };
    save(db);
    res.json(list[i]);
  });
  app.delete(`/api/${col}/:id`, (req, res) => {
    const db = load();
    db[col] = (db[col] || []).filter(x => x.id !== req.params.id);
    save(db);
    res.json({ ok: true });
  });
}
for (const col of READONLY_COLLECTIONS) {
  app.get(`/api/${col}`, (req, res) => res.json(load()[col] || []));
}

// ---- 每月淨資產快照（隨時間變化的主軸）----
app.post('/api/snapshot', (req, res) => {
  const db = load();
  const a = computeAssets(db);
  const mk = monthKey();
  const snap = { month: mk, date: new Date().toISOString().slice(0, 10),
    netWorth: a.netWorth, assets: a.assets, liabilities: a.liabilities, byClass: a.byClass };
  db.snapshots = (db.snapshots || []).filter(s => s.month !== mk);
  db.snapshots.push(snap);
  db.snapshots.sort((x, y) => x.month.localeCompare(y.month));
  // 同時記錄投資組合的「投入 vs 市值」快照（重用 computeIb，避免重複算 FX/成本）
  const ib = computeIb(db);
  db.portfolioSnapshots = (db.portfolioSnapshots || []).filter(s => s.month !== mk);
  db.portfolioSnapshots.push({ month: mk, cost: Math.round(ib.totalCost), value: Math.round(ib.totalValue) });
  db.portfolioSnapshots.sort((x, y) => x.month.localeCompare(y.month));
  save(db);
  res.json(snap);
});

// ---- 市場報價（Yahoo Finance，唯讀，10 分鐘快取）----
const quoteCache = new Map();
async function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
app.get('/api/quotes', async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  const out = {};
  for (const sym of syms) {
    const c = quoteCache.get(sym);
    if (c && Date.now() - c.t < 10 * 60 * 1000) { out[sym] = c; continue; }
    try {
      const r = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice != null) {
        let price = meta.regularMarketPrice, currency = meta.currency || '';
        // 倫敦交易所英鎊線以「便士」報價（GBp/GBX）：÷100 轉成英鎊
        if (currency === 'GBp' || currency === 'GBX') { price = price / 100; currency = 'GBP'; }
        const q = { t: Date.now(), price, currency };
        quoteCache.set(sym, q);
        out[sym] = q;
      } else out[sym] = null;
    } catch { out[sym] = null; }
  }
  res.json(out);
});

// ---- Shiller PE（CAPE），multpl.com，12 小時快取；失敗時退回手動值 ----
let capeCache = null;
app.get('/api/cape', async (req, res) => {
  if (capeCache && Date.now() - capeCache.t < 12 * 3600 * 1000) return res.json(capeCache);
  try {
    const r = await fetchWithTimeout('https://www.multpl.com/shiller-pe', 8000);
    const html = await r.text();
    const m = html.match(/id="current"[\s\S]{0,300}?(\d+\.\d+)/);
    if (m) { capeCache = { t: Date.now(), value: Number(m[1]), source: 'multpl.com' }; return res.json(capeCache); }
    throw new Error('parse failed');
  } catch {
    const manual = load().settings?.capeManual;
    res.json({ t: Date.now(), value: manual ? Number(manual) : null, source: 'manual' });
  }
});

// ---- 美 10 年期實質利率（FRED DFII10，免金鑰 CSV），12 小時快取；失敗退回手動值 ----
// 用於估值訊號的 ECY＝1/CAPE − 實質利率
let realYieldCache = null;
app.get('/api/realyield', async (req, res) => {
  if (realYieldCache && Date.now() - realYieldCache.t < 12 * 3600 * 1000) return res.json(realYieldCache);
  try {
    const r = await fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10', 8000);
    const lines = (await r.text()).trim().split('\n');
    for (let i = lines.length - 1; i > 0; i--) {   // 由後往前找最後一筆有值的（假日為空）
      const [date, v] = lines[i].split(',');
      if (v && v.trim() && v.trim() !== '.' && isFinite(Number(v))) {
        realYieldCache = { t: Date.now(), value: Number(v), date, source: 'FRED DFII10' };
        return res.json(realYieldCache);
      }
    }
    throw new Error('parse failed');
  } catch {
    const manual = load().settings?.signals?.realYieldManual;
    res.json({ t: Date.now(), value: (manual != null && manual !== '') ? Number(manual) : null, source: 'manual' });
  }
});

// ---- IBKR Flex Query 同步：持倉合併進 holdings、現金更新到帳戶 ----
// 新代號的預設分層（找不到就歸「區域衛星」，之後可在編輯裡改）
const DEFAULT_LAYER = {
  CSPX: 'core', QQQM: 'core', VUAA: 'core', SPY: 'core', VOO: 'core',
  EIMI: 'satellite', XUSE: 'satellite', EXUS: 'satellite', ICHN: 'satellite',
  KWEB: 'satellite', CSKR: 'satellite', SJPA: 'satellite', SMH: 'satellite',
  GOOGL: 'stock', GOOG: 'stock', AAPL: 'stock',
  TSLA: 'stock', SPCX: 'stock',
  SGLD: 'gold', GLD: 'gold', IAU: 'gold'
};
app.post('/api/ib/sync', async (req, res) => {
  const db = load();
  const { flexToken, flexQueryId } = db.settings.ib || {};
  try {
    const data = await fetchFlex(flexToken, flexQueryId);
    db.holdings = db.holdings || [];
    const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;   // 金額統一到小數點後兩位
    let updated = 0, created = 0;
    for (const p of data.positions) {
      const sym = String(p.symbol || '').toUpperCase().trim();
      if (!sym) continue;
      const h = db.holdings.find(x => String(x.symbol || '').toUpperCase() === sym);
      if (h) {
        h.quantity = p.quantity;
        if (p.marketPrice) h.price = r2(p.marketPrice);
        if (p.avgCost) h.avgCost = r2(p.avgCost);
        if (p.currency) h.currency = p.currency;
        h.source = 'ib';
        updated++;
      } else {
        db.holdings.push({
          id: uid(), symbol: sym, name: p.description || sym,
          layer: DEFAULT_LAYER[sym] || 'satellite',
          currency: p.currency || 'USD',
          quantity: p.quantity, price: r2(p.marketPrice), avgCost: r2(p.avgCost),
          quoteSymbol: '', source: 'ib'
        });
        created++;
      }
    }
    // 各幣別現金 → 更新（或建立）帶 ibCashCur 標記的現金帳戶
    for (const [cur, cash] of Object.entries(data.cashByCurrency || {})) {
      if (!isFinite(cash)) continue;
      let acc = (db.accounts || []).find(a => a.ibCashCur === cur);
      if (!acc) {
        acc = { id: uid(), name: `IBKR ${cur} 現金`, type: 'cash', class: '現金', currency: cur, ibCashCur: cur, balance: 0 };
        (db.accounts = db.accounts || []).push(acc);
      }
      acc.balance = r2(cash);
      acc.currency = cur;
    }
    // 曾由 IB 同步、但這次報表已找不到的持股 → 可能已出清，回報給前端確認
    const seen = new Set(data.positions.map(p => String(p.symbol || '').toUpperCase().trim()));
    const missing = db.holdings
      .filter(h => h.source === 'ib' && !seen.has(String(h.symbol || '').toUpperCase()))
      .map(h => ({ id: h.id, symbol: h.symbol }));
    // 缺席的區塊要「清空」而不是留舊值：看得見的退化（fallback/卡片消失）勝過
    // 默默拿過期的官方淨值算槓桿與斷頭距離。必要的 Flex 區塊清單見設定頁說明。
    db.settings.ib.lastEquity = data.equity || null;   // { cash(負=融資), stock, date }；無 NAV 區塊時槓桿退回自算
    db.settings.ib.income = data.income ? {
      dividends: r2(data.income.dividends), paymentInLieu: r2(data.income.paymentInLieu),
      withholdingTax: r2(data.income.withholdingTax), interestPaid: r2(data.income.interestPaid),
      interestReceived: r2(data.income.interestReceived), other: r2(data.income.other),
      count: data.income.count, skippedNoFx: data.income.skippedNoFx || 0,
      from: data.period?.from || '', to: data.period?.to || ''
    } : null;
    db.ibTrades = Array.isArray(data.trades) ? data.trades : [];   // 交易摘要與 XIRR 已實現損益修正使用中
    db.settings.ib.lastSync = new Date().toISOString();
    save(db);
    res.json({ ok: true, updated, created, missing, cash: data.cashByCurrency, equity: data.equity, account: data.account });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- 匯出 / 匯入備份 ----
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="finance-backup-${monthKey()}.json"`);
  res.json(load());
});
app.post('/api/import', (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.settings || typeof b.settings !== 'object') {
    return res.status(400).json({ error: '匯入檔格式不正確（需為含 settings 的備份 JSON）' });
  }
  // 合併到乾淨底稿：缺少的集合補空陣列、缺少的設定補預設，避免壞檔讓之後 load/derive 出錯
  const base = emptyDb();
  const merged = {
    ...base, ...b,
    settings: {
      ...base.settings, ...b.settings,
      fxTwd: { ...base.settings.fxTwd, ...(b.settings.fxTwd || {}) },
      ib: { ...base.settings.ib, ...(b.settings.ib || {}) }
    }
  };
  save(merged);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  個人理財網頁已啟動 ✅`);
  console.log(`  請在瀏覽器打開： http://localhost:${PORT}\n`);
  console.log(`  資料只存在本機 data/store.json，按 Ctrl+C 可關閉。\n`);
});
