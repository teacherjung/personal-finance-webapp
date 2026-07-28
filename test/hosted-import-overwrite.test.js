// @ts-check
// C6 考題：**還原備份不可以把「你讀完之後、寫入之前」別人存進去的東西無聲蓋掉**（2026-07-28）。
//
// 病根（Codex 收官審查 #2，本檔逐條重現）：
//   `/api/import` 走的是 `saveDb(merged, { overwrite: true })`——`merged` 是路由自己拼的新物件，
//   沒有版本戳，所以舊實作在**寫入前一刻**自己去資料庫重抓一次目前版本當 CAS 的 expected。
//   那等於**自己蓋章給自己看**：CAS 只保護「重抓」到「寫入」那一瞬間，而真正需要保護的窗口是
//   「路由讀資料（拿機密、拿底稿）」到「寫入」的一整段。
//
//   重現出來的樣子（第一題）：
//     A 分頁按下「還原備份」 → 讀到 v1
//     B 分頁（或手機、或開機自動快照）存了新的 IB token → 資料庫變 v2
//     A 重抓版本拿到 v2 → CAS 通過 → 把 v1 的舊值整包寫回去
//     → **新 token 永久消失，而且畫面回 200 說還原成功**
//
//   「無聲毀資料 ＋ 畫面說成功」是這套系統最嚴重的一族錯（同族：#6 金鑰不符蓋掉密文）。
//   修法＝呼叫端交出 `getDb()` 當時的版本戳（`{ overwrite: true, from: snapshot }`），
//   CAS 因此保護整段窗口；中間有人寫過 → 409、一個字都不寫。
//
// ⚠️ 這一檔刻意**走真的 HTTP 打 /api/import**（真 auth gate、真路由、真櫃檯、假 Supabase）。
//    直接呼叫 `saveDb` 只證得了「牆蓋得對」，證不了「牆蓋在路上」——`lib/routes/core.js`
//    忘了把 snapshot 傳下去的話，純櫃檯考題照樣全綠（AGENTS.md 記過這個教訓）。
//
// ⚠️ 三種並發方各一題，缺一題就有「換個角度就漏掉」的空隙：機密路徑、一般帳目、開機自動快照。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';

const DIR = mkdtempSync(join(tmpdir(), 'finance-import-overwrite-'));
process.env.STORE_FILE = join(DIR, 'store.db');
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 5).toString('base64');

