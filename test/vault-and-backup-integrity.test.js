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

test('寫入櫃檯｜insightState 正規化真的接上：合法書籤要保留、壞欄位要剝掉', () => {
  // ⚠️ 又是「函式有考題、接線沒考題」：sanitizeInsightState 本身逐項有考題，
  //    但沒有一條驗它掛在唯一寫入口。接線拆掉＝「還原壞備份／手改 store 不會讓差異引擎崩」
  //    這個防護實際上不存在，而單元考題還是全綠、看起來守著。
  // ⚠️ 考題設計（第一版是空包彈，Codex #410 r1 H② 抓到）：第一版只送 'oops' 並檢查「結果是某個
  //    object」⇒ 把接線改成 `out.insightState = {}`（每次寫入都清空書籤）照樣綠。
  //    這一版**混入合法與非法欄位**，斷言合法值逐一保留、壞值剝除——清空型的突變會被抓到。
  const bad = sanitizeDbForWrite({
    settings: {},
    insightState: {
      lastSeenAt: '2026-08-05T00:00:00.000Z',      // 合法：字串
      netWorth: 1234567,                            // 合法：有限數字
      usdTwd: 'not-a-number',                       // 壞：該剝掉
      reminders: [
        { key: 'goal-reached', title: '達標', module: '總覽', level: 'info' },   // 合法
        { title: '沒有 key 的要被丟掉' },                                        // 壞：沒有 key
        'not-an-object',                                                        // 壞
      ],
      junkField: 'should be dropped',                // 壞：不在白名單
    },
  }, { mode: 'throw' });
  const st = /** @type {any} */ (bad.insightState);
  assert.equal(st.lastSeenAt, '2026-08-05T00:00:00.000Z', '合法的字串欄位必須保留（清空型突變會在這裡紅）');
  assert.equal(st.netWorth, 1234567, '合法的數字欄位必須保留');
  assert.equal(st.usdTwd, undefined, '型別不對的欄位要剝掉');
  assert.equal(st.junkField, undefined, '白名單外的欄位要剝掉');
  assert.equal(st.reminders?.length, 1, '沒有 key 的與非物件的提醒都要丟掉，只留合法那一筆');
  assert.equal(st.reminders?.[0]?.key, 'goal-reached');
  // 非物件整包 → 空物件（原本那一半的行為，保留）
  const notObj = sanitizeDbForWrite({ settings: {}, insightState: 'oops' }, { mode: 'throw' });
  assert.deepEqual(notObj.insightState, {}, '整包不是物件時正規化成空物件');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、「儲存前自動備份」不是空頭支票（lib/services/store-rules.js）
// ─────────────────────────────────────────────────────────────────────────────

test('店名規則｜備份必須是「這次操作之前」的狀態（不是操作後、也不是永遠停在第一次）', async () => {
  // ⚠️ UI 上寫著「儲存前自動備份」。啟動備份 .bak 每個行程只寫一次，對「一天內改好幾次規則」
  //    毫無保護力＝空頭支票；這顆獨立的 pre-rules 備份才讓那句承諾是真的。
  // ⚠️ 考題設計（第一版是空包彈，Codex #410 r1 H① 抓到）：第一版只檢查「檔案存在＋大小 > 0」
  //    ⇒ 把 backupNow 移到寫入之後（備份到的是**修改後**狀態）、或改成「同名備份已存在就直接
  //    回成功」（永遠停在第一次的舊狀態）——兩種失效都照樣綠。
  //    這一版**直接讀備份裡的 kv.settings**，逐次斷言它是「本次之前、上一次之後」的狀態。
  const bak = `${TEST_STORE}.pre-rules.bak`;
  const readBackupRules = () => {
    const d = new DatabaseSync(bak);
    try {
      const row = /** @type {any} */ (d.prepare('SELECT data FROM kv WHERE key=?').get('settings'));
      const st = row ? JSON.parse(row.data) : {};
      return JSON.stringify(st.storeRules ?? null);
    } finally { d.close(); }
  };

  // 第 0 次：先讓資料庫裡有一份「舊規則」（走正式入口，形狀才對——storeRules 的真實形狀是
  //          {rename, canon, brand, chains, parkExempt}，手塞別的鍵會被櫃檯剝掉）
  store.save({ ...store.emptyDb() });
  await saveStoreRules({ chains: ['第0版'] });
  try { rmSync(bak); } catch { /* 上一步已產生一顆，刪掉以免混淆 */ }

  // 第 1 次儲存：備份裡應該是「第0版」（操作前）
  await saveStoreRules({ chains: ['第1版'] });
  assert.ok(existsSync(bak), '存規則之前必須留下 pre-rules 備份——沒有它，畫面上那句承諾是謊話');
  assert.match(readBackupRules(), /第0版/,
    '備份到的必須是**這次操作之前**的規則（抓到第1版＝備份時機在寫入之後，等於備份了已經被改掉的狀態）');
  assert.doesNotMatch(readBackupRules(), /第1版/, '備份不可含本次寫入的新規則');

  // 第 2 次儲存：備份要**更新**成「第1版」（不是永遠停在第0版）
  await saveStoreRules({ chains: ['第2版'] });
  assert.match(readBackupRules(), /第1版/,
    '同一個行程內第二次儲存，備份要換成「上一次之後、這次之前」的狀態'
    + '——永遠停在第一次＝一天內改好幾次規則時，只還原得回最早那一版');
  assert.doesNotMatch(readBackupRules(), /第2版/, '備份不可含本次寫入的新規則');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、備份的原子替換與殘骸清理（lib/store.js 兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('備份｜做同一顆備份失敗時，舊的那一份必須逐位元組完好（不可先刪舊再做新）', () => {
  // ⚠️ 註解寫明這是自審 r2 修過的病：「原寫法『先刪舊再做新』，若 VACUUM 失敗（例如硬碟滿）
  //    會兩頭空——而損毀還原指引指的正是這顆 .bak」。
  // ⚠️ 考題設計（前兩版都被抓，這是第三版）：
  //    v1（Codex r1 前）失敗目標用了**別的路徑** ⇒「先刪舊」刪的不是那顆、舊備份當然還在。
  //    v2（Codex #410 r1 H③）只比**檔案長度**、而且兩次快照之間沒有改動 live DB
  //       ⇒ 把舊備份改寫成同長度的垃圾照樣綠。
  //    這一版：①保存原始 Buffer 做 deepEqual（逐位元組）②兩次之間**改動 live DB**，
  //       這樣「失敗時被新內容覆寫」也會被抓到。
  const dir = mkdtempSync(join(tmpdir(), 'finance-bak-'));
  TRASH.push(dir);
  const dest = join(dir, 'good.bak');
  store.save({ ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] });
  store.snapshotTo(dest);                       // 上一次的好備份（內容＝42 那筆）
  const goodBytes = readFileSync(dest);
  assert.ok(goodBytes.byteLength > 0);

  // live DB 換成明顯不同的狀態——若失敗路徑「先刪舊再做新」，新內容就會蓋掉舊備份
  store.save({ ...store.emptyDb(), history: [{ id: 'm2', month: '2026-08', amount: 999999 }] });
  mkdirSync(dest + '.tmp');                     // 讓下一次備份在「寫 .tmp」這一步就失敗
  assert.throws(() => store.snapshotTo(dest), /.*/,
    '寫不進去時要拋錯——不拋錯代表它繞過了 .tmp、直接動了正式的備份檔');
  assert.ok(existsSync(dest), '這一次失敗，上一顆好備份必須還在（還原指引指的就是它）');
  assert.deepEqual(readFileSync(dest), goodBytes,
    '舊備份必須**逐位元組**完好——只比長度的話，被同長度的垃圾或新狀態覆寫都抓不到');
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
