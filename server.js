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
import { stockFundamentalsRoutes } from './lib/routes/stock-fundamentals.js';
import { installJsonBodyParsers, AUTH_JSON_LIMIT, STATEMENT_JSON_POST_ROUTES } from './lib/http-body.js';
import { installHeavyAdmission } from './lib/heavy-admission.js';
import { rateLimit, ipKeyOf } from './lib/rate-limit.js';
import { applyHostedTimeouts } from './lib/parse-limits.js';
import { currentTenant } from './lib/tenant.js';
import { isHosted, hostedConfig } from './lib/hosted.js';
import { authRoutes, csrfOriginGuard, authGate } from './lib/routes/auth.js';
import { isMainModule } from './lib/is-main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// export 供測試載入（B0）：測試 import { app } 後自行在隨機埠監聽，不會動到 4321
export const app = express();

/** 五分鐘——各道限速共用同一個窗口（好記、好解釋，也方便對外講「請等五分鐘」）。 */
const RL_WINDOW_MS = 5 * 60 * 1000;
/** 按帳號取鍵：掛在 `authGate` 之後所以一定有身分；退回 IP 只是防禦性寫法。 @param {any} req */
const tenantKeyOf = (req) => currentTenant()?.userId || ipKeyOf(req);

/**
 * **要跟 `RATE_LIMITS` 對帳的外連端點清單（單一真相）**——「這條端點會去打別人，所以它必須被限速」。
 *
 * ⚠️ **誠實劃界**：它**不是**「所有會外連的程式路徑」，只收**需要靠 `RATE_LIMITS` 節流的業務型外連**。
 * HOSTED 的**基礎設施型外連刻意不在表上**——**例如**（不是完整名單）`authGate` 每個受保護請求都做的
 * Supabase 驗簽（`lib/services/auth.js` 的 `currentSession` → `getUser()`）、`me`／`logout` 的輕量
 * session 操作、`lib/store-pg.js` 的 PostgREST 查詢與 `kv_save` RPC。**口徑的單一真相＝
 * `test/hosted-auth.test.js` 裡 `ROUTE_EXEMPT` 的檔內註解**，不在這裡重抄清單。
 * 這張表守的是**限速涵蓋率**。
 *
 * 為什麼要獨立成一張表（Codex 收官審查 #6，2026-07-28）：`RATE_LIMITS` 原本的註解寫著
 * 「IB 同步是全站唯一『我們去打別人』的端點」，同一個檔案往下 30 行就自己推翻了（報價也對外）；
 * 而 `/api/cape`、`/api/realyield`、`/api/insights` 三條同樣對外，**一條都不在表上**。
 * 實測後果：模擬上游失敗後連打 65 次 `/api/cape`，65 次全部真的出去、0 個 429。
 *
 * 病根不是「漏了三條」，是**沒有人負責維護「哪些端點會對外、而且需要限速」這件事**——
 * 註解不是清單，考題也只能從 `RATE_LIMITS` 反查（漏列的當然查不到）。
 * 所以改成：這張表列出**上游主機 → 端點**，考題拿它跟 `RATE_LIMITS` 對帳，
 * **少限一條就紅**。新增未登記的對外能力由 test/hosted-auth.test.js 的雙軌絆索攔
 *（已記錄邊界：已登記模組改打新主機＝主機級對帳另案；蓄意混淆＝code review 職責）。
 *
 * ⚠️ 新增**業務型**對外連線時：①在這裡登記 ②確認 `RATE_LIMITS` 涵蓋得到（前綴比對也算）。
 *    基礎設施型的外連照上方劃界與 `ROUTE_EXEMPT` 的口徑處理，這裡不另列項目。
 */
