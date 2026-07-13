// @ts-check
// IBKR 同步路由（B2）：邏輯在 lib/services/ib-sync.js，這裡只做 HTTP 轉接。
import { Router } from 'express';
import { syncIb } from '../services/ib-sync.js';

export const ibRoutes = Router();

ibRoutes.post('/api/ib/sync', async (req, res) => {
  try {
    res.json(await syncIb());
  } catch (e) {
    res.status(400).json({ ok: false, error: String(/** @type {any} */ (e).message || e) });
  }
});
