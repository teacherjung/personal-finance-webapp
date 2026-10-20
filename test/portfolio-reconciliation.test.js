import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReferenceQuantity, parseAppQuantity, quantityText, quantityDifference, createReferenceComparison, snapshotHoldings, createReferenceSession, createPortfolioReferenceSession } from '../public/modules/portfolio-reconciliation.js';
import { isRealDate } from '../public/modules/calendar-date.js';
import { normalizePortfolioSymbol } from '../public/modules/portfolio-symbol.js';
{

for(const [reference,app,text,scaled] of [
  ['0.3',0.1,'0.2',200000],
  ['0.000003',0.000001,'0.000002',2],
  ['-1.25',2.5,'−3.75',-3750000],
  ['2.5',-1.25,'3.75',3750000],
  ['-1.25',-2.5,'1.25',1250000],
  ['0',0,'0',0],
  ['-0',-0,'0',0],
  ['1000000000',-1000000000,'2000000000',2000000000000000],
  ['-1000000000',1000000000,'−2000000000',-2000000000000000],
  ['999999999.999999',999999999.999998,'0.000001',1],
  [' +001.23000000 ',1,'0.23',230000],
  ['−0.000001',0,'−0.000001',-1],
]) test(`exact difference ${reference} minus ${app}`,()=>assert.deepEqual(quantityDifference(reference,app),{ok:true,scaled,text}));

test('reference rejects incomplete, nondecimal and trailing text',()=>{
  for(const value of ['',' ','0x10','1e2','1,000','1 USD','NaN','Infinity','.5','1.','--1','−-1','1\n2','<img>'])assert.equal(parseReferenceQuantity(value).ok,false,JSON.stringify(value));
  for(const value of [null,undefined,0,false,{},['1']])assert.equal(parseReferenceQuantity(value).ok,false,String(value));
});

test('reference precision keeps zero tails but never removes nonzero tails',()=>{
  assert.deepEqual(parseReferenceQuantity('0.123456000'),{ok:true,scaled:123456});
  assert.deepEqual(parseReferenceQuantity('0.1234561'),{ok:false,reason:'precision'});
  assert.deepEqual(parseReferenceQuantity('0.0000001'),{ok:false,reason:'precision'});
});

test('each reference side has its own range',()=>{
  for(const value of ['1000000000.000001','-1000000000.000001','1000000001','9999999999','10000000000'])assert.deepEqual(parseReferenceQuantity(value),{ok:false,reason:'range'},value);
});

test('App requires actual finite numbers and preserves stored precision',()=>{
  for(const value of [null,undefined,'0','1.2',false,{},[]])assert.deepEqual(parseAppQuantity(value),{ok:false,reason:'type'});
  for(const value of [NaN,Infinity,-Infinity])assert.deepEqual(parseAppQuantity(value),{ok:false,reason:'non-finite'});
  for(const value of [0.30000000000000004,0.1234567,0.0000001])assert.equal(parseAppQuantity(value).ok,false,String(value));
  assert.deepEqual(parseAppQuantity(0.000001),{ok:true,scaled:1});
  for(const value of [1000000001,-1000000001])assert.deepEqual(parseAppQuantity(value),{ok:false,reason:'range'});
});

test('missing or malformed side cannot produce a difference',()=>{
  for(const pair of [['',0],['1',undefined],['1','0'],['1.0000001',0],['1',NaN]]){
    const result=quantityDifference(...pair);assert.equal(result.ok,false);assert.equal(Object.hasOwn(result,'text'),false);assert.equal(Object.hasOwn(result,'scaled'),false);
  }
});

test('format uses exact integer digits and rejects invalid internal values',()=>{
  for(const [value,expected] of [[0,'0'],[-0,'0'],[1,'0.000001'],[-1,'−0.000001'],[1234500,'1.2345'],[2000000000000000,'2000000000']])assert.equal(quantityText(value),expected);
  for(const value of [NaN,Infinity,0.1,2000000000000001,-2000000000000001,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>quantityText(value),RangeError);
});

}

{

const compare = createReferenceComparison({ isRealDate, normalizePortfolioSymbol });
function valid() {
  return {
    holdings: [{ id: 'selected', symbol: ' cSpX ', quantity: 0.1 }, { id: 'other', symbol: 'CSPX', quantity: 99 }],
    selectedId: 'selected',
    reference: { sourceLabel: '合成來源', scopeLabel: '合成範圍', marketLabel: '合成掛牌', date: '2024-02-29', symbol: 'cspx', quantity: '0.3', unit: '股' },
    confirmations: { sameInstrument: true, sameScope: true, sameQuantityDefinition: true },
  };
}
function rejects(input, reason) {
  const out = compare(input);
  assert.equal(out.kind, 'parallel', '條件不足不得產生可算結果');
  assert.equal(out.difference, null, '條件不足不得產生差額');
  assert.ok(out.reasons.includes(reason), '應指出本題缺少的條件');
}

test('有效人工條件只算選定列，使用既有代號與精確算術', () => {
  const input = valid();
  const before = structuredClone(input);
  const out = compare(input);
  assert.equal(out.kind, 'difference');
  assert.deepEqual(out.difference, { scaled: 200000, text: '0.2' });
  assert.deepEqual(out.reasons, []);
  assert.deepEqual(input, before);
  assert.equal(out.appPositionDate, null);
  assert.equal(out.reconciliation, 'not-established');
  assert.equal(out.identityBasis, 'manual-confirmation');
});

test('沒有明確選列不預選，數字零不是字串id', () => {
  for (const id of [undefined, null, '', ' ', 0]) {
    const input = valid(); input.selectedId = id;
    input.holdings = [{ id, symbol: 'CSPX', quantity: 0.1 }];
    rejects(input, 'selection-required');
  }
});
test('不存在id不能退取第一列', () => {
  const missing = valid(); missing.selectedId = 'absent'; rejects(missing, 'selection-not-unique');
});
test('重複id不能任選第一筆', () => {
  const duplicate = valid(); duplicate.holdings.push({ ...duplicate.holdings[0] }); rejects(duplicate, 'selection-not-unique');
});
test('缺id的資料不能提供選列身分', () => {
  const noId = valid(); delete noId.holdings[0].id; rejects(noId, 'selection-not-unique');
});
test('原型id不能提供選列身分', () => {
  const inherited = valid(); inherited.holdings[0] = Object.assign(Object.create({ id: 'selected' }), { symbol: 'CSPX', quantity: 0.1 });
  rejects(inherited, 'selection-not-unique');
});
test('字串零與原型保留字可作純比對id而不使用普通物件查表', () => {
  for (const id of ['0', '__proto__', 'constructor']) {
    const input = valid(); input.selectedId = id; input.holdings[0].id = id;
    assert.equal(compare(input).difference.text, '0.2');
  }
});
for (const key of ['sourceLabel', 'scopeLabel', 'marketLabel']) {
  test('必要手動描述 ' + key + ' 缺少時拒算', () => {
    for (const value of [undefined, null, '', ' ', 0, true, {}]) {
      const input = valid(); input.reference[key] = value;
      rejects(input, key + '-required');
    }
  });
}
test('兩側代號非空才可比，同為空不能當身分相等', () => {
  for (const side of ['app', 'reference', 'both']) {
    const input = valid();
    if (side !== 'app') input.reference.symbol = '';
    if (side !== 'reference') input.holdings[0].symbol = '';
    rejects(input, 'symbol-required');
  }
});
test('錯代號不被人工勾選或同幣別掩蓋', () => {
  const input = valid(); input.reference.symbol = 'NOT-CSPX';
  input.holdings[0].currency = 'USD'; input.reference.currency = 'USD';
  rejects(input, 'symbol-mismatch');
});
test('沿實際日曆判準拒絕非法日與缺日，閏年有效日可算', () => {
  for (const date of [undefined, null, '', '2023-02-29', '2024-02-30', '2024-13-01', '2024-00-01', '2024-01-00', '2024-2-01', '2024-02-29T00:00:00Z']) {
    const input = valid(); input.reference.date = date;
    rejects(input, 'reference-date-invalid');
  }
  for (const date of ['2024-02-29', '2023-02-28', '2000-02-29']) {
    const input = valid(); input.reference.date = date;
    assert.equal(compare(input).kind, 'difference');
  }
});
test('未確認與未支援單位拒算，股或單位直接使用同一數量', () => {
  for (const unit of [undefined, null, '', '未確認', '張', '口', '重量', '股 ', true]) {
    const input = valid(); input.reference.unit = unit;
    rejects(input, 'unit-unconfirmed-or-unsupported');
  }
  for (const unit of ['股', '單位']) {
    const input = valid(); input.reference.unit = unit;
    assert.equal(compare(input).difference.text, '0.2');
  }
});
for (const key of ['sameInstrument', 'sameScope', 'sameQuantityDefinition']) {
  test('人工確認 ' + key + ' 僅接受明確布林true', () => {
    for (const value of [undefined, null, false, 'true', 'false', 1, {}]) {
      const input = valid(); input.confirmations[key] = value;
      rejects(input, key + '-unconfirmed');
    }
    const input = valid();
    const ownConfirmations = { ...input.confirmations }; delete ownConfirmations[key];
    input.confirmations = Object.assign(Object.create({ [key]: true }), ownConfirmations);
    rejects(input, key + '-unconfirmed');
  });
}
test('明確雙零可以相減，缺數量不可補零', () => {
  const zero = valid(); zero.reference.quantity = '0'; zero.holdings[0].quantity = 0;
  const out = compare(zero);
  assert.deepEqual(out.difference, { scaled: 0, text: '0' });
  assert.equal(out.reconciliation, 'not-established');
  for (const value of [undefined, null, '']) {
    const input = valid(); input.reference.quantity = value; rejects(input, 'quantity-invalid');
  }
  for (const value of [undefined, null, '', '0', false, NaN, Infinity]) {
    const input = valid(); input.holdings[0].quantity = value; rejects(input, 'quantity-invalid');
  }
});
test('過精度與負數沿既有算術；App日期維持未知', () => {
  const noisy = valid(); noisy.holdings[0].quantity = 0.1 + 0.2; rejects(noisy, 'quantity-invalid');
  const negative = valid(); negative.reference.quantity = '-0.3'; negative.holdings[0].quantity = -0.1;
  negative.holdings[0].quoteAt = '2024-02-29'; negative.holdings[0].lastSync = '2024-02-29';
  const out = compare(negative);
  assert.deepEqual(out.difference, { scaled: -200000, text: '−0.2' });
  assert.equal(out.appPositionDate, null);
});
test('缺必要條件時保留兩邊可呈現數量並列', () => {
  const input = valid(); input.confirmations.sameScope = false;
  const out = compare(input);
  assert.equal(out.referenceQuantity, '0.3'); assert.equal(out.appQuantity, 0.1);
  assert.equal(out.referenceDate, '2024-02-29'); assert.equal(out.difference, null);
});

}

{

test('原列後續改量不改快照且來源仍可寫', () => {
  const input = [{ id: 'row-change', symbol: 'EXAMPLE', quantity: 13.125 }];
  const before = structuredClone(input);
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.deepEqual(input, before);
  assert.equal(Reflect.set(input[0], 'quantity', -47.5), true);
  assert.equal(input[0].quantity, -47.5);
  assert.equal(got.rows[0].quantity, 13.125, 'S4 snapshot: copied quantity must survive source edit');
});

test('原陣列替換列與增列不改快照', () => {
  const input = [{ id: 'array-original', quantity: 71 }];
  const before = structuredClone(input);
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.deepEqual(input, before);
  assert.equal(Reflect.set(input, '0', { id: 'array-replacement', quantity: 92 }), true);
  assert.equal(Reflect.set(input, '1', { id: 'array-added', quantity: 11 }), true);
  assert.equal(input.length, 2);
  assert.equal(got.rows.length, 1, 'S4 snapshot: copied array must survive source growth');
  assert.equal(got.rows[0].id, 'array-original');
});

test('快照列實際改量被拒且原值保存', () => {
  const input = [{ id: 'frozen-row', quantity: 31 }];
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.equal(Reflect.set(got.rows[0], 'quantity', 88), false, 'S4 snapshot: snapshot row modification must be rejected');
  assert.equal(got.rows[0].quantity, 31);
  assert.equal(input[0].quantity, 31);
});

test('快照陣列替換增列與截短都被拒', () => {
  const input = [{ id: 'frozen-array', quantity: 41 }];
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.equal(Reflect.set(got.rows, '0', { id: 'foreign', quantity: 7 }), false, 'S4 snapshot: snapshot array replacement must be rejected');
  assert.equal(Reflect.set(got.rows, '1', {}), false);
  assert.equal(Reflect.set(got.rows, 'length', 0), false);
  assert.deepEqual(got.rows, [{ id: 'frozen-array', quantity: 41 }]);
  assert.deepEqual(input, [{ id: 'frozen-array', quantity: 41 }]);
});

test('白名單投影排除額外合成秘密及推導日期', () => {
  const input = [{ id: '__proto__', symbol: ' raw ', name: 'Example', currency: 'USD', quantity: 3, source: 'unconfirmed', privateNote: 'synthetic-private-sentinel', lastSync: '2099-01-01', priceSource: 'manual' }];
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.equal(Object.hasOwn(got.rows[0], 'privateNote'), false, 'S4 snapshot: synthetic private field must not escape projection');
  assert.deepEqual(Object.keys(got.rows[0]), ['id', 'symbol', 'name', 'currency', 'quantity', 'source']);
  assert.deepEqual(got.rows[0], { id: '__proto__', symbol: ' raw ', name: 'Example', currency: 'USD', quantity: 3, source: 'unconfirmed' });
});

test('額外欄位getter及內層不會取值', () => {
  let reads = 0;
  const row = { id: 'extra-getter', quantity: 4 };
  Object.defineProperty(row, 'privateNote', { enumerable: true, get() { reads += 1; throw new Error('Synthetic getter must not execute'); } });
  row.extra = { get secret() { reads += 1; throw new Error('Synthetic nested getter must not execute'); } };
  const got = snapshotHoldings([row]);
  assert.equal(got.ok, true);
  assert.equal(reads, 0);
  assert.deepEqual(got.rows[0], { id: 'extra-getter', quantity: 4 });
});

test('順序列數與重複id原樣保留', () => {
  const input = [{ id: 'same', quantity: 2 }, { id: 'other', quantity: 1 }, { id: 'same', quantity: 5 }];
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.deepEqual(got.rows, input);
  assert.equal(got.rows.length, 3);
});

test('缺欄與明確空值不補零且錯型別不強轉', () => {
  const input = [{ id: 'missing' }, { id: 'undefined', quantity: undefined }, { id: 'null', quantity: null }, { id: 'text', quantity: '9' }, { id: 'boolean', quantity: false }, { id: 'nan', quantity: NaN }, { id: 'infinity', quantity: Infinity }, { id: 'negative-zero', quantity: -0 }];
  const got = snapshotHoldings(input);
  assert.equal(got.ok, true);
  assert.equal(Object.hasOwn(got.rows[0], 'quantity'), false);
  assert.equal(Object.hasOwn(got.rows[1], 'quantity'), true);
  assert.deepEqual(got.rows, input);
  assert.equal(Object.is(got.rows[7].quantity, -0), true);
});

test('白名單accessor整批拒收而且getter不執行', () => {
  let reads = 0;
  const bad = { id: 'accessor' };
  Object.defineProperty(bad, 'quantity', { get() { reads += 1; return 8; } });
  const got = snapshotHoldings([{ id: 'valid-before', quantity: 1 }, bad]);
  assert.equal(reads, 0);
  assert.deepEqual(got, { ok: false, reason: 'unsupported-snapshot-input' });
  assert.equal(Object.hasOwn(got, 'rows'), false);
});

test('物件函式與未支援primitive整批拒收', () => {
  for (const value of [{ nested: 'synthetic' }, [], () => 3, Symbol('synthetic'), 1n]) {
    const input = [{ id: 'valid-before', quantity: 2 }, { id: 'invalid-field', quantity: value }];
    const got = snapshotHoldings(input);
    assert.deepEqual(got, { ok: false, reason: 'unsupported-snapshot-input' });
    assert.equal(input.length, 2);
    assert.equal(input[1].quantity, value);
  }
});

test('非plain列與稀疏或accessor陣列項目整批拒收', () => {
  for (const row of [null, undefined, 4, 'row', [], new Date(0), Object.create({ id: 'inherited' }), new (class Holding {})()]) {
    assert.deepEqual(snapshotHoldings([{ id: 'valid-before' }, row]), { ok: false, reason: 'unsupported-snapshot-input' });
  }
  const sparse = [];
  sparse.length = 3;
  sparse[0] = { id: 'before-hole' };
  sparse[2] = { id: 'after-hole' };
  assert.equal(Object.hasOwn(sparse, 1), false);
  assert.equal(snapshotHoldings(sparse).ok, false);
  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { reads += 1; return { id: 'accessor-index' }; } });
  assert.equal(snapshotHoldings(accessor).ok, false);
  assert.equal(reads, 0);
});

