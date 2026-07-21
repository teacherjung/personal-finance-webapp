// 伺服器端點的自動考試（B0）：這是階段 B 大改建的安全網——
// 之後把後端拆房間/換資料庫時，這些考題保證「對外行為完全不變」。
// 隔離原則：STORE_FILE 指向 os 暫存目錄的檔案（從 seed 複製），絕不碰真實 data/store.json。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

// 必須在 import server.js「之前」設好（store.js 在載入時就決定檔案路徑）
const TEST_STORE = join(tmpdir(), `finance-test-store-${process.pid}.db`);   // B3 起為 SQLite 檔
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
// stmtRef/storeKey/source/importBatch/importedAt 是服務層擁有的欄位、已退出 CRUD 白名單（Codex r11）：
// 考題要種「帳單交易」假資料時，以服務層身分走 repo 直寫（同 importRows，不經 pickWritable；
// 型別仍由櫃檯 sanitizeDbForWrite 驗）。絕不可為了種資料把白名單加回去。
const { addItem } = await import('../lib/repo.js');
const seedTx = (fields) => addItem('transactions', fields);
const server = app.listen(0, '127.0.0.1');   // 0＝隨機空埠，不會撞到 4321
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

const GET = async (p) => (await fetch(base + p)).json();
const SEND = (method) => async (p, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const POST = SEND('POST'), PUT = SEND('PUT'), DELETE_ = SEND('DELETE');

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

test('GET /api/summary：回傳完整總覽（seed 資料）', async () => {
  const s = await GET('/summary');
  assert.equal(typeof s.netWorth, 'number');
  assert.ok(s.netWorth > 0);
  assert.ok(Array.isArray(s.reminders));
  assert.equal(typeof s.subscriptions.count, 'number');
});

test('交易 CRUD：新增→讀回→修改→刪除', async () => {
  const created = await (await POST('/transactions', {
    date: '2026-07-05', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 120, note: '端點測試',
  })).json();
  assert.ok(created.id, '新增要回 id');
  const list1 = await GET('/transactions');
  assert.ok(list1.some((t) => t.id === created.id), '列表要包含新增的那筆');
  const updated = await (await PUT(`/transactions/${created.id}`, { category: '娛樂' })).json();
  assert.equal(updated.category, '娛樂');
  assert.equal(updated.amount, 120, '沒送的欄位要保留');
  await DELETE_(`/transactions/${created.id}`);
  const list2 = await GET('/transactions');
  assert.ok(!list2.some((t) => t.id === created.id), '刪除後列表不該再有');
});

test('PUT /api/settings：部分更新會合併、不會蓋掉其他設定', async () => {
  const before = await GET('/settings');
  const res = await (await PUT('/settings', { emergencyFundMonths: 9 })).json();
  assert.equal(res.emergencyFundMonths, 9);
  assert.equal(typeof res.ib, 'object', 'ib 設定要保留');
  assert.equal(res.usdTwd, before.usdTwd, '沒送的欄位要保留');
  await PUT('/settings', { emergencyFundMonths: before.emergencyFundMonths });   // 還原
});

test('POST /api/snapshot：記錄本月快照（本地日期，非 UTC）', async () => {
  const snap = await (await POST('/snapshot')).json();
  assert.match(snap.month, /^\d{4}-\d{2}$/);
  assert.match(snap.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(snap.date.startsWith(snap.month), '快照日期要落在快照月份內');
  assert.equal(typeof snap.netWorth, 'number');
});

test('POST /api/snapshot/auto（1-1）：同一天至多記一次，第二次跳過不重複寫', async () => {
  const r1 = await (await POST('/snapshot/auto')).json();
  assert.equal(typeof r1.recorded, 'boolean');
  assert.match(r1.snap.month, /^\d{4}-\d{2}$/);
  const thisMk = r1.snap.month;
  // 記錄後本月只會有一筆快照（同月覆蓋），且日期＝今天
  const after1 = ((await GET('/db')).snapshots || []).filter(s => s.month === thisMk);
  assert.equal(after1.length, 1, '本月快照唯一（同月覆蓋）');
  assert.ok(after1[0].date.startsWith(thisMk), '快照日期落在本月');
  // 第二次同日呼叫：recorded=false（跳過），本月快照數量不變
  const r2 = await (await POST('/snapshot/auto')).json();
  assert.equal(r2.recorded, false, '同一天第二次應跳過');
  const after2 = ((await GET('/db')).snapshots || []).filter(s => s.month === thisMk);
  assert.equal(after2.length, 1, '跳過後不會多出重複筆');
});

test('自動學習：帳單交易改分類 → /api/learned 記住 → 可刪除', async () => {
  const tx = seedTx({
    date: '2026-07-06', type: 'expense', category: '其他', subcategory: '未分類',
    amount: 50, note: '端點測試店', storeKey: '端點測試店', source: 'stmt',
  });
  await PUT(`/transactions/${tx.id}`, { category: '娛樂', subcategory: '' });
  const learned = await GET('/learned');
  assert.equal(learned['端點測試店']?.category, '娛樂', '改分類要被學起來');
  await POST('/learned/delete', { key: '端點測試店' });
  const after2 = await GET('/learned');
  assert.ok(!('端點測試店' in after2), '刪除學習後不該再有');
  await DELETE_(`/transactions/${tx.id}`);
});

test('欄位白名單：白名單外的欄位（含企圖覆寫 id）寫入時被剝掉', async () => {
  const created = await (await POST('/transactions', {
    id: 'HACK-ID', date: '2026-07-07', type: 'expense', category: '飲食', amount: 10,
    evil: '不在白名單', leverage: 999,
  })).json();
  assert.notEqual(created.id, 'HACK-ID', 'id 由伺服器配發，不可被覆寫');
  assert.ok(!('evil' in created) && !('leverage' in created), '白名單外欄位不該被存起來');
  assert.equal(created.amount, 10, '合法欄位照常寫入');
  await DELETE_(`/transactions/${created.id}`);
});

test('欄位白名單：更新時白名單外欄位一樣被剝掉', async () => {
  const tx = await (await POST('/transactions', { date: '2026-07-08', type: 'expense', category: '飲食', amount: 20 })).json();
  const updated = await (await PUT(`/transactions/${tx.id}`, { amount: 30, hack: 'x' })).json();
  assert.equal(updated.amount, 30);
  assert.ok(!('hack' in updated), '白名單外欄位不該進資料');
  await DELETE_(`/transactions/${tx.id}`);
});

test('輸入防呆：batch/delete 缺批次代號 → 400（在寫檔前擋下）', async () => {
  const res = await POST('/statement/batch/delete', {});
  assert.equal(res.status, 400);
});

test('輸入防呆：改不存在的交易 → 404', async () => {
  const res = await PUT('/transactions/__不存在__', { category: '飲食' });
  assert.equal(res.status, 404);
});

test('設定白名單（Codex）：擋下 IB 同步擁有欄位與未知欄位、合法欄位照寫', async () => {
  const before = await GET('/settings');
  await PUT('/settings', {
    usdTwd: before.usdTwd,                              // 合法：照常寫入
    ib: { lastEquity: { stock: 99999, cash: -99999 }, flexQueryId: before.ib?.flexQueryId || '' },
    fxTwd: { GBP: 41.5, EVIL: 'x' },                    // GBP 數值收、EVIL 非數值剝掉
    evilTop: 1,                                         // 未知頂層欄位剝掉
  });
  const s = await GET('/settings');
  assert.ok(!('evilTop' in s), '未知頂層欄位不該寫入');
  assert.notEqual(s.ib?.lastEquity?.stock, 99999, 'lastEquity 屬 IB 同步、前端不可偽造（影響槓桿/斷頭）');
  assert.equal(s.fxTwd?.GBP, 41.5, '合法匯率照常寫入');
  assert.ok(!('EVIL' in (s.fxTwd || {})), 'fxTwd 非數值項要被剝掉');
  // 機密投影（自主體檢）：GET /settings 剝掉 flexToken、改回報 flexTokenSet 布林（既有 flexQueryId 仍在）
  assert.ok(!('flexToken' in (s.ib || {})), 'flexToken 不可回傳到前端（機密投影）');
  assert.equal(typeof s.ib?.flexTokenSet, 'boolean', '改以 flexTokenSet 布林告知「已設定/未設定」');
  assert.ok('flexQueryId' in (s.ib || {}), 'ib 的非機密既有欄位（flexQueryId）保留');
});

test('匯入防呆（Codex）：集合型別錯誤 → 400，且不寫壞資料', async () => {
  const backup = await GET('/db');
  const res = await POST('/import', { settings: backup.settings, subscriptions: 'oops', holdings: 'oops' });
  assert.equal(res.status, 400);
  const sum = await GET('/summary');   // 確認沒被寫壞
  assert.equal(typeof sum.netWorth, 'number');
});

test('設定型別驗證（Codex#2-1）：usdTwd 錯型別被剝，summary 不變 NaN/null', async () => {
  const before = await GET('/settings');
  await PUT('/settings', { usdTwd: 'oops' });   // 字串 → Number()變 NaN 會污染核心計算
  const s = await GET('/settings');
  assert.equal(s.usdTwd, before.usdTwd, '錯型別的 usdTwd 應被剝掉、保留原值');
  const sum = await GET('/summary');
  assert.equal(typeof sum.netWorth, 'number');
  assert.ok(!Number.isNaN(sum.netWorth), 'netWorth 不可為 NaN');
  assert.notEqual(sum.netWorth, null, 'netWorth 不可為 null');
});

test('匯入型別驗證（Codex#2-2）：備份 settings.usdTwd 錯型別 → 剝掉補預設，summary 正常', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, settings: { ...backup.settings, usdTwd: 'oops' } };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true, '合法結構的備份仍可匯入（壞值被剝、非整檔退回）');
  const sum = await GET('/summary');
  assert.equal(typeof sum.netWorth, 'number');
  assert.ok(!Number.isNaN(sum.netWorth) && sum.netWorth !== null, 'usdTwd 壞值不可污染 summary');
  await POST('/import', backup);   // 還原
});

test('集合型別驗證（Codex#3-1）：holdings.price 錯型別被剝，summary 不變 NaN', async () => {
  const created = await (await POST('/holdings', {
    symbol: 'BADX', name: 'x', layer: 'stock', currency: 'TWD', quantity: 1, price: 'oops',
  })).json();
  assert.ok(created.id);
  assert.ok(!('price' in created) || typeof created.price === 'number', 'price:oops 不可被存成字串');
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth), 'netWorth 不可為 NaN');
  await DELETE_(`/holdings/${created.id}`);
});

test('集合數值：合法數字與數字字串都收、null 清空', async () => {
  const a = await (await POST('/holdings', { symbol: 'AAA', currency: 'TWD', quantity: 2, price: 100 })).json();
  assert.equal(a.price, 100);
  const b2 = await (await POST('/holdings', { symbol: 'BBB', currency: 'TWD', quantity: 1, price: '250' })).json();
  assert.equal(b2.price, 250, '數字字串應轉成數字');
  await DELETE_(`/holdings/${a.id}`); await DELETE_(`/holdings/${b2.id}`);
});

test('匯入集合型別驗證（Codex#3-2）：備份 holdings.price 錯型別 → 剝掉，summary 正常', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, holdings: [...(backup.holdings || []), { id: 'x1', symbol: 'BAD', quantity: 1, price: 'oops', currency: 'TWD', source: 'manual' }] };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true);
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth), 'holdings 壞值不可污染 summary');
  await POST('/import', backup);   // 還原
});

