// 預覽回應機密投影考題（S3 補洞）：GET /api/securities 早已剝指紋/去重鍵（Codex S2r1#6），
// 但 POST /api/securities/preview 的回應原本漏投影——帳戶指紋與 sourceRef 會送到瀏覽器。
// 這裡鎖住 projectSecuritiesPreview 的行為；previewTaishinPdf 已改為回傳投影後結果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSecuritiesPreview } from '../lib/services/securities-import.js';

const fakePreview = () => ({
  stmtMonth: '2026-06',
  accountLabel: '台新證券 …0001',
  blockers: [],
  rows: [{
    source: 'taishin', sourceAccountId: 'fp-機密指紋', sourceAccountLabel: '台新證券 …0001',
    tradeDate: '2026-06-10', symbol: '2330', side: 'buy', quantity: 1000, price: 900,
    netSettlement: 901281, cashDirection: 'out', currency: 'TWD', rawType: '現買',
    sourceRef: 'ts|fp-機密指紋|2026-06-10|2330|現買|1000|900|900000|901281|1',
    flags: { unknownType: false }, duplicate: false, insertRef: 'ts|fp-機密指紋|…|1',
  }],
  byCurrency: { TWD: { buy: 901281, sell: 0, fees: 1281, buyCount: 1, sellCount: 0 } },
  counts: { total: 1, duplicate: 0, importable: 1 },
});

test('projectSecuritiesPreview：剝 sourceAccountId / sourceRef / insertRef，顯示欄位與 duplicate 保留', () => {
  const p = /** @type {any} */ (projectSecuritiesPreview(/** @type {any} */ (fakePreview())));
  const r = p.rows[0];
  assert.ok(!('sourceAccountId' in r), '帳戶指紋不可送瀏覽器');
  assert.ok(!('sourceRef' in r), '去重鍵不可送瀏覽器');
  assert.ok(!('insertRef' in r), '寫入鍵不可送瀏覽器');
  // 顯示需要的都在
  assert.equal(r.symbol, '2330');
  assert.equal(r.duplicate, false);
  assert.equal(r.sourceAccountLabel, '台新證券 …0001');
  assert.deepEqual(r.flags, { unknownType: false });
  // 頂層摘要原樣保留
  assert.equal(p.stmtMonth, '2026-06');
  assert.equal(p.counts.importable, 1);
  assert.equal(p.byCurrency.TWD.fees, 1281);
});

test('projectSecuritiesPreview：不改動原物件（apply 端還要靠原列的 insertRef 寫入）', () => {
  const orig = fakePreview();
  projectSecuritiesPreview(/** @type {any} */ (orig));
  assert.equal(orig.rows[0].sourceRef.startsWith('ts|'), true);
  assert.equal(orig.rows[0].insertRef.startsWith('ts|'), true);
  assert.equal(orig.rows[0].sourceAccountId, 'fp-機密指紋');
});
