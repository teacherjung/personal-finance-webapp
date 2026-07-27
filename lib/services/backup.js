// @ts-check
// 每日滾動備份（系統優化階段四 A，William 2026-07-24 定稿／2026-07-27 開工）。
//
// **宣稱範圍（裁決，勿擴大）**：本機備份只防**誤刪、錯誤匯入、程式寫壞**——同一顆硬碟上的多份副本，
// **不宣稱能防硬碟／電腦損壞**。要防那個得把備份放到另一台機器，而資料庫裡的 IB token 與 PDF 密碼
// 目前是**明文**，所以「離開這台電腦」在有加密備份格式之前維持暫緩（見 docs/系統優化-施工計畫.md 階段四 A）。
//
// **與既有兩種備份的分工**：
//   - 啟動 `.bak`（store.js backupOnce）＝每個行程一顆，會被下次啟動覆蓋 → 只保護「這次開機之前」。
//   - 操作前 `<tag>.bak`（store.js backupNow）＝不可逆整批操作之前，同 tag 覆蓋。
//   - **本檔＝每天一顆、保留 30 天**，這是唯一能回到「上週三」的那一種。
//
// 節流方式沿用月快照（snapshot.js takeSnapshotIfDue）的作法＝**開 app 時檢查今天有沒有做過**，
// 不用背景計時器（app 不會整天開著）。
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, saveDb } from '../repo.js';
import { snapshotTo, dataDir } from '../store.js';

/** 保留天數（裁決：30 天）。 */
export const KEEP_DAYS = 30;
/** 備份資料夾名（在 data/ 底下）。 */
export const BACKUP_DIR = 'backups';
/** 每日備份檔名樣式——**清理只認這個樣式**，正式庫 `store.db`、`.bak`、`-wal`、`-shm` 一律不符合＝絕不會被誤刪。 */
const FILE_RE = /^store-(\d{4}-\d{2}-\d{2})\.db$/;

/** @param {string} date YYYY-MM-DD @returns {string} */
export function backupFileName(date) { return `store-${date}.db`; }

/** 備份資料夾完整路徑。 @returns {string} */
export function backupDirPath() { return join(dataDir(), BACKUP_DIR); }

/**
 * 把日期字串往前推 n 天（純字串算，避免時區）。 @param {string} date @param {number} days @returns {string}
 */
function minusDays(date, days) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

/**
 * 清掉超過保留期的每日備份。**只刪符合 `store-YYYY-MM-DD.db` 的檔**；刪不掉不是致命錯誤
 * （備份本身已經做好了），回報給呼叫端記錄即可——**清理失敗絕不可讓正式庫或今天的備份受影響**。
 * @param {string} today YYYY-MM-DD
 * @param {string} [dir]
 * @returns {{pruned: string[], failed: string[]}}
 */
export function pruneOldBackups(today, dir = backupDirPath()) {
  /** @type {{pruned: string[], failed: string[]}} */
  const out = { pruned: [], failed: [] };
  if (!existsSync(dir)) return out;
  const cutoff = minusDays(today, KEEP_DAYS - 1);   // 保留最近 30 天（含今天）
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (!m) continue;                  // 不認得的檔一律不碰（含正式庫誤放進來的情況）
    if (m[1] >= cutoff) continue;
    try { rmSync(join(dir, name)); out.pruned.push(name); }
    catch { out.failed.push(name); }
  }
  return out;
}

/** 目前留著哪幾天的備份（新到舊）。 @param {string} [dir] @returns {string[]} */
export function listBackupDates(dir = backupDirPath()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(n => FILE_RE.exec(n)?.[1] || '').filter(Boolean).sort().reverse();
}

/**
 * 今天還沒備份就備一份（開 app 時呼叫）。**本函式不丟例外**——備份失敗時 app 仍要能開、能用
 * （裁決），只是要把失敗記下來讓畫面明顯警告，且**連續失敗次數會累積**（畫面據此提高警告強度）。
 *
 * 成功判準刻意寬鬆：`settings.lastBackupDate` 是今天**或**今天的備份檔已存在，都算今天有備份
 * （設定被還原/被清掉時不會白做一顆，也不會因為檔案被手動刪掉就永遠不補）。
 *
 * @param {string} today YYYY-MM-DD（呼叫端給，方便測試；正式呼叫用本地日期）
 * @returns {Promise<{ran:boolean, created:boolean, date:string, file:string|null, pruned:string[], prunedFailed:string[], failStreak:number, error:string, dir:string}>}
 */
export async function dailyBackupIfDue(today) {
  const date = String(today || '');
  const dir = backupDirPath();
  const db = await getDb();
  const s = /** @type {any} */ (db.settings) || {};
  const base = {
    ran: false, created: false, date, file: null, pruned: /** @type {string[]} */ ([]),
    prunedFailed: /** @type {string[]} */ ([]), failStreak: Number(s.backupFailStreak) || 0,
    error: String(s.backupLastError || ''), dir,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return base;   // 壞日期＝不做也不記（不可拿壞日期當檔名）

  const dest = join(dir, backupFileName(date));
  if (s.lastBackupDate === date && existsSync(dest)) return base;   // 今天做過且檔案還在＝跳過

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    snapshotTo(dest);
    const { pruned, failed } = pruneOldBackups(date, dir);   // 清理在備份成功之後才做（先確保今天這顆存在）
    await writeStatus({ lastBackupDate: date, backupFailStreak: 0, backupLastError: '', backupLastErrorAt: '' });
    return { ...base, ran: true, created: true, file: dest, pruned, prunedFailed: failed, failStreak: 0, error: '' };
  } catch (e) {
    const message = String(/** @type {any} */ (e)?.message || e);
    const failStreak = (Number(s.backupFailStreak) || 0) + 1;
    console.warn(`[backup] 每日備份失敗（連續第 ${failStreak} 次，app 仍可正常使用）:`, message);
    // ⚠️ 失敗時**不寫 lastBackupDate**——否則今天就再也不會重試了
    await writeStatus({ backupFailStreak: failStreak, backupLastError: message, backupLastErrorAt: new Date().toISOString() });
    return { ...base, ran: true, created: false, failStreak, error: message };
  }
}

/**
 * 寫服務層擁有的備份狀態欄位（同 `storeRulesHash` 的先例：前端不寫、匯入備份時被白名單剝掉）。
 * 連狀態都寫不進去時只警告——**絕不可因此讓開 app 失敗**。
 * @param {Record<string, any>} patch
 */
async function writeStatus(patch) {
  try {
    const fresh = await getDb();
    fresh.settings = { ...fresh.settings, ...patch };
    await saveDb(fresh);
  } catch (e) {
    console.warn('[backup] 備份狀態寫入失敗（不影響 app 使用）:', /** @type {any} */ (e).message);
  }
}
