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
  '/api/stock-fundamentals/CAL',
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

// ---- 每個集合各種一顆好認的種子（合成資料）----------------------------------
// ⚠️ 這是本檔最容易生出假綠的地方。舊版只在 `transactions` 建一筆，卻拿它的 id 去打十個集合——
//    對其他九個集合來說，那個 id **在任何人的資料裡都不存在**：PUT 回 404、DELETE 回 `{ok:true}`，
//    看起來「攻擊被擋住了」，其實是**打空氣**。同理，只有 transactions 帶得走標記字串，
//    所以「A 讀不到 B」那一題對其餘九個集合也是空的。
//    **每個集合都要有一個真的屬於 B 的受害者。**
//    實測（審查在一個「九個集合全域共用、A 讀得到也刪得掉 B 的信用卡」的假部署上打舊腳本）：
//    舊腳本印出「通過 15 題，失敗 0 題 ✅ 全部通過」。
const STAMP = Date.now();
const MARK_A = `C6A${STAMP}`;
const MARK_B = `C6B${STAMP}`;
// history 的可寫欄位只有 month/amount（lib/schema.js WRITABLE_FIELDS），沒有自由字串欄——
// 標記只能藏在金額裡；用「時間戳＋尾碼」保證這個數字不會出現在其他任何地方。
const HIST_A = Number(`${STAMP}11`);
const HIST_B = Number(`${STAMP}22`);
/** 每個集合一份**通得過欄位白名單與必填檢查**的最小合法 body。 @param {string} mark @param {number} hist */
const seedBodies = (mark, hist) => (/** @type {Record<string, any>} */ ({
  accounts: { name: mark, type: 'cash', currency: 'TWD', balance: 1 },
  assetTargets: { class: mark, targetPct: 1 },
  transactions: { date: '2026-07-01', type: 'expense', category: '其他', amount: 12, note: mark },
  subscriptions: { name: mark, amount: 1, cycle: 'monthly' },
  insurance: { policyName: mark, premium: 1 },
  cards: { name: mark, type: 'credit' },
  history: { month: '2019-01', amount: hist },
  holdings: { symbol: mark, name: mark, layer: 'core', currency: 'USD', quantity: 1, price: 1 },
  watchlist: { symbol: mark, name: mark, currency: 'USD', note: mark },
  research: { symbol: mark, thesis: mark },
}));
/** 標記藏在哪個欄位（PUT 劫持要蓋的就是它）。 @type {Record<string,string>} */
const MARK_FIELD = { accounts: 'name', assetTargets: 'class', transactions: 'note', subscriptions: 'name',
  insurance: 'policyName', cards: 'name', history: 'amount', holdings: 'name', watchlist: 'name', research: 'thesis' };
// ⚠️ 劫持 patch **必須是該集合白名單內的欄位**。舊版一律送 `{name, note}`——對 assetTargets／
//    insurance／history／research 這四個集合，兩個欄位都會被 `pickWritable` 剝光，PUT 等於什麼都沒做：
//    **就算伺服器完全沒有隔離，那一筆也不會變**＝穩定的假綠。
/** @type {Record<string, any>} */
const HIJACK = { accounts: { name: 'hijack' }, assetTargets: { class: 'hijack' }, transactions: { note: 'hijack' },
  subscriptions: { name: 'hijack' }, insurance: { policyName: 'hijack' }, cards: { name: 'hijack' },
  history: { amount: 1 }, holdings: { name: 'hijack' }, watchlist: { name: 'hijack', note: 'hijack' },
  research: { thesis: 'hijack' } };

/** 在某個使用者名下把十個集合各種一顆。 @param {any} who @param {string} mark @param {number} hist */
async function seedAll(who, mark, hist) {
  const bodies = seedBodies(mark, hist);
  /** @type {Record<string, any>} */
  const made = {};
  for (const col of COLLECTIONS) {
    const r = await req(who.jar, `/api/${col}`, { method: 'POST', body: JSON.stringify(bodies[col]) });
    const text = await r.text();
    if (r.status !== 200) { console.error(`種子寫入失敗：${col} → HTTP ${r.status} ${text.slice(0, 200)}`); process.exit(2); }
    made[col] = JSON.parse(text);
    if (!made[col]?.id) { console.error(`種子沒拿到 id：${col} → ${text.slice(0, 200)}`); process.exit(2); }
  }
  return made;
}
const seedB = await seedAll(B, MARK_B, HIST_B);
const seedA = await seedAll(A, MARK_A, HIST_A);
// A 的種子：①「各自看得到自己的」那一題 ②洩漏掃描的反方向 ③⑥的機密要種在 A 自己的卡片上
/** 某個集合、某個人的標記值（字串比對用）。 @param {string} col @param {'A'|'B'} who */
const markOf = (col, who) => (col === 'history'
  ? String(who === 'A' ? HIST_A : HIST_B)
  : (who === 'A' ? MARK_A : MARK_B));
