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

// ---- IBKR Flex Query 同步：持倉合併進 holdings、現金更新到帳戶 ----
app.get('/api/ib', (req, res) => res.json(computeIb(load())));
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
    let updated = 0, created = 0;
    for (const p of data.positions) {
      const sym = String(p.symbol || '').toUpperCase().trim();
      if (!sym) continue;
      const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;   // 統一到小數點後兩位
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
      acc.balance = Math.round(cash * 100) / 100;
      acc.currency = cur;
    }
    // 曾由 IB 同步、但這次報表已找不到的持股 → 可能已出清，回報給前端確認
    const seen = new Set(data.positions.map(p => String(p.symbol || '').toUpperCase().trim()));
    const missing = db.holdings
      .filter(h => h.source === 'ib' && !seen.has(String(h.symbol || '').toUpperCase()))
      .map(h => ({ id: h.id, symbol: h.symbol }));
    if (data.equity) db.settings.ib.lastEquity = data.equity;   // { cash(負=融資), stock, date }
    if (data.income) {
      const r2i = (x) => Math.round(Number(x || 0) * 100) / 100;
      db.settings.ib.income = {
        dividends: r2i(data.income.dividends), paymentInLieu: r2i(data.income.paymentInLieu),
        withholdingTax: r2i(data.income.withholdingTax), interestPaid: r2i(data.income.interestPaid),
        interestReceived: r2i(data.income.interestReceived), other: r2i(data.income.other),
        count: data.income.count, from: data.period?.from || '', to: data.period?.to || ''
      };
    }
    if (Array.isArray(data.trades) && data.trades.length) db.ibTrades = data.trades;   // 供之後 XIRR／已實現損益用
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
