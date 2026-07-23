// 證券交易共同格式正規化器考題（S1）。純函式、零資料庫。涵蓋藍圖 §四/§六：
// identifier-first 去重、方向不靠正負猜、原幣保留、空字串金額≠0、同批出現序、未知類別 fail 材料。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeIbTrade, normalizeTaishinTrade, ibSourceRef, ibDate, taishinSide, cashDirectionOf, accountFingerprint, assignSeqSuffix, reconcileFingerprintRows, baseRef } =
  await import('../lib/services/security-trades.js');

const IB_RAW = {
  accountId: 'U0000000', tradeDate: '2026-01-13', settleDateTarget: '2026-01-15',
  symbol: 'cspx', description: 'ISHARES CORE S&P 500', buySell: 'BUY',
  quantity: 10, tradePrice: 800.5, tradeMoney: 8005, netCash: -8010.2,
  ibCommission: -5.2, taxes: 0, currency: 'usd', listingExchange: 'LSEETF',
  transactionID: 'T-111', tradeID: 'TR-222', ibExecID: 'EX-333',
};

test('IB 去重鍵 identifier-first：transactionID → tradeID → ibExecID → 退路指紋（官方鍵含帳戶指紋，Codex S2r1#4）', () => {
  const FP = accountFingerprint('U0000000');
  assert.equal(ibSourceRef(IB_RAW), `ib|txn|${FP}|T-111`);
  assert.equal(ibSourceRef({ ...IB_RAW, transactionID: '' }), `ib|trd|${FP}|TR-222`);
  assert.equal(ibSourceRef({ ...IB_RAW, transactionID: '', tradeID: '' }), `ib|exe|${FP}|EX-333`);
  const fp = ibSourceRef({ ...IB_RAW, transactionID: '', tradeID: '', ibExecID: '' });
  assert.match(fp, /^ib\|fp\|/, '全缺才退指紋');
  assert.doesNotMatch(fp, /U0000000/, '指紋不可含完整帳號原文');
});

test('IB 正規化：方向看 buySell 不看正負；賣出負數量取絕對值；金額保留原幣', () => {
  const buy = normalizeIbTrade(IB_RAW);
  assert.ok(buy);
  assert.equal(buy.side, 'buy');
  assert.equal(buy.cashDirection, 'out', '買進＝錢出去');
  assert.equal(buy.symbol, 'CSPX');
  assert.equal(buy.currency, 'USD');
  assert.equal(buy.quantity, 10);
  assert.equal(buy.commission, 5.2, '手續費取絕對值');
  assert.equal(buy.netSettlement, 8010.2, '應收付＝絕對值（方向已在 cashDirection）');
  assert.equal(buy.settlementDate, '2026-01-15');
  const sell = normalizeIbTrade({ ...IB_RAW, buySell: 'SELL', quantity: -10, netCash: 7990 });
  assert.ok(sell);
  assert.equal(sell.side, 'sell');
  assert.equal(sell.cashDirection, 'in', '賣出＝錢進來');
  assert.equal(sell.quantity, 10, '負數量取絕對值、方向看 side');
  const gbp = normalizeIbTrade({ ...IB_RAW, currency: 'GBP' });
  assert.ok(gbp);
  assert.equal(gbp.currency, 'GBP', '原幣保留、不換算');
});

test('IB 日期容錯與空值紀律：yyyymmdd 轉 ISO；空字串金額＝null 不是 0；缺核心欄位整筆不收', () => {
  assert.equal(ibDate('20260113'), '2026-01-13');
  assert.equal(ibDate('2026-01-13'), '2026-01-13');
  assert.equal(ibDate('13/01/2026'), null);
  const t = normalizeIbTrade({ ...IB_RAW, netCash: '', ibCommission: null });
  assert.ok(t);
  assert.equal(t.netSettlement, null, "Number('') 是 0——空字串必須當「沒有金額」（r9#1 同款教訓）");
  assert.equal(t.commission, null);
  assert.equal(normalizeIbTrade({ ...IB_RAW, tradeDate: '' }), null, '缺成交日整筆不收');
  assert.equal(normalizeIbTrade({ ...IB_RAW, quantity: 0 }), null, '零股數整筆不收');
});

