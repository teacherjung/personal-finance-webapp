// @ts-check
// 每日滾動備份（系統優化階段四 A，William 2026-07-24 定稿／2026-07-27 開工）。
//
// **宣稱範圍（裁決，勿擴大）**：本機備份只防**誤刪、錯誤匯入、程式寫壞**——同一顆硬碟上的多份副本，
// **不宣稱能防硬碟／電腦損壞**。要防那個得把備份放到另一台機器，而資料庫裡的 IB token 與 PDF 密碼
// 是**明文**，所以「離開這台電腦」在有加密備份格式之前維持暫緩（見 docs/系統優化-施工計畫.md 階段四 A）。
//
// **與其他備份的分工**：
//   - 啟動 `.bak`（store.js backupOnce）＝每個行程一顆，會被下次啟動覆蓋 → 只保護「這次開機之前」。
//   - 操作前 `<tag>.bak`（store.js backupNow）＝本專案**刻意不做**不可逆操作前的備份，理由見下方的設計註解。
//   - **本檔＝每天一顆、保留 30 天**，能提供過去日期的復原點（回得到前幾天當時的狀態）。
//
// 節流方式沿用月快照（snapshot.js takeSnapshotIfDue）的作法＝**開 app 時檢查今天有沒有做過**，
// 不用背景計時器（app 不會整天開著）。
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ C4b：改從**櫃檯**拿 snapshotTo/dataDir（以前直接 import '../store.js'，是全 repo 唯一繞過櫃檯
// 的地方）。理由不是潔癖：HOSTED 模式下這兩支會憑空建出一顆本機 SQLite，而那顆是全新空庫、
// 會被 seed.json 種底稿——於是「今天的備份」內容是 demo 假帳本，畫面卻顯示已備份。
// 經櫃檯就有 isHosted() 的閘門（lib/repo.js 檔尾），而且**架構考題**會盯著「只有 repo.js 能 import store.js」。
import { getDb, saveDb, snapshotTo, dataDir } from '../repo.js';
import { isHosted } from '../hosted.js';

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
 * ⚠️ HOSTED 模式（C4b）整支短路＝不備份也不假裝備份，見函式內註解。
 * @param {string} today YYYY-MM-DD（呼叫端給，方便測試；正式呼叫用本地日期）
 * @returns {Promise<{ran:boolean, created:boolean, date:string, file:string|null, pruned:string[], prunedFailed:string[], failStreak:number, error:string, dir:string, hosted?:boolean}>}
 */
export async function dailyBackupIfDue(today) {
  const date = String(today || '');
  // HOSTED（C4b）：**這件事在雲端沒有意義，所以誠實地什麼都不做**。
  // ①Render 的檔案系統是暫時性的，備份寫完就隨下次部署消失＝假的安全帶；
  // ②真正的雲端備份屬於資料庫層（Supabase 方案），不是這支服務的責任；
  // ③`failStreak/error` 一律回 0／空——租戶資料裡若殘留從本機備份匯入的舊 streak，
  //   前端 backup-alert 會對雲端使用者顯示「請檢查電腦硬碟空間、把 data 資料夾複製一份」
  //   這種本機專用指引（看得懂才怪，而且會教會使用者忽略警告）。
  if (isHosted()) {
    return {
      ran: false, created: false, date, file: null, pruned: [], prunedFailed: [],
      failStreak: 0, error: '', dir: '', hosted: true,
    };
  }
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
 * 🧑‍⚖️ **本專案刻意不做「不可逆操作前的自動備份」**——這是產品決定，不是漏接的實作。
 *
 * **為什麼**：那層網自己會失敗（硬碟滿、檔案被鎖住），而失敗的那一次畫面照樣說「儲存成功」，
 * 等於在使用者以為有安全帶的時候把安全帶抽掉——「壞掉時畫面說成功」是本專案列為最嚴重的一族。
 * 想補救就得「存不成就擋下＋問使用者」，代價是一個單純的儲存動作長出額外的確認框、旗標與說明文案，
 * 而那張網仍然會破：多出來的複雜度買不到可靠度。
 *
 * **刻意接受的代價**：救援粒度只到「今天第一次開 app」，不是「按下去的前一秒」。
 * 使用者手上的救援手段＝本檔的每日滾動備份（保留 KEEP_DAYS 天，能提供過去日期的復原點）、
 * 他自己按的〈匯出備份〉，以及 `lib/store.js` 的 `backupOnce`（每個行程一顆，只保護「這次開機之前」）。
 *
 * ⚠️ **看到「不可逆操作居然沒有備份」想順手補的人請先讀這段**：
 * `test/vault-and-backup-integrity.test.js` 的〈裁決〉那一題釘著「這幾條路不得再長出操作前備份」，
 * 補回去會轉紅。真的要加，先問過 William。
 */

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
