// @ts-check
// 市場資料路由（B2）：Yahoo 報價、Shiller PE（CAPE）、美 10 年期實質利率（FRED）。
// 皆為唯讀外部資料＋記憶體快取；失敗退回設定頁的手動值。
import { Router } from 'express';
import { getSettings } from '../repo.js';

export const marketRoutes = Router();

async function fetchWithTimeout(/** @type {string} */ url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ---- 市場報價（Yahoo Finance，唯讀，10 分鐘快取）----
const quoteCache = new Map();
marketRoutes.get('/api/quotes', async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  /** @type {Record<string, any>} */
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
marketRoutes.get('/api/cape', async (req, res) => {
  if (capeCache && Date.now() - capeCache.t < 12 * 3600 * 1000) return res.json(capeCache);
  try {
    const r = await fetchWithTimeout('https://www.multpl.com/shiller-pe', 8000);
    const html = await r.text();
    const m = html.match(/id="current"[\s\S]{0,300}?(\d+\.\d+)/);
    if (m) { capeCache = { t: Date.now(), value: Number(m[1]), source: 'multpl.com' }; return res.json(capeCache); }
    throw new Error('parse failed');
  } catch {
    const manual = getSettings()?.capeManual;
    res.json({ t: Date.now(), value: manual ? Number(manual) : null, source: 'manual' });
  }
});

// ---- 美 10 年期實質利率（FRED DFII10，免金鑰 CSV），12 小時快取；失敗退回手動值 ----
// 用於估值訊號的 ECY＝1/CAPE − 實質利率
let realYieldCache = null;
marketRoutes.get('/api/realyield', async (req, res) => {
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
    const manual = getSettings()?.signals?.realYieldManual;
    res.json({ t: Date.now(), value: (manual != null && manual !== '') ? Number(manual) : null, source: 'manual' });
  }
});