/** 掃洩漏時要找的所有字串（含 history 藏在金額裡的那個）。 */
const MARKS_A = [MARK_A, String(HIST_A)];
const MARKS_B = [MARK_B, String(HIST_B)];

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
    const ta = await ra.text();
    for (const m of MARKS_B) ok(!ta.includes(m), `A GET ${p} 看得到 B 的資料（標記 ${m}）！`);
    const tb = await (await req(B.jar, p)).text();
    for (const m of MARKS_A) ok(!tb.includes(m), `B GET ${p} 看得到 A 的資料（標記 ${m}）！`);
  }
});
await check('各自看得到自己的**每一個集合**（否則「全都是空的」也會通過上一題）', async () => {
  // ⚠️ 舊版只驗 transactions 一個集合。其餘九個集合天生沒有標記可搜，
  //    所以上一題對它們而言永遠是綠的——**「找不到」與「沒有東西可找」看起來一模一樣。**
  for (const col of COLLECTIONS) {
    ok((await (await req(A.jar, `/api/${col}`)).text()).includes(markOf(col, 'A')), `A 看不到自己的 ${col}`);
    ok((await (await req(B.jar, `/api/${col}`)).text()).includes(markOf(col, 'B')), `B 看不到自己的 ${col}`);
  }
});

console.log('\n③ A 拿 B 的 id 做 PUT／DELETE → B 一筆都不能少（逐集合列舉）');
await check('跨使用者寫入被擋（**每個集合都用該集合真正的 B 受害者**）', async () => {
  for (const col of COLLECTIONS) {
    const victimId = String(seedB[col].id);
    const mark = markOf(col, 'B');
    // ① 先證明這個 id 真的是 B 的東西——不然接下來只是對空氣揮拳（舊版最大的假綠）
    const before = await (await req(B.jar, `/api/${col}`)).json();
    ok(Array.isArray(before) && before.some((/** @type {any} */ x) => String(x.id) === victimId),
      `${col}：找不到 B 的種子（id=${victimId}），這一題無效`);
    // ② A 拿 B 的 id 做 PUT（patch 是該集合白名單內、**真的會蓋掉標記**的欄位）
    const put = await req(A.jar, `/api/${col}/${encodeURIComponent(victimId)}`, { method: 'PUT', body: JSON.stringify(HIJACK[col]) });
    ok(!(await put.text()).includes(mark), `A PUT /api/${col}/${victimId} 的**回應**帶回了 B 的資料＝寫入路徑也在洩漏`);
    // ③ 再 DELETE
    await req(A.jar, `/api/${col}/${encodeURIComponent(victimId)}`, { method: 'DELETE' });
    // ④ 回到 B 身上逐集合驗「一筆都不能少、一個字都不能改」
    const after = await (await req(B.jar, `/api/${col}`)).json();
    const still = (Array.isArray(after) ? after : []).find((/** @type {any} */ x) => String(x.id) === victimId);
    ok(still, `A 把 B 的 ${col} 那一筆刪掉了！`);
    ok(String(still[MARK_FIELD[col]]) === mark,
      `A 把 B 的 ${col} 那一筆改掉了（${MARK_FIELD[col]} 現在是 ${JSON.stringify(still[MARK_FIELD[col]])}）！`);
  }
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

/**
 * 從某人的 cookie 罐取出 Supabase access token。
 *
 * ⚠️ **兩支探針一定要共用這一份**（2026-07-28 修，Codex 收官審查 #3）：
 *    舊版讀探針有 `?.[0]` 的陣列型退路、也斷言了長度；寫探針卻只有 `?.access_token`、
 *    而且解不出來時 `access` 是 `null` → Supabase 回 401 → `status >= 400` **當成攻擊被擋住**。
 *    也就是「token 解不出來」這件事會讓寫探針**穩定假綠**。
 *    抽成同一支函式＝以後 cookie 格式再變，兩邊一起壞、一起被發現。
 * @param {any} who
 */
function accessTokenOf(who) {
  const m = who.jar.match(/sb-[^=]*auth-token[^=]*=([^;]+)/);
  ok(m, '從 cookie 取不到 Supabase session（cookie 名稱可能改了，請人工確認）');
  let token = decodeURIComponent(/** @type {any} */ (m)[1]);
  if (token.startsWith('base64-')) token = Buffer.from(token.slice(7), 'base64').toString('utf8');
  const parsed = (() => { try { return JSON.parse(token); } catch { return null; } })();
  const access = parsed?.access_token || parsed?.[0] || null;
  ok(typeof access === 'string' && access.length > 20,
    '解不出 access_token（請人工用瀏覽器 DevTools 取一次再測）——**不可以當成「攻擊被擋住」**');
  return /** @type {string} */ (access);
}

console.log('\n⑤ RLS 直連：拿 A 的 access token 直打 Supabase REST 讀 kv → 只能看到自己的列');
await check('RLS 直連（這一題只有真 Postgres 測得出來）', async () => {
  if (!SB_URL || !SB_ANON) throw new Error('略過不得：請設 C6_SUPABASE_URL 與 C6_SUPABASE_ANON_KEY');
  const access = accessTokenOf(A);

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
await check('RLS 寫入：A 直連想插一列 user_id=B → 必須被 **RLS** 拒（P1-3 的 WITH CHECK）', async () => {
  if (!SB_URL || !SB_ANON) throw new Error('請設 C6_SUPABASE_URL 與 C6_SUPABASE_ANON_KEY');
  const access = accessTokenOf(A);
  const insert = (/** @type {any} */ body) => fetch(`${SB_URL}/rest/v1/kv`, {
    method: 'POST',
    headers: { apikey: SB_ANON, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });

  // ── 正向對照組（缺了它整題就是假綠）──────────────────────────────────────
  // 沒有這一步，「請求根本沒送成功」（token 壞、欄位打錯、表名改過…）與「RLS 把攻擊擋下來」
  // 在 `status >= 400` 底下**長得一模一樣**。先證明「同樣形狀的寫入，寫給自己是成功的」，
  // 後面那個失敗才有意義。
  const ownKey = `__c6_probe_own_${STAMP}`;
  const good = await insert({ user_id: A.user.id, key: ownKey, data: [] });
  ok(good.status === 201,
    `正向對照失敗：A 連寫自己的列都不行（HTTP ${good.status} ${(await good.text()).slice(0, 200)}）` +
    '——這代表探針自己壞了，不是 RLS 擋住了。修好探針再測。');

  // ── 真正的攻擊 ─────────────────────────────────────────────────────────
  // ⚠️ key 一定要用**不存在的隨機鍵**（2026-07-28 修，Codex 收官審查 #3）：
  //    舊版固定插 `key: 'transactions'`，而 `(user_id, key)` 正是主鍵、B 的種子早就建過那一列。
  //    PostgreSQL 先跑 RLS 的 WITH CHECK、再跑唯一索引，所以
  //        牆在 → 42501 → 403
  //        牆倒 → 23505 → 409
  //    兩者都 `>= 400`——**這一題在任何政策下都是綠的**。
  const victimKey = `__c6_probe_victim_${STAMP}`;
  const r = await insert({ user_id: B.user.id, key: victimKey, data: [] });
  const body = await r.text();
  ok(r.status >= 400, `插別人的列竟然回 ${r.status}——只寫 USING 沒寫 WITH CHECK 就會這樣`);
  // ⚠️ 還要核對**擋下來的理由**：只看 4xx 的話，任何「碰巧失敗」都會被當成隔離成功。
  //    42501 = insufficient_privilege ＝ RLS 政策拒絕，那才是我們要的那個失敗。
  ok(/42501|row-level security|violates row-level/i.test(body),
    `被擋下來了，但**不是 RLS 擋的**（HTTP ${r.status}：${body.slice(0, 300)}）——` +
    '這種綠燈沒有意義，請確認 kv_owner_all 政策真的有 WITH CHECK。');

  // 收尾：正向對照那一列刪掉，別留在資料庫裡
  await fetch(`${SB_URL}/rest/v1/kv?key=eq.${ownKey}`, {
    method: 'DELETE', headers: { apikey: SB_ANON, Authorization: `Bearer ${access}` },
  });
  // 從資料層再確認一次攻擊那一列真的沒進去（回應碼可能騙人，資料不會）
  const after = await fetch(`${SB_URL}/rest/v1/kv?select=key&key=eq.${victimKey}`, {
    headers: { apikey: SB_ANON, Authorization: `Bearer ${access}` },
  });
  ok((await after.json()).length === 0, '攻擊那一列竟然寫進去了');
});

console.log('\n⑥ 機密投影：逐端點驗「只出現 …Set 布林、沒有明文也沒有密文」');
// ⚠️ **一定要先種真的機密**（2026-07-28 修，Codex 收官審查 #4）。
//    舊版的種子卡片只有 `{name, type}`、也從沒設過 flexToken／台新密碼，
//    而四條斷言全是否定式（「回應裡找不到機密」）——於是
//    **「投影把機密剝掉了」與「這個帳號根本沒有機密可剝」長得一模一樣**。
//    把正式投影整層刪掉，這一題照樣全綠。
//    （這正是本腳本自己在檔頭寫過的教訓：「找不到」與「沒有東西可找」必須分得出來。）
const SEC_FLEX = `C6FLEX${STAMP}`;
const SEC_TAISHIN = `C6TAI${STAMP}`;
const SEC_CARDPW = `C6CARD${STAMP}`;
await check('前置：透過正式 API 種下三個機密，並確認伺服器**真的收到了**', async () => {
  const s = await req(A.jar, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ taishinSecPdfPassword: SEC_TAISHIN, ib: { flexToken: SEC_FLEX, flexQueryId: '123' } }),
  });
  ok(s.status === 200, `PUT /api/settings 回 ${s.status}`);
  const c = await req(A.jar, `/api/cards/${seedA.cards.id}`, {
    method: 'PUT', body: JSON.stringify({ pdfPassword: SEC_CARDPW }),
  });
  ok(c.status === 200, `PUT /api/cards 回 ${c.status}`);

  // 關鍵：用 `…Set` 布林確認「伺服器手上確實有這三個機密」。
  // 沒有這一步，下面那一題就退化成「什麼都沒有，所以什麼都沒洩漏」。
  const st = await (await req(A.jar, '/api/settings')).json();
  ok(st?.ib?.flexTokenSet === true, 'flexTokenSet 不是 true——機密沒種進去，投影考題會變成假綠');
  ok(st?.taishinSecPdfPasswordSet === true, 'taishinSecPdfPasswordSet 不是 true');
  const cards = await (await req(A.jar, '/api/cards')).json();
  const card = cards.find((/** @type {any} */ x) => x.id === seedA.cards.id);
  ok(card?.pdfPasswordSet === true, 'pdfPasswordSet 不是 true');
});
await check('機密不送瀏覽器（含寫入端回應）', async () => {
  const probes = [
    ['/api/settings', 'GET', null], ['/api/cards', 'GET', null], ['/api/db', 'GET', null], ['/api/export', 'GET', null],
    ['/api/settings', 'PUT', '{"usdTwd":32}'],
    // 卡片的寫入端回應也要驗（改個名字不該把密碼一起吐回來）
    [`/api/cards/${seedA.cards.id}`, 'PUT', JSON.stringify({ name: MARK_A })],
  ];
  for (const [p, method, body] of probes) {
    const r = await req(A.jar, /** @type {string} */ (p), body ? { method, body } : {});
    const text = await r.text();
    // ① 形狀檢查（舊版就有）：不准出現任何非空的機密欄位
    ok(!/"pdfPassword"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了 pdfPassword 明文`);
    ok(!/"flexToken"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了 flexToken 明文`);
    ok(!/"taishinSecPdfPassword"\s*:\s*"[^"]+"/.test(text), `${method} ${p} 回了台新密碼明文`);
    ok(!text.includes('enc:v1:'), `${method} ${p} 回了密文（沒意義又洩漏長度）`);
    // ② 值檢查（新增）：直接找我們**剛剛親手種下去**的那三串。
    //    形狀檢查會被「欄位改名」繞過（例如哪天欄位叫 pdf_password），值檢查不會。
    for (const [label, secret] of [['IB token', SEC_FLEX], ['台新密碼', SEC_TAISHIN], ['卡片密碼', SEC_CARDPW]]) {
      ok(!text.includes(secret), `${method} ${p} 把${label}送到瀏覽器了`);
    }
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
// ⚠️ **三個端點讀的 body 欄位不一樣**（2026-07-28 修）：`/api/securities/preview` 讀的是
//    `req.body?.file`（lib/routes/securities.js），另外兩個讀 `req.body.data`（lib/routes/statement.js）。
//    舊版三個都送 `data` → 證券那條在 `parseB64` 就以「沒有收到檔案內容」回 400，
//    **根本沒碰到 pdfjs**：不管解析器有沒有上限、會不會回顯密碼，那一題都是綠的。
/** @type {[string, string][]} */
const PDF_ENDPOINTS = [
  ['/api/statement/preview', 'data'],
  ['/api/bank-statement/preview', 'data'],
  ['/api/securities/preview', 'file'],
];

await check('畸形 PDF/XML → 明確錯誤，不含密碼（**每個端點送它自己讀的欄位**）', async () => {
  for (const [p, field] of PDF_ENDPOINTS) {
    const r = await req(A.jar, p, { method: 'POST', body: JSON.stringify({ [field]: 'AAAA', password: 'SHOULD-NOT-ECHO' }) });
    const text = await r.text();
    ok(r.status >= 400 && r.status < 500, `${p} 回 ${r.status}，應為 4xx`);
    ok(!text.includes('SHOULD-NOT-ECHO'), `${p} 把密碼回顯了！`);
    // 這一條是「有沒有真的走到解析器」的照妖鏡：送錯欄位的話，訊息會是「沒有收到檔案內容」，
    // 而不是解析器對一份壞檔該說的話。
    ok(!/沒有收到檔案內容|沒有檔案/.test(text),
      `${p} 回「沒有收到檔案內容」＝這一題送錯了欄位（應送 ${field}），根本沒碰到解析器`);
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
