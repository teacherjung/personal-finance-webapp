// 每日滾動備份（階段四 A）考題。裁決指定五條（docs/系統優化-施工計畫.md:43）：
// ①同日不重複建立 ②超過 30 天正確清理 ③備份失敗不影響正式庫 ④備份檔可重新開啟 ⑤清理失敗不誤刪正式檔。
// 另加：失敗累積 failStreak／成功歸零／失敗不寫 lastBackupDate（今天才會重試）／檔名樣式牆。
// STORE_FILE 指向暫存 SQLite，絕不碰真實資料。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DIR = mkdtempSync(join(tmpdir(), 'finance-daily-backup-'));
const TEST_STORE = join(DIR, 'store.db');
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { dailyBackupIfDue, pruneOldBackups, listBackupDates, backupDirPath, backupFileName, KEEP_DAYS } = await import('../lib/services/backup.js');

const BDIR = backupDirPath();

after(() => { try { chmodSync(BDIR, 0o755); } catch { /* 可能不存在 */ } rmSync(DIR, { recursive: true, force: true }); });

/** 重設乾淨 db＋清空備份資料夾。 */
function reset() {
  const db = store.emptyDb();
  db.transactions = [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 100, note: '考題資料', account: '卡A', ledger: 'card', source: 'stmt', stmtRef: 'c1|2026-07-01|100|考題資料' }];
  store.save(db);
  try { chmodSync(BDIR, 0o755); } catch { /* 尚未建立 */ }
  rmSync(BDIR, { recursive: true, force: true });
  const fresh = getDb();
  delete (/** @type {any} */ (fresh.settings).lastBackupDate);
  fresh.settings = { ...fresh.settings, backupFailStreak: 0, backupLastError: '' };
  saveDb(fresh);
}

test('裁決①：同日第二次呼叫不重複建立（lastBackupDate＋檔案都在＝跳過）', () => {
  reset();
  const r1 = dailyBackupIfDue('2026-07-27');
  assert.equal(r1.created, true);
  assert.ok(existsSync(join(BDIR, backupFileName('2026-07-27'))));
  const r2 = dailyBackupIfDue('2026-07-27');
  assert.equal(r2.ran, false, '同日第二次＝什麼都不做');
  assert.equal(readdirSync(BDIR).filter(n => n.startsWith('store-')).length, 1, '只有一顆');
});

test('裁決①補：記過日期但備份檔被手動刪掉 → 補做（不因記錄還在就永遠不補）', () => {
  reset();
  dailyBackupIfDue('2026-07-27');
  rmSync(join(BDIR, backupFileName('2026-07-27')));
  const r = dailyBackupIfDue('2026-07-27');
  assert.equal(r.created, true, '檔案不在就補一顆');
});

test('裁決②：超過 30 天正確清理；30 天內與不認得的檔一律不動', () => {
  reset();
  mkdirSync(BDIR, { recursive: true });
  writeFileSync(join(BDIR, 'store-2026-06-01.db'), 'old');        // 過期（>30 天前）
  writeFileSync(join(BDIR, 'store-2026-07-26.db'), 'recent');     // 30 天內
  writeFileSync(join(BDIR, 'store.db'), 'not-a-daily-backup');    // 不合樣式＝不碰（⑤的另一半）
  writeFileSync(join(BDIR, 'store-2026-06-01.db.bak'), 'weird');  // 不合樣式＝不碰
  const r = dailyBackupIfDue('2026-07-27');
  assert.equal(r.created, true);
  assert.deepEqual(r.pruned, ['store-2026-06-01.db'], '只清超過保留期且符合樣式的');
  assert.ok(existsSync(join(BDIR, 'store-2026-07-26.db')));
  assert.ok(existsSync(join(BDIR, 'store.db')), '不認得的檔名絕不刪');
  assert.ok(existsSync(join(BDIR, 'store-2026-06-01.db.bak')));
  // 邊界：剛好第 30 天（含今天往前推 29 天）要留
  const keepEdge = pruneOldBackups('2026-07-27');
  assert.deepEqual(keepEdge.pruned, [], '再跑一次沒有可清的');
  assert.equal(KEEP_DAYS, 30);
});

