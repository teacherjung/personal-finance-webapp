// @ts-check
// `scripts/verify-us-gaap-tags.js` 的**離線**考題（Codex #546 r2：那支的三個 export 一題都沒有）。
//
// ⚠️ 誠實劃界：這裡鎖的是**判準**，鎖不了「外面的世界長怎樣」。
// 「這顆 us-gaap 元素名是真的嗎」只有真的連上官方 taxonomy 與 SEC 才問得到，
// 那部分只有手動跑那支腳本才會發生（它是絆線，不在 npm test 裡）。
// 本檔要擋的是**判準自己被改鬆**——r1／r2 兩輪的 High 都是判準寫錯，不是外部資料變了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  controlOnlyExemptions,
  partitionMissing,
  NEVER_ALLOWLISTABLE,
  collectCandidateTags,
  countElementNames,
  taxonomyIntegrityProblem
} from '../scripts/verify-us-gaap-tags.js';

const NEWEST = 2026;

test('classify｜最新版有＝live；只有舊版有＝deprecated；哪都沒有才 MISSING', () => {
  assert.equal(classify([2015, 2026], -1, NEWEST), 'live');
  // SalesRevenueNet 型：2021 起從官方清單移除，但歷史申報有數千筆 ⇒ 保留是對的
  assert.equal(classify([2015, 2017, 2019], -1, NEWEST), 'deprecated');
  // taxonomy 全無、但 SEC 查得到資料 ⇒ 仍是已停用，不是不存在
  assert.equal(classify([], 6006, NEWEST), 'deprecated');
  assert.equal(classify([], 0, NEWEST), 'MISSING');
});

test('classify｜「不在最新版」不可以等於「不存在」（誤殺已停用元素的那條線）', () => {
  assert.notEqual(classify([2015, 2017, 2019], 0, NEWEST), 'MISSING',
    '舊版有就代表它真的存在過，歷史申報要用它——判成 MISSING 會逼人刪掉正確的退路');
});

test('countElementNames｜單引號與雙引號都要收（官方 2018 版用雙引號）', () => {
  assert.deepEqual([...countElementNames("<xs:element name='Revenues' />")], ['Revenues']);
  assert.deepEqual([...countElementNames('<xs:element name="Revenues" />')], ['Revenues']);
  // 引號不成對就不算——避免 name='X" 這種殘缺被當成有效宣告
  assert.deepEqual([...countElementNames(`<xs:element name='Revenues" />`)], []);
});

/** @param {{year?: number, elements?: number, closed?: boolean}} [opts] */
function fakeXsd(opts = {}) {
  const { year = 2026, elements = 6000, closed = true } = opts;
  const head = `<xs:schema targetNamespace='http://fasb.org/us-gaap/${year}'>`;
  const body = Array.from({ length: elements }, (_, i) => `<xs:element name='Elem${i}' />`).join('');
  return head + body + (closed ? '</xs:schema>' : '');
}

test('taxonomyIntegrityProblem｜對照斷言：完整檔必須判成沒問題（否則下面三題是空包彈）', () => {
  assert.equal(taxonomyIntegrityProblem(fakeXsd(), 2026), null);
});

test('taxonomyIntegrityProblem｜截斷檔即使元素夠多也要擋（Codex r2：2MB 殘檔有 6720 個元素）', () => {
  const problem = taxonomyIntegrityProblem(fakeXsd({ closed: false }), 2026);
  assert.match(String(problem), /xs:schema/, '檔尾沒有結束標籤就是殘檔');
});

test('taxonomyIntegrityProblem｜拿到別年份的檔要擋（快取污染／檔名對不上內容）', () => {
  assert.match(String(taxonomyIntegrityProblem(fakeXsd({ year: 2025 }), 2026)), /targetNamespace/);
});

test('taxonomyIntegrityProblem｜元素數過少要擋（正規式失效時不可以靜靜當成「這版沒有」）', () => {
  assert.match(String(taxonomyIntegrityProblem(fakeXsd({ elements: 10 }), 2026)), /門檻/);
});

test('controlOnlyExemptions｜對照組的假 tag 一旦進了候選表就不再豁免（r1 High①）', () => {
  const notInTable = controlOnlyExemptions(new Set(['LongTermDebtNoncurrent']));
  assert.ok(notInTable.has('LongTermDebtAndFinanceLeaseObligationsNoncurrent'),
    '沒進候選表時它只是對照組，本來就不該算成發現');

  const inTable = controlOnlyExemptions(new Set(['LongTermDebtAndFinanceLeaseObligationsNoncurrent']));
  assert.equal(inTable.size, 0,
    '假 tag 回到候選表＝這支工具存在的唯一理由，不可以被自己的對照組掩護掉');
});

