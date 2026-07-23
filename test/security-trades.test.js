// 證券交易共同格式正規化器考題（S1）。純函式、零資料庫。涵蓋藍圖 §四/§六：
// identifier-first 去重、方向不靠正負猜、原幣保留、空字串金額≠0、同批出現序、未知類別 fail 材料。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeIbTrade, normalizeTaishinTrade, ibSourceRef, ibDate, taishinSide, cashDirectionOf, accountFingerprint, assignSeqSuffix } =
  await import('../lib/services/security-trades.js');

const IB_RAW = {
  accountId: 'U0000000', tradeDate: '2026-01-13', settleDateTarget: '2026-01-15',
  symbol: 'cspx', description: 'ISHARES CORE S&P 500', buySell: 'BUY',
  quantity: 10, tradePrice: 800.5, tradeMoney: 8005, netCash: -8010.2,
  ibCommission: -5.2, taxes: 0, currency: 'usd', listingExchange: 'LSEETF',
  transactionID: 'T-111', tradeID: 'TR-222', ibExecID: 'EX-333',
};

test('IB 去重鍵 identifier-first：transactionID → tradeID → ibExecID → 退路指紋', () => {
  assert.equal(ibSourceRef(IB_RAW), 'ib|txn|T-111');
  assert.equal(ibSourceRef({ ...IB_RAW, transactionID: '' }), 'ib|trd|TR-222');
  assert.equal(ibSourceRef({ ...IB_RAW, transactionID: '', tradeID: '' }), 'ib|exe|EX-333');
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
  assert.match(t.sourceRef, /2026-01\|2026-01-13\|0050\|現賣\|1000\|104\|104000\|103540/, '年月＋日＋代號＋類別＋量＋價＋成交額＋應收付全維度');
  const unknown = normalizeTaishinTrade({ tradeDate: '2026-01-13', settlementDate: null, rawType: '興櫃申購', symbol: 'X1', name: '',
    quantity: 10, price: 1, grossAmount: 10, commission: 0, feeDiscount: 0, tax: 0, otherFees: null, netSettlement: 10, currency: 'TWD' }, ctx);
  assert.ok(unknown);
  assert.equal(unknown.side, null);
  assert.equal(unknown.flags.unknownType, true, 'S2 預覽據此阻擋');
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
  assert.equal(list[2].sourceRef, 'ib|txn|T-111', '官方識別碼天生唯一、不加序（跨批穩定）');
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
