import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isRealDate} from '../public/modules/calendar-date.js';
import {isRealDate as schemaDate} from '../lib/schema.js';
import {recordedIncomePeriod as recordedPeriod,incomePeriodLabel} from '../public/modules/ib-income-period.js';
import {dividendEquivalent,dividendResultText,dividendReason} from '../public/modules/portfolio-dividend.js';
const income=()=>({periodBasis:'ib-flex-single-statement-v1',from:'20260115',to:'20260320',dividends:100,paymentInLieu:25,withholdingTax:-20,interestPaid:-8,interestReceived:6,other:300,count:6,skippedNoFx:0,skippedNoCurrency:0,estimatedNoFx:0});
const price=()=>({amountText:'40',currency:'USD'});
const calculate=(i=income(),p=price())=>dividendEquivalent(i,p);

test('PIL is included and tax interest other are excluded; no whole-unit rounding',()=>{
  const result=calculate();assert.equal(result.ok,true);assert.equal(result.gross,125);assert.equal(result.units,3.125);assert.equal(result.unitPrice,40);assert.equal(result.estimated,false);assert.equal(result.period.label,'2026/01/15–2026/03/20');
});

test('same-day period and leap-day predicate preserve calendar policy',()=>{
  assert.equal(recordedPeriod({...income(),from:'20240229',to:'20240229'}).ok,true);
  for(const [value,expected] of [['2024-02-29',true],['2026-02-29',false],['2026-02-31',false],['0099-01-01',false],['0100-01-01',true],['0000-01-01',false],['2026-12-31',true],['2026-13-01',false]])assert.equal(isRealDate(value),expected,value);
});

test('period basis is required even for plausible dates',()=>{
  for(const value of [undefined,null,'ib-flex-single-statement-v2',1,true]){const i=income();if(value===undefined)delete i.periodBasis;else i.periodBasis=value;assert.deepEqual(calculate(i),{ok:false,reason:'period-unverified'});}
});

test('raw dates require complete eight digits and actual ordered calendar days',()=>{
  for(const [from,to] of [['20260231','20260320'],['20260115','20260230'],['20260115','20260114'],['2026-01-15','20260320'],['20260115x','20260320'],['20260115',' 20260320'],['2026011','20260320'],[20260115,'20260320'],['20260115',null]])assert.deepEqual(calculate({...income(),from,to}),{ok:false,reason:'period-invalid'});
});

test('missing and malformed income do not get a period or amount',()=>{
  for(const i of [null,undefined,[],42,'x'])assert.deepEqual(dividendEquivalent(i,price()),{ok:false,reason:'income-unavailable'});
});

