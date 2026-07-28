#!/usr/bin/env node
// @ts-check
// C6 對抗審查：**對真正部署好的服務**跑一次跨使用者攻擊清單（docs/多人上線-施工計畫.md 第七節）。
//
// 為什麼要有這支：C4b／C5 的考題用的是「行為模擬的假 Postgres」——它證明得了
// 「我們的程式在正確的資料庫語意下不洩漏」，但證明不了「Supabase 上的 RLS 政策真的寫對了」。
// 那件事只有打到真的資料庫才算數，所以它一直被誠實地押後到 C6。這支就是那一關。
//
// ⚠️ **只准打合成資料的測試部署**（C6 的定義）。C7 匯入真實資料之後不要再跑這支——
//    它會寫入資料（建交易、試著改別人的東西）。腳本本身有一道 fail-closed 的確認開關。
//
// 用法（在你自己的電腦上跑，不需要任何伺服器權限）：
//
//   export C6_BASE_URL="https://noteasy-xxxx.onrender.com"
//   export C6_A_EMAIL="test-a@example.com"   C6_A_PASSWORD="…"
//   export C6_B_EMAIL="test-b@example.com"   C6_B_PASSWORD="…"
//   # RLS 直連那一題要用（Supabase 專案設定裡的 Project URL 與 anon key）
//   export C6_SUPABASE_URL="https://xxxx.supabase.co"
//   export C6_SUPABASE_ANON_KEY="eyJ…"
//   export C6_CONFIRM_SYNTHETIC=1
//   node scripts/c6-adversarial.js
//
// 密碼只從環境變數讀、**絕不寫進檔案**，輸出也**絕不印出密碼或 token**。

