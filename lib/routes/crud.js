// @ts-check
// 通用 CRUD 路由（B2）：所有集合的增查改刪，一律走 repo 櫃檯＋schema 欄位白名單。
import { Router } from 'express';
import { dayOfMonth } from '../../public/modules/subscriptions-model.js';   // 續費日錨點：使用者改日期時要重設（Codex 複審 2026-07-26）
import { COLLECTIONS, READONLY_COLLECTIONS, REQUIRED_FIELDS, pickWritable, researchSymbolExists } from '../schema.js';
import { getCollection, addItem, updateItem, deleteItem, replaceCollection, uid } from '../repo.js';
import { projectCard, projectAccount } from '../secret-fields.js';
import { learnFromStmtEdit } from '../services/learning.js';
import { learnFromBankEdit, reconcileBankTxAccountNames, reconcileAccountNamesAuto, applyLearnedBankToDb } from '../services/bank-import.js';
import { applyCategoryToStoreDb } from '../services/statement-import.js';
import { isServiceFee } from '../statement.js';
import { isProtoKey } from '../safe-map.js';
import { asyncRoute } from './route-helpers.js';   // C4a：repo 改 async 後 handler 全 async——Express 4 不接 async 拋錯，包這層維持「錯誤走全域中介」的原行為

export const crudRoutes = Router();

// 編輯交易 → 自動學習：信用卡帳單走 learnFromStmtEdit（source:'stmt'）、銀行收支走 learnFromBankEdit（source:'bank'）。
// 兩者各自認自己的 source、非自己的直接返回，故一律都呼叫、由各自把關（同一次寫檔內完成）。
const learnFromTxEdit = (/** @type {any} */ db, /** @type {any} */ item, /** @type {any} */ prev) => {
  learnFromStmtEdit(db, item, prev);
  learnFromBankEdit(db, item, prev);
};

// 帳戶儲存 → 連動更新既有交易的顯示帳戶名（denormalized 字串）：使用者定 2026-07-21「改一次、處處同步」。同一次寫檔完成。
// ⚠️**銀行交易走身分比對**（reconcileBankTxAccountNames：遮罩帳號→現有帳戶現名），不靠可能過期的顯示字串——
//   否則「匯入時叫台新 8791、之後改名」的舊交易永遠對不上（實測回報）。**手動記帳無 bankRef 無從身分比對，才退用
//   舊名→新名字串連動**。整批對齊在任何一次帳戶儲存時都跑一次（順手修好其他帳戶的既有 stale）。
const onAccountSave = (/** @type {any} */ db, /** @type {any} */ item, /** @type {any} */ prev) => {
  const from = String(prev?.name || ''), to = String(item?.name || '');
  if (from && from !== to) for (const t of db.transactions || []) if (!t.bankRef && t.account === from) t.account = to;   // 手動記帳：舊名→新名
  reconcileBankTxAccountNames(db);   // 銀行交易：一律以身分對齊到現名（修這次改名＋既有 stale）
};