test('匯入 IB lastEquity 深層驗證（Codex#3-3）：cash 錯型別 → 丟棄 lastEquity 走 fallback', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, settings: { ...backup.settings, ib: { ...backup.settings.ib, lastEquity: { stock: 100, cash: 'oops' } } } };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true);
  const s = await GET('/settings');
  assert.ok(!s.ib?.lastEquity || typeof s.ib.lastEquity?.cash === 'number', '壞的 lastEquity 應被丟棄（不可留字串 cash 低估槓桿風險）');
  await POST('/import', backup);   // 還原
});

test('估值訊號回歸（#62 修正）：signals/capeManual 以數字送出可存進（表單是 number 型）', async () => {
  const before = await GET('/settings');
  await PUT('/settings', { signals: { china: 13, japan: 1.2, korea: 0.9, taiwanPE: 15, taiwanYield: 3, realYieldManual: 2.1 } });
  await PUT('/settings', { capeManual: 34.5 });
  const s = await GET('/settings');
  assert.equal(s.signals?.china, 13, '數字型的估值訊號要存得進（#62 曾誤剝）');
  assert.equal(s.capeManual, 34.5, '數字型 capeManual 要存得進');
  await PUT('/settings', { signals: before.signals || {}, capeManual: before.capeManual ?? '' });   // 還原
});

test('匯入每筆須為物件（Codex#4-1）：holdings:[null] 被濾掉，summary 不崩', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, holdings: [...(backup.holdings || []), null, 'garbage'] };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true);
  const sum = await GET('/summary');   // 修前：讀 null.currency → TypeError → 崩
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth), '非物件元素不可讓 summary 崩');
  await POST('/import', backup);   // 還原
});

test('集合布林轉換（Codex#4-2）：active:"false" 轉成 boolean false', async () => {
  const sub = await (await POST('/subscriptions', {
    name: '測試', category: '娛樂', amount: 100, cycle: 'monthly', status: 'active', active: 'false',
  })).json();
  assert.equal(sub.active, false, "字串 'false' 應轉成 boolean false（否則被當使用中、多算月費）");
  await DELETE_(`/subscriptions/${sub.id}`);
});

test('枚舉非法→400 而非剝掉（Codex#5-1）：cycle 亂值不可落到「月繳」危險預設', async () => {
  const res = await POST('/subscriptions', { name: 'x', category: '娛樂', amount: 1200, cycle: 'yearlyy', status: 'active' });
  assert.equal(res.status, 400, '非法 cycle 應拒絕（剝掉會被當月繳 1200→年 14400）');
});

test('accounts.type 枚舉→400（Codex#5-2）：擋 mortgagex 讓負債被當資產（淨值方向相反）', async () => {
  const bad = await POST('/accounts', { name: 'x', type: 'mortgagex', class: '負債', currency: 'TWD', balance: 100 });
  assert.equal(bad.status, 400, '非法 accounts.type 應拒絕');
  const ok = await (await POST('/accounts', { name: 'y', type: 'mortgage', class: '負債', currency: 'TWD', balance: 100 })).json();
  assert.equal(ok.type, 'mortgage', '合法 type 照常寫入');
  await DELETE_(`/accounts/${ok.id}`);
});

test('匯入雪快照非物件元素（Codex#5-3）：snapshots:[null] 被濾掉、dashboard 資料不崩', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, snapshots: [...(backup.snapshots || []), null, 'garbage'] };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true);
  const db = await GET('/db');
  assert.ok((db.snapshots || []).every((s) => s && typeof s === 'object'), 'snapshots 不應留下非物件元素');
  await POST('/import', backup);
});

test('匯入 learnedCategories 清理（Codex#5-4）：{bad:null} 被丟棄，設定頁讀 v.name 不崩', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, learnedCategories: { ...(backup.learnedCategories || {}), 壞資料: null, 好資料: { category: '飲食', name: '早餐店' } } };
  const res = await (await POST('/import', poisoned)).json();
  assert.equal(res.ok, true);
  const db = await GET('/db');
  assert.ok(!('壞資料' in (db.learnedCategories || {})), 'value 非物件應被丟棄');
  assert.equal(db.learnedCategories?.好資料?.name, '早餐店', '合法學習保留');
  await POST('/import', backup);
});

test('陣列元素形狀（Codex#5-5）：checkpoints:[null] 的壞元素被過濾', async () => {
  const r = await (await POST('/research', { symbol: 'CP1', checkpoints: [{ date: '2026-07-01', note: 'ok' }, null, 'garbage'] })).json();
  assert.ok(Array.isArray(r.checkpoints) && r.checkpoints.length === 1, '非物件元素應被過濾（否則研究卡讀 c.date 崩）');
  await DELETE_(`/research/${r.id}`);
});

test('匯入枚舉非法→整份拒絕（Codex#5-1 import）：備份含壞 cycle → 400', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, subscriptions: [...(backup.subscriptions || []), { id: 'z1', name: 'bad', amount: 1200, cycle: 'yearlyy', status: 'active' }] };
  const res = await POST('/import', poisoned);
  assert.equal(res.status, 400, '壞枚舉值的備份應被中止匯入');
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth));
});

test('集合布林/枚舉：合法值照常寫入', async () => {
  const sub = await (await POST('/subscriptions', {
    name: '測試2', category: '娛樂', amount: 1200, cycle: 'yearly', status: 'active', active: true, considerCancel: false,
  })).json();
  assert.equal(sub.cycle, 'yearly');
  assert.equal(sub.active, true);
  assert.equal(sub.considerCancel, false);
  await DELETE_(`/subscriptions/${sub.id}`);
});

test('research.checkpoints 須為陣列：字串被剝', async () => {
  const r = await (await POST('/research', { symbol: 'ZZZ', thesis: 't', checkpoints: 'nope' })).json();
  assert.ok(!('checkpoints' in r) || Array.isArray(r.checkpoints), 'checkpoints 非陣列應被剝');
  const r2 = await (await POST('/research', { symbol: 'YYY', checkpoints: [{ note: 'x' }] })).json();
  assert.ok(Array.isArray(r2.checkpoints) && r2.checkpoints.length === 1, '合法陣列 checkpoints 保留');
  await DELETE_(`/research/${r.id}`); await DELETE_(`/research/${r2.id}`);
});

test('幣別枚舉（Codex#6-1）：holdings.currency 亂值→400；合法幣別照寫', async () => {
  const bad = await POST('/holdings', { symbol: 'FX1', currency: 'TWDx', quantity: 1, price: 100 });
  assert.equal(bad.status, 400, '錯幣別會讓 derive fallback 到 USD、金額算錯，應拒絕');
  const ok = await (await POST('/holdings', { symbol: 'FX2', currency: 'JPY', quantity: 1, price: 100 })).json();
  assert.equal(ok.currency, 'JPY');
  await DELETE_(`/holdings/${ok.id}`);
});

test('source 是 IB 同步擁有（Codex#6-2）：CRUD 不可寫 source、匯入 source 亂值→400', async () => {
  const h = await (await POST('/holdings', { symbol: 'SRC', currency: 'USD', quantity: 1, price: 10, source: 'ib' })).json();
  assert.ok(!('source' in h), 'CRUD 不可設定 source（IB 同步擁有，避免偽裝 IB 持股藏槓桿）');
  await DELETE_(`/holdings/${h.id}`);
  const backup = await GET('/db');
  const poisoned = { ...backup, holdings: [...(backup.holdings || []), { id: 's1', symbol: 'X', currency: 'USD', quantity: 1, price: 1, source: 'ibx' }] };
  assert.equal((await POST('/import', poisoned)).status, 400, '匯入 source:ibx 應被拒絕');
});

test('ibCashCur 是 IB 同步擁有（Codex#6-3）：CRUD 不可寫', async () => {
  const a = await (await POST('/accounts', { name: '假IB', type: 'cash', class: '現金', currency: 'TWD', balance: -50, ibCashCur: 'TWD' })).json();
  assert.ok(!('ibCashCur' in a), 'CRUD 不可設定 ibCashCur（避免非 IB 帳戶被當 IB 融資污染槓桿）');
  await DELETE_(`/accounts/${a.id}`);
});

test('匯率須為正數（Codex#6-4）：負匯率被剝、usdTwd≤0 被剝、summary 不變負', async () => {
  const before = await GET('/settings');
  await PUT('/settings', { fxTwd: { GBP: -1 }, usdTwd: -5 });
  const s = await GET('/settings');
  assert.notEqual(s.fxTwd?.GBP, -1, '負匯率不可寫入（會讓外幣資產變負）');
  assert.ok(s.usdTwd > 0, 'usdTwd 必須為正');
  const sum = await GET('/summary');
  assert.ok(sum.netWorth === null || typeof sum.netWorth === 'number');
  await PUT('/settings', { usdTwd: before.usdTwd, fxTwd: before.fxTwd || {} });   // 還原
});

test('已移除的舊分類轉換端點 → JSON 404（使用者定 2026-07-18，改走分類管理）', async () => {
  const res = await POST('/migrate/categories');
  assert.equal(res.status, 404);
});

test('自審｜帳單金額上限：破億的列被跳過（防解析誤抓參考號碼）', async () => {
  const card = await (await POST('/cards', { name: '測試卡', type: 'credit', issuer: '台新' })).json();
  const res = await (await POST(`/cards/${card.id}/statement/import`, {
    transactions: [
      { date: '2026-07-01', amount: 999999999999, store: '亂數', desc: 'X', stmtRef: 'selftest-huge' },
      { date: '2026-07-01', amount: 500, store: '正常', desc: 'Y', stmtRef: 'selftest-ok' },
    ],
  })).json();
  assert.equal(res.imported, 1, '只匯入正常那筆');
  assert.equal(res.skipped, 1, '破億那筆被跳過');
  await DELETE_(`/cards/${card.id}`);
  const txs = await GET('/transactions');
  for (const t of txs.filter((x) => x.stmtRef === 'selftest-ok')) await DELETE_(`/transactions/${t.id}`);
});

test('日期型別牆（自審r2-H2）：endsOn 塞數字→400（修前會讓總覽永久崩潰）、壞日期→400', async () => {
  const r1 = await POST('/subscriptions', { name: 'x', category: '娛樂', amount: 100, cycle: 'monthly', status: 'active', endsOn: 20991231 });
  assert.equal(r1.status, 400, 'endsOn 數字會讓 derive 的 .slice() 炸掉 summary，必須擋');
  const r2 = await POST('/transactions', { date: 'garbage', type: 'expense', category: '飲食', amount: 100 });
  assert.equal(r2.status, 400, '壞格式日期會默默不被計入月現金流，必須擋');
  const r3 = await POST('/holdings', { symbol: 123, currency: 'TWD', quantity: 1, price: 10 });
  assert.equal(r3.status, 400, '數字代號會讓 .toUpperCase() 炸掉 computeAssets，必須擋');
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth), '擋下後 summary 一切正常');
});

test('匯入 settings 陣列洞（自審r2-M5）：settings:[] → 400，設定不被默默重設', async () => {
  const before = await GET('/settings');
  const res = await POST('/import', { settings: ['oops'], transactions: [] });
  assert.equal(res.status, 400, 'typeof []===object 不可繞過檢查');
  const after = await GET('/settings');
  assert.equal(after.usdTwd, before.usdTwd, '匯率不可被重設');
  assert.equal(after.ib?.flexToken, before.ib?.flexToken, 'IB token 不可被清空');
});

