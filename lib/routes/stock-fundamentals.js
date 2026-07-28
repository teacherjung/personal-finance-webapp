// @ts-check
// 個股官方基本面 API 薄殼：GET 只讀快取；POST refresh 才向 SEC 發請求。

import { Router } from 'express';
import {
  getStockFundamentals,
  refreshStockFundamentals
} from '../services/stock-fundamentals.js';
import { wrapRoute } from './route-helpers.js';

export const stockFundamentalsRoutes = Router();

stockFundamentalsRoutes.get('/api/stock-fundamentals/:symbol', wrapRoute(async (req, res) => {
  res.json(await getStockFundamentals(req.params.symbol));
}));

stockFundamentalsRoutes.post('/api/stock-fundamentals/:symbol/refresh', wrapRoute(async (req, res) => {
  res.json(await refreshStockFundamentals(req.params.symbol));
}));
