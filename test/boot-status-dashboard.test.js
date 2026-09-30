// @ts-check
// 總覽最下面「開 App 自動更新檢查」那一塊的**接線**（#653 複審後掃：test/boot-sequence.test.js 沒有載入 dashboard.js，
// 拿掉 watchBoot()、不接 bootSettled／fetchInsightsOnce、區塊 id 改掉，那份考卷照樣全綠）。
// 做法＝jsdom 給全域、fetch 假櫃檯、真的 import 整張 app.js 路由圖停在 #dashboard，讀畫面上的那一塊。
// 守不到的：真瀏覽器排版（手機寬度、字型）；30 秒上限本身（那個時序在 boot-sequence.test.js 用小上限直接考）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/** 可以從外面決定何時完成的 promise。 */
function deferred() {
  /** @type {(v?: unknown) => void} */ let resolve = () => {};
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const localIso = (/** @type {number[]} */ ...p) => new Date(p[0], p[1] - 1, p[2], p[3], p[4]).toISOString();
const SEEN_AT = localIso(2026, 9, 30, 13, 41);

const holdStore = deferred();   // 店名整理那一步先卡著：開機還沒落定時那一塊要是「檢查中…」、洞察不可以先抓
const insights = deferred();    // 洞察先不回：那一行要是「更新中…」
/** @type {string[]} */
const calls = [];
const SUMMARY = {
  cashflow: { month: '2026-09', income: 0, expense: 0, net: 0 }, cashflowHistory: [], snapshots: [], reminders: [],
  goalTrack: null, ib: { totalPnl: 0, totalValue: 0, count: 0, hasLoan: false }, subscriptions: { monthly: 0, count: 0, yearly: 0 },
  netWorth: 0, assets: 0, liabilities: 0, byClass: {}, defaultFx: [], missingFx: [],
};
/** @type {Record<string, () => unknown | Promise<unknown>>} */
const API = {
  '/api/quotes/refresh-auto': () => ({ refreshed: false, reason: 'fresh' }),
  '/api/snapshot/auto': () => ({ recorded: false, snap: { date: '2026-09-01' }, daily: { date: '2026-09-30' }, subsRolled: [] }),
  '/api/backup/daily': () => ({}),
  '/api/accounts/reconcile-names': () => ({ changed: 0, aligned: 0 }),
  '/api/statement/normalize-auto': async () => { await holdStore.promise; return { ran: false }; },
  '/api/settings': () => ({ quotesLastAt: localIso(2026, 9, 30, 13, 5), subsLastRolledAt: localIso(2026, 9, 15, 8, 0) }),
  '/api/summary': () => SUMMARY,
  '/api/insights': async () => insights.promise,
};

let app;
async function boot() {
  if (app) return app;
  const dom = new JSDOM('<!doctype html><html><body><nav id="nav"><a href="#dashboard" data-route="dashboard">總覽</a></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div></body></html>',
    { url: 'http://localhost/#dashboard', pretendToBeVisual: true });
  const win = dom.window;
  const set = (/** @type {string} */ k, /** @type {unknown} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  for (const k of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) set(k, /** @type {any} */ (win)[k]);
  set('fetch', async (/** @type {string} */ url) => {
    const path = String(url).split('?')[0];
    calls.push(path);
    const body = Object.hasOwn(API, path) ? await API[path]() : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  app = await import('../public/app.js');
  return app;
}
const block = () => /** @type {HTMLElement|null} */ (document.getElementById('bootStatusBlock'));
const insightCalls = () => calls.filter((p) => p === '/api/insights').length;

test('總覽那一塊：開機還沒落定＝檢查中、洞察還沒抓；落定後照格式畫出六行、洞察更新中；洞察回來改 ✓；重畫總覽洞察只抓一次', async () => {
  await boot();
  await flush();
  assert.ok(block(), '總覽上要有那一塊（id＝bootStatusBlock）');
  assert.match(String(block()?.textContent), /檢查中…/, '開機還沒落定時要先寫檢查中');
  assert.equal(insightCalls(), 0, '開機還沒落定就不可以抓洞察（洞察讀取會寫書籤，要等五步做完）');

  holdStore.resolve();
  await app.bootSettled;
  await flush();
  const text = String(block()?.textContent);
  assert.match(text, /開 App 自動更新檢查（\d{4}-\d{2}-\d{2}）/);
  assert.match(text, /每次打開 App 會自動做這幾件事：/);
  assert.match(text, /更新報價9\/30 13:05 已更新（一小時內不重抓）/, '報價時間要從 /settings 讀到、畫進那一行');
  assert.match(text, /更新訂閱續費日沒有需要推進的上次推進 9\/15/, '「上次推進」小字要從 /settings 讀到、畫進那一行');
  assert.match(text, /更新洞察更新中…/);
  assert.match(text, /標 ⚠️ 的是這次沒有檢查成功的項目。/);
  assert.equal(block()?.querySelectorAll('li').length, 6);
  assert.equal(insightCalls(), 1, '開機落定後抓一次洞察');

  insights.resolve({ seenAt: SEEN_AT, calm: true });
  await flush();
  assert.match(String(block()?.textContent), /更新洞察9\/30 13:41 已更新/, '洞察回來後那一行要就地改成已更新');

  await app.router();   // 重畫總覽：那一塊直接畫出目前的狀態，不回到檢查中；洞察不再抓
  await flush();
  assert.match(String(block()?.textContent), /更新洞察9\/30 13:41 已更新/);
  assert.equal(insightCalls(), 1, '重畫總覽不可以再抓一次洞察（書籤會把剛冒出的 🆕 吃掉）');
  assert.equal(String(document.getElementById('toast-root')?.textContent).trim(), '', '開機那幾步不跳提示');
});