test('IB 未知 buySell → side null＋unknownType flag（不猜方向）；缺官方識別碼 → missingId flag', () => {
  const odd = normalizeIbTrade({ ...IB_RAW, buySell: 'CANCEL' });
  assert.ok(odd);
  assert.equal(odd.side, null);
  assert.equal(odd.cashDirection, null);
  assert.equal(odd.flags.unknownType, true);
  const noId = normalizeIbTrade({ ...IB_RAW, transactionID: '', tradeID: '', ibExecID: '' });
  assert.ok(noId);
  assert.equal(noId.flags.missingId, true);
});

test('台新正規化：類別對照單一真相（未知不猜）；sourceRef 含帳戶指紋＋年月＋全維度、不含帳號原文', () => {
  assert.equal(taishinSide('現買'), 'buy');
  assert.equal(taishinSide('現賣'), 'sell');
  assert.equal(taishinSide('興櫃申購'), null);
  assert.equal(taishinSide('__proto__'), null, '原型鍵查表不可撈到原型鏈（hasOwn）');
  assert.equal(cashDirectionOf('buy'), 'out');
  assert.equal(cashDirectionOf(null), null);

  const ctx = { accountRaw: '9001-900100', stmtMonth: '2026-01' };
  const t = normalizeTaishinTrade({
    tradeDate: '2026-01-13', settlementDate: '2026-01-15', rawType: '現賣', symbol: '0050', name: '元大台灣50',
    quantity: 1000, price: 104, grossAmount: 104000, commission: 148, feeDiscount: 0, tax: 312, otherFees: null,
    netSettlement: 103540, currency: 'TWD',
  }, ctx);
  assert.ok(t);
  assert.equal(t.side, 'sell');
  assert.equal(t.cashDirection, 'in');
  assert.equal(t.sourceAccountId, accountFingerprint('9001-900100'));
  assert.doesNotMatch(t.sourceRef, /9001-900100/, '去重鍵用指紋、不含帳號原文');
  assert.match(t.sourceRef, /^ts\|/);
  assert.match(t.sourceRef, /2026-01-13\|0050\|現賣\|1000\|104\|104000\|103540/, '日＋代號＋類別＋量＋價＋成交額＋應收付全維度');
  assert.ok(!t.sourceRef.includes('|2026-01|'), 'S2 拍板：鍵**不含**對帳單年月（重疊月兩份單不可雙記，藍圖 §六 L247）');
  const unknown = normalizeTaishinTrade({ tradeDate: '2026-01-13', settlementDate: null, rawType: '興櫃申購', symbol: 'X1', name: '',
    quantity: 10, price: 1, grossAmount: 10, commission: 0, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 10, currency: 'TWD' }, ctx);
  assert.ok(unknown);
  assert.equal(unknown.side, null);
  assert.equal(unknown.flags.unknownType, true, 'S2 預覽據此阻擋');
});

test('自審回歸｜帳號抽取失敗（空 accountRaw）→ missingAccount flag（避免空指紋跨帳戶互撞去重，S2 fail-closed）', () => {
  const noAcct = normalizeTaishinTrade({ tradeDate: '2026-01-13', settlementDate: null, rawType: '現買', symbol: '0050', name: '元大台灣50',
    quantity: 1000, price: 104, grossAmount: 104000, commission: 148, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 104148, currency: 'TWD' },
    { accountRaw: '', stmtMonth: '2026-01' });
  assert.ok(noAcct);
  assert.equal(noAcct.sourceAccountId, '', '空帳號→空指紋');
  assert.equal(noAcct.flags.missingAccount, true);
  const ibNoAcct = normalizeIbTrade({ ...IB_RAW, accountId: '' });
  assert.ok(ibNoAcct);
  assert.equal(ibNoAcct.flags.missingAccount, true);
});