test('signals 巢狀合併（自審r2-M6）：只更新一個市場不可抹掉其他市場的手動估值', async () => {
  const before = await GET('/settings');
  await PUT('/settings', { signals: { china: 11, japan: 1.1, korea: 0.9, taiwanPE: 15, taiwanYield: 3, realYieldManual: 2 } });
  await PUT('/settings', { signals: { china: 12 } });   // 部分更新（修前：其他五個會被抹掉）
  const s = await GET('/settings');
  assert.equal(s.signals?.china, 12);
  assert.equal(s.signals?.japan, 1.1, '只更新中國不可抹掉日本');
  assert.equal(s.signals?.taiwanPE, 15, '只更新中國不可抹掉台股 PE');
  await PUT('/settings', { signals: before.signals || {} });   // 還原
});

test('服務費不學（HTTP 全鏈路）：PUT 改服務費分類 → learned 不長新鍵', async () => {
  const tx = seedTx({
    date: '2026-07-01', type: 'expense', category: '工作', subcategory: 'ChatGPT',
    amount: 70, note: '國外交易服務費-70.00', storeKey: '國外交易服務費-70.00', source: 'stmt',
  });
  await PUT(`/transactions/${tx.id}`, { category: '生活', subcategory: '日用品' });
  const learned = await GET('/learned');
  assert.ok(!('國外交易服務費-70.00' in learned), 'beforeSave 鏈路也不可學服務費');
  await DELETE_(`/transactions/${tx.id}`);
});

test('未知 API 路徑 → JSON 404（不再回 HTML）', async () => {
  const res = await fetch(base + '/nonexistent-endpoint');
  assert.equal(res.status, 404);
  assert.ok((res.headers.get('content-type') || '').includes('application/json'));
});

test('匯出備份：Content-Disposition 正確、內容可解析（資料安全最後防線）', async () => {
  const res = await fetch(base + '/export');
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="finance-backup-\d{4}-\d{2}\.json"/);
  const body = await res.json();
  assert.ok(body.settings && Array.isArray(body.transactions), '備份要含 settings 與集合');
});

test('整批改卡片（HTTP 全鏈路）：stmtRef 前綴重寫＋帳戶名更換＋目標卡去重', async () => {
  const cardA = await (await POST('/cards', { name: '甲卡', type: 'credit', issuer: '台新' })).json();
  const cardB = await (await POST('/cards', { name: '乙卡', type: 'credit', issuer: '富邦' })).json();
  // 甲卡匯入兩筆；乙卡先放一筆與其中一筆「同消費」（日期/金額/說明相同）
  const rows = [
    { date: '2026-07-02', amount: 100, desc: '店家一', store: '店家一', category: '飲食', subcategory: '', stmtRef: `${cardA.id}|2026-07-02|100|店家一` },
    { date: '2026-07-03', amount: 200, desc: '店家二', store: '店家二', category: '飲食', subcategory: '', stmtRef: `${cardA.id}|2026-07-03|200|店家二` },
  ];
  const imp = await (await POST(`/cards/${cardA.id}/statement/import`, { transactions: rows })).json();
  assert.equal(imp.imported, 2);
  await POST(`/cards/${cardB.id}/statement/import`, { transactions: [
    { date: '2026-07-02', amount: 100, desc: '店家一', store: '店家一', category: '飲食', subcategory: '', stmtRef: `${cardB.id}|2026-07-02|100|店家一` },
  ] });
  const r = await (await POST('/statement/reassign', { batchId: imp.batchId, toCardId: cardB.id })).json();
  assert.equal(r.moved, 1, '一筆成功搬到乙卡');
  assert.equal(r.dropped, 1, '與乙卡既有同筆消費 → 去重丟棄');
  const txs = await GET('/transactions');
  const moved = txs.find((t) => t.note === '店家二');
  assert.equal(moved.account, '乙卡');
  assert.ok(moved.stmtRef.startsWith(cardB.id + '|'), 'stmtRef 前綴要換成新卡 id');
  // 清理
  for (const t of txs.filter((x) => ['店家一', '店家二'].includes(x.note))) await DELETE_(`/transactions/${t.id}`);
  await DELETE_(`/cards/${cardA.id}`); await DELETE_(`/cards/${cardB.id}`);
});

test('型別牆封角（Codex#10-1/2）：cards.expiry 數字→400、history.month null→400', async () => {
  const r1 = await POST('/cards', { name: 'x', type: 'credit', expiry: 202612 });
  assert.equal(r1.status, 400, 'expiry 數字會讓卡片頁 .slice 崩，必須擋');
  const r2 = await POST('/history', { month: null, amount: 100 });
  assert.equal(r2.status, 400, 'history.month 是主鍵欄，null 會讓歷史頁崩，必須擋');
});

test('匯入唯讀集合也過牆（Codex#10-3）：ibTrades.date 數字 → 400', async () => {
  const backup = await GET('/db');
  const poisoned = { ...backup, ibTrades: [{ symbol: 'X', date: 20260101 }] };
  assert.equal((await POST('/import', poisoned)).status, 400, '數字 date 會讓投組頁 .localeCompare 崩');
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth));
});

test('匯入巢狀設定 fail-closed（Codex#10-4）：settings.signals 陣列 → 400、設定不動', async () => {
  const before = await GET('/settings');
  const backup = await GET('/db');
  const poisoned = { ...backup, settings: { ...backup.settings, signals: ['oops'] } };
  assert.equal((await POST('/import', poisoned)).status, 400, '巢狀陣列不可被靜默重設成預設');
  const after = await GET('/settings');
  assert.equal(after.usdTwd, before.usdTwd);
  assert.deepEqual(after.signals, before.signals, 'signals 不可被清掉');
});

test('匯入 fail-closed（Codex r13 複審#2）：收入別名型別錯（外層陣列／內層非字串）→ 400、設定不動', async () => {
  const before = await GET('/settings');
  const backup = await GET('/db');
  // ① 外層陣列（typeof []==='object' 會繞過 sanitize 的靜默剝除）→ 走匯入第 79 行巢狀物件檢查
  const p1 = { ...backup, settings: { ...backup.settings, incomeCategoryAliases: ['oops'] } };
  assert.equal((await POST('/import', p1)).status, 400, 'incomeCategoryAliases 陣列不可靜默剝除');
  // ② 內層值非字串 → sanitize 記 bad、走第 134 行 wiped 判斷（同 expenseTree/categoryAliases 口徑）
  const p2 = { ...backup, settings: { ...backup.settings, incomeSubAliases: { '工作': { '薪資': 123 } } } };
  assert.equal((await POST('/import', p2)).status, 400, 'incomeSubAliases 內層非字串不可靜默剝除');
  const after = await GET('/settings');
  assert.equal(after.usdTwd, before.usdTwd, '被拒的匯入不可動到其他設定');
});

test('必填欄位（Codex#11-1）：完全沒傳 month 的三種路徑全被擋', async () => {
  // ① CRUD 新增
  const r1 = await POST('/history', { amount: 100 });
  assert.equal(r1.status, 400, 'POST history 缺 month → 400（修前入庫後歷史頁 .slice 崩）');
  // ② 匯入 portfolioSnapshots 缺 month
  const backup = await GET('/db');
  const p2 = { ...backup, portfolioSnapshots: [{ cost: 100, value: 120 }] };
  assert.equal((await POST('/import', p2)).status, 400, '匯入缺 month 的投組快照 → 400（修前投組頁 .split 崩）');
  // ③ 匯入 snapshots 缺 month
  const p3 = { ...backup, snapshots: [{ netWorth: 100, assets: 100, liabilities: 0, date: '2026-07-01' }] };
  assert.equal((await POST('/import', p3)).status, 400, '匯入缺 month 的淨值快照 → 400（修前快照排序崩）');
  const sum = await GET('/summary');
  assert.ok(typeof sum.netWorth === 'number' && !Number.isNaN(sum.netWorth), '全部擋下、summary 正常');
});

test('匯入正常：合法備份可還原、且還原後 summary 正常', async () => {
  const backup = await GET('/db');   // 用現有 db 當備份 → 冪等，不影響其他考題
  const res = await (await POST('/import', backup)).json();
  assert.equal(res.ok, true);
  const sum = await GET('/summary');
  assert.ok(sum.netWorth > 0);
});

test('資產配置目標整批取代（護欄 G1）：一次原子取代；壞一筆＝整批 400、原目標完全不動', async () => {
  const orig = await GET('/assetTargets');   // 收尾還原，免污染其他考題
  const r = await POST('/assetTargets/replace', { targets: [{ class: '股票', targetPct: 60 }, { class: '債券', targetPct: 40 }] });
  assert.equal(r.status, 200);
  const cur = await GET('/assetTargets');
  assert.deepEqual(cur.map(t => t.class).sort(), ['股票', '債券'].sort());
  assert.ok(cur.every(t => t.id), '取代後每筆有配 id');
  // 壞一筆（targetPct 非數字）→ 整批 400，原目標完全不動（原子：先全驗才寫；壞在第 2 筆，第 1 筆也不可落地）
  const bad = await POST('/assetTargets/replace', { targets: [{ class: '現金', targetPct: 50 }, { class: '黃金', targetPct: 'oops' }] });
  assert.equal(bad.status, 400);
  assert.deepEqual((await GET('/assetTargets')).map(t => t.class).sort(), ['股票', '債券'].sort(), '壞資料被拒→原目標沒被半刪半建');
  // 空陣列 → 原子清空；非陣列 → 400
  await POST('/assetTargets/replace', { targets: [] });
  assert.deepEqual(await GET('/assetTargets'), []);
  assert.equal((await POST('/assetTargets/replace', { targets: 'oops' })).status, 400);
  await POST('/assetTargets/replace', { targets: orig.map(t => ({ class: t.class, targetPct: t.targetPct })) });   // 還原 seed
});

test('備份 round-trip（護欄 G2）：所有服務層 settings＋頂層 KV（收入樹/收入別名/內轉子分類/銀行學習）都活得過 export→import', async () => {
  const orig = await GET('/export');   // 完整備份（含機密），收尾還原免污染
  const seeded = {
    ...orig,
    learnedBank: { 'CD轉入|#806****1206': { type: 'income', category: '工作', subcategory: '鐘點', name: 'William 家教費' } },
    transferSubs: [{ label: '匯出', role: 'out' }, { label: '匯入', role: 'in' }, { label: '結算', role: 'settle' }, { label: '還卡費' }],
    settings: {
      ...orig.settings,
      incomeTree: { '投資收入': ['利息', '股息'], '其他': ['其他收入'] },
      incomeCategoryAliases: { '被動': '投資收入' },
      incomeSubAliases: { '投資收入': { '配息': '股息' } },
    },
  };
  assert.equal((await POST('/import', seeded)).status, 200);
  const exported = await GET('/export');                      // 匯出自己
  assert.equal((await POST('/import', exported)).status, 200);   // 再匯入（round-trip）
  const db = await GET('/db');
  // 頂層 KV
  const lb = db.learnedBank['CD轉入|#806****1206'];
  assert.ok(lb, 'learnedBank 保留');
  assert.equal(lb.type, 'income'); assert.equal(lb.category, '工作'); assert.equal(lb.subcategory, '鐘點'); assert.equal(lb.name, 'William 家教費');
  assert.deepEqual(db.transferSubs.map(s => s.label), ['匯出', '匯入', '結算', '還卡費'], 'transferSubs 標籤與順序保留');
  assert.equal(db.transferSubs.find(s => s.label === '結算').role, 'settle', '角色保留');
  assert.ok(!db.transferSubs.find(s => s.label === '還卡費').role, '自訂項無角色');
  // settings 服務層欄位（r13 新增）
  assert.ok(db.settings.incomeTree['投資收入'], 'incomeTree 保留');
  assert.equal(db.settings.incomeCategoryAliases['被動'], '投資收入', '收入大類別名保留');
  assert.equal(db.settings.incomeSubAliases['投資收入']['配息'], '股息', '收入子類別名保留');
  await POST('/import', orig);   // 還原完整備份
});

