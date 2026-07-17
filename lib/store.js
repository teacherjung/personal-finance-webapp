// @ts-check
// 本機資料庫（B3：SQLite）。所有資料存在 data/store.db，永遠不離開這台電腦。
// 引擎＝Node 內建 node:sqlite（零外部套件、免編譯）；WAL＋交易＝寫到一半斷電也不會壞檔。
// 對外介面不變（load/save/emptyDb/uid）——repo 與其他房間一行都不用動（B1 單一櫃檯的紅利）。
// 儲存形狀：kv(key,data)——settings、learnedCategories 與每個集合各佔一列（JSON）。
// 現階段讀寫都是「整包」，一列一集合最簡單也最穩；階段 C 多人化時再正規化（加 user 欄）。
// 舊資料自動搬家：同資料夾的 store.json（見 ensure()），搬完原檔保留當備份、絕不動它。
import { readFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeDbForWrite, ALL_COLLECTIONS } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
// 資料檔路徑可用環境變數覆寫（B0：測試用隔離的暫存資料檔跑、絕不碰真實資料）。
const FILE = process.env.STORE_FILE || join(DATA_DIR, 'store.db');
const SEED = join(DATA_DIR, 'seed.json');
// 舊版 JSON 資料檔（自動搬家來源）＝同路徑的 .json。自訂 STORE_FILE 非 .db 時不做舊檔搬家。
const LEGACY = FILE.endsWith('.db') ? FILE.slice(0, -3) + '.json' : null;

/** kv 的鍵＝settings、learnedCategories、與所有集合名。 */
const KV_KEYS = ['settings', 'learnedCategories', ...ALL_COLLECTIONS];

/** @type {import('node:sqlite').DatabaseSync | null} */
let db = null;

function open() {
  if (db) return db;
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    db = new DatabaseSync(FILE);
    db.exec('PRAGMA journal_mode = WAL');           // 寫入走 WAL：斷電/強制關機不會留半截壞檔
    const check = /** @type {any} */ (db.prepare('PRAGMA quick_check').get());
    if (check && check.quick_check !== 'ok') throw new Error(`quick_check: ${check.quick_check}`);
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
  } catch (e) {
    db = null;
    // fail closed：資料庫損毀時絕不回空資料庫。.bak 是每次啟動時的完整快照。
    throw new Error(`data/store.db 開啟失敗（檔案可能損毀）：${/** @type {any} */ (e).message}。請先不要進行任何操作，到 data/ 資料夾把 store.db.bak 改名為 store.db（還原啟動時的備份）後重啟伺服器。`, { cause: e });
  }
  // ⚠️ 搬家/備份失敗時必須把 db 重置為 null（自審 r2，高）：否則 fail-closed 只擋「第一次」——
  // 第二次呼叫 open() 看到 db 非空直接放行，衝突未解就繼續讀寫；更糟的是舊 json 損毀＋新庫全空時，
  // 第二次會拿「空資料庫」繼續運作並寫入（設計明文禁止的結局）。重置後每次呼叫都重驗、重丟同樣的指引。
  try {
    migrateIfNeeded(db);
    backupOnce(db);
  } catch (e) {
    try { db.close(); } catch { /* 關閉失敗不影響重置 */ }
    db = null;
    throw e;   // 保留原錯誤（衝突二選一指引／損毀還原指引）
  }
  return db;
}

/**
 * 把整包資料寫進 kv（單一交易＝全有或全無）。extraMeta＝要在同一筆交易內順帶寫入的內部鍵
 *（例如 __dbUpdatedAt——與資料同交易寫入，衝突偵測才不會因半途中斷而失準）。
 * @param {import('node:sqlite').DatabaseSync} d @param {Record<string, any>} obj @param {Record<string, any>=} extraMeta
 */
function writeAll(d, obj, extraMeta = {}) {
  const up = d.prepare('INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data');
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const k of KV_KEYS) up.run(k, JSON.stringify(obj[k] ?? (k === 'settings' || k === 'learnedCategories' ? {} : [])));
    for (const [k, v] of Object.entries(extraMeta)) up.run(k, JSON.stringify(v));
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** 讀內部 meta 數字鍵（不存在回 0）。 @param {import('node:sqlite').DatabaseSync} d @param {string} key */
function metaNum(d, key) {
  const row = /** @type {any} */ (d.prepare('SELECT data FROM kv WHERE key=?').get(key));
  return row ? Number(JSON.parse(row.data)) : 0;
}

