// 本機伺服器：只在你的 Mac 上的 127.0.0.1 監聽，不對外開放。
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, uid, emptyDb } from './lib/store.js';
import { fetchFlex } from './lib/ib.js';
import { parseStatement } from './lib/statement.js';
import { buildSummary, computeIb, monthKey, computeAssets } from './lib/derive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '15mb' }));   // 上傳帳單 PDF 以 base64 走 JSON，需要較大上限
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
    // 現金流缺 IBKR 匯率時，用設定匯率估算為 USD 基準（與交易摘要同口徑，AGENTS.md 優先序）
    const fxToBase = (cur) => {
      const c = String(cur || 'USD').toUpperCase();
      if (c === 'USD') return 1;
      const usdTwd = Number(db.settings.usdTwd || 32);
      const curTwd = c === 'TWD' ? 1 : Number(db.settings.fxTwd?.[c] || 0);
      return (curTwd > 0 && usdTwd > 0) ? curTwd / usdTwd : null;
    };
    const data = await fetchFlex(flexToken, flexQueryId, fxToBase);
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
      estimatedNoFx: data.income.estimatedNoFx || 0, estimatedCurrencies: data.income.estimatedCurrencies || [],
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

// ---- 信用卡帳單匯入（PDF 解密→解析→分類；密碼取自卡片 pdfPassword，PDF 不落地保存）----
// 重複偵測：每筆算 stmtRef（卡id+消費日+金額+說明），與既有記帳比對標記 duplicate。
function stmtDupFlag(db, cardId, txs) {
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  return txs.map(t => {
    const stmtRef = `${cardId}|${t.date}|${t.amount}|${t.desc}`;
    return { ...t, stmtRef, duplicate: existing.has(stmtRef) };
  });
}
const issuerMatchesBank = (issuer, bank) => String(issuer || '').includes(bank);