test('帳戶改名連動既有交易 account（改一次、處處同步，使用者定 2026-07-21）', async () => {
  const acc = await (await POST('/accounts', { name: '台新舊名XYZ', type: 'cash', currency: 'TWD', balance: 1000 })).json();
  const t1 = await (await POST('/transactions', { type: 'expense', date: '2026-06-01', amount: 100, account: '台新舊名XYZ', note: '午餐', category: '飲食', subcategory: '' })).json();
  const t2 = await (await POST('/transactions', { type: 'income', date: '2026-06-02', amount: 200, account: '別的帳戶ABC', note: '薪水', category: '工作', subcategory: '' })).json();
  await PUT('/accounts/' + acc.id, { name: '台新活存NEW' });
  const txs = await GET('/transactions');
  assert.equal(txs.find(t => t.id === t1.id).account, '台新活存NEW', '同帳戶名的手動交易跟著改（字串連動）');
  assert.equal(txs.find(t => t.id === t2.id).account, '別的帳戶ABC', '別帳戶的交易不受影響');
  await DELETE_('/transactions/' + t1.id); await DELETE_('/transactions/' + t2.id); await DELETE_('/accounts/' + acc.id);
});

test('帳戶改名連動銀行交易：身分比對修既有 stale（匯入叫「台新 X」、改名後舊交易也對齊，使用者定 2026-07-21）', async () => {
  const acc = await (await POST('/accounts', { name: '台新 9999', type: 'cash', currency: 'TWD', balance: 0, accountNo: '900100****9999' })).json();
  const bt = seedTx({ source: 'bank', account: '過期自動名 9999', type: 'income', category: '被動', subcategory: '利息', amount: 10, date: '2026-06-01', ledger: 'cashflow', bankRef: 'bank|900100****9999|2026-06-01|in|10||存款息|' });
  await PUT('/accounts/' + acc.id, { name: '【台新】活儲9999' });   // 顯示字串完全不同，仍靠遮罩帳號身分對齊
  assert.equal((await GET('/transactions')).find(t => t.id === bt.id).account, '【台新】活儲9999', '舊 stale 銀行交易也對齊到現名');
  await DELETE_('/transactions/' + bt.id); await DELETE_('/accounts/' + acc.id);
});

test('POST /accounts/reconcile-names（開 app 自動）：既有 stale 銀行交易顯示名對齊到帳戶現名', async () => {
  const acc = await (await POST('/accounts', { name: '對齊測試帳戶', type: 'cash', currency: 'TWD', balance: 0, accountNo: '900300****7777' })).json();
  const bt = seedTx({ source: 'bank', account: '過期名 7777', type: 'expense', category: '其他', subcategory: '未分類', amount: 5, date: '2026-06-01', ledger: 'cashflow', bankRef: 'bank|900300****7777|2026-06-01|out|5||跨轉手續費|' });
  const r = await (await POST('/accounts/reconcile-names', {})).json();
  assert.ok(r.changed >= 1, '有 stale → 回報改動筆數');
  assert.equal((await GET('/transactions')).find(t => t.id === bt.id).account, '對齊測試帳戶');
  await DELETE_('/transactions/' + bt.id); await DELETE_('/accounts/' + acc.id);
});

test('POST /accounts/reconcile-names：順手補回被洗空的銀行交易說明（存款息，使用者回報 2026-07-22）', async () => {
  const bt = seedTx({ source: 'bank', account: '台新', note: '', type: 'income', category: '被動', subcategory: '利息', amount: 7, date: '2026-06-01', ledger: 'cashflow', bankRef: 'bank|900999****3301|2026-06-01|in|7||存款息|' });
  await POST('/accounts/reconcile-names', {});
  assert.equal((await GET('/transactions')).find(t => t.id === bt.id).note, '存款息', '空說明→自動名（bankRef 反解）');
  await DELETE_('/transactions/' + bt.id);
});

test('店名對照表編輯（HTTP 全鏈路）：以「原文」為準——同 storeKey 的不同分店可各自取名', async () => {
  // 銀行截斷情境：兩個不同原文（桃/新分店）共用同一個 storeKey（使用者實際踩到的 12MINI 案例）
  const origA = '測試分店 (桃X999 Taipei', origB = '測試分店 (新X999 Taipei';
  const t1 = seedTx({ date: '2026-07-10', type: 'expense', category: '飲食', amount: 55, note: '測試分店', storeKey: '測試分店', stmtRef: `c1|2026-07-10|55|${origA}`, source: 'stmt' });
  const t2 = seedTx({ date: '2026-07-11', type: 'expense', category: '飲食', amount: 66, note: '測試分店', storeKey: '測試分店', stmtRef: `c1|2026-07-11|66|${origB}`, source: 'stmt' });
  const t3 = seedTx({ date: '2026-07-12', type: 'expense', category: '飲食', amount: 77, note: '測試分店', storeKey: '測試分店', stmtRef: `c1|2026-07-12|77|${origA}`, source: 'stmt' });
  // 只改原文 A（桃）：A 的兩筆整批改，B（新）不動
  const r = await (await POST('/statement/rename-store', { orig: origA, name: '測試分店（桃園店）' })).json();
  assert.equal(r.changed, 2, '同原文的兩筆都改、不同原文不動');
  const after = await GET('/transactions');
  const get = (id) => after.find(t => t.id === id);
  assert.equal(get(t1.id).note, '測試分店（桃園店）');
  assert.equal(get(t3.id).note, '測試分店（桃園店）');
  assert.equal(get(t2.id).note, '測試分店', '不同原文（新店）不可被連動改名');
  assert.equal((await GET('/learned'))[origA]?.name, '測試分店（桃園店）', '學習以原文為 key（未來匯入同原文沿用）');
  assert.ok(!(await GET('/learned'))[origB], '沒改的原文不長學習');
  // 改回自動名（cleanStore(origA)＝截斷括號後＝「測試分店」）＝取消自訂：學習清除
  await POST('/statement/rename-store', { orig: origA, name: '測試分店' });
  assert.ok(!(await GET('/learned'))[origA]?.name, '改回自動名要清除自訂');
  // 分類一起編輯（合併卡）：同原文整批改分類＋學習記分類（與自動分類不同才記）
  await POST('/statement/rename-store', { orig: origA, name: '測試分店（桃園店）', category: '交通', subcategory: '停車費' });
  const after2 = await GET('/transactions');
  const g2 = (id) => after2.find(t => t.id === id);
  assert.equal(g2(t1.id).category, '交通'); assert.equal(g2(t1.id).subcategory, '停車費');
  assert.equal(g2(t3.id).category, '交通', '同原文的分類整批改');
  assert.equal(g2(t2.id).category, '飲食', '不同原文的分類不可被連動');
  const le = (await GET('/learned'))[origA];
  assert.equal(le?.category, '交通', '分類與自動判斷不同→記進學習（未來匯入沿用）');
  assert.equal(le?.name, '測試分店（桃園店）');
  // 還原自動判斷（reset）：店名回 cleanStore、分類回自動分類、學習整筆清除
  const rr = await (await POST('/statement/rename-store', { orig: origA, reset: true })).json();
  assert.ok(rr.changed >= 2);
  const after3 = await GET('/transactions');
  const g3 = (id) => after3.find(t => t.id === id);
  assert.equal(g3(t1.id).note, '測試分店', 'reset 後店名回自動清理名');
  assert.equal(g3(t1.id).category, '其他', 'reset 後分類回自動判斷（無關鍵字命中→其他/未分類）');
  assert.ok(!(await GET('/learned'))[origA], 'reset 清除整筆學習');
  // 防呆：缺原文／空名 → 400
  assert.equal((await POST('/statement/rename-store', { name: 'x' })).status, 400);
  assert.equal((await POST('/statement/rename-store', { orig: origA, name: '  ' })).status, 400);
  // 清理
  for (const id of [t1.id, t2.id, t3.id]) await DELETE_(`/transactions/${id}`);
});

test('店名格式整理（HTTP 全鏈路）：預覽不寫檔、套用改 note＋storeKey、冪等', async () => {
  const tx = seedTx({
    date: '2026-07-08', type: 'expense', category: '飲食', subcategory: '超市',
    amount: 55, note: '統一超商-百福', storeKey: '統一超商-百福', source: 'stmt',
  });
  // 預覽（dryRun）：回 before→after，且不改資料
  const prev = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(prev.changed >= 1);
  assert.ok((prev.changes || []).some(c => c.before === '統一超商-百福' && c.after === '統一超商（百福）'));
  const still = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(still.note, '統一超商-百福', 'dryRun 不可改資料');
  // 不帶 force 的套用要被擋（Codex r5#8）：這條維護路不經確認閘門，繞過必須「明說」
  const noForce = await POST('/statement/normalize-branches', {});
  assert.equal(noForce.status, 400, '空 body 不可默默套用');
  assert.equal((await GET('/transactions')).find(t => t.id === tx.id).note, '統一超商-百福', '被擋下＝資料不動');
  // 正式套用（明確帶 force）：note 與 storeKey 一併正規化
  const applied = await (await POST('/statement/normalize-branches', { force: true })).json();
  assert.ok(applied.changed >= 1);
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after.note, '統一超商（百福）', '套用後 note 已正規化');
  assert.equal(after.storeKey, '統一超商', 'storeKey＝身分鑰匙（品牌層、不含分店）');
  // 冪等：此筆已正規化，再預覽不應再出現
  const again = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(!(again.changes || []).some(c => c.id === tx.id), '已正規化的筆不再出現在預覽');
  await DELETE_(`/transactions/${tx.id}`);
});

test('停車店名治療（HTTP 全鏈路，使用者回報 2026-07-18）：整理拆殼修舊 note、storeKey 搬家、學習表錯名一併治', async () => {
  const origT = '聯信-台灣普客二四股份有A0145 NEW TA';
  // 舊爛資料重現：note 包著標記的錯名（巢狀括號）、storeKey 是舊規則的產物
  const tx = seedTx({
    date: '2026-07-13', type: 'expense', category: '交通', subcategory: '停車費', amount: 40,
    note: '停車費（停車場（Times））', storeKey: '聯信（Times Parking股份有）',
    stmtRef: `c9|2026-07-13|40|${origT}`, source: 'stmt',
  });
  // 學習表塞當年的垃圾（原文級錯名＋舊 storeKey 級學習）——經備份匯入路徑 seed
  const backup = await GET('/db');
  const seeded = { ...(backup.learnedCategories || {}) };
  seeded[origT] = { name: '停車場（Times）' };
  seeded['聯信（Times Parking股份有）'] = { name: 'Times Parking', category: '交通', subcategory: '停車費' };
  assert.equal((await POST('/import', { ...backup, learnedCategories: seeded })).status, 200);
  // 店名格式整理（套用）：note 先拆殼再治、storeKey 用原文重算、學習 key 跟著 storeKey 搬、學過的錯名一併治
  const applied = await (await POST('/statement/normalize-branches', { force: true })).json();
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  // 自訂名逐字（使用者定 2026-07-20）：殘骸名治好＝乾淨店名「台灣普客二四」，但不再自動補「停車費（）」包裝——
  // 停車費屬性由分類欄呈現（下方 subcategory 斷言），顯示名逐字，才不會把使用者刻意拿掉的包裝硬加回去。
  assert.equal(after.note, '台灣普客二四', '包著停車標記的舊殘骸名要能治（拆殼→整理成乾淨店名），但不自動補停車包裝');
  assert.equal(after.subcategory, '停車費', '停車屬性保留在分類欄');
  assert.equal(after.storeKey, '台灣普客二四', 'storeKey 用原文重算：聯信前綴＋「股份有」殘尾都修掉');
  const learned = await GET('/learned');
  assert.equal(learned[origT]?.name, '台灣普客二四', '原文級學習：key 不動、錯名治好');
  assert.ok(!learned['聯信（Times Parking股份有）'], '舊 storeKey 的學習不可原地留下');
  assert.equal(learned['台灣普客二四']?.category, '交通', '搬家不可弄丟分類學習');
  assert.ok(!learned['台灣普客二四']?.name, '品牌層 key 不留顯示名——帶分店的名字改掛原文級（否則同品牌其他分店被連動改名）');
  assert.ok(applied.learnedNamesFixed >= 1, '治了幾個學過的錯名要回報');
  // 冪等：治好的不再出現在預覽
  const again = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(!(again.changes || []).some(c => c.id === tx.id), '治好的筆不再出現');
  // 還原自動判斷：#97 起 autoName 帶標記、storeKey 不帶——共用學習必須用 storeKey（cleanStore）找才清得掉
  const rr = await (await POST('/statement/rename-store', { orig: origT, reset: true })).json();
  assert.equal(rr.ok, true);
  const learned2 = await GET('/learned');
  assert.ok(!learned2[origT], 'reset 清原文級學習');
  assert.ok(!learned2['台灣普客二四'], 'reset 也清無人共用的 storeKey 級學習（修：不可拿帶標記的 autoName 當 key 找）');
  const after2 = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after2.note, '停車費（台灣普客二四）', 'reset 後＝自動判斷名（帶停車標記）');
  assert.equal(after2.subcategory, '停車費', '分類回自動判斷（普客二四 是停車費關鍵字）');
  await DELETE_(`/transactions/${tx.id}`);
});

