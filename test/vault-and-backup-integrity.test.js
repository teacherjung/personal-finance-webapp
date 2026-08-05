// 「資料不會靜靜消失」考題（夜班稽核第三批A，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢在寫入櫃檯與備份這一片找到一整族「註解寫明理由、
// 弄壞卻全綠」的規則。這一片的共同特徵最危險：**壞掉的時候畫面會說成功**。
//   - 唯一寫入口的「集合必須是陣列」煞車：改成默默清空 ⇒ 整個集合被抹掉並回 200。
//   - 「儲存前自動備份」：UI 上寫著這句話，備份呼叫拆掉之後那句話變成謊話。
//   - 備份的原子替換與 .tmp 清理：硬碟滿的那一次會兩頭空，而還原指引指的正是那顆備份。
//   - 資料庫損毀的 fail-closed：守衛拿掉之後損毀檔照常開起來讀寫，使用者只覺得「數字怪怪的」。
//
// 隔離：`STORE_FILE` 指向 os 暫存檔，絕不碰真實 `data/`；損毀那一題另開子行程（模組會快取 db 連線）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_STORE = join(tmpdir(), `finance-vault-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { sanitizeDbForWrite } = await import('../lib/schema.js');
const { saveStoreRules } = await import('../lib/services/store-rules.js');

