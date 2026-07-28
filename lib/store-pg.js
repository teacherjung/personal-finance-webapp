// @ts-check
// HOSTED 模式的資料後端：Supabase Postgres（C4b）。**LOCAL 模式完全走不到這個檔**。
//
// 與本機 SQLite（lib/store.js）的關係＝「同一個形狀、換一顆引擎」：
//   本機   kv(key, data)                 一次交易寫全部 20 個 key
//   雲端   kv(user_id, key, data, version)  一次 RPC 寫全部 20 個 key（plpgsql 函式＝單一交易）
// 結構定義在 `db/supabase-schema.sql`（含 RLS 政策），**改這裡要同步改那裡**。
//
// 三件事情這個檔刻意「不做」，因為做了反而是破口：
// ① **不自己填 user_id**：查詢不帶 `where user_id=…`、寫入不帶 user_id 欄位。
//    隔離**只靠 RLS**（`user_id = auth.uid()`）＋資料表的 `default auth.uid()`。
//    這不是偷懶——「app 層漏了 where 條件」正是 C0 威脅模型第一條（IDOR）要防的事，
//    而防法是「就算漏了也不會出事」，不是「小心一點不要漏」。考題直接驗這件事（故意漏 where 仍被擋）。
// ② **不建自己的 Supabase client**：一律用 auth gate 放進租戶 context 的那一個
//    （＝帶著這位使用者 JWT 的 client）。裁決⑥不可退讓：**一般資料讀寫絕不可用 service_role**，
//    service_role 天生繞過 RLS，拿它查資料＝RLS 形同虛設。沒有 client 就 throw（fail-closed）。
// ③ **不做「本機檔案」那一套**：沒有備份、沒有搬家、沒有 seed。新租戶＝乾淨的 `emptyDb()` 底稿
//    （`data/seed.json` 是 William 本機的示範資料，寫進別人的帳本是資料污染）。
//
// ⚠️ 只 import store.js 的**純函式**（emptyDb / KV_KEYS / KV_MAP_KEYS）——一個字都不碰
//    load/save/snapshotTo/dataDir/backupNow 那些會開啟本機 SQLite 檔的東西。
//    `test/hosted-store-pg.test.js` 有架構考題把這件事釘死。
import { emptyDb, KV_KEYS, KV_MAP_KEYS } from './store.js';
import { sanitizeDbForWrite } from './schema.js';
import { requireTenant, tenantUndecryptableSecrets } from './tenant.js';
import { mapSecrets } from './secret-fields.js';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto-secrets.js';

/** @typedef {Record<string, number|null>} Versions kv 各 key 讀出來時的版本；null＝那一列當時不存在 */

/** kv 各 key 的空值（與 store.js load() 的缺列預設同口徑）。 @param {string} k */
function emptyFor(k) { return KV_MAP_KEYS.has(k) ? {} : []; }

/**
 * 機密加密的 AAD（C5）＝`使用者 id|欄位路徑`。把密文**綁死在這位使用者的這個欄位上**：
 * 同一串密文搬到別人的列、或從 pdfPassword 搬到 flexToken，都會解不開（GCM 驗不過）。
 * RLS 已經擋掉跨租戶寫入，這是第二道——很便宜，值得。
 * @param {string} path @returns {string}
 */
function aadFor(path) { return `${requireTenant().userId}|${path}`; }

/**
 * 這個請求該用的 Supabase client＝**帶著這位使用者 JWT 的那一個**（auth gate 放進 context）。
 * 拿不到就 throw：寧可整個請求失敗，也不可以「退而求其次」用別的憑證去查資料。
 * @returns {any}
 */
function client() {
  const t = requireTenant();
  if (!t.supabase) {
    throw Object.assign(
      new Error('伺服器無法確認你的身分，請重新登入後再試'),
      { status: 500, code: 'tenant_no_client' });
  }
  return t.supabase;
}

/**
 * Supabase/PostgREST 的錯誤 → 我們的錯誤口徑。
 * `40001`（serialization_failure）＝ kv_save 丟出來的版本衝突，翻成 409 給呼叫端。
 * 其餘一律 500，且**訊息換成我們自己寫的中文**——不把資料庫原文（含表名、SQL 片段）送到瀏覽器。
 * @param {any} error @param {string} where
 */