test('店名格式整理｜自訂 vs 自動（使用者定 2026-07-18）：沒自訂的從原文重生（eTag 場站名救回）、自訂的保留', async () => {
  // A：自動名（學習表沒 name）——舊 note 已丟場站名，只有原文還留著 → 整理用現行規則從原文重生
  const ta = seedTx({
    date: '2026-07-14', type: 'expense', category: '交通', subcategory: '停車費', amount: 60,
    note: '停車費（eTag停車）', storeKey: 'eTag停車',
    stmtRef: 'c9|2026-07-14|60|eTag停車3087-H8:救國團林口運動中心', source: 'stmt',
  });
  // B：自訂名（rename-store 學了 name）——整理不可把自訂名洗掉
  const origB = 'QQ小館X999 Taipei';
  const tb = seedTx({
    date: '2026-07-13', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 300,
    note: 'QQ小館', storeKey: 'QQ小館', stmtRef: `c9|2026-07-13|300|${origB}`, source: 'stmt',
  });
  await POST('/statement/rename-store', { orig: origB, name: '我的愛店' });
  await (await POST('/statement/normalize-branches', { force: true })).json();
  const after = await GET('/transactions');
  const g = (id) => after.find(t => t.id === id);
  assert.equal(g(ta.id).note, 'eTag 停車（救國團林口運動中心）', '非自訂 → 從原文重生：場站名救回、名字已含停車不再包停車費（）');
  assert.equal(g(ta.id).storeKey, 'eTag 停車', 'storeKey＝品牌層身分鑰匙（場站在顯示名）');
  assert.equal(g(tb.id).note, '我的愛店', '自訂名（學習表有 name）→ 就地整理、保留自訂');
  // 清理：B 先還原自動（清學習）再刪
  await POST('/statement/rename-store', { orig: origB, reset: true });
  await DELETE_(`/transactions/${ta.id}`); await DELETE_(`/transactions/${tb.id}`);
});

test('自訂分類（HTTP）：GET 回生效樹、POST 改名連動舊交易，測後還原樹', async () => {
  const orig = await GET('/categories');
  assert.ok(orig['娛樂'] && orig['其他'].includes('未分類'), 'GET 回內建預設樹');
  const tx = await (await POST('/transactions', { date: '2026-07-09', type: 'expense', category: '娛樂', subcategory: '電影', amount: 120 })).json();
  // 娛樂 → 休閒
  const nt = {}; for (const k of Object.keys(orig)) nt[k === '娛樂' ? '休閒' : k] = orig[k];
  const r = await (await POST('/categories', { tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] })).json();
  assert.equal(r.ok, true);
  assert.ok(r.changedTx >= 1);
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after.category, '休閒', '舊交易一併改名');
  const tree2 = await GET('/categories');
  assert.ok('休閒' in tree2 && !('娛樂' in tree2), 'GET 回新樹');
  // 還原：休閒→娛樂、刪測試交易（避免污染其他考題）
  await POST('/categories', { tree: orig, parentRenames: [{ from: '休閒', to: '娛樂' }] });
  await DELETE_(`/transactions/${tx.id}`);
});

test('POST /api/categories 缺 tree → 400、不把分類刪光（Codex#6）', async () => {
  const before = await GET('/categories');
  const res = await POST('/categories', {});
  assert.equal(res.status, 400, '缺 tree 要 400');
  const after = await GET('/categories');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '缺 tree 不可把分類刪光');
});

test('匯入保留自訂分類樹與別名（Codex#1）：export→import 不遺失', async () => {
  const orig = await GET('/categories');
  const nt = {}; for (const k of Object.keys(orig)) nt[k === '娛樂' ? '休閒' : k] = orig[k];
  await POST('/categories', { tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] });
  const backup = await GET('/db');
  assert.ok(backup.settings.expenseTree?.['休閒'], '匯出含 expenseTree');
  assert.equal(backup.settings.categoryAliases?.['娛樂'], '休閒', '匯出含別名');
  await POST('/import', backup);   // 重新匯入自己的備份
  const s = await GET('/settings');
  assert.ok(s.expenseTree?.['休閒'], '匯入後 expenseTree 保留（不該退回系統預設）');
  assert.equal(s.categoryAliases?.['娛樂'], '休閒', '匯入後別名保留');
  await POST('/categories', { tree: orig, parentRenames: [{ from: '休閒', to: '娛樂' }] });   // 還原、免污染後續
});

test('店名整理不改壞原文級學習 key（Codex#4）', async () => {
  const orig = '全家便利商店-ZZ測試店A0145 TAIPEI';
  const tx = seedTx({ date: '2026-07-22', type: 'expense', category: '飲食', amount: 33, note: '全家商店（ZZ測試店）', storeKey: '全家商店（ZZ測試店）', stmtRef: `z|2026-07-22|33|${orig}`, source: 'stmt' });
  await POST('/statement/rename-store', { orig, name: '全家（ZZ我的店）' });   // 原文級學習（key＝原文）
  assert.equal((await GET('/learned'))[orig]?.name, '全家（ZZ我的店）', '前置：原文級學習存在');
  await POST('/statement/normalize-branches', { force: true });   // 跑店名整理
  assert.equal((await GET('/learned'))[orig]?.name, '全家（ZZ我的店）', '原文級 key 不可被 normalizeStoreDisplay 改寫');
  await DELETE_(`/transactions/${tx.id}`);
  await POST('/learned/delete', { key: orig });
});

test('還原自動判斷清共用學習——僅當 storeKey 未被其他原文共用（Codex#3）', async () => {
  const sk = 'ZZ共用店', oA = 'ZZ共用店 (甲X1 Taipei', oB = 'ZZ共用店 (乙X1 Taipei';
  const a1 = seedTx({ date: '2026-07-20', type: 'expense', category: '飲食', amount: 11, note: sk, storeKey: sk, stmtRef: `z|2026-07-20|11|${oA}`, source: 'stmt' });
  const b1 = seedTx({ date: '2026-07-21', type: 'expense', category: '飲食', amount: 22, note: sk, storeKey: sk, stmtRef: `z|2026-07-21|22|${oB}`, source: 'stmt' });
  await PUT(`/transactions/${a1.id}`, { category: '交通', subcategory: '停車費' });   // 造 storeKey 級學習
  assert.equal((await GET('/learned'))[sk]?.category, '交通', '前置：storeKey 學習已建立');
  await POST('/statement/rename-store', { orig: oA, reset: true });   // 共用時 reset
  assert.equal((await GET('/learned'))[sk]?.category, '交通', '共用時不可刪共用學習（誤傷其他分店）');
  await DELETE_(`/transactions/${b1.id}`);   // oB 移除→sk 變 oA 獨佔
  await POST('/statement/rename-store', { orig: oA, reset: true });
  assert.ok(!(await GET('/learned'))[sk], '獨佔時 reset 才清共用學習（未來匯入才是自動）');
  await DELETE_(`/transactions/${a1.id}`);
});

test('顯示標記（HTTP 全鏈路）：店名格式整理替舊資料補上（FP）與停車費（），storeKey 不受污染', async () => {
  // 舊資料樣態：匯入當時 FP 前綴已被砍掉、也還沒有停車標記
  const fpOrig = 'FP-ZZ測試小吃';
  const parkOrig = 'ZZ測試嘟嘟房A1234 TAIPEI';
  const t1 = seedTx({ date: '2026-07-25', type: 'expense', category: '飲食', subcategory: '外送', amount: 88, note: 'ZZ測試小吃', storeKey: 'ZZ測試小吃', stmtRef: `z|2026-07-25|88|${fpOrig}`, source: 'stmt' });
  const t2 = seedTx({ date: '2026-07-26', type: 'expense', category: '交通', subcategory: '停車費', amount: 60, note: 'ZZ測試嘟嘟房', storeKey: 'ZZ測試嘟嘟房', stmtRef: `z|2026-07-26|60|${parkOrig}`, source: 'stmt' });
  // 舊的 FP 記錄若曾被手動改成「主體（分店）」→ 整理後分店摘掉、變「主體（FP）」（外送不留分店）
  const t3 = seedTx({ date: '2026-07-27', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 99, note: 'ZZ迷你鍋（桃園店）', storeKey: 'ZZ迷你鍋', stmtRef: 'z|2026-07-27|99|FP-ZZ迷你鍋 (桃X9 Taipei', source: 'stmt' });
  const prev = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok((prev.changes || []).some(c => c.after === 'ZZ測試小吃（FP）'), '預覽要看得到 FP 標記');
  assert.ok((prev.changes || []).some(c => c.after === '停車費（ZZ測試嘟嘟房）'), '預覽要看得到停車標記（名字沒有「停車」二字也涵蓋）');
  await POST('/statement/normalize-branches', { force: true });
  const after = await GET('/transactions');
  const g = (id) => after.find(t => t.id === id);
  assert.equal(g(t1.id).note, 'ZZ測試小吃（FP）', '舊 FP 記錄由帳單原文補回標記');
  assert.equal(g(t1.id).storeKey, 'ZZ測試小吃', 'storeKey（身分鑰匙）不含標記');
  assert.equal(g(t2.id).note, '停車費（ZZ測試嘟嘟房）', '停車依分類套用');
  assert.equal(g(t2.id).storeKey, 'ZZ測試嘟嘟房', 'storeKey 不含標記');
  assert.equal(g(t3.id).note, 'ZZ迷你鍋（FP）', '外送不留分店：主體（分店）→ 主體（FP）');
  // 冪等：再跑一次不再變動這幾筆
  const again = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(!(again.changes || []).some(c => [t1.id, t2.id, t3.id].includes(c.id)), '已標記過的不再重複變動');
  for (const id of [t1.id, t2.id, t3.id]) await DELETE_(`/transactions/${id}`);
});

test('隔離確認：測試用的是暫存資料檔，不是真實 store.json', () => {
  assert.ok(TEST_STORE.startsWith(tmpdir()), '資料檔必須在系統暫存目錄');
  assert.ok(!TEST_STORE.includes('榮祥森'), '不可指向專案資料夾');
});

