// @ts-check
// 市場資料路由（B2）：Yahoo 報價、Shiller PE（CAPE）、美 10 年期實質利率（FRED）＋開 app 自動刷新報價（D1）。
// 抓取＋快取邏輯住在 lib/services/market-data.js（後端 auto 流程可自呼、不繞 HTTP）；這裡只做 HTTP 薄殼。
import { Router } from 'express';
import { getQuotes, getCape, getRealYield, refreshQuotesIfStale } from '../services/market-data.js';
import { getInsights } from '../services/insights.js';

export const marketRoutes = Router();

marketRoutes.get('/api/quotes', async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  res.json(await getQuotes(syms));
});

marketRoutes.get('/api/cape', async (req, res) => res.json(await getCape()));
marketRoutes.get('/api/realyield', async (req, res) => res.json(await getRealYield()));

// 開 app 自動刷新報價（D1）：報價 >1 小時舊才抓、更新持股報價＋匯率＋寫 quotesLastAt；抓失敗靜默用舊價、不擋開機。
marketRoutes.post('/api/quotes/refresh-auto', async (req, res) => {
  try { res.json(await refreshQuotesIfStale()); }
  catch (e) { res.json({ refreshed: false, updated: 0, reason: 'error', error: String(/** @type {any} */ (e)?.message || e) }); }
});

// r15 搬遷（#369）：/api/insights 是外連路由（CAPE/FRED）——歸外連檔，core.js 閉包才乾淨
// 每日洞察引擎（D3）：讀取＝視為「看過了」→ 更新書籤（有寫檔副作用，故只有總覽呼叫）。失敗靜默降級成平靜空殼
// （原則5：絕不擋開機、絕不跳錯誤打擾）。內部已對報價抓取失敗自處理（ecy=null）。
marketRoutes.get('/api/insights', async (req, res) => {
  try { res.json(await getInsights()); }
  catch (e) {
    res.json({ firstRun: true, calm: true, reminders: { new: [], cleared: [], ongoing: [], all: [] },
      tierChanges: [], sinceLast: null, windows: { today: null, week: null }, error: String(/** @type {any} */ (e)?.message || e) });
  }
});
