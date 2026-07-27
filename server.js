// @ts-check
// 本機伺服器：只在你的 Mac 上的 127.0.0.1 監聽，不對外開放。
// B2 之後這裡只是「薄殼」：啟動 express、掛中介層與各主題路由（lib/routes/*.js）。
// 業務邏輯在 lib/services/*.js、資料存取一律走 lib/repo.js 櫃檯、欄位白名單在 lib/schema.js。
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRoutes } from './lib/routes/core.js';
import { crudRoutes } from './lib/routes/crud.js';
import { marketRoutes } from './lib/routes/market.js';
import { ibRoutes } from './lib/routes/ib.js';
import { statementRoutes } from './lib/routes/statement.js';
import { securitiesRoutes } from './lib/routes/securities.js';
import { installJsonBodyParsers } from './lib/http-body.js';
import { isHosted, hostedConfig } from './lib/hosted.js';
import { authRoutes, csrfOriginGuard, authGate } from './lib/routes/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// export 供測試載入（B0）：測試 import { app } 後自行在隨機埠監聽，不會動到 4321
export const app = express();
installJsonBodyParsers(app);
// 雙模式（C2，裁決①）：HOSTED＝noteasy.com.tw（公開站＋帳號系統）；LOCAL＝預設＝以下每一行照舊。
// ⚠️ LOCAL 分支的行為必須與 C2 之前 byte-for-byte 等價——這是 C0 的「本機版零改動」契約。
if (isHosted()) {
  hostedConfig();                       // fail-fast：缺環境變數＝啟動即 throw（不可默默半套上線）
  app.use(csrfOriginGuard);             // CSRF Origin 牆（變更類請求；C0 威脅模型）
  app.get('/health', (req, res) => res.json({ ok: true }));   // 機器健康檢查（裁決④：/health 讓給機器）
  app.use(authRoutes);                  // /api/auth/*（login/logout/me/confirm/set-password）
  app.use(authGate);                    // C3 gate（P1-1）：/finance＋全部 /api/*（白名單除外）——只宣稱 401，隔離歸 C4
  // 公開站（C1 的 public-site/）＋extensionless rewrite（/login→login.html；C1 記錄在案的接手項）
  const site = join(__dirname, 'public-site');
  app.use(express.static(site, { extensions: ['html'] }));
  // /finance＝理財 app（C3 才掛 auth gate；C2 先讓路徑存在＝重導到既有 SPA）
  app.use('/finance', express.static(join(__dirname, 'public')));
} else {
  app.use(express.static(join(__dirname, 'public')));
}
// 把 Chart.js 從 node_modules 對外提供（離線可用）
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules/chart.js/dist/chart.umd.js')));

app.use(coreRoutes);        // /db /summary /settings /snapshot /migrate /export /import
app.use(crudRoutes);        // 各集合的通用 CRUD（含欄位白名單）
app.use(marketRoutes);      // /quotes /cape /realyield
app.use(ibRoutes);          // /ib/sync
app.use(statementRoutes);   // /statement/* /cards/:id/statement/* /learned*
app.use(securitiesRoutes);  // /securities* 證券交易（S2：查詢/台新對帳單匯入/匯入紀錄）

// 不存在的 API 路徑 → 明確 JSON 404（而非 Express 預設 HTML「Cannot GET…」）；前端打錯 URL 時看得懂
app.use('/api', (req, res) => res.status(404).json({ error: '不存在的 API 路徑' }));

// 統一錯誤處理（4 參數＝Express 錯誤中介）：回乾淨 JSON，不回含伺服器絕對路徑的 HTML 堆疊。
// ⚠️ 自審 r2（中）：診斷不可吞——搬家衝突的「二選一」指引、schema tripwire 的「寫入端漏了驗證」
// 都靠這裡送達；一律 console.error 留紀錄。413＝上傳過大、回可操作的白話訊息；其餘有 status＝請求端問題
// （如壞 JSON body）回泛用訊息；
// 無 status＝伺服器內部錯誤 → 500＋err.message（訊息皆為我們自己寫的中文指引，無堆疊、無路徑洩漏）。
app.use((err, req, res, next) => {
  console.error('[api error]', /** @type {any} */ (err)?.message || err);
  if (res.headersSent) return next(err);
  if (/** @type {any} */ (err)?.status === 413 || /** @type {any} */ (err)?.type === 'entity.too.large') {
    return res.status(413).json({ error: '上傳內容太大，請縮小檔案或備份後再試' });
  }
  if (/** @type {any} */ (err)?.status) return res.status(/** @type {any} */ (err).status).json({ error: '請求格式不正確' });
  res.status(500).json({ error: String(/** @type {any} */ (err)?.message || '伺服器內部錯誤') });
});

const PORT = Number(process.env.PORT) || 4321;   // 轉成數字（env 是字串；app.listen 要 number）
// 只有「直接執行」（npm start / node server.js）才啟動監聽；被測試 import 時不開埠（B0）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // P1-6（C0 契約）：HOSTED 聽 0.0.0.0（Render 的健康檢查與流量才進得來）；LOCAL 維持 127.0.0.1 不對外。
  app.listen(PORT, isHosted() ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`\n  個人理財網頁已啟動 ✅`);
    console.log(`  請在瀏覽器打開： http://localhost:${PORT}\n`);
    console.log(`  資料只存在本機 data/store.db（SQLite；舊 store.json 僅為搬家備份），按 Ctrl+C 可關閉。\n`);
  });
}