test('空陣列與null原型列可複製且非陣列拒收', () => {
  assert.deepEqual(snapshotHoldings([]), { ok: true, rows: [] });
  const row = Object.assign(Object.create(null), { id: 'null-prototype', quantity: 0 });
  assert.deepEqual(snapshotHoldings([row]), { ok: true, rows: [{ id: 'null-prototype', quantity: 0 }] });
  for (const input of [null, undefined, {}, 'array']) assert.equal(snapshotHoldings(input).ok, false);
});

}

{
const compare=createReferenceComparison({isRealDate,normalizePortfolioSymbol});
const hint='核對 public/modules/portfolio-reconciliation.js 的選列／欄位／calculate／read／dispose；重跑 node --test test/portfolio-reconciliation.test.js';
const refs={sourceLabel:'合成來源',scopeLabel:'合成範圍',symbol:'TEST',marketLabel:'合成掛牌',date:'2024-02-29',unit:'股',quantity:'0.3'};
const confirmationNames=['sameInstrument','sameScope','sameQuantityDefinition'];
const noConfirmations={sameInstrument:false,sameScope:false,sameQuantityDefinition:false};
function fresh(id,quantity=0.1){
  const holdings=[{id,symbol:'TEST',name:'合成標的',quantity,currency:'USD',source:'manual'}];
  const calls={snapshot:0,compare:0,throwNow:false};
  const session=createReferenceSession({holdings,snapshotHoldings:input=>{calls.snapshot++;return snapshotHoldings(input);},compareReference:input=>{calls.compare++;if(calls.throwNow)throw new Error('SYNTHETIC-COMPARISON-FAILURE');return compare(input);}});
  assert.equal(session.ok,true,hint);return{session,holdings,calls,id};
}
function fill(f,quantity='0.3'){
  assert.equal(f.session.select(f.id).ok,true,hint);
  for(const [field,value]of Object.entries({...refs,quantity}))assert.equal(f.session.setReferenceField(field,value).ok,true,hint);
  for(const name of confirmationNames)assert.equal(f.session.setConfirmation(name,true).ok,true,hint);
  return f;
}
function valid(f,expected='0.2'){
  const r=f.session.calculate();assert.equal(r.ok,true,hint);assert.equal(r.comparison.kind,'difference',hint);assert.equal(r.comparison.difference.text,expected,hint);return r;
}
test('初始全空、無確認、未計算且只取一次快照',()=>{
  const f=fresh('initial');const state=f.session.read();assert.equal(state.status,'active',hint);assert.equal(state.selectedId,'',hint);
  for(const value of Object.values(state.reference))assert.equal(value,'',hint);assert.deepEqual(state.confirmations,noConfirmations,hint);assert.equal(state.comparison,null,hint);assert.equal(f.calls.snapshot,1,hint);assert.equal(f.calls.compare,0,hint);
  fill(f);valid(f);f.session.read();valid(f);assert.equal(f.calls.snapshot,1,hint);assert.equal(f.calls.compare,2,hint);
});
test('不支援的快照明確拒收而非空部位',()=>{
  let calls=0;const result=createReferenceSession({holdings:[null],snapshotHoldings,compareReference:input=>{calls++;return compare(input);}});
  assert.deepEqual(result,{ok:false,reason:'unsupported-snapshot-input'},hint);assert.equal(calls,0,hint);
});
test('必要依賴缺漏明確拒絕',()=>{
  assert.throws(()=>createReferenceSession(),/functions are required/,hint);assert.throws(()=>createReferenceSession({snapshotHoldings}),/functions are required/,hint);
});
test('真正填值與明確計算取得精確中性差額',()=>{
  const f=fill(fresh('explicit'));assert.equal(f.calls.compare,0,hint);assert.equal(f.session.read().comparison,null,hint);const r=valid(f);
  assert.equal(r.comparison.difference.scaled,200000,hint);assert.equal(r.comparison.reconciliation,'not-established',hint);assert.equal(r.comparison.appPositionDate,null,hint);
});
for(const [field,value]of [['sourceLabel','新來源'],['scopeLabel','新範圍'],['symbol',' test '],['marketLabel','新掛牌'],['date','2024-03-01'],['unit','單位']]){
  test('脈絡改變清結果並撤三確認｜'+field,()=>{
    const f=fill(fresh(field));valid(f);const beforeCalls=f.calls.compare;assert.equal(f.session.setReferenceField(field,value).changed,true,hint);
    const state=f.session.read();assert.equal(state.reference[field],value,hint);assert.equal(state.comparison,null,hint);assert.deepEqual(state.confirmations,noConfirmations,hint);assert.equal(f.calls.compare,beforeCalls,hint);
    const r=f.session.calculate();assert.equal(r.comparison.kind,'parallel',hint);assert(r.comparison.reasons.includes('sameInstrument-unconfirmed'),hint);
  });
}
test('選列改變清結果並撤確認而不代選',()=>{
  const f=fill(fresh('selected'));valid(f);const count=f.calls.compare;f.session.select('missing');const state=f.session.read();assert.equal(state.selectedId,'missing',hint);assert.equal(state.comparison,null,hint);assert.deepEqual(state.confirmations,noConfirmations,hint);assert.equal(f.calls.compare,count,hint);assert.equal(f.session.calculate().comparison.kind,'parallel',hint);
});
test('選列清空及脈絡改回原值不復活',()=>{
  const f=fill(fresh('return'));valid(f);f.session.select('');f.session.select(f.id);assert.equal(f.session.read().comparison,null,hint);assert.deepEqual(f.session.read().confirmations,noConfirmations,hint);
  fill(f);valid(f);f.session.setReferenceField('scopeLabel','另一範圍');f.session.setReferenceField('scopeLabel',refs.scopeLabel);assert.equal(f.session.read().comparison,null,hint);assert.deepEqual(f.session.read().confirmations,noConfirmations,hint);
});
for(const field of confirmationNames){
  test('確認更新只動該項且清結果｜'+field,()=>{
    const f=fill(fresh(field));valid(f);const n=f.calls.compare;f.session.setConfirmation(field,false);let s=f.session.read();assert.equal(s.comparison,null,hint);assert.equal(s.confirmations[field],false,hint);for(const other of confirmationNames.filter(x=>x!==field))assert.equal(s.confirmations[other],true,hint);assert.equal(f.calls.compare,n,hint);
    assert.equal(f.session.calculate().comparison.kind,'parallel',hint);f.session.setConfirmation(field,true);s=f.session.read();assert.equal(s.comparison,null,hint);valid(f);
    const g=fresh('single-'+field);g.session.calculate();g.session.setConfirmation(field,true);s=g.session.read();assert.equal(s.comparison,null,hint);for(const other of confirmationNames.filter(x=>x!==field))assert.equal(s.confirmations[other],false,hint);assert.equal(g.calls.compare,1,hint);
  });
}
test('新數量清舊結果保留確認並用當前值重算',()=>{
  const f=fill(fresh('quantity'));valid(f);f.session.setReferenceField('quantity','0.6');const state=f.session.read();assert.equal(state.comparison,null,hint);assert.deepEqual(state.confirmations,{sameInstrument:true,sameScope:true,sameQuantityDefinition:true},hint);assert.equal(f.calls.compare,1,hint);valid(f,'0.5');
  f.session.setReferenceField('quantity','0.1234567');assert.equal(f.session.read().comparison,null,hint);const bad=f.session.calculate();assert.equal(bad.comparison.kind,'parallel',hint);assert(bad.comparison.reasons.includes('quantity-invalid'),hint);
});
test('無變化通知不撤銷且不自動算',()=>{
  const f=fill(fresh('same'));valid(f);const before=f.session.read();assert.equal(f.session.select(f.id).changed,false,hint);for(const [field,value]of Object.entries(refs))assert.equal(f.session.setReferenceField(field,value).changed,false,hint);for(const field of confirmationNames)assert.equal(f.session.setConfirmation(field,true).changed,false,hint);assert.deepEqual(f.session.read(),before,hint);assert.equal(f.calls.compare,1,hint);
});
test('錯欄位與型別拒收且整份狀態保存',()=>{
  const f=fill(fresh('invalid'));valid(f);const before=f.session.read();const operations=[()=>f.session.select(null),()=>f.session.select({}),()=>f.session.setReferenceField('__proto__','bad'),()=>f.session.setReferenceField('constructor','bad'),()=>f.session.setReferenceField('unknown','bad'),()=>f.session.setReferenceField('quantity',{}),()=>f.session.setReferenceField('quantity',0),()=>f.session.setConfirmation('__proto__',true),()=>f.session.setConfirmation('sameScope','true'),()=>f.session.setConfirmation('sameScope',1),()=>f.session.setConfirmation('sameScope',undefined)];
  for(const operation of operations){assert.equal(operation().ok,false,hint);assert.deepEqual(f.session.read(),before,hint);}assert.equal(f.calls.compare,1,hint);assert.equal(Object.hasOwn(Object.prototype,'bad'),false,hint);
});
test('原持股後改仍以建立時快照計算',()=>{
  const f=fill(fresh('frozen'));valid(f);f.holdings[0].quantity=0.9;f.holdings.push({...f.holdings[0]});valid(f);assert.equal(f.calls.snapshot,1,hint);assert.equal(f.session.read().rows.length,1,hint);assert.equal(f.session.read().rows[0].quantity,0.1,hint);
});
test('真正session操作不改原輸入或其他資料',()=>{
  const f=fresh('preserved');const other={marker:'FRESH-PRESERVATION',quantity:7};f.holdings[0].privateSentinel='SYNTHETIC-ONLY';const before=structuredClone({holdings:f.holdings,other});fill(f);valid(f);f.session.setReferenceField('quantity','0.4');valid(f,'0.3');f.session.dispose();assert.deepEqual({holdings:f.holdings,other},before,hint);assert.equal(Object.isFrozen(f.holdings),false,hint);assert.equal(Object.isFrozen(f.holdings[0]),false,hint);assert(!JSON.stringify(f.session.read()).includes('SYNTHETIC-ONLY'),hint);
});
test('read的巢狀輸出不能回改內部',()=>{
  const cases=[
    ['reference',exposed=>{exposed.reference.quantity='LEAK-REFERENCE';}],
    ['confirmations',exposed=>{exposed.confirmations.sameScope=false;}],
    ['reasons',exposed=>{exposed.comparison.reasons.push('LEAK-REASONS');}],
    ['difference',exposed=>{exposed.comparison.difference.text='LEAK-DIFFERENCE';}],
  ];
  for(const [name,mutate]of cases){
    const message='回寫落點 '+name+'｜'+hint;
    const f=fill(fresh('read-'+name));valid(f);
    const before=structuredClone(f.session.read());
    assert.equal(before.reference.quantity,'0.3',message);assert.equal(before.confirmations.sameScope,true,message);
    assert.deepEqual(before.comparison.reasons,[],message);assert.equal(before.comparison.difference.text,'0.2',message);
    const exposed=f.session.read();mutate(exposed);
    assert.deepEqual(f.session.read(),before,message);
    assert.equal(f.calls.compare,1,message);assert.equal(Object.isFrozen(exposed.rows),true,message);assert.equal(Object.isFrozen(exposed.rows[0]),true,message);
  }
});
test('calculate傳回結果不能回改內部',()=>{
  const f=fill(fresh('returned'));const exposed=valid(f);exposed.comparison.difference.text='999';exposed.comparison.reasons.push('injected');const state=f.session.read();assert.equal(state.comparison.difference.text,'0.2',hint);assert.deepEqual(state.comparison.reasons,[],hint);
});
test('依賴拋錯清掉上次成功結果',()=>{
  const f=fill(fresh('throws'));valid(f);f.calls.throwNow=true;assert.throws(()=>f.session.calculate(),/SYNTHETIC-COMPARISON-FAILURE/,hint);assert.equal(f.session.read().comparison,null,hint);assert.equal(f.calls.compare,2,hint);
});
test('dispose後舊操作不再更新或呼叫模型',()=>{
  const f=fill(fresh('disposed'));valid(f);const lateCalculate=f.session.calculate,lateSelect=f.session.select;f.session.dispose();f.session.dispose();const state=f.session.read();assert.equal(state.status,'disposed',hint);assert.equal(state.comparison,null,hint);assert.deepEqual(state.confirmations,noConfirmations,hint);
  for(const operation of [()=>lateSelect('late'),()=>f.session.setReferenceField('quantity','8'),()=>f.session.setConfirmation('sameScope',true),()=>lateCalculate()]){assert.deepEqual(operation(),{ok:false,reason:'disposed'},hint);assert.deepEqual(f.session.read(),state,hint);}assert.equal(f.calls.compare,1,hint);assert.equal(f.calls.snapshot,1,hint);
});
test('兩實例各自計算且舊實例不能影響新實例',()=>{
  const a=fill(fresh('A'));valid(a);const beforeA=a.session.read();const b=fill(fresh('B',1.1),'1.5');valid(b,'0.4');assert.deepEqual(a.session.read(),beforeA,hint);const beforeB=b.session.read();const late=a.session.setReferenceField;a.session.dispose();late('quantity','9');a.session.calculate();a.session.dispose();assert.deepEqual(b.session.read(),beforeB,hint);assert.equal(a.calls.compare,1,hint);assert.equal(b.calls.compare,1,hint);valid(b,'0.4');
});

}