/** 本檔製造出來的暫存檔（含各種 .bak）收工一起刪。 */
const TRASH = [TEST_STORE];
after(() => {
  for (const f of TRASH) {
    for (const suf of ['', '.bak', '.tmp', '-wal', '-shm', '.json',
      '.pre-rules.bak', '.pre-normalize.bak', '.pre-ledger-migration.bak', '.pre-sec-contract.bak']) {
      try { rmSync(f + suf, { recursive: true }); } catch { /* 可能不存在 */ }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 一、唯一寫入口的 fail-loud（lib/schema.js 兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('寫入櫃檯｜集合不是陣列＝寫入端有 bug，必須當場炸出來（絕不默默清空並回報成功）', () => {
  // ⚠️ 這是全批最嚴重的一條：改成 `out[col] = []` 之後，任何一條寫入路徑
  //    （例如 replaceCollection 收到非陣列 body）會把**整個集合的資料抹掉並回 200**——
  //    無聲毀資料＋畫面說成功，本專案自己列為最嚴重的一族。
  //    全 repo 原本沒有任何考題提到「必須是陣列」（grep 零命中）。
  for (const mode of ['throw', 'strip']) {
    assert.throws(
      () => sanitizeDbForWrite({ settings: {}, transactions: {} }, { mode }),
      /陣列/,
      `mode=${mode}：集合是物件時必須丟錯（不論寬鬆或嚴格模式都不可默默清空）`,
    );
  }
  // 反面：合法的空集合要照常通過（避免整段守衛被改成「一律 throw」也綠）。
  const ok = sanitizeDbForWrite({ settings: {}, transactions: [] }, { mode: 'throw' });
  assert.deepEqual(ok.transactions, [], '合法的空陣列要照常通過');
});

test('寫入櫃檯｜insightState 的正規化真的掛在寫入口上（不是只有函式自己是對的）', () => {
  // ⚠️ 又是「函式有考題、接線沒考題」：sanitizeInsightState 本身逐項有考題，
  //    但沒有一條驗它掛在唯一寫入口。接線拆掉＝「還原壞備份／手改 store 不會讓差異引擎崩」
  //    這個防護實際上不存在，而單元考題還是全綠、看起來守著。
  const bad = sanitizeDbForWrite({ settings: {}, insightState: 'oops' }, { mode: 'throw' });
  assert.notEqual(bad.insightState, 'oops',
    '非物件的 insightState 必須在寫入口被正規化（沒接線＝壞形狀會存進資料庫）');
  assert.equal(typeof bad.insightState, 'object', '正規化後要是物件');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、「儲存前自動備份」不是空頭支票（lib/services/store-rules.js）
// ─────────────────────────────────────────────────────────────────────────────

test('店名規則｜按下儲存時，磁碟上真的要出現可還原的 pre-rules 備份', async () => {
  // ⚠️ UI 上寫著「儲存前自動備份」。啟動備份 .bak 每個行程只寫一次，對「一天內改好幾次規則」
  //    毫無保護力＝空頭支票；這顆獨立的 pre-rules 備份才讓那句承諾是真的。
  //    規則會改掉學過的分類與自訂店名，其中一部分刪掉規則也還原不回來。
  //    備份呼叫拆掉之後 1487 題一聲不響（夜班實測）。
  const bak = `${TEST_STORE}.pre-rules.bak`;
  store.save({ ...store.emptyDb() });
  try { rmSync(bak); } catch { /* 尚未存在 */ }
  await saveStoreRules({ storeCanon: [{ from: '測試店', to: '測試商店' }] });
  assert.ok(existsSync(bak),
    '存規則之前必須留下 store.db.pre-rules.bak——沒有它，畫面上那句「儲存前自動備份」是謊話');
  const size = readFileSync(bak).byteLength;
  assert.ok(size > 0, '備份檔不可以是空的（空檔還原不回來，比沒有備份更糟）');

  // 同一個行程內再存一次，也要各自留下可還原的一份（這正是啟動備份做不到的事）。
  const before = readFileSync(bak).byteLength;
  await saveStoreRules({ storeCanon: [{ from: '測試店', to: '第二次改名' }] });
  assert.ok(existsSync(bak), '第二次儲存同樣要有備份');
  assert.ok(readFileSync(bak).byteLength >= before * 0.5,
    '第二次的備份要是一份完整的資料庫快照（不是被截斷的殘骸）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、備份的原子替換與殘骸清理（lib/store.js 兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('備份｜做同一顆備份失敗時，舊的那一份必須完好無損（不可先刪舊再做新）', () => {
  // ⚠️ 註解寫明這是自審 r2 修過的病：「原寫法『先刪舊再做新』，若 VACUUM 失敗（例如硬碟滿）
  //    會兩頭空——而損毀還原指引指的正是這顆 .bak」。硬碟滿的那一次會同時失去新舊備份，
  //    而畫面只有一行 console.warn 說「保留上一顆舊備份」——那句話會變成謊話。
  // ⚠️ 考題設計（這一題我自己第一版是空包彈，突變驗證抓到）：失敗的目標必須是**同一個路徑**，
  //    否則「先刪舊再做新」刪的是別的檔、舊備份當然還在，突變照樣綠。
  //    製造失敗的方法＝先把 `<dest>.tmp` 佔成一個**資料夾**：
  //      正確實作 → 第一步 rmSync(tmp) 對資料夾丟錯 ⇒ 拋錯、dest 一個位元組沒動；
  //      「先刪舊再做新」→ 先把 dest 刪了，然後 VACUUM 成功 ⇒ 不拋錯（本題轉紅）。
  const dir = mkdtempSync(join(tmpdir(), 'finance-bak-'));
  TRASH.push(dir);
  const dest = join(dir, 'good.bak');
  store.save({ ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] });
  store.snapshotTo(dest);                       // 先做出一顆「上一次的好備份」
  const goodBytes = readFileSync(dest).byteLength;
  assert.ok(goodBytes > 0);

  mkdirSync(dest + '.tmp');                     // 讓下一次備份在「寫 .tmp」這一步就失敗
  assert.throws(() => store.snapshotTo(dest), /.*/,
    '寫不進去時要拋錯——不拋錯代表它繞過了 .tmp、直接動了正式的備份檔');
  assert.ok(existsSync(dest), '這一次失敗，上一顆好備份必須還在（還原指引指的就是它）');
  assert.equal(readFileSync(dest).byteLength, goodBytes, '舊備份的內容一個位元組都不可變');
});

test('備份｜失敗時不可留下半截的 .tmp 殘骸（會被誤認成備份、還原到它會失敗）', () => {
  // ⚠️ docstring 明寫「失敗時一定清掉半成品 .tmp，不留下會被誤認成備份的殘骸」。
  //    每日備份會反覆呼叫這支，殘骸會在 backups/ 底下累積成一堆「看起來像備份、其實是半截檔」，
  //    而損毀還原的指引正是「把備份改名回 store.db」——改到半截檔會讓還原本身失敗。
  // ⚠️ 考題設計（第一版是空包彈，突變驗證抓到）：要讓 `.tmp` **真的被寫出來**、失敗發生在
  //    後面的改名那一步，否則沒有殘骸可清，「不清理」的突變照樣綠。
  //    製造法＝把 dest 佔成一個資料夾：VACUUM 寫 .tmp 成功 → renameSync(檔案→資料夾) 失敗。
  const dir = mkdtempSync(join(tmpdir(), 'finance-tmp-'));
  TRASH.push(dir);
  const dest = join(dir, 'occupied');
  mkdirSync(dest);
  store.save({ ...store.emptyDb() });
  assert.throws(() => store.snapshotTo(dest), /.*/, '改名失敗要拋錯');
  assert.ok(!existsSync(dest + '.tmp'),
    '半成品 .tmp 必須被清掉——留著會被誤認成備份，而還原到半截檔會讓自救本身失敗');
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、資料庫損毀＝fail-closed（lib/store.js）
// ─────────────────────────────────────────────────────────────────────────────

test('開啟資料庫｜檔案損毀時要給「還原指引」，不可只丟一句看不懂的原始錯誤', () => {
  // ⚠️ 註解明寫「fail closed：資料庫損毀時絕不回空資料庫」，而丟出去的訊息就是使用者
  //    唯一拿得到的還原指引（刪 -wal/-shm、把 .bak 改名回 store.db）。斷電／硬碟壞是真實情境。
  // ⚠️ 考題設計（第一版是空包彈，突變驗證抓到）：關鍵判準**不是「有沒有丟錯」而是「有沒有還原指引」**。
  //    我第一版用「SQLite 檔頭＋垃圾」，那種檔連 CREATE TABLE 都失敗 ⇒ 守衛拿掉後照樣從
  //    open() 的 catch 丟出帶指引的訊息，突變全綠。
  //    這一版刻意造「**開得起來、schema 也在、只有中段資料頁壞掉**」的檔：
  //      有守衛 → quick_check 當場擋下、給指引；
  //      沒守衛 → open() 順利返回，等到 load() 真的讀資料才炸，訊息是
  //               「database disk image is malformed」＝使用者完全不知道該怎麼自救（本題轉紅）。
  const corrupt = join(tmpdir(), `finance-corrupt-${process.pid}.db`);
  TRASH.push(corrupt);
  {
    const d = new DatabaseSync(corrupt);
    d.exec('PRAGMA journal_mode = DELETE');     // 不留 -wal，免得干擾
    d.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const ins = d.prepare('INSERT INTO kv(key,data) VALUES(?,?)');
    for (let i = 0; i < 400; i++) ins.run(`k${i}`, JSON.stringify({ pad: 'x'.repeat(200) }));
    d.close();
    const buf = readFileSync(corrupt);
    buf.fill(0x5a, 4096 * 3, 4096 * 5);          // 破壞中段資料頁（第 1 頁的 schema 保持完好）
    writeFileSync(corrupt, buf);
  }
  const script = "const s = await import('./lib/store.js'); try { s.load(); console.log('NO_THROW'); }"
    + " catch (e) { console.log('THREW:' + e.message); }";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: corrupt },
  });
  assert.doesNotMatch(out, /NO_THROW/, '損毀的資料庫不可被照常開起來讀寫');
  assert.match(out, /store\.db\.bak/,
    '錯誤訊息必須點名 store.db.bak（使用者唯一拿得到的自救說明）——'
    + '只丟一句 database disk image is malformed 等於把人丟在原地');
  assert.match(out, /刪掉|改名/, '要說清楚步驟（先刪 -wal/-shm、再把備份改名回去）');
});