const BASE = (process.env.C6_BASE_URL || '').replace(/\/+$/, '');
const A_EMAIL = process.env.C6_A_EMAIL || '';
const A_PW = process.env.C6_A_PASSWORD || '';
const B_EMAIL = process.env.C6_B_EMAIL || '';
const B_PW = process.env.C6_B_PASSWORD || '';
const SB_URL = (process.env.C6_SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON = process.env.C6_SUPABASE_ANON_KEY || '';

if (!BASE || !A_EMAIL || !A_PW || !B_EMAIL || !B_PW) {
  console.error('缺環境變數：C6_BASE_URL / C6_A_EMAIL / C6_A_PASSWORD / C6_B_EMAIL / C6_B_PASSWORD（見本檔開頭）');
  process.exit(2);
}
if (process.env.C6_CONFIRM_SYNTHETIC !== '1') {
  console.error('這支會寫入資料。確認目標是「只有合成資料的測試部署」之後，設 C6_CONFIRM_SYNTHETIC=1 再跑。');
  process.exit(2);
}

const ORIGIN = new URL(BASE).origin;
let pass = 0;
const failures = [];

/** @param {string} name @param {() => Promise<void>} fn */
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name} → ${/** @type {any} */ (e)?.message}`); console.log(`  ❌ ${name}\n       ${/** @type {any} */ (e)?.message}`); }
}
/** @param {any} cond @param {string} msg */
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/** 登入並取回 cookie 字串（不印出密碼）。 @param {string} email @param {string} pw */
async function login(email, pw) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: pw }),
  });
  if (r.status !== 200) throw new Error(`登入失敗（${email}）：HTTP ${r.status}`);
  const jar = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!jar) throw new Error(`登入沒拿到 session cookie（${email}）`);
  return { jar, user: (await r.json()).user };
}

const req = (/** @type {string} */ jar, /** @type {string} */ p, /** @type {any} */ init = {}) => fetch(`${BASE}${p}`, {
  ...init, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: jar, ...(init.headers || {}) },
});

// ---- 要逐條打的端點清單（**列舉、不抽樣**）--------------------------------
const COLLECTIONS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance',
  'cards', 'history', 'holdings', 'watchlist', 'research'];
const READ_ENDPOINTS = [
  ...COLLECTIONS.map(c => `/api/${c}`),
  '/api/portfolioSnapshots', '/api/ibTrades', '/api/dailyValues',
  '/api/securities', '/api/securities/batches',
  '/api/db', '/api/summary', '/api/settings', '/api/export',
  '/api/learned', '/api/bank-learned', '/api/statement/batches', '/api/bank-statement/batches',
  '/api/refund-pairs', '/api/monthly-review', '/api/categories', '/api/income-categories',
  '/api/transfer-subcategories', '/api/statement/rules', '/api/statement/health',
];

console.log(`\nC6 對抗審查 → ${BASE}\n`);

const A = await login(A_EMAIL, A_PW);
const B = await login(B_EMAIL, B_PW);
console.log(`登入成功：A=${A.user?.id?.slice(0, 8)}… B=${B.user?.id?.slice(0, 8)}…\n`);
if (A.user?.id === B.user?.id) { console.error('A 與 B 是同一個帳號，這樣測不出隔離'); process.exit(2); }

// 兩邊各種一顆好認的種子（合成資料）
const MARK_A = `C6A-${Date.now()}`;
const MARK_B = `C6B-${Date.now()}`;
for (const [who, mark] of [[A, MARK_A], [B, MARK_B]]) {
  const r = await req(/** @type {any} */ (who).jar, '/api/transactions', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-01', type: 'expense', category: '其他', amount: 12, note: mark }),
  });
  if (r.status !== 200) { console.error(`種子寫入失敗：HTTP ${r.status}`); process.exit(2); }
}

console.log('① 未登入打全部 /api/*（白名單除外）→ 401；/finance → 轉登入');
await check('未登入逐條 401', async () => {
  for (const p of READ_ENDPOINTS) {
    const r = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    ok(r.status === 401, `${p} 回 ${r.status}，應為 401`);
  }
  const w = await fetch(`${BASE}/api/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' });
  ok(w.status === 401, `未登入 POST 回 ${w.status}，應為 401`);
});
await check('/finance 未登入＝轉 /login', async () => {
  const r = await fetch(`${BASE}/finance/`, { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === '/login', `回 ${r.status} → ${r.headers.get('location')}`);
});
await check('白名單：/health 與 /api/auth/me 不經牆', async () => {
  ok((await fetch(`${BASE}/health`)).status === 200, '/health 應該通');
  ok((await fetch(`${BASE}/api/auth/me`)).status === 200, '/api/auth/me 應該通');
});

console.log('\n② A 的 cookie 逐條打每一個讀取端點 → 看不到 B 的任何東西（逐條列舉、不抽樣）');
await check('A 看不到 B 的資料（兩個方向都驗）', async () => {
  for (const p of READ_ENDPOINTS) {
    const ra = await req(A.jar, p);
    ok(ra.status === 200, `A GET ${p} 回 ${ra.status}`);
    ok(!(await ra.text()).includes(MARK_B), `A GET ${p} 看得到 B 的資料！`);
    const rb = await req(B.jar, p);
    ok(!(await rb.text()).includes(MARK_A), `B GET ${p} 看得到 A 的資料！`);
  }
});
await check('各自看得到自己的（否則「全都是空的」也會通過上一題）', async () => {
  ok((await (await req(A.jar, '/api/transactions')).text()).includes(MARK_A), 'A 看不到自己的資料');
  ok((await (await req(B.jar, '/api/transactions')).text()).includes(MARK_B), 'B 看不到自己的資料');
});

console.log('\n③ A 拿 B 的 id 做 PUT／DELETE → B 一筆都不能少（逐集合列舉）');
await check('跨使用者寫入被擋', async () => {
  const bList = await (await req(B.jar, '/api/transactions')).json();
  const victim = bList.find((/** @type {any} */ t) => t.note === MARK_B);
  ok(victim, '找不到 B 的種子交易');
  for (const col of COLLECTIONS) {
    await req(A.jar, `/api/${col}/${encodeURIComponent(victim.id)}`, { method: 'PUT', body: JSON.stringify({ name: 'hijack', note: 'hijack' }) });
    await req(A.jar, `/api/${col}/${encodeURIComponent(victim.id)}`, { method: 'DELETE' });
  }
  const after = await (await req(B.jar, '/api/transactions')).json();
  const still = after.find((/** @type {any} */ t) => t.id === victim.id);
  ok(still, 'A 把 B 的交易刪掉了！');
  ok(still.note === MARK_B, 'A 把 B 的交易改掉了！');
});

console.log('\n④ 偽造／過期 cookie → 401（不是 500）；跨站 POST → 403');
await check('偽造 session cookie＝401', async () => {
  const forged = A.jar.replace(/=([^;]*)/, '=forged-value-not-a-real-token');
  const r = await req(forged, '/api/db');
  ok(r.status === 401, `回 ${r.status}，應為 401（500 代表錯誤處理有洞）`);
});
await check('跨站 Origin 的變更請求＝403', async () => {
  const r = await fetch(`${BASE}/api/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: A.jar }, body: '{}',
  });
  ok(r.status === 403, `回 ${r.status}，應為 403`);
});

console.log('\n⑤ RLS 直連：拿 A 的 access token 直打 Supabase REST 讀 kv → 只能看到自己的列');
await check('RLS 直連（這一題只有真 Postgres 測得出來）', async () => {
  if (!SB_URL || !SB_ANON) throw new Error('略過不得：請設 C6_SUPABASE_URL 與 C6_SUPABASE_ANON_KEY');
  // 從 cookie 取出 access token（@supabase/ssr 會把 session 存在 sb-*-auth-token cookie）
  const m = A.jar.match(/sb-[^=]*auth-token[^=]*=([^;]+)/);
  ok(m, '從 cookie 取不到 Supabase session（cookie 名稱可能改了，請人工確認）');
  let token = decodeURIComponent(/** @type {any} */ (m)[1]);
  if (token.startsWith('base64-')) token = Buffer.from(token.slice(7), 'base64').toString('utf8');
  const parsed = (() => { try { return JSON.parse(token); } catch { return null; } })();
  const access = parsed?.access_token || parsed?.[0] || null;
  ok(typeof access === 'string' && access.length > 20, '解不出 access_token（請人工用瀏覽器 DevTools 取一次再測）');

  const r = await fetch(`${SB_URL}/rest/v1/kv?select=user_id,key`, {
    headers: { apikey: SB_ANON, Authorization: `Bearer ${access}` },
  });
  ok(r.status === 200, `Supabase REST 回 ${r.status}`);
  const rows = await r.json();
  ok(Array.isArray(rows), '回應不是陣列');
  const owners = [...new Set(rows.map((/** @type {any} */ x) => x.user_id))];
  ok(owners.length <= 1, `RLS 沒擋住！這個 token 看得到 ${owners.length} 個使用者的列`);
  ok(owners.length === 0 || owners[0] === A.user.id, 'RLS 回了別人的列！');
  console.log(`       （A 直連看到 ${rows.length} 列，全部屬於自己）`);
});
await check('RLS 寫入：A 直連想插一列 user_id=B → 必須被拒（P1-3 的 WITH CHECK）', async () => {
  if (!SB_URL || !SB_ANON) throw new Error('請設 C6_SUPABASE_URL 與 C6_SUPABASE_ANON_KEY');
  const m = A.jar.match(/sb-[^=]*auth-token[^=]*=([^;]+)/);
  let token = decodeURIComponent(/** @type {any} */ (m)[1]);
  if (token.startsWith('base64-')) token = Buffer.from(token.slice(7), 'base64').toString('utf8');
  const access = (() => { try { return JSON.parse(token)?.access_token; } catch { return null; } })();
  const r = await fetch(`${SB_URL}/rest/v1/kv`, {
    method: 'POST',
    headers: { apikey: SB_ANON, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: B.user.id, key: 'transactions', data: [] }),
  });
  ok(r.status >= 400, `插別人的列竟然回 ${r.status}——只寫 USING 沒寫 WITH CHECK 就會這樣`);
});

console.log('\n⑥ 機密投影：逐端點驗「只出現 …Set 布林、沒有明文也沒有密文」');
await check('機密不送瀏覽器（含寫入端回應）', async () => {
  const probes = [
    ['/api/settings', 'GET', null], ['/api/cards', 'GET', null], ['/api/db', 'GET', null], ['/api/export', 'GET', null],
    ['/api/settings', 'PUT', '{"usdTwd":32}'],
  ];
  for (const [p, method, body] of probes) {
    const r = await req(A.jar, /** @type {string} */ (p), body ? { method, body } : {});
    const text = await r.text();
    ok(!/"pdfPassword"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了 pdfPassword 明文`);
    ok(!/"flexToken"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了 flexToken 明文`);
    ok(!/"taishinSecPdfPassword"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了台新密碼明文`);
    ok(!text.includes('enc:v1:'), `${method} ${p} 回了密文（沒意義又洩漏長度）`);
  }
});

