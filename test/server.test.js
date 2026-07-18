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
  const tx = await (await POST('/transactions', {
    date: '2026-07-06', type: 'expense', category: '其他', subcategory: '未分類',
    amount: 50, note: '端點測試店', storeKey: '端點測試店', source: 'stmt',
  })).json();
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
  assert.ok('flexToken' in (s.ib || {}), 'ib 既有欄位保留');
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
  const tx = await (await POST('/transactions', {
    date: '2026-07-01', type: 'expense', category: '工作', subcategory: 'ChatGPT',
    amount: 70, note: '國外交易服務費-70.00', storeKey: '國外交易服務費-70.00', source: 'stmt',
  })).json();
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

test('店名格式整理（HTTP 全鏈路）：預覽不寫檔、套用改 note＋storeKey、冪等', async () => {
  const tx = await (await POST('/transactions', {
    date: '2026-07-08', type: 'expense', category: '飲食', subcategory: '超市',
    amount: 55, note: '統一超商-百福', storeKey: '統一超商-百福', source: 'stmt',
  })).json();
  // 預覽（dryRun）：回 before→after，且不改資料
  const prev = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(prev.changed >= 1);
  assert.ok((prev.changes || []).some(c => c.before === '統一超商-百福' && c.after === '統一超商（百福）'));
  const still = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(still.note, '統一超商-百福', 'dryRun 不可改資料');
  // 正式套用：note 與 storeKey 一併正規化
  const applied = await (await POST('/statement/normalize-branches', {})).json();
  assert.ok(applied.changed >= 1);
  const after = (await GET('/transactions')).find(t => t.id === tx.id);
  assert.equal(after.note, '統一超商（百福）', '套用後 note 已正規化');
  assert.equal(after.storeKey, '統一超商（百福）', 'storeKey 一併對齊');
  // 冪等：此筆已正規化，再預覽不應再出現
  const again = await (await POST('/statement/normalize-branches', { dryRun: true })).json();
  assert.ok(!(again.changes || []).some(c => c.id === tx.id), '已正規化的筆不再出現在預覽');
  await DELETE_(`/transactions/${tx.id}`);
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

test('隔離確認：測試用的是暫存資料檔，不是真實 store.json', () => {
  assert.ok(TEST_STORE.startsWith(tmpdir()), '資料檔必須在系統暫存目錄');
  assert.ok(!TEST_STORE.includes('榮祥森'), '不可指向專案資料夾');
});
