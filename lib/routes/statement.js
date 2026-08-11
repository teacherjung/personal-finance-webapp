// @ts-check
// 帳單匯入路由（B2）：邏輯在 lib/services/statement-import.js，這裡只做 HTTP 轉接與錯誤轉換。
import { Router } from 'express';
import {
  previewAuto, previewForCard, importRows, listBatches, reassignBatch, deleteBatch,
  getLearned, deleteLearned, normalizeBranches, renameStoreDisplay, normalizeIfRulesChanged, applyCategoryToStore, setBatchMonth,
  rememberStatementPassword, clearStatementPasswords
} from '../services/statement-import.js';
import { runHealthCheck, dismissHealthItem } from '../services/health-check.js';
import { getStoreRules, previewStoreRules, saveStoreRules, listOrphanLearned } from '../services/store-rules.js';
import { previewBankStatement, applyBankStatement, listBankBatches, deleteBankBatch, listLearnedBank, deleteLearnedBank, applyLearnedBankToExisting } from '../services/bank-import.js';
import { wrapRoute as wrap } from './route-helpers.js';   // 錯誤口徑歸戶（系統優化 U2）；語意同原本地 wrap

export const statementRoutes = Router();

// 自動預覽（免選卡）／指定卡片預覽／匯入。password 可選（P0.5）：留白＝自動試統一密碼池
statementRoutes.post('/api/statement/preview', wrap(async (req, res) => res.json(await previewAuto(req.body.data, req.body.password))));
// 匯入密碼池（P0.5）：記住一組（前端在預覽成功＋勾「記住」後呼叫）／全部清除（設定頁）。
// 密碼只在 body 進來、存進 settings 機密欄（LOCAL 明文/HOSTED 加密、投影剝除）；回應絕不含明文。
statementRoutes.post('/api/statement/password/remember', wrap(async (req, res) => res.json(await rememberStatementPassword(req.body?.password))));
statementRoutes.post('/api/statement/password/clear', wrap(async (req, res) => res.json(await clearStatementPasswords())));
statementRoutes.post('/api/cards/:id/statement/preview', wrap(async (req, res) => res.json(await previewForCard(req.params.id, req.body.data))));
statementRoutes.post('/api/cards/:id/statement/import', wrap(async (req, res) =>
  res.json(await importRows(req.params.id, req.body.transactions, req.body.statementMonth, req.body.statementDue))));

// 銀行對帳單（三層重構 stage 2）：預覽概要區帳戶餘額變動／套用（更新+自動建帳戶）。密碼在 body、只在記憶體用、不落檔。
statementRoutes.post('/api/bank-statement/preview', wrap(async (req, res) => res.json(await previewBankStatement(req.body.data, req.body.password))));
statementRoutes.post('/api/bank-statement/apply', wrap(async (req, res) => res.json(await applyBankStatement(req.body.data, req.body.password))));
// 銀行對帳單匯入紀錄（stage 3+）：列出每次上傳的批次／整批刪除重匯（比照信用卡帳單的匯入紀錄）。純資料操作、無密碼。
statementRoutes.get('/api/bank-statement/batches', wrap(async (req, res) => res.json(await listBankBatches())));
statementRoutes.post('/api/bank-statement/batch/delete', wrap(async (req, res) => res.json(await deleteBankBatch(req.body?.batchId))));
// 銀行收支「真·學習」已學規則：檢視／刪除（設定頁「銀行收支學習」用；教錯的救援）
statementRoutes.get('/api/bank-learned', wrap(async (req, res) => res.json(await listLearnedBank())));
statementRoutes.post('/api/bank-learned/delete', wrap(async (req, res) => res.json(await deleteLearnedBank(req.body?.key))));
// 同類一起改（Q2乙）：把某 bankKey 學過的規則套用到所有既有同鑰匙的銀行交易（編輯時勾「同時套用」）
statementRoutes.post('/api/bank-tx/apply-learned', wrap(async (req, res) => res.json(await applyLearnedBankToExisting(req.body?.bankKey))));
// 手動修正整批的帳單年月（表頭讀不出期別／讀錯時的退路）
statementRoutes.post('/api/statement/batch/month', wrap(async (req, res) =>
  res.json(await setBatchMonth(req.body?.batchId, req.body?.month))));