function toAppError(error, where) {
  if (error?.code === '40001') {
    return Object.assign(
      new Error('資料在你操作期間被另一個裝置或分頁改過，請重新整理後再存一次'),
      { status: 409, code: 'kv_conflict' });
  }
  console.error(`[store-pg] ${where} 失敗:`, error?.code || '', error?.message || error);
  return Object.assign(new Error('資料庫暫時無法存取，請稍後再試'), { status: 500, code: 'kv_backend' });
}

/**
 * 讀出這位使用者的整包資料。
 * **新租戶（一列都沒有）＝回 `emptyDb()`**，不是 20 個空 key——`settings` 若是 `{}`，
 * 淨資產、匯率、投資上限全部會用到 undefined，畫面看起來只是「數字怪怪的」，極難查。
 * @returns {Promise<{db: any, versions: Versions}>}
 */
export async function loadKv() {
  // ⚠️ 故意不帶 .eq('user_id', …)：隔離由 RLS 負責（見檔頭①）。
  const { data, error } = await client().from('kv').select('key,data,version');
  if (error) throw toAppError(error, 'loadKv');

  const db = /** @type {any} */ (emptyDb());
  /** @type {Versions} */
  const versions = Object.create(null);
  for (const k of KV_KEYS) versions[k] = null;

  for (const row of Array.isArray(data) ? data : []) {
    const k = String(row?.key || '');
    if (!Object.hasOwn(versions, k)) continue;   // 未知鍵忽略（同 LOCAL：只認 KV_KEYS）
    db[k] = row.data ?? emptyFor(k);
    versions[k] = Number(row.version);
  }
  // 機密欄位解密（C5）：資料庫裡存的是密文，記憶體裡才是原文——**解密只發生在這一層**，
  // 上面的服務與路由拿到的形狀與 LOCAL 完全一樣（所以它們一行都不必知道有加密這回事）。
  //
  // ⚠️ **解不開的欄位要把原始密文記下來**（C6 資料毀損止血，2026-07-28）：`decryptSecret` 解不開回空字串，
  //    而 `saveKv` 每次寫入都重寫全部 20 個 kv key——那個空字串會在使用者下一次隨手記帳時把原密文
  //    **永久蓋掉**（金鑰設錯一次＝IB token 與 PDF 密碼全滅，換回正確金鑰也救不回來，已實測）。
  //    記在**這個請求**的租戶槽（`lib/tenant.js`），`saveKv` 據此把原密文原封不動寫回去。
  // ⚠️ **每次讀取都先清空**，不可累積：CAS 衝突會讓 `lib/repo.js` 的 mutate 重跑一次 loadKv，
  //    若不清空，上一輪記下的舊密文會在「別的分頁剛把這個欄位正當清空」時被復活、蓋掉正確結果。
  //    清空後重新登記＝記的永遠是「這一版資料庫裡真正躺著的那串」，而 CAS 保證我們寫回去的就是那一版。
  const undecryptable = tenantUndecryptableSecrets();
  undecryptable?.clear();
  /** 走訪過的路徑；用來認出「兩筆資料算出同一個路徑」的情形。 @type {Set<string>} */
  const seenPaths = new Set();
  /** 撞在一起的路徑（見下方說明）。 @type {Set<string>} */
  const ambiguousPaths = new Set();
  mapSecrets(db, (v, path) => {
    if (seenPaths.has(path)) ambiguousPaths.add(path); else seenPaths.add(path);
    const plain = decryptSecret(v, aadFor(path));
    // 「原本是密文、卻解出空字串」＝解不開。（`encryptSecret` 對空值原樣回傳、不產生密文，
    //   所以一串合法密文必定解出非空字串——這個判準不會把「使用者存了空值」誤判成解密失敗。）
    if (plain === '' && isEncrypted(v)) undecryptable?.set(path, v);
    return plain;
  });
  // ⚠️ 路徑撞在一起的欄位**不登記**（實測可重現：`/api/import` 的檔案可以帶沒有 id 的卡片，
  //    `sanitizeDbForWrite` 不會補 id，兩張都算出 `cards..pdfPassword`）。寫回是**按路徑**寫的，
  //    所以一旦兩筆同路徑，甲的密文會被寫進乙那一格——後果從既有的「解不開（無害）」升級成
  //    「兩張卡的密碼被對調（有害）」。這種情形退回今天的行為（那個欄位的密文照舊會被空字串蓋掉），
  //    寧可少救一個欄位，也不要把資料寫錯。
  for (const p of ambiguousPaths) undecryptable?.delete(p);
  return { db, versions };
}

