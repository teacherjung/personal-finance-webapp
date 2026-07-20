// 三層重構 stage 1 的回歸考題（使用者定 2026-07-20）：信用卡帳本 vs 現金流帳本分家、
// 收入新樹、緊急預備金新公式、內轉不進加總、搬家一次性且冪等。隔離：STORE_FILE 指到 os 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-cashflow-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const repo = await import('../lib/repo.js');
const { normalizeLedger } = await import('../lib/store.js');
const { buildSummary, isCardLedger, monthKey } = await import('../lib/derive.js');
const { importRows } = await import('../lib/services/statement-import.js');
const { effectiveIncomeTree, saveIncomeTree, conformIncome } = await import('../lib/services/categories.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---- normalizeLedger（搬家核心；與 /api/import 舊備份還原共用同一判準）----
test('搬家｜source:stmt→card、其餘→cashflow；舊平面收入分類歸新樹', () => {
  const txs = [
    { id: 't1', source: 'stmt', type: 'expense', category: '飲食', subcategory: '餐廳' },   // 卡匯入
    { id: 't2', type: 'expense', category: '居住', subcategory: '房租' },                    // 手動支出
    { id: 't3', type: 'income', category: '薪資', subcategory: '' },                          // 舊平面收入
    { id: 't4', type: 'income', category: '投資', subcategory: '' },
    { id: 't5', type: 'income', category: '工作', subcategory: '鐘點' },                      // 已是新樹形狀（有子類）→ 不動
  ];
  const changed = normalizeLedger(txs);
  assert.equal(txs[0].ledger, 'card', '卡匯入→card 帳本');
  assert.equal(txs[1].ledger, 'cashflow', '手動→cashflow 帳本');
  assert.deepEqual([txs[2].category, txs[2].subcategory], ['工作', '薪資'], '薪資→工作/薪資');
  assert.deepEqual([txs[3].category, txs[3].subcategory], ['被動', '投資'], '投資→被動/投資');
  assert.deepEqual([txs[4].category, txs[4].subcategory], ['工作', '鐘點'], '已有子類的不再搬');
  assert.ok(changed >= 4);
});

test('搬家｜冪等：對已搬過的資料再跑一次＝0 變動', () => {
  const txs = [
    { id: 't1', source: 'stmt', type: 'expense', category: '飲食', subcategory: '餐廳', ledger: 'card' },
    { id: 't2', type: 'income', category: '工作', subcategory: '薪資', ledger: 'cashflow' },
  ];
  assert.equal(normalizeLedger(txs), 0, '搬過的不再動（避免重複搬、還原備份重跑安全）');
});

test('搬家｜原型鍵防線：category=toString 不炸、不誤搬', () => {
  const txs = [{ id: 't1', type: 'income', category: 'toString', subcategory: '' }];
  assert.doesNotThrow(() => normalizeLedger(txs));
  assert.equal(txs[0].category, 'toString', 'toString 不在對照表→原樣（hasOwn 擋原型）');
  assert.equal(txs[0].ledger, 'cashflow');
});

// ---- isCardLedger 排除法 ----
test('帳本判準｜排除法：明確 card、或缺 ledger+source:stmt 才算 card；其餘皆 cashflow', () => {
  assert.equal(isCardLedger({ ledger: 'card' }), true);
  assert.equal(isCardLedger({ source: 'stmt' }), true, '缺 ledger 的舊卡匯入仍算 card');
  assert.equal(isCardLedger({ ledger: 'cashflow', source: 'stmt' }), false, '明確 cashflow 蓋過 source');
  assert.equal(isCardLedger({}), false, '缺 ledger 的舊手動列＝cashflow（不掉帳）');
  assert.equal(isCardLedger({ type: 'income' }), false);
});

// ---- 現金流只吃 cashflow 帳本；繳卡費/內轉語意 ----
test('現金流｜信用卡帳本不進本月收入/支出；手動與內轉的計入規則', () => {
  const mk = monthKey();
  const db = {
    settings: {}, accounts: [], holdings: [], subscriptions: [], insurance: [], snapshots: [],
    transactions: [
      { id: 'a', date: `${mk}-05`, type: 'expense', category: '飲食', amount: 1000, ledger: 'card' },     // 卡消費，不算
      { id: 'b', date: `${mk}-06`, type: 'expense', category: '居住', amount: 2000, ledger: 'cashflow' },  // 現金流支出
      { id: 'c', date: `${mk}-07`, type: 'income', category: '工作', amount: 5000, ledger: 'cashflow' },   // 現金流收入
      { id: 'd', date: `${mk}-08`, type: 'transfer', category: '內轉', amount: 9999, ledger: 'cashflow' }, // 內轉，不進收支
    ],
  };
  const cf = buildSummary(db).cashflow;
  assert.equal(cf.income, 5000, '只算 cashflow 的收入，內轉不算');
  assert.equal(cf.expense, 2000, '卡消費 1000 不進現金流支出');
  assert.equal(cf.net, 3000);
});

// ---- 緊急預備金：台幣現金（含定存、排除外幣）÷ 六個月平均支出 ----
test('緊急預備金｜分子只算台幣現金（活存＋定存、排除外幣）', () => {
  // 上個月一筆現金流支出 30000 → avgExp=30000；TWD 現金 60000 → 2.0 個月（< 6 才示警）。
  // 外幣 USD 100000 若被算進來，現金會暴增、月數變大到不示警——用「有沒有示警＋月數」反推是否排除外幣。
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevMk = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const db = {
    settings: { emergencyFundMonths: 6 }, holdings: [], subscriptions: [], insurance: [], snapshots: [],
    accounts: [
      { id: 'tw1', name: '台新活存', type: 'cash', class: '現金', currency: 'TWD', balance: 20000 },
      { id: 'tw2', name: '台新定存', type: 'cash', class: '現金', currency: 'TWD', balance: 40000 },   // 定存也算
      { id: 'us1', name: 'IB USD', type: 'cash', class: '現金', currency: 'USD', balance: 100000 },    // 外幣不算
    ],
    transactions: [{ id: 'e', date: `${prevMk}-10`, type: 'expense', category: '居住', amount: 30000, ledger: 'cashflow' }],
  };
  const s = buildSummary(db);
  const r = s.reminders.find(x => x.title && x.title.includes('緊急預備金'));
  assert.ok(r, '台幣現金 6 萬 ÷ 3 萬 = 2 個月 < 6 → 要示警（外幣沒被算進來）');
  assert.match(r.detail, /2\.0 個月/, `月數＝6萬/3萬=2.0，實得：${r?.detail}`);
});

// ---- 收入樹：獨立、改名只連動 cashflow 收入 ----
test('收入樹｜effectiveIncomeTree 預設含 工作/被動/其他；conformIncome 退路＝其他/其他收入', () => {
  const t = effectiveIncomeTree({ settings: {} });
  assert.ok(t['工作'] && t['被動'] && t['其他'], '預設收入樹');
  assert.deepEqual(conformIncome(t, '不存在的分類', '亂'), ['其他', '其他收入'], '對不上→退路');
});

test('收入樹｜改名連動 cashflow 收入交易，不動卡帳本、不動支出', () => {
  const db = repo.getDb();
  db.settings.incomeTree = { '工作': ['薪資', '鐘點'], '其他': ['其他收入'] };
  db.transactions = [
    { id: 'i1', type: 'income', category: '工作', subcategory: '薪資', ledger: 'cashflow' },
    { id: 'i2', type: 'income', category: '工作', subcategory: '薪資', ledger: 'card', source: 'stmt' },   // 卡帳本（實務不會有收入，仍不可被動）
    { id: 'x1', type: 'expense', category: '工作', subcategory: 'ChatGPT', ledger: 'cashflow' },            // 支出同名大類，不可被收入改名波及
  ];
  repo.saveDb(db);
  const r = saveIncomeTree({ tree: { '工作坊': ['薪資', '鐘點'], '其他': ['其他收入'] }, parentRenames: [{ from: '工作', to: '工作坊' }] });
  assert.equal(r.changedTx, 1, '只改到 cashflow 那筆收入');
  const after = repo.getDb();
  assert.equal(after.transactions.find(t => t.id === 'i1').category, '工作坊');
  assert.equal(after.transactions.find(t => t.id === 'i2').category, '工作', '卡帳本不被動（isCardTx 擋）');
  assert.equal(after.transactions.find(t => t.id === 'x1').category, '工作', '支出樹的「工作」不被收入改名波及');
});