const { setSupabaseFactoryForTest, cookieAdapterFor } = await import('../lib/services/auth.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { app } = await import('../server.js');

const A = { id: 'user-imp-a', email: 'a@x.com' };
const pg = createFakePostgres();

// ---------------------------------------------------------------------------
// 可控的交錯點：讓「匯入請求讀完資料」與「匯入請求寫入」中間停住，好把第二個請求塞進去。
//
// 為什麼要自己做這個閘門而不是靠真實競態：真實競態不可重現（有時候贏、有時候輸），
// 那種考題會變成間歇性紅——比沒有考題更糟，因為下一個人會直接把它標成 flaky 關掉。
// 這裡用一個請求標頭當開關，交錯點因此是**確定的**：一定在那個位置、一定只停一次。
// ---------------------------------------------------------------------------
/** @type {{ hit: Promise<void>, release: () => void, armed: boolean } | null} */
let gate = null;

/** 架一次一次性閘門：回傳「已經讀完、正停在那裡」的 promise 與放行函式。 */
function armGate() {
  /** @type {() => void} */
  let onHit = () => {};
  /** @type {() => void} */
  let release = () => {};
  const hit = new Promise((r) => { onHit = () => r(undefined); });
  const held = new Promise((r) => { release = () => r(undefined); });
  gate = {
    hit,
    release,
    armed: true,
    // @ts-ignore 內部用
    _onHit: onHit,
    // @ts-ignore 內部用
    _held: held,
  };
  return gate;
}

/** 包一層假 client：帶著 `X-Test-Pause` 的請求，第一次讀完 kv 之後停在閘門上。 */
function pausableFactory(/** @type {(req: any, res: any) => any} */ inner) {
  return (/** @type {any} */ req, /** @type {any} */ res) => {
    const client = inner(req, res);
    const wantsPause = String(req.headers?.['x-test-pause'] || '') === '1';
    if (!wantsPause) return client;
    const realFrom = client.from;
    client.from = (/** @type {string} */ table) => {
      const builder = realFrom(table);
      const realSelect = builder.select;
      builder.select = (/** @type {string} */ cols) => {
        const sel = realSelect(cols);
        const realThen = sel.then;
        // 讀出來的資料照常交給呼叫端，但**在 resolve 之前**先停住：
        // 這正是「路由已經拿到快照、還沒寫入」的那一刻。
        sel.then = (/** @type {any} */ ok, /** @type {any} */ err) => realThen(async (/** @type {any} */ v) => {
          const g = gate;
          if (g?.armed) {
            g.armed = false;                      // 只停第一次讀（之後的讀不要再卡）
            /** @type {any} */ (g)._onHit();
            await /** @type {any} */ (g)._held;
          }
          return v;
        }, err).then(ok, err);
        return sel;
      };
      return builder;
    };
    return client;
  };
}

before(() => setSupabaseFactoryForTest(
  pausableFactory(makeFakeSupabaseFactory({ pg, users: { tokA: A }, cookieAdapterFor }))));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const ORIGIN = 'https://noteasy.com.tw';

after(() => {
  server.close();
  setSupabaseFactoryForTest(null);
  rmSync(DIR, { recursive: true, force: true });
});

const as = (/** @type {string} */ p, /** @type {any} */ init = {}) => fetch(`${base}${p}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: 'sb-test-auth-token=tokA', ...(init.headers || {}) },
});

/** 某個 kv key 的**資料庫原始列**——斷言一律看這裡，不看 API 回應（回應說 ok 正是這個 bug 的一部分）。 @param {string} key */
const rowOf = (key) => pg.selectAs(A.id).find(r => r.key === key)?.data;

/** 一份合法的還原備份（內容不重要，重要的是它會整包覆蓋）。 */
const BACKUP = {
  settings: { usdTwd: 31 },
  transactions: [{ id: 'restored-1', date: '2026-07-01', type: 'expense', category: '其他', amount: 1, note: 'RESTORED' }],
};

/**
 * 跑一次「匯入到一半被別人插隊」：匯入讀完 → 執行 `interloper()` → 放行匯入。
 * @param {() => Promise<any>} interloper
 */
async function importInterleavedWith(interloper) {
  const g = armGate();
  const importing = as('/api/import', {
    method: 'POST', headers: { 'X-Test-Pause': '1' }, body: JSON.stringify(BACKUP),
  });
  await g.hit;                     // 匯入已經讀完快照，正停在寫入之前
  const other = await interloper();  // 另一個分頁／裝置在這一刻寫進去
  g.release();
  return { res: await importing, other };
}

// ============================================================================
// 一、三種並發方：匯入都必須輸（409），對方寫的東西都必須還在
// ============================================================================

test('並發①（機密路徑）：匯入期間存了新的 IB token → 匯入回 409，token 不可以被蓋掉', async () => {
  const NEW = 'FLEXTOKEN-DURING-IMPORT-0001';
  const { res, other } = await importInterleavedWith(() => as('/api/settings', {
    method: 'PUT', body: JSON.stringify({ ib: { flexToken: NEW, flexQueryId: '123' } }),
  }));
  assert.equal(other.status, 200, '前置條件：插隊的那一次設定必須真的存進去了');

  assert.equal(res.status, 409,
    '匯入拿的是過期版本 → 必須 409。舊實作會回 200，而使用者永遠不會知道 token 沒了');
  const stored = rowOf('settings')?.ib?.flexToken;
  assert.ok(stored && String(stored).startsWith('enc:v1:'),
    `新 token 的密文必須還在資料庫裡（實際：${JSON.stringify(stored)}）`);
  const s = await (await as('/api/settings')).json();
  assert.equal(s.ib.flexTokenSet, true, '從使用者的角度：IB token 仍然是「已設定」');
});

test('並發②（一般帳目）：匯入期間記了一筆帳 → 匯入回 409，那筆帳不可以消失', async () => {
  const { res, other } = await importInterleavedWith(() => as('/api/transactions', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-28', type: 'expense', category: '其他', amount: 55, note: 'DURING-IMPORT' }),
  }));
  assert.equal(other.status, 200, '前置條件：插隊的那一筆帳必須真的記進去了');

  assert.equal(res.status, 409, '匯入必須輸給「先寫進去的那一方」');
  assert.match(JSON.stringify(rowOf('transactions')), /DURING-IMPORT/,
    '匯入期間記的那筆帳必須還在（舊實作會被備份整包蓋掉）');
});

test('並發③（開機自動快照）：最像真實世界的那一條——使用者什麼都沒做也會寫入', async () => {
  // 為什麼特別考這一條：①②都需要使用者「同時操作兩個地方」，聽起來像邊角情境；
  // 自動快照不需要——另一台裝置只要**開著頁面**就可能寫入，使用者完全無感。
  const { res, other } = await importInterleavedWith(() => as('/api/snapshot/auto', { method: 'POST' }));
  assert.ok(other.status < 400, `前置條件：自動快照要成功（實際 ${other.status}：${await other.clone().text()}）`);

  assert.equal(res.status, 409, '自動快照也算「別人寫過了」，匯入一樣要輸');
  assert.match(JSON.stringify(rowOf('snapshots')), /\d/, '快照必須還在');
});

// ============================================================================
// 二、別把牆蓋成「什麼都不准」：沒有人插隊時，還原備份要照常成功
// ============================================================================

test('沒有人插隊時，還原備份照常成功並真的寫進去（防止為了過上面三題把匯入整條路擋死）', async () => {
  const r = await as('/api/import', { method: 'POST', body: JSON.stringify(BACKUP) });
  assert.equal(r.status, 200, `正常還原必須成功：${await r.clone().text()}`);
  assert.match(JSON.stringify(rowOf('transactions')), /RESTORED/, '備份內容要真的落庫');
});

// ============================================================================
// 三、釘住方向：不准再有第二個「無來源版本的整包覆蓋」
// ============================================================================

test('架構題：`overwrite: true` 全 repo 只准出現在 /api/import，而且一定要帶 from', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const roots = ['lib', 'lib/routes', 'lib/services'];
  /** @type {string[]} */
  const hits = [];
  for (const dir of roots) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8');
      for (const line of src.split('\n')) {
        // 只看真的呼叫（`saveDb(..., { overwrite`），不看註解裡提到的字
        if (/saveDb\([^)]*\{[^}]*overwrite:\s*true/.test(line)) hits.push(`${dir}/${f}: ${line.trim()}`);
      }
    }
  }
  assert.equal(hits.length, 1, `整包覆蓋只准有一個入口，實際找到：\n${hits.join('\n')}`);
  assert.match(hits[0], /^lib\/routes\/core\.js:/, '那個入口必須是匯入');
  assert.match(hits[0], /from:/,
    'overwrite 一定要同時交出 from（版本戳的來源）——少了它就是把 Codex #2 那個洞加回來');
});