export const OUTBOUND_ENDPOINTS = [
  { host: 'ndcdyn.interactivebrokers.com', why: 'IBKR Flex Web Service（拉整份報表）', paths: ['/api/ib/sync'] },
  { host: 'query1.finance.yahoo.com', why: '報價', paths: ['/api/quotes', '/api/quotes/refresh-auto'] },
  { host: 'open.er-api.com + cdn.jsdelivr.net', why: '匯率備援（Yahoo 抓不到匯率時依序退；丙）', paths: ['/api/quotes', '/api/quotes/refresh-auto'] },
  { host: 'www.multpl.com', why: 'CAPE（席勒本益比）', paths: ['/api/cape'] },
  { host: 'fred.stlouisfed.org', why: '實質利率（FRED）', paths: ['/api/realyield'] },
  // 洞察引擎自己會呼叫 CAPE 與實質利率兩者，**而且會寫入資料庫**（更新書籤）。
  { host: 'www.multpl.com + fred.stlouisfed.org', why: '每日洞察（內部再呼叫上面兩者）', paths: ['/api/insights'] },
  { host: 'www.sec.gov + data.sec.gov', why: 'SEC 官方基本面（三份 JSON）', paths: ['/api/stock-fundamentals/:symbol/refresh'] },
  // r12：Supabase 一直是實際上游（HOSTED auth），補登記。me／logout 刻意不在 paths：
  // 輕量讀取不限速＝2026-07-28 既有裁決（見 AGENTS 速率限制列），只列有限速的三條登入類。
  { host: 'SUPABASE_URL（環境變數指定的 Supabase 主機）', why: 'Supabase Auth（HOSTED 登入／驗證；@supabase/ssr）', paths: ['/api/auth/login', '/api/auth/confirm', '/api/auth/set-password'] },
  // P1b-1：AI 解析路線（★3 拍板＝Anthropic）。兩條路徑＝既有銀行上傳端點（AI 是其中的 fallback 分支，
  // 需 useAi **AI 要求旗標**（確認窗僅 aiAskBeforeSend 開啟時出現、預設直接帶——舊名「同意旗標」棄用：那個名字誤示每次都問過）；HOSTED 停止線寫死）。⚠️ 限速誠實句（r1#4）：表上的「上傳解析類」只在 HOSTED
  // 掛載（mountRateLimit 在 isHosted 分支）、而 AI 又在 HOSTED 停用——**這張限速表不管 LOCAL 的 AI 路線**
  //（server.test 有「LOCAL 不掛表」考題）。LOCAL AI 的成本護欄＝**發數上限**（C1，William 2026-08-26：
  // 單張預設 6 發／單日預設 20 發、設定頁可調、超限那發不出門＋白話說明）——擋點在 lib/ai-transport.js
  // 的 transport 進入處（每一發先過 lib/ai-budget.js 的 take()），單日計數落 db（settings.aiUsage）。
  // 結構上每次上傳至多 **4 發**模型呼叫（P2-4 雙讀預設開＝preview 雙讀 2＋不一致仲裁 1＋apply 成功後配方生成 1；
  // 關雙讀＝單讀階梯至多 2＋生成 1＝至多 3 發）＝單張 6 是防未來重試迴圈的裕度，不是日常會撞到的數。
  // ⚠️ 這是**發數**上限不是金額上限（實際 NT$ 依 Anthropic 帳單；費用級距絆線在 ai-consent.js）。
  { host: 'api.anthropic.com', why: 'AI 解析帳單（lib/ai-transport.js；LOCAL 專用、確認窗僅 aiAskBeforeSend=true 時出現；成本邊界見上註）', paths: ['/api/bank-statement/preview', '/api/bank-statement/apply'] },
];

/**
 * **速率限制的路徑表（單一真相）**——`server.js` 依它掛載，考題依它反查。
 *
 * 為什麼要有這張表（2026-07-28）：`test/server.test.js` 的「LOCAL 不限速」反向考題本來是自己
 * 挑一條路徑打（挑到 `/api/transactions`，而那條**根本沒有掛限速**），於是就算有人把限速誤掛到
 * LOCAL，那一題照樣是綠的——典型的「補了抓不到病的假考題」。改成從這張表反查之後，
 * **每加一道限速，正反兩面的考題都自動跟著涵蓋**。
 *
 * `probe` ＝考題用的具體 URL（路徑表裡有 `:id` 這種樣板，不能直接打）。
 * 選 probe 的規矩：**必須是不會對外連線、不會寫壞資料的請求**——
 * `/api/ib/sync` 在沒有 flexToken 時 `fetchFlex` 一開頭就 throw（`lib/ib.js:205`），
 * `GET /api/quotes` 不帶 symbols 時 `getQuotes([])` 完全不發外部請求。
 */