// 自動預覽：不必先選卡。系統試各卡密碼解密→判銀行＋末四碼→自動歸卡；認不出才回候選讓使用者選。
app.post('/api/statement/preview', async (req, res) => {
  try {
    const db = load();
    const b64 = String(req.body.data || '');
    if (!b64) return res.status(400).json({ error: '沒有收到檔案內容' });
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const cards = (db.cards || []).filter(c => (c.type || 'credit') === 'credit');
    // 逐一試密碼：空字串（未加密/XLSX）＋各卡去重後的 pdfPassword（多為同組身分證字號）
    const pwList = ['', ...new Set(cards.map(c => c.pdfPassword).filter(Boolean))];
    let parsed = null, lastErr = null;
    for (const pw of pwList) {
      try { parsed = await parseStatement(bytes, pw); break; }
      catch (e) {
        lastErr = e;
        if (!/密碼|加密|Password/i.test(String(e.message || ''))) break;   // 非密碼錯誤（格式/無明細）直接回報
      }
    }
    if (!parsed) return res.status(400).json({ error: String(lastErr?.message || '解析失敗') });
    // 對卡：①末四碼唯一命中→自動；②該銀行只有一張卡→自動；③否則回候選（該銀行優先，無則全部信用卡）
    const bankCards = cards.filter(c => issuerMatchesBank(c.issuer, parsed.bank));
    let resolved = null, candidates = [];
    if (parsed.lastFour) {
      const hit = cards.filter(c => String(c.lastFour) === String(parsed.lastFour));
      if (hit.length === 1) resolved = hit[0];
      else if (hit.length > 1) candidates = hit;
    }
    if (!resolved && !candidates.length) {
      if (bankCards.length === 1) resolved = bankCards[0];
      else candidates = bankCards.length ? bankCards : cards;
    }
    const base = { bank: parsed.bank, lastFour: parsed.lastFour || null };
    if (resolved) {
      return res.json({ ...base, resolvedCard: { id: resolved.id, name: resolved.name, lastFour: resolved.lastFour || null },
        transactions: stmtDupFlag(db, resolved.id, parsed.transactions) });
    }
    res.json({ ...base, resolvedCard: null,
      candidates: candidates.map(c => ({ id: c.id, name: c.name, lastFour: c.lastFour || null })) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
// 指定卡片預覽（自動判斷失敗時使用者選卡、或預覽中改卡後重解析）：用該卡密碼解密、歸該卡。
app.post('/api/cards/:id/statement/preview', async (req, res) => {
  try {
    const db = load();
    const card = (db.cards || []).find(c => c.id === req.params.id);
    if (!card) return res.status(404).json({ error: '找不到卡片' });
    const b64 = String(req.body.data || '');
    if (!b64) return res.status(400).json({ error: '沒有收到檔案內容' });
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const parsed = await parseStatement(bytes, card.pdfPassword);
    res.json({ bank: parsed.bank, lastFour: parsed.lastFour || null,
      card: { id: card.id, name: card.name }, transactions: stmtDupFlag(db, card.id, parsed.transactions) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
// 匯入：把使用者確認過的列寫進記帳（再做一次重複防呆）
app.post('/api/cards/:id/statement/import', (req, res) => {
  const db = load();
  const card = (db.cards || []).find(c => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: '找不到卡片' });
  const rows = Array.isArray(req.body.transactions) ? req.body.transactions : [];
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  const batchId = uid();                       // 這次匯入的批次代號（供事後整批改卡片）
  const importedAt = new Date().toISOString();
  let imported = 0, skipped = 0;
  for (const r of rows) {
    const amount = Number(r.amount);
    if (!r.date || !(amount > 0) || !r.stmtRef) { skipped++; continue; }   // 負數（繳款/退款）不入帳
    if (existing.has(r.stmtRef)) { skipped++; continue; }
    (db.transactions ||= []).push({
      id: uid(), date: r.date, type: 'expense',
      category: String(r.category || '生活'), subcategory: String(r.subcategory || ''), amount,
      account: card.name, note: String(r.desc || ''),
      stmtRef: r.stmtRef, source: 'stmt', importBatch: batchId, importedAt
    });
    existing.add(r.stmtRef);
    imported++;
  }
  save(db);
  res.json({ ok: true, imported, skipped, batchId, cardId: card.id, cardName: card.name });
});

// ---- 匯入批次：事後「整批改卡片」（使用者選錯卡片時，一鍵把整批消費改到另一張卡）----
// 批次清單：把 source:'stmt' 的交易依 importBatch 聚合，回卡片名/日期範圍/筆數/金額。
app.get('/api/statement/batches', (req, res) => {
  const db = load();
  const groups = {};
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || !t.importBatch) continue;
    const g = groups[t.importBatch] || (groups[t.importBatch] = {
      batchId: t.importBatch, cardName: t.account || '', importedAt: t.importedAt || '',
      count: 0, amount: 0, minDate: t.date, maxDate: t.date
    });
    g.count++; g.amount += Number(t.amount) || 0;
    if (t.date < g.minDate) g.minDate = t.date;
    if (t.date > g.maxDate) g.maxDate = t.date;
  }
  const list = Object.values(groups).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  res.json(list);
});
// 整批改卡片：改 account＋重寫 stmtRef 的卡片前綴（cardId|date|amount|desc）；目標卡已有同筆則丟棄重複。
app.post('/api/statement/reassign', (req, res) => {
  const db = load();
  const batchId = String(req.body.batchId || '');
  const card = (db.cards || []).find(c => c.id === String(req.body.toCardId || ''));
  if (!batchId) return res.status(400).json({ error: '缺少批次代號' });
  if (!card) return res.status(404).json({ error: '找不到目標卡片' });
  const others = new Set((db.transactions || [])
    .filter(t => t.importBatch !== batchId).map(t => t.stmtRef).filter(Boolean));   // 目標卡既有 stmtRef（排除本批）
  let moved = 0, dropped = 0;
  const kept = [];
  for (const t of db.transactions || []) {
    if (t.importBatch !== batchId) { kept.push(t); continue; }
    const ref = String(t.stmtRef || '');
    const idx = ref.indexOf('|');
    const newRef = idx >= 0 ? card.id + ref.slice(idx) : ref;
    if (others.has(newRef)) { dropped++; continue; }   // 目標卡已有同筆消費 → 丟棄重複
    others.add(newRef);
    kept.push({ ...t, account: card.name, stmtRef: newRef });
    moved++;
  }
  db.transactions = kept;
  save(db);
  res.json({ ok: true, moved, dropped, cardName: card.name });
});
// 刪除整批：把某次匯入的所有消費從記帳移除（用於解析/分類不對時，整批砍掉重匯）。
app.post('/api/statement/batch/delete', (req, res) => {
  const db = load();
  const batchId = String(req.body.batchId || '');
  if (!batchId) return res.status(400).json({ error: '缺少批次代號' });
  const before = (db.transactions || []).length;
  db.transactions = (db.transactions || []).filter(t => t.importBatch !== batchId);
  const removed = before - db.transactions.length;
  save(db);
  res.json({ ok: true, removed });
});

// ---- 舊分類 → 新兩層分類 一次性轉換（冪等；save() 會自動備份 .bak）----
// 只改「已不存在於新分類」的舊標籤；飲食/交通/健康/娛樂/保險 本身就是新分類，原樣保留。
// 收入分類（薪資/投資/獎金/其他收入）不動。
const CATEGORY_MIGRATION = {
  '房貸': ['居住', '房貸'],
  '子女教育': ['養育', ''],
  '旅遊': ['娛樂', '旅遊'],
  '生活雜支': ['生活', '其他生活雜支'],
  '醫療': ['健康', '看診'],
  '身心': ['健康', ''],              // 舊「身心」大類更名為「健康」（子類原樣保留）
  '訂閱': ['生活', '其他生活雜支'],   // 舊訂閱看不出是影音/學習/工作，先歸生活雜項（使用者定）
  '稅務': ['生活', '所得稅'],
  '其他': ['其他', '未分類'],       // 舊「其他/其他支出」＝無法判斷 → 新的「其他」分類
  '其他支出': ['其他', '未分類']
};
app.post('/api/migrate/categories', (req, res) => {
  const db = load();
  let changed = 0;
  const byCat = {};
  for (const t of db.transactions || []) {
    const m = CATEGORY_MIGRATION[t.category];
    if (m) {
      byCat[t.category] = (byCat[t.category] || 0) + 1;
      t.category = m[0];
      if (m[1] && !t.subcategory) t.subcategory = m[1];
      changed++;
    }
  }
  save(db);
  res.json({ ok: true, changed, byOldCategory: byCat });
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
