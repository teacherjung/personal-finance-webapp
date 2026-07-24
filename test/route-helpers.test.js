// 路由錯誤 helper 考題（系統優化 U2）：statement/securities/ib 三份複製收斂後的單一真相。
// 語意鎖住：帶 status＝原味 JSON 回應（含 extra 形狀）；無 status＝交 next（全域中介 500 口徑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRouteError, wrapRoute } from '../lib/routes/route-helpers.js';

/** 假 res：記錄 status/json 呼叫。 */
const fakeRes = () => {
  const calls = { status: null, json: null };
  return { calls, status(c) { calls.status = c; return this; }, json(b) { calls.json = b; return this; } };
};

test('sendRouteError：帶 status → 原味 {error}；不呼叫 next', () => {
  const res = fakeRes();
  let nexted = null;
  sendRouteError(res, (e) => { nexted = e; }, Object.assign(new Error('密碼錯誤'), { status: 400 }));
  assert.equal(res.calls.status, 400);
  assert.deepEqual(res.calls.json, { error: '密碼錯誤' });
  assert.equal(nexted, null);
});

test('sendRouteError：extra 形狀保留（ib 的 {ok:false}——搬家不裝修）', () => {
  const res = fakeRes();
  sendRouteError(res, () => {}, Object.assign(new Error('缺 token'), { status: 400 }), { ok: false });
  assert.deepEqual(res.calls.json, { ok: false, error: '缺 token' });
});

test('sendRouteError：無 status → 交 next、res 不動（全域中介負責 500 與紀錄）', () => {
  const res = fakeRes();
  let nexted = null;
  const boom = new Error('內部錯誤');
  sendRouteError(res, (e) => { nexted = e; }, boom);
  assert.equal(res.calls.status, null);
  assert.equal(res.calls.json, null);
  assert.equal(nexted, boom);
});

test('wrapRoute：async reject 與 sync throw 都接得住；成功路徑原樣通過', async () => {
  const res = fakeRes();
  await wrapRoute(async () => { throw Object.assign(new Error('慢路炸'), { status: 404 }); })(null, res, () => {});
  assert.equal(res.calls.status, 404);
  const res2 = fakeRes();
  await wrapRoute(() => { throw Object.assign(new Error('快路炸'), { status: 400 }); })(null, res2, () => {});
  assert.equal(res2.calls.status, 400);
  const res3 = fakeRes();
  await wrapRoute((req, r) => r.json({ ok: true }))(null, res3, () => {});
  assert.deepEqual(res3.calls.json, { ok: true });
});