/** 舊 settings 補上預設值再進清理（與 /api/import 同口徑：缺的補預設、巢狀合併）。 @param {any} s */
function mergeSettingsDefaults(s) {
  const base = emptyDb().settings;
  const src = (s && typeof s === 'object') ? s : {};
  return {
    ...base, ...src,
    signals: { ...base.signals, ...(src.signals || {}) },
    fxTwd: { ...base.fxTwd, ...(src.fxTwd || {}) },
    ib: { ...base.ib, ...(src.ib || {}) }
  };
}

/**
 * 首次啟動／舊版搬家：store.json 還沒搬過→搬入；搬過但 json 又變新→分兩種：
 * ①資料庫在搬家後「沒被寫過」＝安全，以較新的 json 重搬（舊版程式繼續記帳的情境）。
 * ②資料庫在搬家後「也被寫過」＝兩邊都有新資料——自動選哪邊都會遺失另一邊（Codex#8-1 實測），
 *   fail closed：停下來請使用者二選一，絕不自動覆蓋。
 * @param {import('node:sqlite').DatabaseSync} d
 */
function migrateIfNeeded(d) {
  const has = d.prepare("SELECT 1 FROM kv WHERE key='settings'").get();
  const migratedAt = metaNum(d, '__migratedFromJsonAt');
  if (LEGACY && existsSync(LEGACY)) {
    const mtime = statSync(LEGACY).mtimeMs;
    if (!has || mtime > migratedAt) {
      const dbUpdatedAt = metaNum(d, '__dbUpdatedAt');
      if (has && dbUpdatedAt > migratedAt) {
        // 兩邊都動過 → 不可自動覆蓋（會靜默遺失其中一邊的新資料）
        throw new Error(
          `store.json 與 store.db 在上次搬家後「都」被更改過，無法自動判斷該以哪邊為準。` +
          `請二選一後重啟：①保留資料庫（建議）＝把 data/store.json 改名成 store.json.old；` +
          `②以 JSON 為準＝把 data/store.db（連同 .bak/-wal/-shm）刪除，重啟時會重新從 store.json 搬入。`);
      }
      let parsed;
      try { parsed = JSON.parse(readFileSync(LEGACY, 'utf8')); }
      catch (e) {
        if (has) { console.warn('[store] store.json 損毀、略過重新搬家（沿用現有資料庫）:', /** @type {any} */ (e).message); return; }
        throw new Error(`舊資料檔 store.json 損毀、無法搬家：${/** @type {any} */ (e).message}。請先把 store.json.bak 改名為 store.json 再重啟。`, { cause: e });
      }
      // 舊資料用剝除＋警告（不卡死）；settings 清理後再補一次預設（被剝掉的壞值由預設接手，不會缺欄）
      const clean = sanitizeDbForWrite({ ...emptyDb(), ...parsed, settings: mergeSettingsDefaults(parsed.settings) }, { mode: 'strip' });
      clean.settings = mergeSettingsDefaults(clean.settings);
      writeAll(d, clean, { '__migratedFromJsonAt': Date.now() });
      console.log(`[store] 已把 store.json 搬進 SQLite（store.db）。原 store.json 保留不動、當作備份。`);
      return;
    }
  }
  if (!has) {
    const seedRaw = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : {};
    const seedDb = { ...emptyDb(), ...seedRaw, settings: mergeSettingsDefaults(seedRaw.settings) };
    writeAll(d, sanitizeDbForWrite(seedDb, { mode: 'strip' }));
  }
}

/** 每次啟動備份一次：VACUUM INTO 產生一致的完整快照（.bak）。 @param {import('node:sqlite').DatabaseSync} d */
let backedUp = false;
function backupOnce(d) {
  if (backedUp) return;
  // 先做新快照到 .tmp、成功才原子替換舊 .bak（自審 r2，中）：原寫法「先刪舊再做新」，
  // 若 VACUUM 失敗（例如硬碟滿）會兩頭空——而損毀還原指引指的正是這顆 .bak。
  const bak = FILE + '.bak', tmp = bak + '.tmp';
  try {
    if (existsSync(tmp)) rmSync(tmp);
    d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    renameSync(tmp, bak);
    backedUp = true;
  } catch (e) {
    console.warn('[store] 啟動備份 .bak 失敗（保留上一顆舊備份，不影響使用）:', /** @type {any} */ (e).message);
    try { rmSync(tmp); } catch { /* tmp 可能不存在 */ }
  }
}