console.log('\n⑦ 錯誤訊息不得洩漏伺服器路徑／堆疊');
await check('壞請求的錯誤訊息乾淨', async () => {
  const probes = [
    ['/api/import', 'POST', '{"settings":{},"transactions":"oops"}'],
    ['/api/cards/nope', 'PUT', '{"name":"x"}'],
    ['/api/statement/preview', 'POST', '{"data":"not-a-pdf"}'],
    ['/api/nonexistent-endpoint', 'GET', null],
  ];
  for (const [p, method, body] of probes) {
    const r = await req(A.jar, /** @type {string} */ (p), body ? { method, body } : {});
    const text = await r.text();
    ok(!/\/(opt|usr|home|var)\/[a-z]/i.test(text), `${method} ${p} 的錯誤訊息洩漏伺服器路徑`);
    ok(!text.includes('    at '), `${method} ${p} 的錯誤訊息含堆疊`);
  }
});

console.log('\n⑧ 匯入綁 session user：A 匯入一份指名 B 的備份 → B 一個字都不能變');
await check('匯入只寫進自己的 namespace', async () => {
  const bBefore = await (await req(B.jar, '/api/db')).text();
  const evil = {
    user_id: B.user.id, userId: B.user.id,
    settings: { usdTwd: 33 },
    transactions: [{ id: `c6-import-${Date.now()}`, date: '2026-07-02', type: 'expense', category: '其他', amount: 1, note: MARK_A + '-imported' }],
  };
  const r = await req(A.jar, '/api/import', { method: 'POST', body: JSON.stringify(evil) });
  ok(r.status === 200, `匯入回 ${r.status}`);
  const bAfter = await (await req(B.jar, '/api/db')).text();
  ok(bBefore === bAfter, 'A 的匯入動到了 B 的資料！');
  ok((await (await req(A.jar, '/api/db')).text()).includes(MARK_A + '-imported'), 'A 自己的匯入沒生效');
});

