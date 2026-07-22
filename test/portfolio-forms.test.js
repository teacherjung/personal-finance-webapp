import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capeFormModel,
  fxBandsFormModel,
  holdingFormModel,
  holdingSubmission,
  signalsFormModel,
  watchFormModel
} from '../public/modules/portfolio-forms.js';

const LAYERS = { core: { label: '核心' }, stock: { label: '個股' } };
const ORDER = ['core', 'stock'];

test('投資表單｜新增持股保留 USD 與核心預設，欄位沿用分層和四種幣別', () => {
  const form = holdingFormModel(null, LAYERS, ORDER);
  assert.equal(form.title, '新增持股');
  assert.deepEqual(form.values, { currency: 'USD', layer: 'core' });
  assert.deepEqual(form.fields.find(field => field.key === 'layer').options, [
    { value: 'core', label: '核心' },
    { value: 'stock', label: '個股' }
  ]);
  assert.deepEqual(form.fields.find(field => field.key === 'currency').options, ['USD', 'TWD', 'GBP', 'JPY']);
});

test('投資表單｜舊持股缺均價時由成本除股數帶回，已有均價則四捨五入兩位', () => {
  assert.equal(holdingFormModel({ quantity: 3, cost: 100 }, LAYERS, ORDER).values.avgCost, 33.33);
  assert.equal(holdingFormModel({ quantity: 3, cost: 100, avgCost: 9.876 }, LAYERS, ORDER).values.avgCost, 9.88);
  assert.equal(holdingFormModel({ quantity: 0, cost: 100 }, LAYERS, ORDER).values.avgCost, '');
});

test('投資表單｜持股送出統一價格精度並重算成本，不改動原始表單資料', () => {
  const data = { symbol: ' cspx ', layer: 'core', quantity: 3, avgCost: 10.126, price: 12.345 };
  const result = holdingSubmission(null, data, { symbols: new Set(), regions: new Set(), equity: false });
  assert.equal(result.symbol, 'CSPX');
  assert.deepEqual(result.body, { ...data, symbol: 'CSPX', avgCost: 10.13, price: 12.35, cost: 30.39 });
  assert.equal(data.cost, undefined);
});

test('投資表單｜只有加碼才列凍結原因，且依單一個股、區域、股票總曝險排序', () => {
  const freeze = { symbols: new Set(['AAPL']), regions: new Set(['美國']), equity: true };
  const added = holdingSubmission({ symbol: 'AAPL', layer: 'stock', quantity: 1 }, { symbol: 'aapl', layer: 'stock', quantity: 2 }, freeze);
  assert.deepEqual(added.freezeReasons, ['單一個股上限', '美國上限', '股票總曝險上限']);

  const reduced = holdingSubmission({ symbol: 'AAPL', layer: 'stock', quantity: 2 }, { symbol: 'aapl', layer: 'stock', quantity: 1 }, freeze);
  assert.deepEqual(reduced.freezeReasons, []);
});

test('投資表單｜股數不變但改成已凍結標的仍要警告，不能靠換代號繞過上限', () => {
  const freeze = { symbols: new Set(['AAPL']), regions: new Set(['美國']), equity: true };
  const changed = holdingSubmission(
    { symbol: 'GOOGL', layer: 'stock', quantity: 2 },
    { symbol: ' aapl ', layer: 'stock', quantity: 2 },
    freeze
  );

  assert.equal(changed.body.symbol, 'AAPL');
  assert.deepEqual(changed.freezeReasons, ['單一個股上限', '美國上限', '股票總曝險上限']);
});

test('投資表單｜股數不變但改進個股層仍要重新檢查凍結上限', () => {
  const freeze = { symbols: new Set(['AAPL']), regions: new Set(), equity: false };
  const changed = holdingSubmission(
    { symbol: 'AAPL', layer: 'core', quantity: 2 },
    { symbol: 'AAPL', layer: 'stock', quantity: 2 },
    freeze
  );

  assert.deepEqual(changed.freezeReasons, ['單一個股上限']);
});

test('投資表單｜願望清單、估值、CAPE 與休眠匯率表單保留原預設', () => {
  assert.deepEqual(watchFormModel(null).values, { currency: 'USD' });
  assert.equal(watchFormModel({ symbol: 'QQQM' }).title, '編輯願望清單');
  assert.deepEqual(signalsFormModel({ signals: { china: 12 } }).values, { china: 12 });
  assert.deepEqual(capeFormModel({ capeManual: 31 }).values, { capeManual: 31 });
  assert.deepEqual(fxBandsFormModel({}).values, { fxLow: 28, fxHigh: 32 });
});
