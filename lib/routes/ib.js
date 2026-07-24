// @ts-check
// IBKR 同步路由（B2）：邏輯在 lib/services/ib-sync.js，這裡只做 HTTP 轉接。
import { Router } from 'express';
import { syncIb } from '../services/ib-sync.js';
import { wrapRoute } from './route-helpers.js';   // 錯誤口徑歸戶（系統優化 U2）

export const ibRoutes = Router();

// 只認 status（Codex#11-2）：服務層已把「IB 連線/token 類使用者層錯誤」標上 400；其餘交全域中介留紀錄。
// 錯誤 body 沿用既有 { ok:false, error } 形狀（搬家不裝修）——由 wrapRoute 的 extra 參數承接。
ibRoutes.post('/api/ib/sync', wrapRoute(async (req, res) => res.json(await syncIb()), { ok: false }));