for(const field of ['dividends','paymentInLieu'])test(`finite amount is required: ${field}`,()=>{
  for(const value of [undefined,null,'100',NaN,Infinity]){const i=income();if(value===undefined)delete i[field];else i[field]=value;assert.deepEqual(calculate(i),{ok:false,reason:'amount-unavailable'});}
});
for(const field of ['count','skippedNoFx','skippedNoCurrency','estimatedNoFx'])test(`quality is explicit nonnegative safe integer: ${field}`,()=>{
  for(const value of [undefined,null,'0',-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const i=income();if(value===undefined)delete i[field];else i[field]=value;assert.deepEqual(calculate(i),{ok:false,reason:'quality-unavailable'});}
});

test('known omitted currency and FX refuse even with otherwise valid data',()=>{
  assert.deepEqual(calculate({...income(),skippedNoCurrency:1}),{ok:false,reason:'incomplete-currency'});
  assert.deepEqual(calculate({...income(),skippedNoFx:1}),{ok:false,reason:'incomplete-fx'});
});

test('estimated qualification is explicit; no missing estimate count becomes zero',()=>{
  const result=calculate({...income(),estimatedNoFx:2});assert.equal(result.ok,true);assert.equal(result.units,3.125);assert.equal(result.estimated,true);
});

test('zero and negative corrections retain neutral numeric sign',()=>{
  const zero=calculate({...income(),dividends:-25});assert.equal(zero.ok,true);assert.equal(zero.units,0);
  const negative=calculate({...income(),dividends:-45});assert.equal(negative.ok,true);assert.equal(negative.gross,-20);assert.equal(negative.units,-0.5);
});

test('USD reference price is explicit and cannot default to an amount',()=>{
  for(const currency of [undefined,null,'TWD','usd'])assert.deepEqual(calculate(income(),{amountText:'40',currency}),{ok:false,reason:'price-currency'});
  assert.deepEqual(calculate(income(),{amountText:'',currency:'USD'}),{ok:false,reason:'price-missing'});
  for(const amountText of [null,40,'0','-1','0x10','1e3','40USD','Infinity','1,000','.5','5.','1..0','1 0','0.'+'0'.repeat(400)+'1'])assert.deepEqual(calculate(income(),{amountText,currency:'USD'}),{ok:false,reason:'price-invalid'});
  assert.equal(calculate(income(),{amountText:' +40.000 ',currency:'USD'}).units,3.125);
});

test('amount and result overflow are distinct and never produce units',()=>{
  assert.deepEqual(calculate({...income(),dividends:Number.MAX_VALUE,paymentInLieu:Number.MAX_VALUE}),{ok:false,reason:'amount-overflow'});
  assert.deepEqual(calculate(income(),{amountText:'0.'+'0'.repeat(323)+'5',currency:'USD'}),{ok:false,reason:'result-overflow'});
});

test('S4 quantity cap is not applied to financial amounts',()=>{
  const result=calculate({...income(),dividends:2e9,paymentInLieu:0},{amountText:'1',currency:'USD'});assert.equal(result.ok,true);assert.equal(result.units,2e9);
});

test('recorded qualification requires own fields and never mutates inputs',()=>{
  const parent=income(),inherited=Object.create(parent);assert.deepEqual(calculate(inherited),{ok:false,reason:'period-unverified'});
  const i=income(),p=price(),before=structuredClone({i,p});const result=calculate(i,p);assert.equal(result.ok,true);assert.deepEqual({i,p},before);assert.notEqual(result.period,i);assert.equal(Object.hasOwn(result,'periodBasis'),false);
});

test('非零除法下溢拒算，真零與可表示的極小非零值保留', () => {
  for (const sign of [1, -1]) {
    const i = {...income(), dividends: sign * Number.MIN_VALUE, paymentInLieu: 0};
    assert.deepEqual(calculate(i, {amountText:'2', currency:'USD'}), {ok:false, reason:'result-out-of-range'});
    const small = calculate(i, {amountText:'1', currency:'USD'});
    assert.equal(small.ok, true);
    assert.equal(small.units, sign * Number.MIN_VALUE);
    assert.equal(dividendResultText(small), sign > 0 ? '約 5e−324 參考單位' : '約 −5e−324 參考單位；負值表示配息沖回。');
  }
  const zero = calculate({...income(), dividends:-0, paymentInLieu:-0});
  assert.equal(zero.ok,true);
  assert.equal(Object.is(zero.units,-0),false);
  assert.equal(dividendResultText(zero),'約 0 參考單位；本報表配息合計為零。');
});

test('計算不先四捨五入金額或單價，非零小額仍有結果', () => {
  assert.equal(calculate({...income(),dividends:12.5,paymentInLieu:0},{amountText:'2',currency:'USD'}).units,6.25);
  assert.equal(calculate({...income(),dividends:0.01,paymentInLieu:0},{amountText:'0.002',currency:'USD'}).units,5);
  const estimated = calculate({...income(),estimatedNoFx:1});
  assert.match(dividendResultText(estimated), /含匯率估算/);
});

test('日曆抽出保留 schema 具名入口與既有年份、時區判準', () => {
  assert.equal(schemaDate,isRealDate);
  for(const [value,expected] of [['2024-02-29',true],['2026-02-29',false],['0099-01-01',false],['0100-01-01',true],['0000-01-01',false],['2026-12-31',true],['2026-13-01',false],['2026-01-00',false],['2026-1-01',false],['2026-01-01T00:00:00Z',false],[null,false]]) {
    assert.equal(schemaDate(value),expected, String(value));
    assert.equal(isRealDate(value),expected, String(value));
  }
});

test('期間標籤保留完整日、舊資料不假稱完整月份，未知原因安全退回', () => {
  assert.equal(incomePeriodLabel(income()), '2026/01/15–2026/03/20');
  const old = income(); delete old.periodBasis;
  assert.equal(incomePeriodLabel(old), '2026/01/15–2026/03/20；單報表期間尚未核對');
  for(const from of ['202601', '<img src=x>', null]) assert.equal(incomePeriodLabel({...income(),from}), '期間資料不完整或無效，尚未核對');
  assert.equal(dividendReason('toString'),'資料無法換算。');
  assert.equal(dividendResultText({ok:false,reason:'result-out-of-range'}),'數值超出可表示範圍，無法換算。');
});


test('換算資格｜自有期間不能掩護從原型繼承的金額、品質或單價', () => {
  for (const field of ['dividends','paymentInLieu','count','skippedNoFx','skippedNoCurrency','estimatedNoFx']) {
    const i=income();const value=i[field];delete i[field];Object.setPrototypeOf(i,{[field]:value});
    assert.deepEqual(dividendEquivalent(i,price()),{ok:false,reason:['dividends','paymentInLieu'].includes(field)?'amount-unavailable':'quality-unavailable'});
  }
  for(const field of ['currency','amountText']) {
    const p=price();const value=p[field];delete p[field];Object.setPrototypeOf(p,{[field]:value});
    assert.deepEqual(dividendEquivalent(income(),p),{ok:false,reason:field==='currency'?'price-currency':'price-invalid'});
  }
});