test('同批出現序：同鍵多筆補 |#N（同日同價兩筆真交易都唯一）；唯一鍵（官方識別碼）不動', () => {
  const ctx = { accountRaw: '9001-900100', stmtMonth: '2026-01' };
  const mk = () => normalizeTaishinTrade({ tradeDate: '2026-01-13', settlementDate: null, rawType: '現買', symbol: '0056', name: '元大高股息',
    quantity: 500, price: 40, grossAmount: 20000, commission: 28, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 20028, currency: 'TWD' }, ctx);
  const a = mk(), b = mk(), ib = normalizeIbTrade(IB_RAW);
  assert.ok(a && b && ib);
  const list = assignSeqSuffix([a, b, ib]);
  assert.notEqual(list[0].sourceRef, list[1].sourceRef, '兩筆一模一樣的真交易 ref 必須不同');
  assert.match(list[0].sourceRef, /\|#1$/);
  assert.match(list[1].sourceRef, /\|#2$/);
  assert.match(list[2].sourceRef, /^ib\|txn\|[0-9a-f]{12}\|T-111$/, '官方識別碼（含帳戶指紋段）不加序（跨批穩定）');
  // 冪等基礎：同一份輸入再跑一次 → 同樣的 ref（S2 重匯 0 新增靠這個）
  const c = mk(), d = mk();
  assert.ok(c && d);
  const again = assignSeqSuffix([c, d]);
  assert.deepEqual([again[0].sourceRef, again[1].sourceRef], [list[0].sourceRef, list[1].sourceRef]);
});

test('帳戶指紋：不可逆、對空白正規化、非空才產生', () => {
  assert.equal(accountFingerprint('9001-900100'), accountFingerprint(' 9001-900100 '), '空白不影響指紋');
  assert.notEqual(accountFingerprint('9001-900100'), accountFingerprint('9001-900101'));
  assert.equal(accountFingerprint(''), '');
  assert.equal(accountFingerprint('9001-900100').length, 12);
});

// ==== 對抗式自審確認的 bug 之回歸考題 ====

test("自審回歸｜IB 取消列 'BUY (Ca.)'/'SELL (Ca.)' → side null＋unknownType（不當正常買賣＝避免幽靈雙倍計）", () => {
  const ca = normalizeIbTrade({ ...IB_RAW, buySell: 'BUY (Ca.)', quantity: -10 });
  assert.ok(ca);
  assert.equal(ca.side, null, "'BUY (Ca.)' 不可被 startsWith 認成 buy");
  assert.equal(ca.cashDirection, null);
  assert.equal(ca.flags.unknownType, true, 'S2 fail-closed 據此擋下、顯示原文');
  const sca = normalizeIbTrade({ ...IB_RAW, buySell: 'SELL (Ca.)' });
  assert.ok(sca);
  assert.equal(sca.side, null);
  assert.equal(normalizeIbTrade({ ...IB_RAW, buySell: 'BUY' })?.side, 'buy', '正常 BUY 不受影響');
});

test('自審回歸｜ibDate 過真實日曆：假日期回 null；normalizeIbTrade 拒收假成交日', () => {
  assert.equal(ibDate('20260230'), null, '2 月 30 日不存在');
  assert.equal(ibDate('20261301'), null, '13 月不存在');
  assert.equal(ibDate('20260113'), '2026-01-13', '真日期照轉');
  assert.equal(normalizeIbTrade({ ...IB_RAW, tradeDate: '20260230' }), null, '假成交日整筆不收（不流到 S2 寫入才炸）');
});

test('自審回歸｜assignSeqSuffix 跨批穩定：退路指紋唯一時也補 |#1，multiplicity 變動不漂移；官方識別碼永不加序', () => {
  const ctx = { accountRaw: '9001-900100', stmtMonth: '2026-01' };
  const mk = () => normalizeTaishinTrade({ tradeDate: '2026-01-13', settlementDate: null, rawType: '現買', symbol: '0056', name: '元大高股息',
    quantity: 500, price: 40, grossAmount: 20000, commission: 28, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 20028, currency: 'TWD' }, ctx);
  const b1 = assignSeqSuffix([mk()]);
  assert.match(b1[0].sourceRef, /\|#1$/, '唯一退路指紋也要有序尾，跨批才穩');
  const b2 = assignSeqSuffix([mk(), mk()]);
  assert.equal(b2[0].sourceRef, b1[0].sourceRef, '同一筆真交易的 ref 不因批內多一筆而漂移（S2 冪等地基）');
  assert.match(b2[1].sourceRef, /\|#2$/);
  const dup = assignSeqSuffix([normalizeIbTrade(IB_RAW), normalizeIbTrade(IB_RAW)]);
  assert.match(dup[0].sourceRef, /^ib\|txn\|[0-9a-f]{12}\|T-111$/, '官方識別碼重複也不加序（重複＝資料錯、去重成一筆）');
  assert.equal(dup[1].sourceRef, dup[0].sourceRef);
});

test('自審回歸｜grossAmount：tradeMoney 空字串時退到 proceeds（?? 對 null 才退位）', () => {
  const t = normalizeIbTrade({ ...IB_RAW, tradeMoney: '', proceeds: -8005 });
  assert.ok(t);
  assert.equal(t.grossAmount, 8005, '空字串 tradeMoney 不遮蔽 proceeds');
});

// ==== S2 自審三條 HIGH 的根治考題：內容比對＋計數對帳（reconcileFingerprintRows）====

const FP_T = (over = {}) => {
  const t = normalizeTaishinTrade({ tradeDate: '2026-02-13', settlementDate: null, rawType: '現買', symbol: '0050', name: 'X',
    quantity: 1000, price: 104, grossAmount: 104000, commission: 148, feeDiscount: 0, tax: 0, otherFees: null,
    netSettlement: 104148, currency: 'TWD', ...over }, { accountRaw: '9001-900100', stmtMonth: '2026-02' });
  assert.ok(t); return t;
};
/** 模擬庫列（含序號 ref）。 @param {any} t @param {number} n */
const stored = (t, n) => ({ ...t, sourceRef: `${t.sourceRef}|#${n}` });

test('自審根治｜視窗位移不覆寫：庫 [A#1,B#2]、批只剩 [B] → 全 dup、0 插入、A 完好（原 HIGH：B 搶走 #1 蓋掉 A）', () => {
  const A = FP_T({ commission: 5 }), B = FP_T({ commission: 7 });
  const existing = [stored(A, 1), stored(B, 2)];
  const plan = reconcileFingerprintRows(existing, [FP_T({ commission: 7 })]);
  assert.deepEqual(plan.duplicate, [true], '內容比對命中庫內 B，不看位置');
  assert.deepEqual(plan.insertRefs, [null]);
  assert.equal(existing[0].commission, 5, '不改動任何既有列');
});

test('自審根治｜補印插入不漏記：庫 [X#1,Y#2]、批 [X,Z,Y]（Z 為新真交易）→ X/Y dup、Z 插入 #3（原 HIGH：Z 撞舊 #2 被漏）', () => {
  const X = FP_T({ name: 'X' }), Y = FP_T({ name: 'Y' }), Z = FP_T({ name: 'Z' });
  const plan = reconcileFingerprintRows([stored(X, 1), stored(Y, 2)], [FP_T({ name: 'X' }), FP_T({ name: 'Z' }), FP_T({ name: 'Y' })]);
  assert.deepEqual(plan.duplicate, [true, false, true], 'X/Y 內容配對成功、Z 是新的');
  assert.equal(plan.insertRefs[1], `${Z.sourceRef}|#3`, 'Z 拿庫內最大序+1，不與既有列相撞');
});

test('自審根治｜重疊月不雙記：同一筆交易印在兩份不同月對帳單 → 鍵相同（無 stmtMonth）、內容相同 → dup（原 HIGH：兩鍵雙記 60 萬）', () => {
  const jan = normalizeTaishinTrade({ tradeDate: '2026-01-31', settlementDate: null, rawType: '現買', symbol: '2330', name: '台積電',
    quantity: 1000, price: 600, grossAmount: 600000, commission: 855, feeDiscount: 0, tax: 0, otherFees: null,
    netSettlement: 600855, currency: 'TWD' }, { accountRaw: '9001-900100', stmtMonth: '2026-01' });
  const feb = normalizeTaishinTrade({ tradeDate: '2026-01-31', settlementDate: null, rawType: '現買', symbol: '2330', name: '台積電',
    quantity: 1000, price: 600, grossAmount: 600000, commission: 855, feeDiscount: 0, tax: 0, otherFees: null,
    netSettlement: 600855, currency: 'TWD' }, { accountRaw: '9001-900100', stmtMonth: '2026-02' });
  assert.ok(jan && feb);
  assert.equal(jan.sourceRef, feb.sourceRef, '鍵不含對帳單年月');
  const plan = reconcileFingerprintRows([stored(jan, 1)], [feb]);
  assert.deepEqual(plan.duplicate, [true], '2 月那份單裡的同一筆＝重複，不再入帳');
});

test('自審根治｜baseRef 剝序；官方識別碼列不參與指紋對帳', () => {
  assert.equal(baseRef('ts|f|x|#12'), 'ts|f|x');
  assert.equal(baseRef('ib|txn|T-1'), 'ib|txn|T-1');
  const official = { sourceRef: 'ib|txn|T-1', tradeDate: '2026-01-13' };
  const plan = reconcileFingerprintRows([official], [FP_T()]);
  assert.deepEqual(plan.duplicate, [false], '官方列不進指紋池');
  assert.match(String(plan.insertRefs[0]), /\|#1$/);
});

// ==== Codex S2 複審 r1 的回歸考題（findings 1/3/4）====

test('Codex S2r1#1｜缺幣別不猜 USD：missingCurrency flag；缺核心金額 → missingCore flag', () => {
  const noCur = normalizeIbTrade({ ...IB_RAW, currency: '' });
  assert.ok(noCur);
  assert.equal(noCur.currency, '', '不可默默填 USD');
  assert.equal(noCur.flags.missingCurrency, true);
  const bare = normalizeIbTrade({ accountId: 'U0000000', tradeDate: '2026-01-13', symbol: 'VT', buySell: 'BUY', quantity: 10, transactionID: 'T-1', currency: 'USD' });
  assert.ok(bare);
  assert.equal(bare.flags.missingCore, true, '缺價/成交額/應收付＝不可入庫材料');
  assert.ok(!normalizeIbTrade(IB_RAW).flags.missingCore, '欄位齊全無 flag');
});

test('Codex S2r1#3｜手續費幣別：與交易幣別不同才存 commissionCurrency；相同省略', () => {
  const gbpFee = normalizeIbTrade({ ...IB_RAW, ibCommissionCurrency: 'GBP' });
  assert.ok(gbpFee);
  assert.equal(gbpFee.commissionCurrency, 'GBP', '美元交易收英鎊手續費＝要標明單位');
  const same = normalizeIbTrade({ ...IB_RAW, ibCommissionCurrency: 'USD' });
  assert.ok(same);
  assert.equal(same.commissionCurrency, undefined, '同幣別省略（慣例＝跟交易幣別）');
});

test('Codex S2r1#4｜跨帳戶同 transactionID → 兩個不同鍵（不互相覆蓋）', () => {
  const a = ibSourceRef({ ...IB_RAW, accountId: 'U1111111', transactionID: 'TXN-42' });
  const b = ibSourceRef({ ...IB_RAW, accountId: 'U2222222', transactionID: 'TXN-42' });
  assert.notEqual(a, b, 'IB 未承諾 ID 跨帳戶唯一——帳戶指紋必須入鍵');
});
