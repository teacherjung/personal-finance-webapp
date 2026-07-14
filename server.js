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

const __dirname = dirname(fileURLToPath(import.meta.url));
// export 供測試載入（B0）：測試 import { app } 後自行在隨機埠監聽，不會動到 4321
export const app = express();
app.use(express.json({ limit: '15mb' }));   // 上傳帳單 PDF 以 base64 走 JSON，需要較大上限
app.use(express.static(join(__dirname, 'public')));
// 把 Chart.js 從 node_modules 對外提供（離線可用）
app.use('/vendor/chart.js', express.static(join(__dirname, 'node_modules/chart.js/dist/chart.umd.js')));

app.use(coreRoutes);        // /db /summary /settings /snapshot /migrate /export /import
app.use(crudRoutes);        // 各集合的通用 CRUD（含欄位白名單）
app.use(marketRoutes);      // /quotes /cape /realyield
app.use(ibRoutes);          // /ib/sync
app.use(statementRoutes);   // /statement/* /cards/:id/statement/* /learned*

// 統一錯誤處理（4 參數＝Express 錯誤中介）：壞的 JSON body 等會落到這裡，回乾淨 JSON，
// 而不是 Express 預設的「含伺服器絕對路徑的 HTML 堆疊」（資訊外洩，多人化前尤其重要）。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 400).json({ error: '請求格式不正確' });
});

const PORT = Number(process.env.PORT) || 4321;   // 轉成數字（env 是字串；app.listen 要 number）
// 只有「直接執行」（npm start / node server.js）才啟動監聽；被測試 import 時不開埠（B0）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  個人理財網頁已啟動 ✅`);
    console.log(`  請在瀏覽器打開： http://localhost:${PORT}\n`);
    console.log(`  資料只存在本機 data/store.db（SQLite；舊 store.json 僅為搬家備份），按 Ctrl+C 可關閉。\n`);
  });
}
