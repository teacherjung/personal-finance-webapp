// @ts-check
// 通用 CRUD 路由（B2）：所有集合的增查改刪，一律走 repo 櫃檯＋schema 欄位白名單。
import { Router } from 'express';
import { COLLECTIONS, READONLY_COLLECTIONS, pickWritable } from '../schema.js';
import { getCollection, addItem, updateItem, deleteItem } from '../repo.js';
import { learnFromStmtEdit } from '../services/learning.js';

export const crudRoutes = Router();

for (const col of COLLECTIONS) {
  crudRoutes.get(`/api/${col}`, (req, res) => res.json(getCollection(col)));
  crudRoutes.post(`/api/${col}`, (req, res) => res.json(addItem(col, pickWritable(col, req.body))));
  crudRoutes.put(`/api/${col}/:id`, (req, res) => {
    // 帳單交易改分類 → 自動學習（beforeSave：更新＋學習同一次寫檔）
    const item = updateItem(col, req.params.id, pickWritable(col, req.body), col === 'transactions' ? learnFromStmtEdit : undefined);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(item);
  });
  crudRoutes.delete(`/api/${col}/:id`, (req, res) => {
    deleteItem(col, req.params.id);
    res.json({ ok: true });
  });
}
// 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET
for (const col of READONLY_COLLECTIONS) {
  crudRoutes.get(`/api/${col}`, (req, res) => res.json(getCollection(col)));
}