// 匯入批次：清單／整批改卡片／刪除整批
// ⚠️ C4a：service 全 async——res.json 收到沒 await 的 Promise 會**默默序列化成 {}**（不報錯），一律 await。
statementRoutes.get('/api/statement/batches', wrap(async (req, res) => res.json(await listBatches())));
statementRoutes.post('/api/statement/reassign', wrap(async (req, res) => res.json(await reassignBatch(req.body.batchId, req.body.toCardId))));
statementRoutes.post('/api/statement/batch/delete', wrap(async (req, res) => res.json(await deleteBatch(req.body.batchId))));

// 帳單分類自動學習：檢視／刪除（設定頁用）
statementRoutes.get('/api/learned', wrap(async (req, res) => res.json(await getLearned())));
statementRoutes.post('/api/learned/delete', wrap(async (req, res) => res.json(await deleteLearned(req.body.key))));

// 店名格式整理（可重複執行）：dryRun 預覽 note 的 before→after；正式套用寫檔（含 storeKey/學習表對齊）。
// ⚠️ **UI 入口已於 2026-07-19 移除**（使用者定）：整理現在全自動——規則變動由 `normalize-auto` 觸發、
// 改分類由 `learnFromStmtEdit` 當場重算顯示名，使用者沒有需要手動按的時機了。
// 端點**刻意保留**為維護用途（Claude/Codex 排查時可 curl 呼叫），非死碼，勿刪。
// ⚠️ 正式套用需明確帶 force:true（Codex r5#8 裁定）：這條路**不經** #141 的確認閘門，
// 會直接合併有衝突的學習資料（不可逆）。維護後門可以留，但繞過閘門必須是「明說的」——
// 不帶 force 的誤呼叫（忘了帶 dryRun 之類）不可默默動資料。
statementRoutes.post('/api/statement/normalize-branches', wrap(async (req, res) => {
  if (req.body?.dryRun) return res.json(await normalizeBranches(true));
  if (req.body?.force !== true) {
    return res.status(400).json({ error: '維護端點需明確帶 force:true 才會套用（不經確認閘門、學習衝突會直接合併且不可逆）；預覽請帶 dryRun:true。' });
  }
  res.json(await normalizeBranches(false));
}));
// 帳務體檢（第二帖）：唯讀偵測器＋略過持久化；修正動作走既有的 rename-store / apply-category
statementRoutes.get('/api/statement/health', wrap(async (req, res) => res.json(await runHealthCheck())));
statementRoutes.post('/api/statement/health/dismiss', wrap(async (req, res) =>
  res.json(await dismissHealthItem(req.body?.id, !!req.body?.clearAll))));
// 規則更新後自動整理（開 app 呼叫，同一版規則只跑一次）——「忘了按套用」的解藥，比照 /snapshot/auto
// `force`＝使用者已確認「學習表會被蓋掉」。⚠️ 不可以在這裡接「備份沒存成也要繼續」那一類旗標：
// 不可逆操作前的自動備份是本專案刻意不做的（理由見 lib/services/backup.js 的設計註解），
// test/vault-and-backup-integrity.test.js 的〈裁決〉那一題釘著這條路不得長出它。
statementRoutes.post('/api/statement/normalize-auto', wrap(async (req, res) => res.json(
  await normalizeIfRulesChanged(!!req.body?.force))));
// 店名規則自助管理（第三帖）：讀取／全庫影響預覽／存檔並立即套用；孤兒學習條目清單（唯讀）
statementRoutes.get('/api/statement/rules', wrap(async (req, res) => res.json(await getStoreRules())));
statementRoutes.post('/api/statement/rules/preview', wrap(async (req, res) => res.json(await previewStoreRules(req.body?.rules))));
statementRoutes.post('/api/statement/rules', wrap(async (req, res) => res.json(
  await saveStoreRules(req.body?.rules))));
statementRoutes.get('/api/statement/learned/orphans', wrap(async (req, res) => res.json(await listOrphanLearned())));

// 同店整批改分類（收支列表編輯時勾「同時套用到這家店的其他 N 筆」）
statementRoutes.post('/api/statement/apply-category', wrap(async (req, res) =>
  res.json(await applyCategoryToStore(req.body?.storeKey, req.body?.category, req.body?.subcategory))));

// 帳單說明／分類學習（合併卡）編輯：以「帳單原文」為準改顯示名＋分類（同原文整批改＋記學習，
// 未來匯入沿用；不同分店可各自取名）。reset=true＝整列還原自動判斷並清除學習。
statementRoutes.post('/api/statement/rename-store', wrap(async (req, res) =>
  res.json(await renameStoreDisplay(req.body?.orig, req.body?.name, req.body?.category, req.body?.subcategory, !!req.body?.reset, !!req.body?.clearBrand, !!req.body?.applyAll))));