/**
 * 只讀版本、不讀資料——`/api/import` 這種「整包覆蓋」的路徑用：它手上的 db 是自己拼出來的
 * 新物件（沒有讀出來的版本戳），但仍然要走 CAS，不可以無條件蓋（無條件蓋＝另一個分頁
 * 同時在記帳的話，那些帳直接消失且沒有任何痕跡）。
 * @returns {Promise<Versions>}
 */
export async function currentVersions() {
  const { data, error } = await client().from('kv').select('key,version');
  if (error) throw toAppError(error, 'currentVersions');
  /** @type {Versions} */
  const versions = Object.create(null);
  for (const k of KV_KEYS) versions[k] = null;
  for (const row of Array.isArray(data) ? data : []) {
    const k = String(row?.key || '');
    if (Object.hasOwn(versions, k)) versions[k] = Number(row.version);
  }
  return versions;
}

/**
 * 寫回整包資料（compare-and-swap，P1-5）。版本不合＝丟 409，**一個字都不會寫進去**
 *（原子性由 plpgsql 函式的單一交易保證）。
 *
 * ⚠️ `sanitizeDbForWrite` 必須在**任何 await 之前**同步跑完（與 LOCAL 的 store.save 同一條規矩）：
 *    它內部用了模組級的 `lenEnforced` 旗標（lib/schema.js），中間讓出事件圈就可能被別的請求翻掉。
 * @param {any} db @param {Versions} expected
 * @returns {Promise<Versions>} 寫入後的新版本（呼叫端要拿去重新戳在 db 物件上）
 */
export async function saveKv(db, expected) {
  const clean = /** @type {any} */ (sanitizeDbForWrite(db, { mode: 'throw' }));
  // 機密欄位加密（C5）。**先深拷貝再加密**：`clean` 可能與呼叫端手上的 db 共用巢狀物件，
  // 就地加密會讓呼叫端接下來拿到密文（例如 PUT /api/settings 的回應、或同一請求後續的計算）。
  // 反正下一步就是要 JSON 化送進 RPC，這趟拷貝不算額外成本。
  //
  // ⚠️ 解不開的欄位寫回**原密文**、不是空字串（見 `loadKv` 的說明；沒有這一段＝金鑰設錯一次就永久毀資料）。
  //    判準刻意收得很窄——只有「這一輪讀出來時解不開」**且**「現在要寫的值是空字串」才保留原密文；
  //    使用者輸入了新值（非空）一律照常加密覆蓋，不會被舊密文黏住。
  //    副作用（已知、可接受）：對一個「解不開的欄位」送出清除，會變成 no-op。但 UI 走不到這條路——
  //    三個清除入口都用 `…Set` 布林把關（public/modules/cards.js:102、settings.js:172、:185），
  //    而解不開時記憶體裡是空字串、`…Set` 就是 false，那個 checkbox 根本不會渲染。
  //    在使用者的心智模型裡那個欄位本來就是「未設定」，清除本來就該是 no-op；
  //    反過來「靜默毀掉真憑證」嚴重一個數量級。
  const undecryptable = tenantUndecryptableSecrets();
  const forStorage = mapSecrets(JSON.parse(JSON.stringify(clean)), (v, path) => {
    const keep = v === '' ? undecryptable?.get(path) : undefined;
    return keep || encryptSecret(v, aadFor(path));
  });
  /** @type {Record<string, any>} */
  const rows = {};
  for (const k of KV_KEYS) rows[k] = forStorage[k] ?? emptyFor(k);
  /** @type {Record<string, number|null>} */
  const p_expected = {};
  for (const k of KV_KEYS) p_expected[k] = expected?.[k] ?? null;

  const { data, error } = await client().rpc('kv_save', { p_rows: rows, p_expected });
  if (error) throw toAppError(error, 'saveKv');

  /** @type {Versions} */
  const next = Object.create(null);
  const got = /** @type {any} */ (data)?.versions || {};
  for (const k of KV_KEYS) next[k] = Object.hasOwn(got, k) ? Number(got[k]) : null;
  return next;
}
