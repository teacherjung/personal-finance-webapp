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
const TEST_STORE = join(tmpdir(), `finance-test-store-${process.pid}.json`);
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
  try { rmSync(TEST_STORE); rmSync(TEST_STORE + '.bak'); } catch { /* 沒有 .bak 也沒關係 */ }
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

test('匯入正常：合法備份可還原、且還原後 summary 正常', async () => {
  const backup = await GET('/db');   // 用現有 db 當備份 → 冪等，不影響其他考題
  const res = await (await POST('/import', backup)).json();
  assert.equal(res.ok, true);
  const sum = await GET('/summary');
  assert.ok(sum.netWorth > 0);
});

test('隔離確認：測試用的是暫存資料檔，不是真實 store.json', () => {
  assert.ok(TEST_STORE.startsWith(tmpdir()), '資料檔必須在系統暫存目錄');
  assert.ok(!TEST_STORE.includes('榮祥森'), '不可指向專案資料夾');
});
