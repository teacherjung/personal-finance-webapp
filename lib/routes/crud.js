// @ts-check
// 通用 CRUD 路由（B2）：所有集合的增查改刪，一律走 repo 櫃檯＋schema 欄位白名單。
import { Router } from 'express';
import { COLLECTIONS, READONLY_COLLECTIONS, REQUIRED_FIELDS, pickWritable } from '../schema.js';
import { getCollection, addItem, updateItem, deleteItem, replaceCollection, uid } from '../repo.js';
import { projectCard, projectAccount } from '../secret-fields.js';
import { learnFromStmtEdit } from '../services/learning.js';
import { learnFromBankEdit } from '../services/bank-import.js';

export const crudRoutes = Router();

// 編輯交易 → 自動學習：信用卡帳單走 learnFromStmtEdit（source:'stmt'）、銀行收支走 learnFromBankEdit（source:'bank'）。
// 兩者各自認自己的 source、非自己的直接返回，故一律都呼叫、由各自把關（同一次寫檔內完成）。
const learnFromTxEdit = (/** @type {any} */ db, /** @type {any} */ item, /** @type {any} */ prev) => {
  learnFromStmtEdit(db, item, prev);
  learnFromBankEdit(db, item, prev);
};

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
    const item = updateItem(col, req.params.id, value, col === 'transactions' ? learnFromTxEdit : undefined);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(project(col, item));   // 寫入端也剝機密（Codex r10#2）——PUT 只改別的欄位也別把存的 PII 吐回
  });
  crudRoutes.delete(`/api/${col}/:id`, (req, res) => {
    deleteItem(col, req.params.id);
    res.json({ ok: true });
  });
}
// 資產配置目標「整批取代」（護欄 G1，Codex #2）：取代前端「GET→逐筆 DELETE→逐筆 POST」的破壞性流程——
// 中途失敗會把目標半刪半建、救不回。改成一次呼叫、後端**單次寫檔**（replaceCollection 原子）。逐筆驗證＝與單筆
// POST 同一把尺（pickWritable+REQUIRED_FIELDS）；**任一筆壞＝整批 400、什麼都不動**（先全驗完才寫）。
crudRoutes.post('/api/assetTargets/replace', (req, res) => {
  const list = req.body?.targets;
  if (!Array.isArray(list)) return res.status(400).json({ error: '需要 targets 陣列' });
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const { value, errors } = pickWritable('assetTargets', list[i]);
    if (errors.length) return badReq(res, errors.map(e => `targets[${i}]：${e}`));
    // assetTargets 不在 REQUIRED_FIELDS，這裡明確要求 class＋targetPct（整批取代不留半殘目標）——pickWritable
    // 對壞數字是「安全剝掉」（value 少了 targetPct）、對 class 是自由字串，故在此顯式驗，任一筆壞＝整批 400。
    if (!value.class || typeof value.class !== 'string') return res.status(400).json({ error: `targets[${i}] 缺類別名稱` });
    if (typeof value.targetPct !== 'number') return res.status(400).json({ error: `targets[${i}] 目標 % 需為數字` });
    items.push({ id: uid(), ...value });
  }
  res.json(replaceCollection('assetTargets', items));
});

// 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET
for (const col of READONLY_COLLECTIONS) {
  crudRoutes.get(`/api/${col}`, (req, res) => res.json(getCollection(col)));
}