export const RATE_LIMITS = [
  {
    // ⚠️ `stage: 'pre-gate'` ＝必須掛在 `authGate` **之前**（登入本來就還沒有身分），所以只能按 IP。
    name: '登入類（按 IP）', stage: 'pre-gate',
    paths: ['/api/auth/login', '/api/auth/confirm', '/api/auth/set-password'],
    probe: { method: 'POST', path: '/api/auth/login' },
    max: 20, keyOf: ipKeyOf,
    message: '嘗試次數過多，請稍等幾分鐘再試',
  },
  {
    name: '上傳解析類（按帳號）', stage: 'post-gate',
    paths: [...STATEMENT_JSON_POST_ROUTES, '/api/import'],
    probe: { method: 'POST', path: '/api/statement/preview' },
    max: 30, keyOf: tenantKeyOf,
    message: '上傳與解析的次數過多，請稍等幾分鐘再試（這是為了讓大家的服務都不會被拖慢）',
  },
  {
    // IB 同步會**對外連線**（Flex Web Service）並解析 XML。
    // 猛打它＝拿我們的伺服器去打 IBKR，可能害使用者的 Flex Query 被 IBKR 限流甚至停用。
    // 6 次／5 分鐘對正常使用綽綽有餘：入口只有兩個手動按鈕，而且兩處都會先 `btn.disabled = true`
    //（`public/modules/portfolio-remote-actions.js`、`public/modules/securities.js`），沒有自動排程。
    name: 'IB 同步（按帳號）', stage: 'post-gate',
    paths: ['/api/ib/sync'],
    probe: { method: 'POST', path: '/api/ib/sync' },
    max: 6, keyOf: tenantKeyOf,
    message: 'IB 同步太頻繁了，請稍等幾分鐘再試（同步一次會向 IBKR 拉整份報表，打太密可能被對方限流）',
  },
  {
    // 報價同樣會對外連線（Yahoo）。上限比 IB 寬很多——開一次 app 就會刷新一輪報價，是正常操作。
    // ⚠️ `app.use('/api/quotes', …)` 是**前綴比對**，所以 `POST /api/quotes/refresh-auto` 也一起涵蓋——
    //    那條同樣會打 Yahoo，本來就該一起限。
    name: '報價（按帳號）', stage: 'post-gate',
    paths: ['/api/quotes'],
    probe: { method: 'GET', path: '/api/quotes' },
    max: 60, keyOf: tenantKeyOf,
    message: '報價刷新太頻繁了，請稍等幾分鐘再試',
  },
  {
    // 官方基本面 refresh 會向 SEC 拉三份 JSON；GET 只讀快取、不限，正常開頁不消耗外部額度。
    name: 'SEC 官方基本面更新（按帳號）', stage: 'post-gate',
    paths: ['/api/stock-fundamentals/:symbol/refresh'],
    probe: { method: 'POST', path: '/api/stock-fundamentals/__proto__/refresh' },
    max: 12, keyOf: tenantKeyOf,
    message: '官方基本面更新太頻繁了，請稍等幾分鐘再試',
  },
  {
    // 估值訊號（CAPE／實質利率）與每日洞察：三條都會對外（multpl／FRED），
    // 而且**失敗時不入快取**（`lib/services/market-data.js` 只在成功時寫 cache），
    // 所以上游一掛，每一發請求都會真的出去＝穩定的 1:1 放大路徑（Codex 收官審查 #6 實測 65/65）。
    // 上限訂寬（開一次 app 會刷一輪、總覽頁也會叫 insights），但要有天花板。
    name: '估值訊號與洞察（按帳號）', stage: 'post-gate',
    paths: ['/api/cape', '/api/realyield', '/api/insights'],
    // ⚠️ probe 刻意用 `/api/cape/__probe` 而不是 `/api/cape`：三條路的 handler **都會對外連線**，
    //    而考題會把 probe 打 `max + 5` 次——直接打 `/api/cape` 等於每次 `npm test` 就對 multpl.com
    //    發 65 個請求。`app.use(路徑, …)` 是**前綴比對**，所以 `/api/cape/__probe` 一樣會經過
    //    這道限速（實測：中介層跑到、handler 沒跑到、最後落 404）。
    //    ＝在不打上游的前提下，考的仍然是「這道限速有沒有真的掛上去」。
    probe: { method: 'GET', path: '/api/cape/__probe' },
    max: 60, keyOf: tenantKeyOf,
    message: '估值資料刷新太頻繁了，請稍等幾分鐘再試',
  },
];