console.log('\n⑨ 解析器 DoS：超大／畸形上傳要明確拒絕，服務不能掛');
await check('超大 body → 413/400，之後服務還活著', async () => {
  const big = JSON.stringify({ settings: {}, transactions: [], pad: 'x'.repeat(60 * 1024 * 1024) });
  const r = await req(A.jar, '/api/import', { method: 'POST', body: big }).catch(() => ({ status: 0 }));
  ok(/** @type {any} */ (r).status === 413 || /** @type {any} */ (r).status === 400 || /** @type {any} */ (r).status === 0,
    `回 ${/** @type {any} */ (r).status}，應為 413/400`);
  const alive = await fetch(`${BASE}/health`);
  ok(alive.status === 200, '送完大 body 之後服務掛了！');
});
await check('畸形 PDF/XML → 明確錯誤，不含密碼', async () => {
  for (const p of ['/api/statement/preview', '/api/bank-statement/preview', '/api/securities/preview']) {
    const r = await req(A.jar, p, { method: 'POST', body: JSON.stringify({ data: 'AAAA', password: 'SHOULD-NOT-ECHO' }) });
    const text = await r.text();
    ok(r.status >= 400 && r.status < 500, `${p} 回 ${r.status}，應為 4xx`);
    ok(!text.includes('SHOULD-NOT-ECHO'), `${p} 把密碼回顯了！`);
  }
  ok((await fetch(`${BASE}/health`)).status === 200, '服務掛了');
});

console.log(`\n${'='.repeat(60)}`);
console.log(`通過 ${pass} 題，失敗 ${failures.length} 題`);
if (failures.length) {
  console.log('\n失敗清單：');
  for (const f of failures) console.log(`  • ${f}`);
  console.log('\n⚠️ 有失敗＝不可進 C7（不要把真實資料匯上去）。');
  process.exit(1);
}
console.log('✅ 全部通過。C6 的程式面驗收成立——接著才輪到 C7（DNS＋匯入真實資料）。');

// 這個檔用了 top-level await（登入、逐條打端點都是非同步的）。
// `export {}` 讓 tsc 把它當成 ES module——沒有它會報 TS1375（pre-push 的校對關卡實際擋下過一次）。
export {};
