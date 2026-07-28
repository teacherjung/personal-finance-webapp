// @ts-check
// 速率限制考題（可用性第一層，2026-07-28）。
// 純函式層用**注入的時鐘**——等真實時間的考題又慢又不穩（而且會讓整套 npm test 變慢）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, rateLimit, ipKeyOf } from '../lib/rate-limit.js';

/** 可控時鐘。 @param {number} start */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
}

test('計數器：窗口內放行到上限，超過就擋，並回可操作的 Retry-After 秒數', () => {
  const c = clock();
  const lim = createLimiter({ windowMs: 60_000, max: 3, now: c.now });
  assert.deepEqual(lim.hit('a'), { allowed: true, remaining: 2, retryAfterSec: 0 });
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, true);
  const blocked = lim.hit('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSec, 60, '要告訴使用者「等多久」，不是只說不行');
});

test('計數器：不同 key 各算各的（一個人被擋不可以牽連別人）', () => {
  const c = clock();
  const lim = createLimiter({ windowMs: 60_000, max: 1, now: c.now });
  assert.equal(lim.hit('甲').allowed, true);
  assert.equal(lim.hit('甲').allowed, false);
  assert.equal(lim.hit('乙').allowed, true, '乙不該因為甲被擋而受影響');
});

test('計數器：窗口過了就重新開始', () => {
  const c = clock();
  const lim = createLimiter({ windowMs: 60_000, max: 2, now: c.now });
  lim.hit('a'); lim.hit('a');
  assert.equal(lim.hit('a').allowed, false);
  c.advance(60_001);
  assert.equal(lim.hit('a').allowed, true, '窗口過了要放行，否則等於永久封鎖');
});

test('計數器：過期的鍵會被清掉（不清＝「防資源耗盡」自己變成資源耗盡）', () => {
  const c = clock();
  const lim = createLimiter({ windowMs: 1_000, max: 5, now: c.now });
  for (let i = 0; i < 500; i++) lim.hit(`ip-${i}`);
  assert.equal(lim.size(), 500);
  c.advance(2_000);
  lim.hit('新的一個');            // 任何一次呼叫都會順便掃一輪
  assert.ok(lim.size() < 10, `過期鍵沒被清掉（還有 ${lim.size()} 個）——這會隨著攻擊者換 IP 無限長大`);
});

test('中介層：超過上限回 429＋Retry-After，且**不丟例外**（被猛打時不該再產生堆疊物件）', () => {
  const c = clock();
  const mw = rateLimit({ windowMs: 60_000, max: 1, keyOf: () => 'k', message: '太多次了', now: c.now });
  const mkRes = () => ({ code: 0, body: /** @type {any} */ (null), headers: /** @type {Record<string,string>} */ ({}),
    set(/** @type {string} */ k, /** @type {string} */ v) { this.headers[k] = v; return this; },
    status(/** @type {number} */ s) { this.code = s; return this; },
    json(/** @type {any} */ b) { this.body = b; return this; } });

  let nexts = 0;
  const r1 = mkRes();
  mw(/** @type {any} */ ({}), /** @type {any} */ (r1), () => { nexts++; });
  assert.equal(nexts, 1, '第一次要放行');

  const r2 = mkRes();
  assert.doesNotThrow(() => mw(/** @type {any} */ ({}), /** @type {any} */ (r2), () => { nexts++; }));
  assert.equal(nexts, 1, '第二次不可以再往下走');
  assert.equal(r2.code, 429);
  assert.equal(r2.body.error, '太多次了');
  assert.equal(r2.headers['Retry-After'], '60');
});

test('中介層：取不到 key 就放行（寧可放行，也不要把正當使用者一起擋掉）', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 0, keyOf: () => null, message: 'x' });
  let passed = false;
  mw(/** @type {any} */ ({}), /** @type {any} */ ({}), () => { passed = true; });
  assert.equal(passed, true);
});

test('ipKeyOf：優先用 req.ip（trust proxy 之後才是真實客戶端），退回 socket', () => {
  assert.equal(ipKeyOf({ ip: '1.2.3.4', socket: { remoteAddress: '10.0.0.1' } }), '1.2.3.4');
  assert.equal(ipKeyOf({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(ipKeyOf({}), null, '取不到就回 null → 中介層放行');
});