test('Codex#3/#2/#5｜整理：品牌層 name 一律搬原文級（key 沒變也要）、撞 key 欄位合併、缺 storeKey 補回', async () => {
  const origA = '統一超商-百福X999 TAIPEI', origB = '統一超商-德權X999 TAIPEI';
  const t1 = seedTx({ date: '2026-07-21', type: 'expense', category: '飲食', subcategory: '超市',
    amount: 51, note: '統一超商（百福）', storeKey: '統一超商', stmtRef: `cX|2026-07-21|51|${origA}`, source: 'stmt' });
  const t2 = seedTx({ date: '2026-07-22', type: 'expense', category: '飲食', subcategory: '超市',
    amount: 52, note: '統一超商（德權）', storeKey: '統一超商', stmtRef: `cX|2026-07-22|52|${origB}`, source: 'stmt' });
  // Codex#5：帳單交易完全沒有 storeKey（學習機制上線前匯入的舊資料）
  const origC = '石二鍋(林口家樂X999 Taipei';
  const t3 = seedTx({ date: '2026-07-23', type: 'expense', category: '飲食', subcategory: '餐廳',
    amount: 53, note: '石二鍋', stmtRef: `cX|2026-07-23|53|${origC}`, source: 'stmt' });
  // 種學習表：品牌層殘留 name（key 不會變動）＋撞 key 的兩條（一條只有 name、一條只有分類）
  const backup = await GET('/db');
  const seeded = { ...(backup.learnedCategories || {}) };
  seeded['統一超商'] = { name: '統一超商（舊自訂分店）', category: '飲食', subcategory: '超市' };
  seeded['全家便利商店'] = { name: '全家便利商店（漢中店）' };   // 整理後 key→全家商店，name 被摘掉剩空殼
  seeded['全家商店'] = { category: '飲食', subcategory: '超市' };   // 撞 key：分類不可被空殼擋掉
  assert.equal((await POST('/import', { ...backup, learnedCategories: seeded })).status, 200);

  await (await POST('/statement/normalize-branches', { force: true })).json();
  const after = await GET('/transactions');
  const g = (id) => after.find(t => t.id === id);
  // Codex#3：品牌 key 沒變（統一超商→統一超商）時，殘留的 name 以前留在品牌層＝往後每次整理都連動所有分店。
  // 搬家後「目前畫面不變」是刻意的（不驚嚇使用者），真正的不變量是「品牌層不再有 name」＋「之後改一家不連動另一家」。
  const learned = await GET('/learned');
  assert.ok(!learned['統一超商']?.name, '品牌層 entry 一律不留 name（否則同品牌全部連動）');
  assert.equal(learned['統一超商']?.category, '飲食', '品牌層的分類學習要留著');
  assert.equal(learned[origA]?.name, '統一超商（舊自訂分店）', 'name 改掛到原文級（正確的層）');
  assert.equal(learned[origB]?.name, '統一超商（舊自訂分店）', '共用該名字的每個原文都各自掛一份');
  // 真正的驗收：改其中一個原文，另一個不受影響
  await POST('/statement/rename-store', { orig: origA, name: '統一超商（百福門市）' });
  const after2 = await GET('/transactions');
  assert.equal(after2.find(t => t.id === t1.id).note, '統一超商（百福門市）');
  assert.equal(after2.find(t => t.id === t2.id).note, '統一超商（舊自訂分店）', '改一家分店不可連動另一家');
  // Codex#2：撞 key 時欄位層級合併——先到者被摘成空殼不可擋掉後到者的分類
  assert.equal(learned['全家商店']?.category, '飲食', '空物件（{}）不可吃掉另一條的分類學習');
  // Codex#5：缺 storeKey 的舊帳單資料要被補回品牌層鑰匙
  assert.equal(g(t3.id).storeKey, '石二鍋', '整理要替沒有鑰匙的帳單交易補寫鑰匙');
  for (const id of [t1.id, t2.id, t3.id]) await DELETE_(`/transactions/${id}`);
});

test('Codex#8｜匯入一律從帳單原文重算鑰匙，不信前端傳來的衍生值', async () => {
  const cards = await GET('/cards');
  const card = cards[0] || (await (await POST('/cards', { name: '測試卡X', type: 'credit' })).json());
  const desc = '統一超商-百福Z999 TAIPEI';
  const res = await (await POST(`/cards/${card.id}/statement/import`, { transactions: [{
    date: '2026-07-24', amount: 45, desc, store: '統一超商（百福）',
    storeKey: '停車費（全家便利商店（台北））（FP）',   // 惡意/舊分頁污染值
    category: '飲食', subcategory: '超市', stmtRef: `${card.id}|2026-07-24|45|${desc}`,
  }] })).json();
  assert.equal(res.imported, 1);
  const tx = (await GET('/transactions')).find(t => t.stmtRef === `${card.id}|2026-07-24|45|${desc}`);
  assert.equal(tx.storeKey, '統一超商', '鑰匙以帳單原文重算，前端傳的髒值不採用');
  await DELETE_(`/transactions/${tx.id}`);
});

test('Codex#4｜還原自動判斷：同品牌共用規則會被回報，可選擇一併清除', async () => {
  const origA = '八方雲集中山Y999 TAIPEI', origB = '八方雲集松江Y999 TAIPEI';
  const t1 = seedTx({ date: '2026-07-25', type: 'expense', category: '飲食', subcategory: '餐廳',
    amount: 61, note: '八方雲集（中山）', storeKey: '八方雲集', stmtRef: `cY|2026-07-25|61|${origA}`, source: 'stmt' });
  const t2 = seedTx({ date: '2026-07-26', type: 'expense', category: '飲食', subcategory: '餐廳',
    amount: 62, note: '八方雲集（松江）', storeKey: '八方雲集', stmtRef: `cY|2026-07-26|62|${origB}`, source: 'stmt' });
  const backup = await GET('/db');
  assert.equal((await POST('/import', { ...backup,
    learnedCategories: { ...(backup.learnedCategories || {}), '八方雲集': { category: '娛樂', subcategory: '' } } })).status, 200);
  // 只還原 A：品牌規則被 B 共用 → 保留，但要回報（否則使用者以為還原了，下次匯入又被套回去）
  const r1 = await (await POST('/statement/rename-store', { orig: origA, reset: true })).json();
  assert.equal(r1.brandRule?.key, '八方雲集');
  assert.ok(r1.brandRule.sharedCount >= 1, '要告訴使用者被幾個原文共用');
  assert.equal((await GET('/learned'))['八方雲集']?.category, '娛樂', '未經確認不可擅自清掉共用規則');
  // 使用者確認後一併清除
  const r2 = await (await POST('/statement/rename-store', { orig: origA, reset: true, clearBrand: true })).json();
  assert.equal(r2.ok, true);
  assert.ok(!(await GET('/learned'))['八方雲集'], 'clearBrand 才真的清掉共用規則');
  for (const id of [t1.id, t2.id]) await DELETE_(`/transactions/${id}`);
});

test('第一帖｜規則更新後自動整理：同一版規則只跑一次、有變動才寫檔', async () => {
  // 先塞一筆待整理的舊資料（規則升級後名字會變）
  const tx = seedTx({ date: '2026-07-27', type: 'expense', category: '飲食', subcategory: '超市',
    amount: 33, note: '統一超商-德權', storeKey: '統一超商-德權', source: 'stmt' });
  // 第一次：這個 DB 還沒記過任何規則指紋 → 會跑
  const r1 = await (await POST('/statement/normalize-auto', {})).json();
  assert.equal(r1.ran, true, '沒記過指紋＝規則等於「新的」，要跑一次');
  assert.ok(r1.rulesHash, '要回報這次套用的規則指紋');
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after.note, '統一超商（德權）', '自動整理真的有套用（使用者不必記得按套用）');
  assert.equal(after.storeKey, '統一超商', '鑰匙同步對齊到品牌層');
  // 第二次：同一版規則 → 不重跑（否則每次開 app 都白洗一次 .bak）
  const r2 = await (await POST('/statement/normalize-auto', {})).json();
  assert.equal(r2.ran, false, '同一版規則只跑一次');
  assert.equal(r2.rulesHash, r1.rulesHash);
  await DELETE_(`/transactions/${tx.id}`);
});

test('第一帖｜同店整批改分類＋預覽也回報鑰匙變動數', async () => {
  const mk = (d, note, amt) => seedTx({ date: d, type: 'expense', category: '其他', subcategory: '未分類',
    amount: amt, note, storeKey: '八方雲集', stmtRef: `cZ|${d}|${amt}|八方雲集${note}Z9 TAIPEI`, source: 'stmt' });
  const a = mk('2026-07-28', '中山', 71);
  const b = mk('2026-07-29', '松江', 72);
  const r = await (await POST('/statement/apply-category', { storeKey: '八方雲集', category: '飲食', subcategory: '餐廳' })).json();
  assert.equal(r.changed, 2, '同一把鑰匙的帳單交易全部改');
  const after = await GET('/transactions');
  for (const id of [a.id, b.id]) assert.equal(after.find(t => t.id === id).category, '飲食');
  assert.equal((await GET('/learned'))['八方雲集']?.category, '飲食', '分類學在品牌層（同品牌共用）');
  assert.ok(!(await GET('/learned'))['八方雲集']?.name, '品牌層不留顯示名');
  // 防呆
  assert.equal((await POST('/statement/apply-category', { category: '飲食' })).status, 400);
  assert.equal((await POST('/statement/apply-category', { storeKey: '八方雲集' })).status, 400);
  // 預覽要回報鑰匙變動數（自動整理沒有預覽，事後至少要說清楚改了什麼）
  const prev = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.equal(typeof prev.keyChanged, 'number', 'dryRun 也要算鑰匙變動');
  for (const id of [a.id, b.id]) await DELETE_(`/transactions/${id}`);
});

test('第一帖｜匯入完成摘要：回報第一次見到的店家與未分類筆數', async () => {
  const cards = await GET('/cards');
  const card = cards[0] || (await (await POST('/cards', { name: '摘要測試卡', type: 'credit' })).json());
  const d1 = '全新神秘小店QQ9 TAIPEI', d2 = '統一超商-德權QQ9 TAIPEI';
  const rows = [
    { date: '2026-07-30', amount: 11, desc: d1, store: '全新神秘小店', category: '其他', subcategory: '未分類', stmtRef: `${card.id}|2026-07-30|11|${d1}` },
    { date: '2026-07-30', amount: 12, desc: d2, store: '統一超商（德權）', category: '飲食', subcategory: '超市', stmtRef: `${card.id}|2026-07-30|12|${d2}` },
  ];
  const out = await (await POST(`/cards/${card.id}/statement/import`, { transactions: rows })).json();
  assert.equal(out.imported, 2);
  assert.ok(out.newStores.includes('全新神秘小店'), '沒見過的店要列進「第一次見到」');
  assert.equal(out.uncategorized, 1, '落在其他/未分類的筆數要回報');
  const txs = await GET('/transactions');
  for (const r of rows) { const t = txs.find(x => x.stmtRef === r.stmtRef); if (t) await DELETE_(`/transactions/${t.id}`); }
});

