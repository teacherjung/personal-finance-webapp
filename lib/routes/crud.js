// @ts-check
// 通用 CRUD 路由（B2）：所有集合的增查改刪，一律走 repo 櫃檯＋schema 欄位白名單。
import { Router } from 'express';
import { COLLECTIONS, READONLY_COLLECTIONS, REQUIRED_FIELDS, pickWritable } from '../schema.js';
import { getCollection, addItem, updateItem, deleteItem } from '../repo.js';
import { projectCard, projectAccount } from '../secret-fields.js';
import { learnFromStmtEdit } from '../services/learning.js';

export const crudRoutes = Router();

// 枚舉/布林非法值→400（剝掉會落到危險預設，如 cycle→月繳、accounts.type→資產）
const badReq = (res, errors) => res.status(400).json({ error: `欄位值不合法：${errors.join(', ')}` });
// 讀寫端剝機密（自主體檢）：cards 剝 pdfPassword、accounts 剝 accountNo（都是 PII，通用清單/下拉不需要）
const project = (/** @type {string} */ col, /** @type {any} */ x) => col === 'cards' ? projectCard(x) : col === 'accounts' ? projectAccount(x) : x;
for (const col of COLLECTIONS) {
  // cards 讀取端剝機密（自主體檢）：pdfPassword＝身分證字號只有卡片編輯窗需要，通用清單/下拉不需要
  crudRoutes.get(`/api/${col}`, (req, res) => res.json(getCollection(col).map(x => project(col, x))));
  crudRoutes.post(`/api/${col}`, (req, res) => {
    const { value, errors } = pickWritable(col, req.body);
    if (errors.length) return badReq(res, errors);
    // 缺必填（Codex#11-1）：在路由層給乾淨 400，不讓它撞到櫃檯 tripwire 變 500
    const miss = (REQUIRED_FIELDS[col] || []).filter(f => !(f in value) || value[f] === '' || value[f] == null);
    if (miss.length) return res.status(400).json({ error: `缺少必填欄位：${miss.join('、')}` });
    const created = addItem(col, value);
    res.json(project(col, created));   // 寫入端也剝機密（Codex r10#2）
  });
  crudRoutes.put(`/api/${col}/:id`, (req, res) => {
    const { value, errors } = pickWritable(col, req.body);
    if (errors.length) return badReq(res, errors);
    // 帳單交易改分類 → 自動學習（beforeSave：更新＋學習同一次寫檔）
    const item = updateItem(col, req.params.id, value, col === 'transactions' ? learnFromStmtEdit : undefined);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(project(col, item));   // 寫入端也剝機密（Codex r10#2）——PUT 只改別的欄位也別把存的 PII 吐回
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