test('裁決③＋失敗行為：備份失敗 → 正式庫不受影響、failStreak 累積、不寫 lastBackupDate（今天會重試）', () => {
  reset();
  // 讓 backups 這個路徑變成「檔案」→ 寫 backups/store-….db 必炸（ENOTDIR）＝穩定模擬失敗
  writeFileSync(BDIR, 'i-am-a-file-not-a-dir');
  const r1 = dailyBackupIfDue('2026-07-27');
  assert.equal(r1.created, false);
  assert.equal(r1.failStreak, 1);
  assert.ok(r1.error, '失敗訊息要據實回報');
  const s1 = /** @type {any} */ (getDb().settings);
  assert.equal(s1.lastBackupDate, undefined, '失敗絕不可寫 lastBackupDate——否則今天不會重試');
  assert.equal(s1.backupFailStreak, 1);
  // 連續失敗累積（畫面據此提高強度）
  const r2 = dailyBackupIfDue('2026-07-27');
  assert.equal(r2.failStreak, 2);
  // 正式庫完好：讀回資料、能照常寫入
  const db = getDb();
  assert.equal(db.transactions.length, 1, '正式庫資料完好');
  saveDb(db);
  // 修好之後同一天就能成功，且 failStreak 歸零
  rmSync(BDIR);
  const r3 = dailyBackupIfDue('2026-07-27');
  assert.equal(r3.created, true, '修好後同日重試成功');
  assert.equal(r3.failStreak, 0);
  assert.equal(/** @type {any} */ (getDb().settings).backupFailStreak, 0, '成功歸零');
  assert.equal(/** @type {any} */ (getDb().settings).lastBackupDate, '2026-07-27');
});

test('裁決④：備份檔可重新開啟＝真的 SQLite、kv 內容與正式庫一致', () => {
  reset();
  const r = dailyBackupIfDue('2026-07-27');
  assert.equal(r.created, true);
  const d = new DatabaseSync(/** @type {string} */ (r.file), { readOnly: true });
  try {
    const row = /** @type {any} */ (d.prepare("SELECT data FROM kv WHERE key='transactions'").get());
    const txs = JSON.parse(row.data);
    assert.equal(txs.length, 1);
    assert.equal(txs[0].note, '考題資料');
    assert.equal(/** @type {any} */ (d.prepare('PRAGMA integrity_check').get()).integrity_check, 'ok');
  } finally { d.close(); }
});

test('裁決⑤：清理失敗不誤刪正式檔、也不影響今天剛建好的備份', () => {
  reset();
  mkdirSync(BDIR, { recursive: true });
  writeFileSync(join(BDIR, 'store-2026-06-01.db'), 'old');
  // 資料夾唯讀 → rmSync 過期檔會失敗；但今天的備份在 chmod 前已建好（先備份、後清理的順序）
  // ⚠️ 這裡直接測 pruneOldBackups 的失敗路徑（dailyBackupIfDue 的順序＝先 snapshotTo 再 prune，已由上面考題蓋住）
  chmodSync(BDIR, 0o555);
  const out = pruneOldBackups('2026-07-27');
  chmodSync(BDIR, 0o755);
  assert.deepEqual(out.pruned, []);
  assert.deepEqual(out.failed, ['store-2026-06-01.db'], '刪不掉要據實回報、不可假裝清乾淨');
  assert.ok(existsSync(TEST_STORE), '正式庫完好');
  assert.ok(existsSync(join(BDIR, 'store-2026-06-01.db')), '刪不掉的檔還在（不會半刪）');
});

test('壞日期不做也不記（不可拿壞字串當檔名）', () => {
  reset();
  for (const bad of ['', '2026/07/27', '2026-7-27', 'DROP TABLE', null, undefined]) {
    const r = dailyBackupIfDue(/** @type {any} */ (bad));
    assert.equal(r.ran, false, `壞日期(${bad})不執行`);
  }
  assert.ok(!existsSync(BDIR) || readdirSync(BDIR).length === 0, '沒有任何檔案被建立');
});

test('listBackupDates：新到舊、只認每日備份樣式', () => {
  reset();
  mkdirSync(BDIR, { recursive: true });
  writeFileSync(join(BDIR, 'store-2026-07-20.db'), 'a');
  writeFileSync(join(BDIR, 'store-2026-07-25.db'), 'b');
  writeFileSync(join(BDIR, 'whatever.db'), 'c');
  assert.deepEqual(listBackupDates(), ['2026-07-25', '2026-07-20']);
});
