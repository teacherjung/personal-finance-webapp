// 路由錯誤 helper 考題（系統優化 U2）：statement/securities/ib 三份複製收斂後的單一真相。
// 語意鎖住：帶 status＝原味 JSON 回應（含 extra 形狀）；無 status＝交 next（全域中介 500 口徑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRouteError, wrapRoute, asyncRoute } from '../lib/routes/route-helpers.js';

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

// ---- asyncRoute（core/crud 那批走全域中介的路由在用）與 wrapRoute 的 extra：為什麼要各釘一題——asyncRoute 若改成 sendRouteError
//      會偷改整批路由的錯誤口徑；wrapRoute 丟掉 extra，ib 同步靠它的 {ok:false} 形狀就消失。
test('asyncRoute：任何錯誤（含帶 status 的）一律交 next、res 不動——包裝不可順手改口徑；同步 throw 也接得住；成功原樣過', async () => {
  const e = Object.assign(new Error('缺 id'), { status: 400 });
  const res = fakeRes(); let nexted = null;
  await asyncRoute(async () => { throw e; })(null, res, (/** @type {any} */ x) => { nexted = x; });
  assert.equal(nexted, e, '帶 status 的錯也要交 next（全域中介回泛用訊息，不是 wrapRoute 的原味 JSON）');
  assert.equal(res.calls.status, null); assert.equal(res.calls.json, null);
  const res2 = fakeRes(); let nexted2 = null;
  await asyncRoute(() => { throw e; })(null, res2, (/** @type {any} */ x) => { nexted2 = x; });
  assert.equal(nexted2, e, '同步 throw 也接得住（Express 4 不接 async handler 的 rejection）');
  const res3 = fakeRes();
  await asyncRoute((/** @type {any} */ _req, /** @type {any} */ r) => r.json({ ok: 1 }))(null, res3, () => { throw new Error('成功路徑不該 next'); });
  assert.deepEqual(res3.calls.json, { ok: 1 });
});

test('wrapRoute：extra 要進錯誤 body（ib 同步的 {ok:false} 形狀靠它）', async () => {
  const res = fakeRes();
  await wrapRoute(async () => { throw Object.assign(new Error('缺 token'), { status: 400 }); }, { ok: false })(null, res, () => {});
  assert.equal(res.calls.status, 400);
  assert.deepEqual(res.calls.json, { ok: false, error: '缺 token' });
});