// 枚舉/布林非法值→400（剝掉會落到危險預設，如 cycle→月繳、accounts.type→資產）
const badReq = (res, errors) => res.status(400).json({ error: `欄位值不合法：${errors.join(', ')}` });
const researchConflict = (symbol) => `「${String(symbol || '').trim().toUpperCase()}」已有研究資料，請改用編輯原有研究`;
// 讀寫端剝機密（自主體檢）：cards 剝 pdfPassword、accounts 剝 accountNo（都是 PII，通用清單/下拉不需要）
const project = (/** @type {string} */ col, /** @type {any} */ x) => col === 'cards' ? projectCard(x) : col === 'accounts' ? projectAccount(x) : x;
for (const col of COLLECTIONS) {
  // cards 讀取端剝機密（自主體檢）：pdfPassword＝身分證字號只有卡片編輯窗需要，通用清單/下拉不需要
  crudRoutes.get(`/api/${col}`, asyncRoute(async (req, res) => res.json((await getCollection(col)).map(x => project(col, x)))));
  crudRoutes.post(`/api/${col}`, asyncRoute(async (req, res) => {
    const { value, errors } = pickWritable(col, req.body);
    if (errors.length) return badReq(res, errors);
    // 缺必填（Codex#11-1）：在路由層給乾淨 400，不讓它撞到櫃檯 tripwire 變 500
    const miss = (REQUIRED_FIELDS[col] || []).filter(f => !(f in value) || value[f] === '' || value[f] == null);
    if (miss.length) return res.status(400).json({ error: `缺少必填欄位：${miss.join('、')}` });
    if (col === 'research' && researchSymbolExists(await getCollection('research'), value.symbol)) {
      return res.status(400).json({ error: researchConflict(value.symbol) });
    }
    const created = await addItem(col, value);
    res.json(project(col, created));   // 寫入端也剝機密（Codex r10#2）
  }));
  crudRoutes.put(`/api/${col}/:id`, asyncRoute(async (req, res) => {
    // 「同類/同店一起改」原子化（護欄 G3，2026-07-22）：勾了 applyAll → 單筆編輯（含學習）＋傳播到同鑰匙其他筆
    // **一次寫檔**完成，取代前端「PUT 再另呼 apply」兩次寫（中途失敗＝半套用、且 transactions.js/settings.js
    // 原本沒接錯誤）。傳播丟 apiError（保留字/找不到目標）＝整筆編輯一起 rollback（updateItem 還沒 save）。
    // applyAll 是控制旗標、**非可寫欄位**：先讀出、再從送進白名單的 body 摘掉（免 pickWritable 誤報未知欄位、
    // 也確保它不會被當資料寫進交易）。
    const applyAll = col === 'transactions' && req.body?.applyAll === true;
    const body = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
    delete body.applyAll;
    const { value, errors } = pickWritable(col, body);
    if (errors.length) return badReq(res, errors);
    /** @type {any} */ let applied = null;
    // 帳單交易改分類 → 自動學習；帳戶改名 → 連動交易顯示名（都在 beforeSave、同一次寫檔）
    const beforeSave = col === 'transactions'
      ? (/** @type {any} */ db, /** @type {any} */ item, /** @type {any} */ prev) => {
          learnFromTxEdit(db, item, prev);
          if (applyAll) {   // 銀行走 learnedBank 規則、帳單走本筆分類；鑰匙來自已存的 bankKey/storeKey（服務層擁有、不隨 patch 動）
            if (item.source === 'bank' && item.bankKey) applied = applyLearnedBankToDb(db, String(item.bankKey));
            // 帳單傳播只在**滿足 applyCategoryToStoreDb 全部前提**時跑（G3 對抗審查兩輪 confirmed）：
            // worker 對「服務費(不支援整批改)／空分類／保留字 storeKey」都會 throw，而傳播與本筆編輯同一次寫檔，
            // throw 會連本筆編輯一起 rollback（使用者的單筆修改無聲丟失）。這些都是「傳播不適用」而非暫時失敗，
            // 故**在此鏡射 worker 的前提、不適用就略過傳播**（本筆編輯照常存）。前端也不對服務費列顯示勾選框。
            else if (item.source === 'stmt' && item.storeKey && item.category && !isServiceFee(item.storeKey) && !isProtoKey(item.storeKey)) applied = applyCategoryToStoreDb(db, String(item.storeKey), item.category, item.subcategory || '');
          }
        }
      : col === 'subscriptions'
        // 續費日錨點（Codex 複審 2026-07-26）：**使用者一改 nextCharge，錨點就跟著換成新號數**。
        // 不能只靠「錨點對不對得上現在的日期」推斷——1/31 的錨點 31 遇到使用者手動改成 4/30 時，
        // min(31,30)=30 剛好對得上，舊錨點會復活、下個月變成 5/31（實測；使用者選的是 30 號）。
        // 這裡是唯一知道「使用者這次真的動了日期」的地方：清空日期就一併清掉錨點。
        // `chargeAnchorDay` 不在 CRUD 白名單，前端送不進來，只由此處與自動推進服務寫。
        ? (/** @type {any} */ db, /** @type {any} */ item, /** @type {any} */ prev) => {
            // ⚠️ 比對**新舊值**、不是「請求有沒有帶這個欄位」（Codex 複審 2026-07-26 第二輪抓到）：
            // 訂閱表單每次儲存都回送整份資料（含沒改的 nextCharge），只看「有帶」會把只改信箱／金額
            // 也當成改日期 → 錨點被日期本身（2/28）蓋掉 → 下個月又縮成 3/28。實測重現過。
            if (!Object.hasOwn(value, 'nextCharge')) return;              // 沒送＝不處理
            const next = String(item.nextCharge || '');
            if (next === String(prev?.nextCharge || '')) return;          // 送了但沒變＝保留既有錨點
            const day = dayOfMonth(next);
            if (day) item.chargeAnchorDay = day; else delete item.chargeAnchorDay;   // 真的改了／清空了
          }
      : col === 'accounts' ? onAccountSave
      : col === 'research'
        ? (/** @type {any} */ db, /** @type {any} */ item) => {
            if (researchSymbolExists(db.research, item.symbol, item.id)) {
              throw Object.assign(new Error(researchConflict(item.symbol)), { status: 400 });
            }
          }
        : undefined;
    let item;
    try { item = await updateItem(col, req.params.id, value, beforeSave); }
    catch (e) { const err = /** @type {any} */ (e); if (err?.status) return res.status(err.status).json({ error: String(err.message || err) }); throw e; }
    if (!item) return res.status(404).json({ error: 'not found' });
    // 寫入端也剝機密（Codex r10#2）——PUT 只改別的欄位也別把存的 PII 吐回。applyAll 時附上傳播計數給前端報數。
    res.json(applied ? { ...project(col, item), applied } : project(col, item));
  }));
  crudRoutes.delete(`/api/${col}/:id`, asyncRoute(async (req, res) => {
    await deleteItem(col, req.params.id);
    res.json({ ok: true });
  }));
}
// 資產配置目標「整批取代」（護欄 G1，Codex #2）：取代前端「GET→逐筆 DELETE→逐筆 POST」的破壞性流程——
// 中途失敗會把目標半刪半建、救不回。改成一次呼叫、後端**單次寫檔**（replaceCollection 原子）。逐筆驗證＝與單筆
// POST 同一把尺（pickWritable+REQUIRED_FIELDS）；**任一筆壞＝整批 400、什麼都不動**（先全驗完才寫）。
crudRoutes.post('/api/assetTargets/replace', asyncRoute(async (req, res) => {
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
  res.json(await replaceCollection('assetTargets', items));
}));

// 開 app 自動對齊帳戶名（護欄式同步，使用者定 2026-07-21）：修「帳戶改名後既有交易顯示名沒跟上」的舊資料，
// 比照 /snapshot/auto、/normalize-auto——零操作、僅有變動時寫檔。前端在開機序列呼叫一次。
crudRoutes.post('/api/accounts/reconcile-names', asyncRoute(async (req, res) => res.json(await reconcileAccountNamesAuto())));

// 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET。
// securityTrades 例外（S2 自審 #7）：它有自己的 GET /api/securities（包 {trades}、排序、查帳語意），
// 這裡再自動開一條裸 /api/securityTrades 會出現兩個口徑不同的讀取端——單一入口，跳過。
for (const col of READONLY_COLLECTIONS) {
  if (col === 'securityTrades') continue;
  crudRoutes.get(`/api/${col}`, asyncRoute(async (req, res) => res.json(await getCollection(col))));
}
