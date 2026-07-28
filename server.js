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
import { installJsonBodyParsers, AUTH_JSON_LIMIT, STATEMENT_JSON_POST_ROUTES } from './lib/http-body.js';
import { rateLimit, ipKeyOf } from './lib/rate-limit.js';
import { currentTenant } from './lib/tenant.js';
import { isHosted, hostedConfig } from './lib/hosted.js';
import { authRoutes, csrfOriginGuard, authGate } from './lib/routes/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// export 供測試載入（B0）：測試 import { app } 後自行在隨機埠監聽，不會動到 4321
export const app = express();
// 雙模式（C2，裁決①）：HOSTED＝noteasy.com.tw（公開站＋帳號系統）；LOCAL＝預設＝以下每一行照舊。
// ⚠️ LOCAL 分支的行為必須與 C2 之前 byte-for-byte 等價——這是 C0 的「本機版零改動」契約。
if (isHosted()) {
  hostedConfig();
  // ⚠️ Render 之類的平台會在前面代理：不設 trust proxy 的話 `req.ip` 是代理的 IP，
  // 「每 IP 限制」會退化成「全站共用一個額度」（把正當使用者一起擋掉）。`1` ＝只信任一層代理，
  // 不無條件相信整串 X-Forwarded-For（那可以偽造）。LOCAL 不設＝維持 Express 預設。
  app.set('trust proxy', 1);                       // fail-fast：缺環境變數＝啟動即 throw（不可默默半套上線）
  app.use(csrfOriginGuard);             // CSRF Origin 牆（變更類請求；C0 威脅模型）
  app.get('/health', (req, res) => res.json({ ok: true }));   // 機器健康檢查（裁決④：/health 讓給機器）
  // ⚠️ **身分牆之前只准解析登入用的小 body**（2026-07-28 修）：登入端點在牆的白名單裡、
  // 需要 body 才讀得到信箱密碼，所以給它一個 32KB 的專屬 parser——牆前的每一個位元組都是未驗證流量。
  app.use('/api/auth', express.json({ limit: AUTH_JSON_LIMIT }));
  // 速率限制①：登入類端點按 **IP**（可用性第一層，2026-07-28）。Supabase Auth 自己也有速率限制，
  // 這一道是**保護我們的行程**——連續猛打登入會把 CPU 與事件圈吃光，牆後的正當使用者跟著遭殃。
  // 只限「會做事」的三條（login/confirm/set-password）；`me`／`logout` 是輕量讀取、限了只會擋到正常換頁。
  app.use(['/api/auth/login', '/api/auth/confirm', '/api/auth/set-password'], rateLimit({
    windowMs: 5 * 60 * 1000, max: 20, keyOf: ipKeyOf,
    message: '嘗試次數過多，請稍等幾分鐘再試',
  }));
  app.use(authRoutes);                  // /api/auth/*（login/logout/me/confirm/set-password）
  app.use(authGate);                    // C3 gate（P1-1）：/finance＋全部 /api/*（白名單除外）
  // ⚠️ **大件 parser 一定要掛在 authGate 之後**：以前掛在最前面，等於「不管誰寄來的包裹都先拆開，
  // 拆完才到櫃台問這個人能不能進來」。實測 10 個**未登入**請求 × 45MB 就把行程 OOM 打死
  //（模擬 Render 512MB 容器）；搬到牆後之後同樣的攻擊全數 401、記憶體只多 8MB。
  // 速率限制②：上傳／解析類端點按 **帳號**（掛在 gate 之後，所以一定有身分可用）。
  // 這些端點會解 PDF／XLSX／XML，是全站最貴的 CPU 操作——**多人化才成立的攻擊面**：
  // 以前只有你自己會反覆丟大檔，現在任何一位受邀使用者都可以。按帳號而不按 IP：
  // 同一個家庭／公司出口 IP 的兩個人不該互相排擠。
  app.use([...STATEMENT_JSON_POST_ROUTES, '/api/import'], rateLimit({
    windowMs: 5 * 60 * 1000, max: 30, keyOf: (req) => currentTenant()?.userId || ipKeyOf(req),
    message: '上傳與解析的次數過多，請稍等幾分鐘再試（這是為了讓大家的服務都不會被拖慢）',
  }));
  installJsonBodyParsers(app);
  // 公開站（C1 的 public-site/）＋extensionless rewrite（/login→login.html；C1 記錄在案的接手項）
  const site = join(__dirname, 'public-site');
  app.use(express.static(site, { extensions: ['html'] }));
  // /finance＝理財 app（C3 才掛 auth gate；C2 先讓路徑存在＝重導到既有 SPA）
  app.use('/finance', express.static(join(__dirname, 'public')));
} else {
  // LOCAL：位置與改造前**完全相同**（原本就緊接在 if 之前，而 else 的第一行就是 static）——
  // 中介層堆疊逐層比對過、無差異。本機不對外（只聽 127.0.0.1），沒有未驗證流量的問題。
  installJsonBodyParsers(app);
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
  // 409＝並行寫入衝突（C4b compare-and-swap）：**必須回原味訊息**，否則使用者看到的是
  // 「請求格式不正確」——他的格式明明沒問題，真正該做的是重新整理再存一次。比照 413 的先例
  // （可操作的白話訊息），不走下面那條泛用訊息。
  if (/** @type {any} */ (err)?.status === 409) {
    return res.status(409).json({ error: String(/** @type {any} */ (err)?.message || '資料已被其他裝置更新，請重新整理後再試') });
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
