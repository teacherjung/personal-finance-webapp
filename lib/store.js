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
      ibConcentrationPct: 5,         // 單一個股佔投組上限 (%)
      ibIdleCashAlert: 5000,         // IB 閒置現金提醒 (美元 USD)
      qqqmMaxPct: 30,                // QQQM 佔美股核心的上限 (%)
      capeManual: '',                // Shiller PE 手動值（抓取失敗時使用）
      fxHigh: 32,                    // 美元/台幣：高於此為「美元→台幣」分批區
      fxLow: 28,                     // 美元/台幣：低於此為「台幣→美元」分批區
      fxTwd: { GBP: 40.8, JPY: 0.215 }, // 其他幣別兌台幣（更新報價會自動更新）
      ib: { flexToken: '', flexQueryId: '', lastSync: null }
    },
    accounts: [],        // 資產/負債帳戶 (現金、IB、房產、保單現金價值、房貸…)
    assetTargets: [],    // 資產配置目標 [{class, targetPct}]
    transactions: [],    // 收支記帳
    subscriptions: [],   // 訂閱服務
    cards: [],           // 信用卡 / 會員卡
    history: [],          // 訂閱費歷史紀錄（每月凍結值）
    insurance: [],       // 保險保單
    ibPositions: [],     // IB 持倉 (Flex Query 抓回後快取，暫未使用)
    holdings: [],        // 投資組合持股（主資料：核心/債券/衛星/個股/投機）
    watchlist: [],       // 回檔買進願望清單
    research: [],        // 個股研究筆記（論點/指標/風險/檢查點）
    portfolioSnapshots: [], // 每月「投入 vs 市值」快照
    ibTrades: [],        // IBKR 成交紀錄（同步時整批更新，供 XIRR／已實現損益）
    snapshots: []        // 每月淨資產快照 (隨時間變化的主軸)
  };
}

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

// 對某個集合做 CRUD 的小工具
export function uid() {
  return Date.now().toString(36) + Math.floor(performance.now() * 1000 % 1e6).toString(36);
}
