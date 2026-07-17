// @ts-check
// IBKR 同步路由（B2）：邏輯在 lib/services/ib-sync.js，這裡只做 HTTP 轉接。
import { Router } from 'express';
import { syncIb } from '../services/ib-sync.js';

export const ibRoutes = Router();

ibRoutes.post('/api/ib/sync', async (req, res, next) => {
  try {
    res.json(await syncIb());
  } catch (e) {
    // 只認 status（Codex#11-2）：服務層已把「IB 連線/token 類使用者層錯誤」標上 400；
    // 其餘（資料庫/schema/程式內部錯誤幾乎都有 message，不能拿 message 當判準）交全域中介留紀錄
    const err = /** @type {any} */ (e);
    if (err && err.status) return res.status(err.status).json({ ok: false, error: String(err.message || err) });
    next(err);
  }
});
