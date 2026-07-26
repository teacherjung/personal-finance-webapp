// 加油站顯示名「分店加油站」端到端考題（使用者定 2026-07-25，全品牌統一）。
//
// 純函式層（cleanStore/normalizeStoreDisplay）另有考題；這裡鎖「整條線」：
//   ①匯入（importRows）寫進 note 的就是新格式（泰山加油站），鑰匙照舊「加油站」。
//   ②使用者自訂名「加油站」＝逐字照登（2026-07-20 鐵則）——匯入不覆蓋、整理不動它、
//     也**不因它跳「刪掉規則也救不回」的確認閘**（learnedNameChanges 必須為空）。
//     這正是使用者真實資料的形狀：2026-07-18 合併加油站時整批改名成「加油站」的那層自訂。
//   ③既有舊格式資料（note＝中油（泰山站））整理後收斂到新格式；整理**冪等**——
//     規則指紋自動整理每次開 app 都可能重跑，不冪等＝名字一直在漂。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-gas-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { importRows, normalizeBranches } = await import('../lib/services/statement-import.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

const row = (desc, extra = {}) => ({
  date: '2026-07-01', amount: 1000, desc,
  category: '交通', subcategory: '油錢', stmtRef: `c1|2026-07-01|1000|${desc}`, ...extra });

test('匯入：加油站消費的 note＝「分店加油站」、storeKey 照舊「加油站」', () => {
  const db = getDb();
  db.cards = [{ id: 'c1', name: '測試卡', type: 'credit', lastFour: '9001' }];   // 合成末四碼（假值）
  db.transactions = [];
  db.learnedCategories = {};
  saveDb(db);
  const r = importRows('c1', [
    row('中油-泰山站(D2158)TAIPEI'),        // 使用者拍板當天給的驗收例①
    row('統一精工-新店站TAIPEI'),            // 驗收例②
    row('台塑-合成站(D9901)TAIPEI'),         // 台塑關鍵字（合成分店名＋合成代碼）
    // 無分隔符無括號兩型（Codex 複審 2026-07-26）：①無分店 ②黏寫分店
    row('中油A123 TAIPEI'),
    row('統一精工'),
    row('台塑石油股份有限公司'),
    row('台塑石油合成站'),
  ]);
  assert.equal(r.imported, 7);
  const db2 = getDb();
  const noteOf = (d) => db2.transactions.find(t => t.stmtRef.endsWith(d))?.note;
  assert.equal(noteOf('中油-泰山站(D2158)TAIPEI'), '泰山加油站');
  assert.equal(noteOf('統一精工-新店站TAIPEI'), '新店加油站');
  assert.equal(noteOf('台塑-合成站(D9901)TAIPEI'), '合成加油站');
  assert.equal(noteOf('中油A123 TAIPEI'), '中油加油站', '無分店＝品牌加油站，不可留「中油」');
  assert.equal(noteOf('統一精工'), '統一精工加油站');
  assert.equal(noteOf('台塑石油股份有限公司'), '台塑加油站');
  assert.equal(noteOf('台塑石油合成站'), '合成加油站', '無分隔符也要切出分店');
  for (const t of db2.transactions) assert.equal(t.storeKey, '加油站', `鑰匙照舊聚合(${t.note})`);
  // 畫面不會兩種格式並存：全部以「加油站」結尾（Codex 複審的核心訴求）
  for (const t of db2.transactions) assert.match(t.note, /加油站$/, `顯示格式統一(${t.note})`);
});

test('自訂名「加油站」逐字照登：匯入不覆蓋、整理不動、不跳確認閘', () => {
  const db = getDb();
  db.cards = [{ id: 'c1', name: '測試卡', type: 'credit', lastFour: '9001' }];
  db.transactions = [];
  // 使用者真實資料的形狀：原文級學習掛著自訂名「加油站」（2026-07-18 整批改名那層）
  db.learnedCategories = { '中油-金山站(D2159)TAIPEI': { name: '加油站', category: '交通', subcategory: '油錢' } };
  saveDb(db);
  importRows('c1', [row('中油-金山站(D2159)TAIPEI')]);
  const t = getDb().transactions.find(x => x.stmtRef.includes('金山'));
  assert.equal(t?.note, '加油站', '自訂名逐字，勝過新自動格式');
  // 整理（dryRun 預覽）：自訂名不得被改寫、不得出現在 learnedNameChanges（嚇人確認閘的依據）
  const prev = normalizeBranches(true);
  assert.equal(prev.changes.some(c => c.after !== '加油站' && c.before === '加油站'), false, '自訂名「加油站」不在改名清單');
  assert.equal((prev.learnedNameChanges || []).length, 0, '沒有學習名被規則改寫＝不跳確認閘');
});

test('整理：舊格式（中油（泰山站））收斂到新格式，且整理冪等', () => {
  const db = getDb();
  db.cards = [{ id: 'c1', name: '測試卡', type: 'credit', lastFour: '9001' }];
  db.learnedCategories = {};
  // 舊資料形狀：匯入當年寫的是舊自動格式，原文留在 stmtRef 第 4 段
  db.transactions = [{
    id: 't-old', date: '2026-06-01', type: 'expense', category: '交通', subcategory: '油錢',
    amount: 900, account: '測試卡', note: '中油（泰山站）', storeKey: '加油站',
    stmtRef: 'c1|2026-06-01|900|中油-泰山站(D2158)TAIPEI', source: 'stmt',
  }];
  saveDb(db);
  const prev = normalizeBranches(true);   // 預覽
  assert.deepEqual(prev.changes.map(c => [c.before, c.after]), [['中油（泰山站）', '泰山加油站']]);
  normalizeBranches(false);               // 套用
  assert.equal(getDb().transactions[0].note, '泰山加油站');
  const again = normalizeBranches(true);  // 再跑一次＝什麼都不該再變（冪等）
  assert.equal(again.changes.length, 0, '整理冪等：新格式不再被改');
});