test('正式入口共用日曆與代號判準，清空初始狀態',()=>{
  const session=createPortfolioReferenceSession([{id:'formal',symbol:' test ',quantity:0.1}]);
  assert.equal(session.ok,true);session.select('formal');
  for(const [key,value]of Object.entries({sourceLabel:'合成來源',scopeLabel:'合成範圍',marketLabel:'合成掛牌',date:'2024-02-29',symbol:'TEST',quantity:'0.3',unit:'股'}))session.setReferenceField(key,value);
  for(const key of ['sameInstrument','sameScope','sameQuantityDefinition'])session.setConfirmation(key,true);
  assert.equal(session.calculate().comparison.difference.text,'0.2');
  session.setReferenceField('date','2023-02-29');
  assert.equal(session.calculate().comparison.kind,'parallel');
});

test('空白選列的完整參考只要求明確選列', () => {
  const compare = createReferenceComparison({ isRealDate, normalizePortfolioSymbol });
  const hint = '核對 portfolio-reconciliation.js 的選列原因；重跑 node --test test/portfolio-reconciliation.test.js';
  for (const selectedId of ['', ' \t ']) {
    const input = {
      holdings: [{ id: 'unique', symbol: 'TEST', quantity: 0.1 }], selectedId,
      reference: { sourceLabel: '合成來源', scopeLabel: '合成範圍', marketLabel: '合成市場', date: '2024-02-29', symbol: 'TEST', quantity: '0.3', unit: '股' },
      confirmations: { sameInstrument: true, sameScope: true, sameQuantityDefinition: true },
    };
    const result = compare(input);
    assert.equal(result.kind, 'parallel', hint);
    assert.equal(result.difference, null, hint);
    assert.deepEqual(result.reasons, ['selection-required'], hint);
    input.reference.sourceLabel = '';
    input.reference.date = '2024-02-30';
    assert.deepEqual(compare(input).reasons, ['selection-required', 'sourceLabel-required', 'reference-date-invalid'], hint);
  }
});

