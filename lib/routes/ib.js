// @ts-check
// IBKR 同步路由（B2）：邏輯在 lib/services/ib-sync.js，這裡只做 HTTP 轉接。
import { Router } from 'express';
import { syncIb } from '../services/ib-sync.js';

export const ibRoutes = Router();

ibRoutes.post('/api/ib/sync', async (req, res, next) => {
  try {
    res.json(await syncIb());
  } catch (e) {
    // 同步失敗多為使用者可理解的情境（token 未設/IBKR 回錯）→ 400＋原味訊息；
    // 但若是內部錯誤（無 message 的怪東西）也一樣走這裡回 400 就會誤標——交給全域中介留紀錄（Codex#10-6）
    const err = /** @type {any} */ (e);
    if (err && err.message) return res.status(400).json({ ok: false, error: String(err.message) });
    next(err);
  }
});