test('第二帖｜帳務體檢：七個偵測器各抓各的、略過可持久化與還原', async () => {
  const mk = (d, amt, cat, sub, note, key, orig) => seedTx({
    date: d, type: 'expense', category: cat, subcategory: sub, amount: amt,
    note, storeKey: key, stmtRef: `cH|${d}|${amt}|${orig}`, source: 'stmt' });
  const made = [];
  const add = async (...a) => { made.push(mk(...a).id); };
  // D5 未分類（兩筆同店）
  await add('2026-07-01', 99, '其他', '未分類', 'NextGen（USD/9.99）', 'NEXTGEN', 'NEXTGEN.AIH99');
  await add('2026-06-01', 99, '其他', '未分類', 'NextGen（USD/9.99）', 'NEXTGEN', 'NEXTGEN.AIH88');
  // D2 鑰匙吃錯店：醫院鑰匙底下混進火鍋店原文（真實案例）
  await add('2026-07-02', 800, '健康', '看診', '林口長庚醫院', '林口長庚醫院', '長庚醫療財團法人林口長庚紀念醫H1');
  await add('2026-07-03', 700, '健康', '看診', '林口長庚醫院', '林口長庚醫院', 'FP-錢都日式涮涮鍋(林口長庚店H2');
  // D1 前綴對＋D6 簽名對＋D7 分期
  await add('2026-07-04', 100, '飲食', '餐廳', '潮味決', '潮味決', '潮味決H3');
  await add('2026-07-05', 200, '飲食', '餐廳', '潮味決.湯滷專門店', '潮味決.湯滷專門店', '潮味決.湯滷專門店H4');
  await add('2026-07-06', 50, '生活', '3C產品', 'LINEPAY*none', 'LINEPAY*none', 'LINEPAY*noneH5');
  await add('2026-07-07', 60, '生活', '3C產品', 'LINEPAY*NONE', 'LINEPAY*NONE', 'LINEPAY*NONEH6');
  await add('2026-07-08', 1000, '生活', '3C產品', 'Apple A第03/12期', 'Apple A第03/12期', 'Apple A第03/12期H7');
  await add('2026-07-09', 1000, '生活', '3C產品', 'Apple A第04/12期', 'Apple A第04/12期', 'Apple A第04/12期H8');
  // D4 分類漂移：星巴克被記成娛樂（無學習）；D3 雜訊：尾端城市名
  await add('2026-07-10', 150, '娛樂', '電影', '星巴克', '星巴克', 'STARBUCKSH9 TAIPEI');
  await add('2026-07-11', 80, '飲食', '餐廳', '八方雲集Taipei', '八方雲集', '八方雲集H10');

  const h = await GET('/statement/health');
  const types = (id) => h.items.filter(x => x.id.startsWith(id));
  assert.ok(types('D5|NEXTGEN').length === 1, 'D5 未分類要聚合成一件');
  assert.equal(types('D5|NEXTGEN')[0].data.count, 2);
  assert.ok(types('D2|林口長庚醫院').length === 1, 'D2 要抓到鑰匙底下分類異質（醫院混火鍋）');
  assert.ok(h.items.some(x => x.id === 'D1|潮味決↔潮味決.湯滷專門店'), 'D1 前綴鑰匙對');
  assert.ok(h.items.some(x => x.type === 'key-dup' && x.data.keys.includes('LINEPAY*NONE')), 'D6 大小寫分家');
  assert.ok(h.items.some(x => x.type === 'installment' && x.data.keys.length === 2), 'D7 分期分裂聚成一件');
  const d4 = h.items.find(x => x.id.startsWith('D4|STARBUCKSH9 TAIPEI|'));
  assert.ok(d4, 'D4 分類漂移（星巴克≠娛樂、無學習）');
  assert.equal(d4.data.auto.category, '飲食');
  assert.ok(h.items.some(x => x.id.startsWith('D3|八方雲集H10|')), 'D3 顯示名殘留城市名');
  assert.ok(h.items[0].severity >= h.items[h.items.length - 1].severity, '嚴重度大到小排序');
  // r2-Codex#5：ID 要含「內容指紋」，內容變了舊的略過才不會永久蓋住新問題
  // D2/D3/D4/D7 加內容雜湊；D1/D6 的 ID 本來就含全部相關鑰匙＝已含內容；D5 刻意只用店家 key（見服務層說明）
  for (const it of h.items) {
    if (!['D2|', 'D3|', 'D4|', 'D7|'].some(pre => it.id.startsWith(pre))) continue;
    assert.ok(it.id.split('|').length >= 3, `項目 ID 要含內容指紋：${it.id}`);
  }
  // r2-Codex#7：略過只收「目前真的存在」的編號
  assert.equal((await POST('/statement/health/dismiss', { id: 'D9|完全不存在的項目' })).status, 400,
    '不存在的編號不可被寫進略過清單');
  // 略過：持久化＋還原
  const before = h.items.length;
  await POST('/statement/health/dismiss', { id: 'D5|NEXTGEN' });
  const h2 = await GET('/statement/health');
  assert.equal(h2.items.length, before - 1, '略過的不再出現');
  assert.equal(h2.dismissed, 1);
  await POST('/statement/health/dismiss', { clearAll: true });
  const h3 = await GET('/statement/health');
  assert.equal(h3.items.length, before, '清空略過＝全部重新顯示');
  assert.equal((await POST('/statement/health/dismiss', {})).status, 400, '缺 id 又沒 clearAll → 400');
  // D4 的兩個動作走 rename-store（既有端點）：保留現值 → 學起來 → 不再報
  await POST('/statement/rename-store', { orig: 'STARBUCKSH9 TAIPEI', name: '星巴克', category: '娛樂', subcategory: '電影' });
  const h4 = await GET('/statement/health');
  assert.ok(!h4.items.some(x => x.id === 'D4|STARBUCKSH9 TAIPEI'), '學過＝使用者故意的，不再報漂移');
  await POST('/statement/rename-store', { orig: 'STARBUCKSH9 TAIPEI', reset: true });
  for (const id of made) await DELETE_(`/transactions/${id}`);
  await POST('/statement/health/dismiss', { clearAll: true });
});

test('第二帖｜匯入留底 autoCat/autoSub（日後精確分辨「人改的 vs 機器判的」）', async () => {
  const cards = await GET('/cards');
  const card = cards[0] || (await (await POST('/cards', { name: '留底測試卡', type: 'credit' })).json());
  const desc = 'STARBUCKSAB12 TAIPEI';
  // 使用者在預覽把分類改成娛樂（≠自動的飲食）→ 匯入後留底要記「自動＝飲食」
  const out = await (await POST(`/cards/${card.id}/statement/import`, { transactions: [{
    date: '2026-07-31', amount: 120, desc, store: '星巴克', category: '娛樂', subcategory: '電影',
    stmtRef: `${card.id}|2026-07-31|120|${desc}` }] })).json();
  assert.equal(out.imported, 1);
  const tx = (await GET('/transactions')).find(t => t.stmtRef === `${card.id}|2026-07-31|120|${desc}`);
  assert.equal(tx.category, '娛樂', '使用者選的分類照存');
  assert.equal(tx.autoCat, '飲食', '匯入當下的純自動判斷留底');
  assert.equal(tx.autoSub, '飲料／咖啡');
  await DELETE_(`/transactions/${tx.id}`);
  await POST('/learned/delete', { key: '星巴克' });   // learnFromImport 學走的，清掉免污染其他考題
});

test('r2-Codex#1｜孤兒學習（交易已刪）不可被整理當成品牌級改寫或摘掉自訂名', async () => {
  const backup = await GET('/db');
  const orphan = '統一超商-德權';   // 沒有任何交易用這個 key／原文
  assert.equal((await POST('/import', { ...backup,
    learnedCategories: { ...(backup.learnedCategories || {}), [orphan]: { name: '我的自訂名', category: '飲食', subcategory: '超市' } } })).status, 200);
  await (await POST('/statement/normalize-branches', { force: true })).json();
  const learned = await GET('/learned');
  assert.ok(learned[orphan], '孤兒學習的 key 不可被改寫（改了未來匯入兩邊都命中不到）');
  assert.equal(learned[orphan].name, '我的自訂名', '孤兒學習的自訂名不可被當成品牌層摘掉');
  assert.equal(learned[orphan].category, '飲食');
  await POST('/learned/delete', { key: orphan });
});

test('r2-Codex#2/#3/#4｜同店整批改：清原文級分類、擋服務費、擋不存在的鑰匙', async () => {
  const origA = '八方雲集-中山R2 TAIPEI', origB = '八方雲集-松江R2 TAIPEI';
  const mk = (d, amt, orig, note) => seedTx({ date: d, type: 'expense', category: '飲食', subcategory: '餐廳',
    amount: amt, note, storeKey: '八方雲集', stmtRef: `cR|${d}|${amt}|${orig}`, source: 'stmt' });
  const a = mk('2026-08-01', 51, origA, '八方（中山）');
  const b = mk('2026-08-02', 52, origB, '八方（松江）');
  // A 有自己的原文級分類學習（單獨設過）
  await POST('/statement/rename-store', { orig: origA, name: '八方（中山）', category: '娛樂', subcategory: '電影' });
  assert.equal((await GET('/learned'))[origA]?.category, '娛樂');
  // 整店改分類 → 原文級的分類要被清掉（否則未來匯入 A 又被套回娛樂），但 name 保留
  const r = await (await POST('/statement/apply-category', { storeKey: '八方雲集', category: '交通', subcategory: '大眾運輸' })).json();
  assert.ok(r.origCleared >= 1, '要回報清掉幾筆原文級分類');
  const learned = await GET('/learned');
  assert.ok(!learned[origA]?.category, '原文級分類要清掉（品牌整批改的語意＝整個品牌都算這一類）');
  assert.equal(learned[origA]?.name, '八方（中山）', '顯示名是各分店自己的事，要保留');
  assert.equal(learned['八方雲集']?.category, '交通');
  // #4 不存在的鑰匙 → 404 且不留隱形規則
  assert.equal((await POST('/statement/apply-category', { storeKey: '根本不存在的店R2', category: '娛樂' })).status, 404);
  assert.ok(!(await GET('/learned'))['根本不存在的店R2'], '找不到交易就不可種下隱形品牌規則');
  // #3 服務費整組拒絕
  const fee = seedTx({ date: '2026-08-03', type: 'expense', category: '飲食', subcategory: '餐廳',
    amount: 30, note: '國外交易服務費（-900）', storeKey: '國外交易服務費（-900）',
    stmtRef: 'cR|2026-08-03|30|國外交易服務費-900.00', source: 'stmt' });
  assert.equal((await POST('/statement/apply-category', { storeKey: '國外交易服務費（-900）', category: '娛樂' })).status, 400);
  assert.equal((await GET('/transactions')).find(t => t.id === fee.id).category, '飲食', '服務費的分類由所屬消費決定，不可被整批改');
  for (const id of [a.id, b.id, fee.id]) await DELETE_(`/transactions/${id}`);
  await POST('/learned/delete', { key: '八方雲集' });
  await POST('/learned/delete', { key: origA });
});

test('r2-Codex#8｜autoCat/autoSub 不可由通用 CRUD 寫入（匯入服務層仍寫得進去）', async () => {
  const tx = await (await POST('/transactions', { date: '2026-08-04', type: 'expense', category: '飲食', amount: 10,
    autoCat: '娛樂', autoSub: '電影' })).json();
  assert.ok(!('autoCat' in tx) && !('autoSub' in tx), '前端不可偽造留底（偽造了體檢的人改/機器判會失準）');
  await DELETE_(`/transactions/${tx.id}`);
});

test('Codex r11｜服務層欄位不可由通用 CRUD 寫入：stmtRef/storeKey/source/importBatch/importedAt 全剝', async () => {
  // 手動記帳不可偽裝成帳單交易——source:'stmt' 會混進學習/批次列表/帳務體檢的口徑
  const tx = await (await POST('/transactions', { date: '2026-08-05', type: 'expense', category: '飲食', amount: 10,
    stmtRef: 'cE|2026-08-05|10|假原文', storeKey: '假鑰匙', source: 'stmt',
    importBatch: 'B假批次', importedAt: '2026-08-05T00:00:00.000Z' })).json();
  for (const f of ['stmtRef', 'storeKey', 'source', 'importBatch', 'importedAt']) {
    assert.ok(!(f in tx), `${f} 是帳單匯入服務層擁有的欄位，通用 CRUD 不可寫`);
  }
  await DELETE_(`/transactions/${tx.id}`);
});