/**
 * 實際掛上去的限速中介層。**考題專用**（比照 `setSupabaseFactoryForTest` 的慣例）——
 * 正式路徑一行都不呼叫它，限速的重點就是不能被重置。
 *
 * 為什麼需要（2026-07-29）：`test/hosted-secrets.test.js` 有十幾題各自走 `/api/import`，
 * 而「上傳解析類」是**每帳號每 5 分鐘 30 次**，於是排在後面的題目拿到的是 **429 而不是它要考的東西**。
 * 那個失敗長得跟真 bug 一模一樣（實測連續踩到兩次），而且**每加一題就往前推一格**——
 * 是個會隨時間自己爆炸的地雷。所以給考題一個明確的重置點，別讓它們互相偷額度。
 * @type {any[]}
 */
export const MOUNTED_RATE_LIMITS = [];

/** 考題專用：把所有限速計數歸零（跨題之間互不偷額度）。 */
export function resetRateLimitsForTest() {
  for (const mw of MOUNTED_RATE_LIMITS) mw.limiter?.reset();
}

/** 依 `RATE_LIMITS` 掛上某一階段的所有限速（HOSTED 專用）。 @param {string} stage */
function mountRateLimit(stage) {
  for (const rl of RATE_LIMITS) {
    if (rl.stage !== stage) continue;
    const mw = rateLimit({
      windowMs: RL_WINDOW_MS, max: rl.max, keyOf: rl.keyOf, message: rl.message,
    });
    MOUNTED_RATE_LIMITS.push(mw);
    app.use(rl.paths, mw);
  }
}
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
  // 速率限制①：登入類端點按 **IP**（可用性第一層，2026-07-28）。Supabase Auth 自己也有速率限制，
  // 這一道是**保護我們的行程**——連續猛打登入會把 CPU 與事件圈吃光，牆後的正當使用者跟著遭殃。
  // 只限「會做事」的三條（login/confirm/set-password）；`me`／`logout` 是輕量讀取、限了只會擋到正常換頁。
  // ⚠️ 這一道**必須掛在 `authGate` 之前**（登入本來就還沒有身分），所以只能按 IP。
  //
  // ⚠️ **也必須掛在 JSON parser 之前**（Codex 收官審查 #5，2026-07-28 修）：
  //    body-parser 遇到畸形 JSON 會在自己內部 `next(err)`，Express 於是**直接跳到全域錯誤中介**，
  //    中間所有一般中介層——包含這道限速——整段被跳過。實測連送 25 個畸形 JSON：
  //    25 個 400、**0 個 429**，而上限明明是 20。超過 32KB 的 body（413）也走同一條縫。
  //    這道限速按 IP 取鍵、**根本不需要 body**，所以擺在 parser 前面沒有任何代價。
  //    （對照組：post-gate 那幾道本來就掛在 `installJsonBodyParsers` 之前，順序一直是對的。）
  mountRateLimit('pre-gate');
  // ⚠️ **身分牆之前只准解析登入用的小 body**：登入端點在牆的白名單裡、需要 body 才讀得到信箱密碼，
  // 所以給它一個 32KB 的專屬 parser——牆前的每一個位元組都是未驗證流量。
  app.use('/api/auth', express.json({ limit: AUTH_JSON_LIMIT }));
  app.use(authRoutes);                  // /api/auth/*（login/logout/me/confirm/set-password）
  app.use(authGate);                    // C3 gate（P1-1）：/finance＋全部 /api/*（白名單除外）
  // ⚠️ **大件 parser 一定要掛在 authGate 之後**：以前掛在最前面，等於「不管誰寄來的包裹都先拆開，
  // 拆完才到櫃台問這個人能不能進來」。實測 10 個**未登入**請求 × 45MB 就把行程 OOM 打死
  //（模擬 Render 512MB 容器）；搬到牆後之後同樣的攻擊全數 401、記憶體只多 8MB。
  // 速率限制裡 `stage:'post-gate'` 的那幾道：**按帳號**（掛在 gate 之後，所以一定有身分可用）。
  // 按帳號而不按 IP：同一個家庭／公司出口 IP 的兩個人不該互相排擠。
  // **哪幾道＝上面的 `RATE_LIMITS` 表**：道數與編號會隨表增減，這裡不重抄——重抄一份就會漂。
  // 幾個關於「為什麼要限」的重點：
  //   ・上傳解析類：解 PDF／XLSX／XML，全站最貴的 CPU 操作——**多人化才成立的攻擊面**
  //      （HOSTED 是多使用者、共用同一個行程，任一位使用者反覆丟大檔就能把解析成本吃光）。
  //   ・**會對外連線**的那幾道：猛打它們等於拿我們的伺服器去打上游服務。是哪幾道＝對照上面的
  //      `OUTBOUND_ENDPOINTS`（⚠️ 那張表登記的是「要跟限速對帳的外連端點」，不是所有會外連的
  //      程式路徑——劃界見它的檔頭註解）。
  mountRateLimit('post-gate');
  // ⚠️ **重型工作的入場管制必須夾在這兩行中間**（2026-08-02，Codex #350 r2 High／#371 r1）：
  //    在限速／authGate 之後（沒登入的人不該佔名額），在 body parser 之前（**還沒收 body
  //    就回絕**才擋得住記憶體堆積——行程隔離的佇列是等 body 收完才拿名額的，太晚）。
  //    範圍＝所有吃大 body 或做重解析的端點（HEAVY_ROUTES），不只 PDF：實測 /api/import
  //    的 50MB 還原可以在 PDF 名額占用中照樣通過。掛載順序有考題直接讀 app 的 router stack。
  installHeavyAdmission(app);
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
app.use(marketRoutes);      // /quotes /cape /realyield /insights（r15 搬入）
app.use(ibRoutes);          // /ib/sync
app.use(statementRoutes);   // /statement/* /cards/:id/statement/* /learned*
app.use(securitiesRoutes);  // /securities* 證券交易（S2：查詢/台新對帳單匯入/匯入紀錄）
app.use(stockFundamentalsRoutes); // /stock-fundamentals/:symbol（SEC 快取讀取／手動更新）

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
const isMain = isMainModule(import.meta.url);
if (isMain) {
  // P1-6（C0 契約）：HOSTED 聽 0.0.0.0（Render 的健康檢查與流量才進得來）；LOCAL 維持 127.0.0.1 不對外。
  const server = app.listen(PORT, isHosted() ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`\n  個人理財網頁已啟動 ✅`);
    console.log(`  請在瀏覽器打開： http://localhost:${PORT}\n`);
    // ⚠️ 這一行以前不分模式都說「資料只存在本機」——HOSTED 下那是假的（資料在 Supabase）。
    console.log(isHosted()
      ? `  模式：HOSTED（資料存在雲端資料庫），按 Ctrl+C 可關閉。\n`
      : `  資料只存在本機 data/store.db（SQLite；舊 store.json 僅為搬家備份），按 Ctrl+C 可關閉。\n`);
  });
  // slowloris 防線（2026-07-28）：只收緊 HOSTED——LOCAL 只聽 127.0.0.1、只有自己在用，
  // 收緊只會在「上傳大備份剛好硬碟很慢」時誤殺自己。詳見 lib/parse-limits.js 檔尾。
  if (isHosted()) {
    const t = applyHostedTimeouts(server);
    // ⚠️ **把實際套用的值印出來**（2026-07-28，Codex 收官審查 #8）。兩個理由：
    //    ① 除錯：上線後有人問「為什麼我的上傳在 4 分半被切斷」，log 裡直接看得到答案。
    //    ② 這是**唯一能從行程外面證明「接線真的接上了」的訊號**——舊考題只對一個假物件
    //       直接呼叫 helper，證明得了「helper 會賦值」，證明不了「server 有呼叫 helper」。
    //       把上面那行刪掉，考題照樣全綠（Codex 實測）。現在刪掉這行，考題會紅。
    console.log(`  連線逾時（HOSTED）：headers ${t.headersTimeout}ms／request ${t.requestTimeout}ms／keepAlive ${t.keepAliveTimeout}ms\n`);
  }
}