export function emptyDb() {
  return {
    settings: {
      currency: 'TWD',
      usdTwd: 32,                    // 美元兌台幣匯率（IB 為美元，換算成台幣計入總資產）
      emergencyFundMonths: 6,        // 緊急預備金目標月數
      allocationDriftPct: 5,         // 資產配置偏離提醒門檻 (%)
      ibConcentrationPct: 5,         // 投資原則：單一個股上限 (% 淨資產)
      equityCapPct: 90,              // 投資原則：股票總曝險上限 (% 淨資產，動態股債比天花板)
      countryCapPct: 15,             // 投資原則：單一國家上限 (% 淨資產，美國/其他不設限)
      chinaCapPct: 15,               // 投資原則：中國上限 (% 淨資產，可與國家上限不同)
      levCapPct: 1.3,                // 投資原則：融資槓桿上限 (x)，任何時期適用（訊號期加碼只用新資金、不舉新債）
      ibMaintenancePct: 25,          // IB 維持保證金率 (%)，斷頭距離計算用（IB 危機時會調高、強平無寬限期）
      ibIdleCashAlert: 5000,         // IB 閒置現金提醒 (美元 USD)
      qqqmMaxPct: 30,                // QQQM 佔美股核心的上限 (%)
      capeManual: '',                // Shiller PE 手動值（抓取失敗時使用）
      // 估值訊號儀表：美股 ECY 自動（CAPE＋FRED 實質利率）；區域市場每月手動更新
      signals: { realYieldManual: '', china: '', japan: '', korea: '', taiwanPE: '', taiwanYield: '' },
      fxHigh: 32,                    // 美元/台幣：高於此為「美元→台幣」分批區
      fxLow: 28,                     // 美元/台幣：低於此為「台幣→美元」分批區
      fxTwd: { GBP: 40.8, JPY: 0.215 }, // 其他幣別兌台幣（更新報價會自動更新）
      ib: { flexToken: '', flexQueryId: '', lastSync: null }
    },
    accounts: [],        // 資產/負債帳戶 (現金、IB、房產、保單現金價值、房貸…)
    assetTargets: [],    // 資產配置目標 [{class, targetPct}]
    transactions: [],    // 收支記帳
    learnedCategories: {}, // 帳單分類自動學習：{ 店名(cleanStore後) → {category, subcategory} }，使用者修正時累積、匯入時優先套用
    subscriptions: [],   // 訂閱服務
    cards: [],           // 信用卡 / 會員卡
    history: [],          // 訂閱費歷史紀錄（每月凍結值）
    insurance: [],       // 保險保單
    holdings: [],        // 投資組合持股（主資料：核心/債券/衛星/個股/投機；IB 同步直接合併進來）
    watchlist: [],       // 回檔買進願望清單
    research: [],        // 個股研究筆記（論點/指標/風險/檢查點）
    portfolioSnapshots: [], // 每月「投入 vs 市值」快照
    ibTrades: [],        // IBKR 成交紀錄（同步時整批更新；交易摘要與 XIRR 已實現損益修正使用中）
    snapshots: []        // 每月淨資產快照 (隨時間變化的主軸)
  };
}

/** 載入本機資料庫。 @returns {import('./types.js').Db} */
export function load() {
  const d = open();
  /** @type {any} */
  const out = {};
  const get = d.prepare('SELECT data FROM kv WHERE key=?');
  for (const k of KV_KEYS) {
    const row = /** @type {any} */ (get.get(k));
    out[k] = row ? JSON.parse(row.data) : (k === 'settings' || k === 'learnedCategories' ? {} : []);
  }
  return out;
}

/**
 * 寫回整包資料。B3「驗證入櫃檯」：這裡是唯一的門——所有寫入自動過 sanitizeDbForWrite
 *（枚舉/布林非法＝寫入端程式有 bug，當場 throw 讓考試抓到；不再可能有路徑繞過牆）。
 * 整包寫入包在單一交易裡：全有或全無，不會存到一半。
 */
export function save(dbObj) {
  const d = open();
  const clean = sanitizeDbForWrite(dbObj, { mode: 'throw' });
  // __dbUpdatedAt 與資料同一筆交易寫入：搬家衝突偵測（migrateIfNeeded）靠它判斷「資料庫在搬家後被寫過」
  writeAll(d, clean, { '__dbUpdatedAt': Date.now() });
  return dbObj;
}

// 產生短唯一 ID（新資料列用）
export function uid() {
  return Date.now().toString(36) + Math.floor(performance.now() * 1000 % 1e6).toString(36);
}
