// 簡單、零相依的本機 JSON 資料庫。
// 所有資料存在 data/store.json，永遠不離開這台電腦。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FILE = join(DATA_DIR, 'store.json');
const SEED = join(DATA_DIR, 'seed.json');

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    if (existsSync(SEED)) copyFileSync(SEED, FILE);
    else writeFileSync(FILE, JSON.stringify(emptyDb(), null, 2));
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
  ensure();
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (e) {
    return emptyDb();
  }
}

export function save(db) {
  ensure();
  // 寫入前先備份上一版，避免資料損毀
  if (existsSync(FILE)) {
    try { copyFileSync(FILE, FILE + '.bak'); } catch {}
  }
  writeFileSync(FILE, JSON.stringify(db, null, 2));
  return db;
}

// 產生短唯一 ID（新資料列用）
export function uid() {
  return Date.now().toString(36) + Math.floor(performance.now() * 1000 % 1e6).toString(36);
}
