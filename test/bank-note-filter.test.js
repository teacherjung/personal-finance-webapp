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

// 假帳戶對照（純函式注入）：**帳戶全名、含尾括號**（使用者定 2026-07-27 二修：兩個「台新活儲」
// 只差括號，剝掉就分不出錢轉進哪一個）；其他＝非自己帳戶
const NAMES = { 8791: '台新活儲（Richart）', 8057: '台新預備（Richart）', 2162: '台新證券（Richart）' };
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
    ['轉帳支取', '轉入288810****8791', 'out', '現金轉出・轉入到：台新活儲（Richart）'],
    ['轉帳存入', '轉出288818****8057', 'in', '現金存入・轉出自：台新預備（Richart）'],
    ['轉帳存入', '轉出288815****2162', 'in', '現金存入・轉出自：台新證券（Richart）'],
    ['轉帳支取', '全支付電支扣款', 'out', '現金轉出・全支付'],
    ['轉帳存入', '交割折讓', 'in', '現金存入・交割折讓'],
    ['刷卡消費', '富邦ｍｏｍｏ－ＥＣ', 'out', '刷卡消費・momo'],
    ['CD提款', 'ATM/跨行交易', 'out', '現金提款・ATM 跨行提領'],
    ['CD提款', 'ATM/自行交易', 'out', '現金提款・ATM 本行提領'],
    // 行內（無銀行代碼）帳號顯示補台新代碼 812-（使用者定 2026-07-27 二修：與他行 824-…格式一致）
    ['轉帳支取', '轉入288810****3047養育費', 'out', '現金轉出・812-288810****3047（養育費）'],
    ['CD轉出', '數位跨行700-00031128****1827', 'out', '現金轉出・700-00031128****1827'],
    ['繳費轉出', '北富銀信用卡費', 'out', '繳費轉出・北富銀信用卡費'],
    ['轉帳支取', '轉入288810****3047', 'out', '現金轉出・812-288810****3047'],
    // 使用者補 2026-07-27 二修：CD轉入／存款息 的摘要詞
    ['CD轉入', '數位跨行 822-00001234****9999', 'in', '現金轉入・822-00001234****9999'],
    ['存款息', '利息2元', 'in', '存款利息・利息 2元'],
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
  const t3note = '現金轉出・轉入到：台新活儲';   // ＝#305 版過濾器的產物（剝括號時代）——已遷移過一輪的舊 note
  db.transactions = [
    mk('t1', '轉帳支取', '轉入288810****8791', '轉帳支取・轉入288810****8791'),   // 仍是最舊自動名 → 升級
    mk('t2', 'CD轉出', '數位跨行 824-00001110****6146 Ｗｅｉ', '給 Wei 的生活費'),   // 使用者自訂過 → 不動
    // Codex #307 r1 要求的證明：被前一版過濾器升級過的 note——遷移時 autoNote 欄同步跟上了（#305 機制），
    // 所以 note===autoNote＝仍是自動名 → 這一版再升級成全名版；不會被誤判成使用者自訂。
    { ...mk('t3', '轉帳支取', '轉入288810****8791', t3note), autoNote: t3note },
  ];
  await saveDb(db);
  const { changed } = await reconcileAccountNamesAuto();
  assert.ok(changed >= 3, `三筆的 note/autoNote 至少各有一處更新（實得 ${changed}）`);
  const fresh = await getDb();
  const t1 = (fresh.transactions || []).find(t => t.id === 't1');
  const t2 = (fresh.transactions || []).find(t => t.id === 't2');
  const t3 = (fresh.transactions || []).find(t => t.id === 't3');
  assert.equal(t1.note, '現金轉出・轉入到：台新活儲（Richart）', '自動名升級（帳戶對照＝全名含括號，兩個台新活儲才分得出來）');
  assert.equal(t2.note, '給 Wei 的生活費', '自訂說明一字不動');
  assert.equal(t2.autoNote, '現金轉出・824-00001110****6146（Wei）', 'autoNote 欄跟上新格式（清空自訂時回復到好讀版）');
  assert.equal(t3.note, '現金轉出・轉入到：台新活儲（Richart）', '前一版過濾器的產物（note===autoNote）也升級、不被誤判自訂');
  // 冪等：再跑一次不再有變動
  const again = await reconcileAccountNamesAuto();
  assert.equal(again.changed, 0, '第二輪不可再報變動（冪等）');
});

test('learnFromBankEdit 清空回復：autoNote 欄同步跟上（Codex #307 r1——不同步會留下 note≠autoNote 的孤兒，下次改版被誤判自訂）', async () => {
  const { learnFromBankEdit } = await import('../lib/services/bank-import.js');
  const db = await getDb();   // 帳戶對照沿用上一題種好的台新活儲（Richart）
  const item = { source: 'bank', type: 'transfer', category: '內轉', subcategory: '內轉出', note: '',
    autoNote: '轉帳支取・轉入288810****8791',   // 匯入時代的最舊格式（過期）
    bankRef: 'bank|288810****8791|2026-07-01|out|100|900|轉帳支取|轉入288810****8791' };
  learnFromBankEdit(db, item, { note: '我的自訂名' });
  assert.equal(item.note, '現金轉出・轉入到：台新活儲（Richart）', '回復＝當下最新格式');
  assert.equal(item.autoNote, item.note, 'autoNote 欄同步＝維持「note===autoNote ⇔ 仍是自動名」不變量');
});
