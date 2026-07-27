// @ts-check
// 收支說明過濾器（使用者定 2026-07-27）：台新對帳單的「摘要・備註」翻成人話。
// 22 條範例全數出自使用者貼的真實樣式——固定輸入輸出；三條裁決註記：
//   ・刷卡消費的店名走 cleanStore（信用卡同一條管線）：APPLE.COM/BILL→Apple（使用者範例寫 APPLE、
//     這裡統一既有鑰匙寫法 Apple）；momo 三條範例互相矛盾（富邦 ｍｏｍｏ／ｍｏｍｏ（日貨本舖）），
//     統一走前一輪拍板的「所有含 momo＝momo」。
//   ・「現金提款：ATM…」的冒號統一成全站的「・」分隔。
//   ・「繳費轉出・北富銀信用卡費」使用者未給期望＝原樣保留。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-test-bank-note-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { bankDisplayNote, reconcileAccountNamesAuto } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => { for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

// 假帳戶對照（純函式注入）：8791＝台新活儲、8057＝台新預備、2162＝台新證券；其他＝非自己帳戶
const NAMES = { 8791: '台新活儲', 8057: '台新預備', 2162: '台新證券' };
const accountNameOf = (/** @type {string} */ acct) => {
  if (acct.includes('-')) return null;   // 與正式版同：他行代碼帳號不查
  const m = acct.match(/\*{2,}(\d+)\s*$/);
  return (m && NAMES[m[1]]) || null;
};
const dn = (/** @type {string} */ s, /** @type {string} */ n, /** @type {'in'|'out'|null} */ dir = 'out') =>
  bankDisplayNote(s, n, { direction: dir, accountNameOf });

test('摘要詞對照＋備註清理：使用者 22 條範例逐一', () => {
  const cases = /** @type {[string, string, 'in'|'out', string][]} */ ([
    ['刷卡消費', 'APPLE.COM/BILL A5773', 'out', '刷卡消費・Apple'],
    ['CD轉出', '數位跨行 824-00001110****6146 Ｗｅｉ', 'out', '現金轉出・824-00001110****6146（Wei）'],
    ['媒體轉帳', '簽帳卡 消費回饋', 'in', '現金轉入・消費回饋'],
    ['CD轉出', '數位跨行808-00006919****8191 榮先生', 'out', '現金轉出・808-00006919****8191（榮先生）'],
    ['轉帳支取', '轉入288810****8791', 'out', '現金轉出・轉入到：台新活儲'],
    ['轉帳存入', '轉出288818****8057', 'in', '現金存入・轉出自：台新預備'],
    ['轉帳存入', '轉出288815****2162', 'in', '現金存入・轉出自：台新證券'],
    ['轉帳支取', '全支付電支扣款', 'out', '現金轉出・全支付'],
    ['轉帳存入', '交割折讓', 'in', '現金存入・交割折讓'],
    ['刷卡消費', '富邦ｍｏｍｏ－ＥＣ', 'out', '刷卡消費・momo'],
    ['CD提款', 'ATM/跨行交易', 'out', '現金提款・ATM 跨行提領'],
    ['CD提款', 'ATM/自行交易', 'out', '現金提款・ATM 本行提領'],
    ['轉帳支取', '轉入288810****3047養育費', 'out', '現金轉出・288810****3047（養育費）'],
    ['CD轉出', '數位跨行700-00031128****1827', 'out', '現金轉出・700-00031128****1827'],
    ['繳費轉出', '北富銀信用卡費', 'out', '繳費轉出・北富銀信用卡費'],
    ['轉帳支取', '轉入288810****3047', 'out', '現金轉出・288810****3047'],
    ['刷卡消費', 'ｍｏｍｏ＊買買奇ＭｙＭａｒｋｅｔ', 'out', '刷卡消費・momo'],
    ['刷卡消費', 'ｍｏｍｏ＊日貨本舖', 'out', '刷卡消費・momo'],
    ['跨轉手續費', '數位跨行013-00000035****4901', 'out', '跨轉手續・013-00000035****4901'],
    ['媒體轉出', '房屋貸款富邦人壽', 'out', '現金轉出・房屋貸款富邦人壽'],
    ['媒體轉入', '基金配息00953B', 'in', '現金轉入・基金配息 00953B'],
  ]);
  for (const [summary, note, dir, want] of cases) {
    assert.equal(dn(summary, note, dir), want, `${summary}・${note}`);
  }
});

test('邊角：媒體轉帳方向不明＝摘要原樣不硬猜；空備註＝只回摘要；他行代碼帳號末碼撞自己帳戶也不誤標', () => {
  assert.equal(dn('媒體轉帳', '簽帳卡 消費回饋', null), '媒體轉帳・消費回饋');
  assert.equal(dn('CD提款', '', 'out'), '現金提款');
  // 824-…8791：末碼與台新活儲相同，但這是**他行**帳號（帶銀行代碼）＝別人的帳戶，不可翻成「轉入到：台新活儲」
  assert.equal(dn('轉帳支取', '轉入824-00001110****8791', 'out'), '現金轉出・824-00001110****8791');
});

test('遷移（開 app 護欄）：自動名升級成好讀版、使用者自訂過的說明一字不動、autoNote 欄一律跟上', async () => {
  const db = await getDb();
  db.accounts = [
    { id: 'a1', name: '台新活儲（Richart）', type: 'cash', class: '現金', currency: 'TWD', balance: 0, accountNo: '288810123458791' },
  ];
  const mk = (/** @type {string} */ id, /** @type {string} */ summary, /** @type {string} */ note, /** @type {string} */ cur) => ({
    id, date: '2026-07-01', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 100,
    account: '台新活儲（Richart）', note: cur, ledger: 'cashflow', source: 'bank', dir: 'out',
    autoNote: `${summary}・${note}`,   // 舊格式自動名
    bankRef: `bank|288810****8791|2026-07-01|out|100|900|${summary}|${note}`,
  });
  db.transactions = [
    mk('t1', '轉帳支取', '轉入288810****8791', '轉帳支取・轉入288810****8791'),   // 仍是自動名 → 升級
    mk('t2', 'CD轉出', '數位跨行 824-00001110****6146 Ｗｅｉ', '給 Wei 的生活費'),   // 使用者自訂過 → 不動
  ];
  await saveDb(db);
  const { changed } = await reconcileAccountNamesAuto();
  assert.ok(changed >= 2, `兩筆的 note/autoNote 至少各有一處更新（實得 ${changed}）`);
  const fresh = await getDb();
  const t1 = (fresh.transactions || []).find(t => t.id === 't1');
  const t2 = (fresh.transactions || []).find(t => t.id === 't2');
  assert.equal(t1.note, '現金轉出・轉入到：台新活儲', '自動名升級（含帳戶對照、帳戶名去尾括號）');
  assert.equal(t2.note, '給 Wei 的生活費', '自訂說明一字不動');
  assert.equal(t2.autoNote, '現金轉出・824-00001110****6146（Wei）', 'autoNote 欄跟上新格式（清空自訂時回復到好讀版）');
  // 冪等：再跑一次不再有變動
  const again = await reconcileAccountNamesAuto();
  assert.equal(again.changed, 0, '第二輪不可再報變動（冪等）');
});
