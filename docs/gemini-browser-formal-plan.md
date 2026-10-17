# Gemini 網頁正式掃描接線計畫

## 目的與已核前提

沿用既有 Google 帳號與官方 Gemini 網頁，在 A 憑證分離政策下接好材料制掃描。原生準備 #693 已合併，原生 B 認證例外未獲批准，不能由本計畫開啟。網頁單次合成試驗已收到完整回覆，官方明細顯示 4 Argon／High；這只證明該次網頁回覆及 UI 來源，不能追認為 G1 或 G2。[合成試驗與界線](https://github.com/teacherjung/personal-finance-webapp/pull/693#issuecomment-6232947536)。

本計畫依 2026-10-17 [GPT‑6.1 Sol 技術方案](https://github.com/teacherjung/personal-finance-webapp/pull/701#issuecomment-6233045497)施工；技術操作化與 William 的 A 政策分開記錄。公開 Search 本身不違反 A；私人 Skills、Connected Apps、Task、本機操作與模型指揮瀏覽器均不在掃描通道內。不新增權限、不擷取 cookies、tokens、Keychain 登入秘密或既有私人對話，不修改全域帳號設定。既有標準 canary 的 Keychain 服務控制只核外部命令是否能列 metadata，輸出經本機判準收斂成成功／失敗；不輸出項目、不解密密碼。

## 架構與 G2 界線

1. **盒內 client** 持有整輪「材料→唯一請求→唯一回覆→findings」狀態機。材料與模型回覆只當資料，不執行程式、命令、連結或回覆提供的路徑。它沒有真實 HOME、登入憑證、原倉庫或可用外網。
2. **盒外 runner** 持有來源釘值、掃前檢查、一次性工作憑據、時限、輸出上限與整場生命週期。只有它啟動盒內 client，且必須存活至掃後檢查與清理完成。失敗不能留下可重用的發稿工作。
3. **固定 CUA 傳輸器** 在受支援的 CUA 工具環境執行。它只有有效且仍存活的工作憑據才能碰 UI；固定開新的官方 Temporary Chat，核模型／推理、空白狀態，原樣填入盒內 client 的完整請求，送出一次，再原樣保存唯一完整回覆及官方明細。模型不能提供動作、選擇器、URL 或檔案路徑。
4. CUA 沒有可假定的 Node 直接入口，所以先交付受控操作式流程：操作者啟動 runner，再執行經審查的固定 CUA 步驟，最後由仍在執行的 runner 收件、驗證與結束。操作者不另向 Gemini 發稿、不剪貼挑選答案、不照回覆臨場安排操作；不宣稱無人值守。

這不是把解析器放進盒子就稱整條隔離。G2 的完整證據須包括盒內整輪控制、盒外傳輸權限界線、來源／工作憑據與掃前後實測。UI 的 tab handle 與單回合觀測不是平台簽章；沒有平台 chat/turn id 就不偽造。

## 契約與失敗處理

- 材料只取已提交的 base/head 完整差異及變更檔案前後內容，沿用既有建構器的路徑、文字與大小拒收。網頁另設較小的整份請求上限，超量拒收，不切片或截斷。
- `browser-ui/v1` 保存自有 tab、初始零回覆、精確一次送出、唯一新增回覆、完整提示雜湊、原文雜湊、隨機 scanId／尾端挑戰與同一回覆官方模型明細。使用獨立網頁來源型別，不冒稱 CLI structured_output／finish。
- 完整原文必須是唯一封閉 JSON；重複鍵、額外內容、畸形編碼、過限、來源或版本不合、未知／降級模型、缺明細、再生、修補、逾時與多回覆都拒收。尾端挑戰只證明尾端值可見，不聲稱模型完整理解材料。
- 精確結果與來源驗證、隔離、掃前／掃後及 G1 時序分開記帳。合成夾具、呼叫參數或模型自稱不能升格為正式收據。未完成正式資格的場次只記驗證，不計 PR 掃描。
- 掃後檢查完整輸出、檔名及假機密；疑似破口留去敏證據並停用、通報。只清理本場盒子與自建分頁，不終止共用瀏覽器或登出帳號。

## 檔案與分工

- `scripts/gemini-browser-{protocol,client,runner,cua}.js`
- `scripts/gemini-browser-files.js`、`test/helpers/gemini-browser-fixture.js`
- `scripts/gemini-browser-sandbox.sb`、`scripts/gemini-browser-canary.js`
- `scripts/grok-sandbox-canary.js` 僅修正 profile 參數的呼叫端說明
- `test/gemini-browser-{protocol,flow,cua,canary}.test.js`
- `test/gemini-native-runner.test.js` 補 GN-02 的直接準備入口題；GN-01／GN-03 原生觸發待辦維持停放
- `scripts/gemini-native-protocol.js` 僅令純協定載入不要求宿主提供 process；普通 Node 的直接入口拒絕保留
- 本文件、`docs/project-collaboration.md`
- 必要的專案設定 `settings.json`、產物 `PROJECT-SETTINGS.md`、專案守表題 `test/acceptance-table.test.js`

開工 D5 查以上完整路徑，均為專案自有檔。共用套件檔不修改；若實際遇到套件設定契約阻擋，依 D5 先改套件再同步。`PROJECT.md` 由 #700 預約，本支先避開；共同待辦於不衝突時補入，最遲階段收官前完成。使用本線獨立施工樹，不動別線常設工作樹與 #693 固定樹。

## 固定交接與操作

工作檔放在 runner 的固定私有根，每場隨機識別值、獨立 lease 與不可覆寫事件；盒內程序讀寫不到它。任何 UI 前，adapter 先發新 challenge，活 runner 回相同 challenge 才能建頁；送出前再發另一個 challenge，runner 先不可逆核准、adapter 先標記消耗，才呼叫一次 Submit。心跳或 PID 不單獨當身分證明。同 UID 可信操作者可改整個檔案域，不在此身份隔離保證內。

受控操作依序由釘住的盒外 wrapper 呼叫 `runBrowserScan`，取得工作識別值後，在既有 CUA REPL 載入同一提供者的固定模組，呼叫 `beginBrowserScan(browser, runId)`；等待後呼叫 `captureBrowserScan(runId)`。回傳 PENDING 時可以再次觀測，同一工作不能再次 begin／Submit。取消呼叫 `cancelBrowserScan(runId)`；它只作用於本場持有的 tab。沒有 Node 私接 CUA、CDP 或帳號 token 的後門。這是有操作者的固定程序，不是無人值守服務。

部署採單向信任：操作者獨立保存的預期 launcher／Node 指紋 → 固定 launcher → 固定資料設定 → 提供者、Node 與提示。每次啟動先由外部核對根指紋，再以絕對路徑執行；launcher 在匯入提供者之前只用 Node 內建模組核設定及完整執行來源集合。設定不反嵌自己的 hash 或 launcher hash；runner 的來源 pins 由已核 launcher 在記憶體組成。自算 launcher 指紋只用於前後漂移檢查，不是載入映像證明。首次資格不引用自己尚未產生的收據；正式部署另釘資格收據與同一受測核心，核心或 provider head 改變就重取資格。

CUA loader 與獨立 launcher 共用內建模組的檔案核對核心，分開主機角色。先固定設定，再產出 loader，最後讓 launcher 固定 loader 指紋並列入前後 pins。CUA REPL 也須先在外部用內建模組核 loader 的預期值，才可載入；loader 再核設定與來源後才載入 adapter。CUA host 不套用 worker 的 argv／執行檔判準，兩個環境分別留痕。ESM 可能快取已載入模組，換版須用全新固定提供者路徑及新 loader；只改頂層 query 或只清變數不能保證依賴一起換版。

CUA 不取得、代理或探測 process；檔案擁有者用固定 loader 內釘住的 UID 期望，不能宣稱驗過宿主 effective UID。沒有活 runner 回應的新 challenge 就不能建頁或取得送出許可；PID 僅留來源資訊，不代替活性證據。一般 Node runner 的程序管理留在原宿主。

請求使用單行固定文字＋JSON，避免網頁編輯器把多行轉成段落而難以逐字核對。初始整份上限為 32 KiB；資格場必須完整填入、送出並通過同上限的全鏈，才准登記正式場。超過上限的 PR 整份拒收，不能把這個能力說成不限大小。模型必須回完整封閉 JSON，包 Markdown 或加前後文也會失敗，不人工修復。

掃描停止立即使結果不可採用。檔案握手不能原子撤回已在途的瀏覽器動作，最多容許已核准的一次送出嘗試；不重試、不追認晚到結果。未確認 CUA 呼叫結束及自有分頁關閉，不能解開下一掃的鎖。清理分別記程序群組、最佳努力離群掃蕩、盒子與 CUA 靜止，不宣稱關頁取消 Google 遠端計算。

## 實作、驗證與啟用順序

1. 草稿登記高風險及完整預計檔案；先完成上述契約與固定操作配方，再做整輪接線。
2. 行為題覆蓋成功整輪、無工作憑據零 UI 動作、過期／重用／跨場拒收、材料與原文一 byte 改動、模型明細缺失、再生／多回覆／逾時、中斷收尾與輸出上限。每個重要防線用有效來源突變證明題目會紅。
3. 真 OS 盒用假機密做每個登記禁區的讀／列名／寫入反控與正面控制；補無網路、無登入資料、有限環境、掃後輸出及資源清理驗證。不能用會碰真實券商工具的測試。
4. 用固定候選版做一場不含真實資料的整輪資格驗證。完整保存請求、回覆及 UI 收據，證明固定配方沒有照模型內容追加動作。普通成功回覆不代替隔離驗收。
5. 跑三關、有效突變與 Grok 獨立複審；第一次通過後按 G1／G3 如實處理本支掃描資格，不把自己的驗證當自己的正式複審或追認舊合成場。
6. 固定盒外發射器、本機部署定位及來源；綁定 scanner 設定後重驗，資格齊全才啟用。發射者／模型／推理登記須與實際能力相符，舊 Grok 複審通道仍獨立可用。

## 風險、回復與驗收

最糟風險是未可信的材料或回覆讓盒外傳輸器讀到未授權資料，或把缺來源證據的結果當成正式掃描。以固定資料通道、每場一次性工作憑據、拒收未知狀態、隔離正反控制與獨立複審限制。回復為停用本網頁發射器、撤回本支設定／程式，保留原始失敗證據；不登入、不刪歷史、不更改憑證政策。

驗收時在本線提供的入口執行合成資格場，看到完整模型明細、材料與回覆核對、掃前後檢查及資源清理全部通過。再核正式登記的同一版本；欠任何一項就清楚顯示未啟用。需要本人操作時只列當時缺少的具體一步，不要求重做已完成的帳號確認或模型選單協助。