test('Codex r11｜PUT 挾帶假 storeKey 不可劫持學習（毒化學習表的路要斷）', async () => {
  const orig = 'ZZ毒化測試店R11 TAIPEI';
  const tx = seedTx({ date: '2026-08-06', type: 'expense', category: '其他', subcategory: '未分類',
    amount: 42, note: 'ZZ毒化測試店', storeKey: 'ZZ毒化測試店', stmtRef: `cE|2026-08-06|42|${orig}`, source: 'stmt' });
  // 修正前：storeKey 通過 pickWritable → 合併進 item → learnFromStmtEdit 把分類學到假鑰匙上，
  // 未來匯入命中假鑰匙的店全被套錯分類（實測重現 2026-07-20）
  await PUT(`/transactions/${tx.id}`, { category: '娛樂', subcategory: '', storeKey: '假鑰匙星巴克' });
  const learned = await GET('/learned');
  assert.ok(!('假鑰匙星巴克' in learned), '假鑰匙不可長進學習表');
  assert.equal(learned['ZZ毒化測試店']?.category, '娛樂', '學習要落在庫裡的正牌鑰匙');
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after.storeKey, 'ZZ毒化測試店', '交易上的鑰匙不可被挾帶改寫');
  await DELETE_(`/transactions/${tx.id}`);
  await POST('/learned/delete', { key: 'ZZ毒化測試店' });
});

test('Codex r11｜還原備份保留服務層欄位（stmtRef 被剝＝帳單交易失去原文/去重/批次，絕不允許）', async () => {
  const ref = 'cE|2026-08-07|77|備份測試店E1 TAIPEI';
  const tx = seedTx({ date: '2026-08-07', type: 'expense', category: '飲食', subcategory: '', amount: 77,
    note: '備份測試店', storeKey: '備份測試店', stmtRef: ref,
    source: 'stmt', importBatch: 'B備份測試', importedAt: '2026-07-20T00:00:00.000Z' });
  const backup = await GET('/db');   // export→import 一圈（匯入走 validateImportItem：只驗型別、不剝白名單外欄位）
  assert.equal((await POST('/import', backup)).status, 200);
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after?.stmtRef, ref, '還原後 stmtRef 原樣保留');
  assert.equal(after.storeKey, '備份測試店');
  assert.equal(after.source, 'stmt');
  assert.equal(after.importBatch, 'B備份測試');
  assert.equal(after.importedAt, '2026-07-20T00:00:00.000Z');
  await DELETE_(`/transactions/${after.id}`);
});

test('帳單年月（使用者定 2026-07-19）：匯入時存進每一筆、批次回報、可手動修正', async () => {
  const cards = await GET('/cards');
  const card = cards[0] || (await (await POST('/cards', { name: '期別測試卡', type: 'credit' })).json());
  const d = '星巴克SM1 TAIPEI';
  const ref = `${card.id}|2026-06-15|60|${d}`;
  const out = await (await POST(`/cards/${card.id}/statement/import`, { transactions: [{
    date: '2026-06-15', amount: 60, desc: d, store: '星巴克', category: '飲食', subcategory: '飲料', stmtRef: ref,
  }], statementMonth: '2026-06', statementDue: 46299 })).json();
  assert.equal(out.imported, 1);
  const tx = (await GET('/transactions')).find(t => t.stmtRef === ref);
  assert.equal(tx.stmtMonth, '2026-06', '帳單期別存進交易');
  assert.equal(tx.stmtDue, 46299, '應繳金額存進交易');
  assert.notEqual(tx.stmtDue, 60, '應繳金額≠這批的消費總和，兩者是不同概念');
  const batch = (await GET('/statement/batches')).find(b => b.batchId === out.batchId);
  assert.equal(batch.stmtMonth, '2026-06', '批次列表回報期別');
  assert.equal(batch.stmtDue, 46299, '批次列表回報帳單應繳金額（與匯入金額本就不同）');
  // 手動修正（表頭讀不出或讀錯時的退路）
  const r = await (await POST('/statement/batch/month', { batchId: out.batchId, month: '2026-07' })).json();
  assert.equal(r.changed, 1);
  assert.equal((await GET('/statement/batches')).find(b => b.batchId === out.batchId).stmtMonth, '2026-07');
  // 清除 → 退回推估（欄位不存在，前端顯示推估值）
  await POST('/statement/batch/month', { batchId: out.batchId, month: '' });
  assert.ok(!(await GET('/statement/batches')).find(b => b.batchId === out.batchId).stmtMonth);
  // 防呆
  assert.equal((await POST('/statement/batch/month', { batchId: out.batchId, month: '2026/07' })).status, 400);
  assert.equal((await POST('/statement/batch/month', { batchId: '不存在的批次', month: '2026-07' })).status, 404);
  await DELETE_(`/transactions/${tx.id}`);
});

// ---- Codex r10 修正（HTTP 全鏈路）----

test('r10#2｜寫入端也剝機密：PUT /settings 與卡片 POST/PUT 回應不可含 flexToken／pdfPassword', async () => {
  // 先設一個 token，再改別的欄位 → PUT 回應不可把 token 送回（只 GET 剝、PUT 不剝＝改匯率就外洩）
  await PUT('/settings', { ib: { flexToken: 'SECRET_TOK_123', flexQueryId: 'Q1' } });
  const putRes = await (await PUT('/settings', { usdTwd: 33 })).json();
  assert.ok(!('flexToken' in (putRes.ib || {})), 'PUT /settings 回應不可含 flexToken');
  assert.equal(putRes.ib?.flexTokenSet, true, 'PUT /settings 回應改以 flexTokenSet 布林告知');
  // 卡片 POST：帶 pdfPassword → 回應剝掉、改回報 pdfPasswordSet
  const created = await (await POST('/cards', { name: 'r10投影卡', type: 'credit', pdfPassword: 'A123456789' })).json();
  assert.ok(!('pdfPassword' in created), 'POST /cards 回應不可含 pdfPassword');
  assert.equal(created.pdfPasswordSet, true);
  // 卡片 PUT：只改名字、沒送密碼 → 回應也不可把存的密碼吐回
  const putc = await (await PUT('/cards/' + created.id, { name: 'r10投影卡改名' })).json();
  assert.ok(!('pdfPassword' in putc), 'PUT /cards 回應不可含 pdfPassword（即使沒送也別把存的吐回）');
  await DELETE_('/cards/' + created.id);
  await PUT('/settings', { ib: { flexToken: '' } });   // 清掉，不污染後續
});

test('r10#3｜匯入內層也 fail-closed：自訂分類/店名規則有壞值 → 整份退回 400、不清空既有資料', async () => {
  const before = await GET('/categories');
  // 內層值型別錯（expenseTree 的值該是 string[]、storeRules.rename 該是陣列）→ 以前靜默剝除回 200、把樹/規則清空
  assert.equal((await POST('/import', { settings: { expenseTree: { 餐飲: 'oops' } } })).status, 400, 'expenseTree 內層壞值 → 400');
  assert.equal((await POST('/import', { settings: { storeRules: { rename: 'oops' } } })).status, 400, 'storeRules 內層壞值 → 400');
  assert.deepEqual(await GET('/categories'), before, '被拒的匯入不可改動既有分類樹（什麼都不動）');
});

test('r10#10｜可以真正清除機密：送空字串 → flexToken／pdfPassword 清空（flexTokenSet／pdfPasswordSet 變 false）', async () => {
  // flexToken
  await PUT('/settings', { ib: { flexToken: 'TOK_TO_CLEAR' } });
  assert.equal((await GET('/settings')).ib?.flexTokenSet, true, '設定後 flexTokenSet=true');
  await PUT('/settings', { ib: { flexToken: '' } });
  assert.equal((await GET('/settings')).ib?.flexTokenSet, false, '送空字串 → 清除，flexTokenSet=false');
  // pdfPassword
  const card = await (await POST('/cards', { name: 'r10清除卡', type: 'credit', pdfPassword: 'A123456789' })).json();
  assert.equal(card.pdfPasswordSet, true);
  await PUT('/cards/' + card.id, { pdfPassword: '' });
  assert.equal((await GET('/cards')).find(c => c.id === card.id)?.pdfPasswordSet, false, '送空字串 → 清除 pdfPassword');
  await DELETE_('/cards/' + card.id);
});

test('三層重構｜還原「重構前舊備份」(交易 source:stmt、缺 ledger)：/api/import 補上 ledger:card，手動列歸 cashflow', async () => {
  const backup = await GET('/db');
  const poisoned = {
    ...backup,
    transactions: [
      { id: 'legacy-card', date: '2026-04-10', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 500, account: '測試卡', source: 'stmt', stmtRef: 'x|2026-04-10|500|舊卡消費', note: '舊卡消費' },  // 舊卡消費，缺 ledger
      { id: 'legacy-manual', date: '2026-04-11', type: 'income', category: '薪資', subcategory: '', amount: 30000, note: '舊薪資' },  // 舊手動收入，缺 ledger、舊平面分類
    ],
  };
  assert.equal((await POST('/import', poisoned)).status, 200);
  const txs = await GET('/transactions');
  const card = txs.find(t => t.id === 'legacy-card');
  const manual = txs.find(t => t.id === 'legacy-manual');
  assert.equal(card.ledger, 'card', 'source:stmt 的舊卡消費 → 匯入端 normalizeLedger 補 ledger:card（否則會被當現金流雙算繳卡費）');
  assert.equal(manual.ledger, 'cashflow', '舊手動 → cashflow');
  assert.deepEqual([manual.category, manual.subcategory], ['工作', '薪資'], '舊平面收入分類歸新樹');
  await POST('/import', backup);   // 還原
});

test('三層重構 stage 2｜帳戶完整帳號 accountNo 投影：GET 剝除只回 set/last4、export 保留完整、可清除', async () => {
  const acc = await (await POST('/accounts', { name: '帳號投影卡', type: 'cash', currency: 'TWD', balance: 100, accountNo: '9001001234567890', balanceAsOf: '2099-01-01' })).json();
  assert.equal('accountNo' in acc, false, 'POST 回傳不含完整帳號');
  assert.equal(acc.accountNoSet, true);
  assert.equal(acc.accountNoLast4, '7890');
  assert.equal(acc.balanceAsOf, undefined, 'balanceAsOf 不在白名單、POST 帶了也被剝');
  const got = (await GET('/accounts')).find(a => a.id === acc.id);
  assert.equal('accountNo' in got, false, 'GET /accounts 不外洩完整帳號');
  assert.equal(got.accountNoSet, true);
  // export 一定要保留完整帳號（備份漏了還原就永久遺失）
  const backup = await GET('/db');   // 注意：/db 是投影過的，export 才完整
  assert.equal('accountNo' in (backup.accounts.find(a => a.id === acc.id)), false, '/api/db 也投影');
  const exp = await GET('/export');
  assert.equal(exp.accounts.find(a => a.id === acc.id).accountNo, '9001001234567890', '/api/export 保留完整帳號（供還原）');
  // 清除：送空字串
  await PUT('/accounts/' + acc.id, { accountNo: '' });
  assert.equal((await GET('/accounts')).find(a => a.id === acc.id).accountNoSet, false, '送空字串→清除');
  await DELETE_('/accounts/' + acc.id);
});