test('非空選列須以原字串唯一識別才檢查代號', () => {
  const compare = createReferenceComparison({ isRealDate, normalizePortfolioSymbol });
  const hint = '核對 portfolio-reconciliation.js 的唯一身分及代號資格；重跑 node --test test/portfolio-reconciliation.test.js';
  for (const mode of ['missing', 'duplicate', 'inherited', 'padded']) {
    const row = { id: 'unique', symbol: 'TEST', quantity: 0.1 };
    const holdings = mode === 'duplicate' ? [row, { ...row }] : mode === 'inherited' ? [Object.assign(Object.create({ id: 'unique' }), { symbol: 'TEST', quantity: 0.1 })] : [row];
    const selectedId = mode === 'missing' ? 'absent' : mode === 'padded' ? ' unique ' : 'unique';
    const result = compare({ holdings, selectedId,
      reference: { sourceLabel: '合成來源', scopeLabel: '合成範圍', marketLabel: '合成市場', date: '2024-02-29', symbol: 'TEST', quantity: '0.3', unit: '股' },
      confirmations: { sameInstrument: true, sameScope: true, sameQuantityDefinition: true },
    });
    assert.equal(result.kind, 'parallel', hint);
    assert.equal(result.difference, null, hint);
    assert.deepEqual(result.reasons, ['selection-not-unique'], hint);
  }
});