test('partitionMissing｜allowlist 綁的是 (tag, metric) 一對，不是 tag 名（r2 High①）', () => {
  const allow = [{ tag: 'DeadTag', metric: 'capitalExpenditure' }];

  // 對照斷言：登記在案的那一對確實會被認成「已登記」，否則下面兩題證明不了東西
  const exact = partitionMissing([{ tag: 'DeadTag', metric: 'capitalExpenditure' }], allow);
  assert.deepEqual(exact.fresh, []);
  assert.equal(exact.registered.length, 1);
  assert.deepEqual(exact.stale, []);

  // 繞法②：把已登記的舊帳 tag 挪到別的 metric ⇒ 那是新發現，必須紅
  const moved = partitionMissing([{ tag: 'DeadTag', metric: 'noncurrentDebt' }], allow);
  assert.deepEqual(moved.fresh, [{ tag: 'DeadTag', metric: 'noncurrentDebt' }],
    '同一顆 tag 出現在沒登記的 metric 上＝新的洞，allowlist 不可以順便掩護');
  assert.equal(moved.stale.length, 1, '原本登記的那一對這次沒出現＝清單過期，也要紅');
});

test('partitionMissing｜對照組的假 tag 登記進 allowlist 也沒用，一律算新發現（r2 High①）', () => {
  const fake = 'LongTermDebtAndFinanceLeaseObligationsNoncurrent';
  assert.ok(NEVER_ALLOWLISTABLE.has(fake), '對照斷言：這顆本來就該在「永不可豁免」名單裡');

  const allow = [{ tag: fake, metric: 'noncurrentDebt' }];
  const { fresh, registered } = partitionMissing([{ tag: fake, metric: 'noncurrentDebt' }], allow);
  assert.deepEqual(fresh, [{ tag: fake, metric: 'noncurrentDebt' }],
    '它是「假 tag 回到候選表」的判定基準，登記了也不能被掩護——否則這支工具的證據等於被拆掉');
  assert.deepEqual(registered, []);
});

test('partitionMissing｜「永不可豁免」只擋名單內那幾顆，一般舊帳照樣登記得起來', () => {
  // 反向對照：沒有這一題，上面那題可能只是因為「allowlist 整個失效」而過
  const allow = [{ tag: 'OrdinaryDeadTag', metric: 'capitalExpenditure' }];
  const { fresh, registered } = partitionMissing(
    [{ tag: 'OrdinaryDeadTag', metric: 'capitalExpenditure' }], allow
  );
  assert.deepEqual(fresh, []);
  assert.equal(registered.length, 1);
});

test('partitionMissing｜清單過期（那一對修好了）要紅，不讓 allowlist 無聲爛掉', () => {
  const allow = [{ tag: 'DeadTag', metric: 'capitalExpenditure' }];
  const { fresh, registered, stale } = partitionMissing([], allow);
  assert.deepEqual(fresh, []);
  assert.deepEqual(registered, []);
  assert.deepEqual(stale, [{ tag: 'DeadTag', metric: 'capitalExpenditure' }]);
});

test('partitionMissing｜完全沒登記的新洞一律是 fresh', () => {
  const { fresh } = partitionMissing([{ tag: 'BrandNewFake', metric: 'revenue' }], []);
  assert.deepEqual(fresh, [{ tag: 'BrandNewFake', metric: 'revenue' }]);
});

test('collectCandidateTags｜候選表的每一顆都要被收進來，含 currentDebt 的三個來源群', () => {
  const byTag = collectCandidateTags();
  // currentDebt 沒有自己的 tags 陣列、是由 currentDebtSources 展開的，最容易在攤平時漏掉
  for (const tag of ['DebtCurrent', 'ShortTermBorrowings', 'LongTermDebtCurrent']) {
    assert.ok(byTag.has(tag), `${tag} 屬於 currentDebt 的來源群，不可以在攤平時漏掉`);
    assert.deepEqual(byTag.get(tag)?.metrics, ['currentDebt']);
  }
  // 這一支修的那顆：真名字要在、假名字不可以在
  assert.ok(byTag.has('LongTermDebtAndCapitalLeaseObligations'));
  assert.ok(!byTag.has('LongTermDebtAndFinanceLeaseObligationsNoncurrent'));
  // unitKind 要跟著帶（SEC frames 的 unit 段靠它挑，挑錯會永遠 404）
  assert.equal(byTag.get('EarningsPerShareDiluted')?.unitKind, 'per-share');
  assert.equal(byTag.get('WeightedAverageNumberOfDilutedSharesOutstanding')?.unitKind, 'shares');
  assert.equal(byTag.get('LongTermDebtNoncurrent')?.unitKind, 'currency');
});
