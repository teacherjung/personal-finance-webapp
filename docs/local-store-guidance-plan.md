# LOCAL 資料位置及保存指引

追加的 docs/sync-index.md 與 test/vault-and-backup-integrity.test.js 亦已單獨 D5 核為專案自有；後者的原損毀題改核逐次私有診斷與公開指路，保留真 quick_check 故障及暫存清理斷言。

本支從已合併的 #711 開始，基底 5e4b2448b01434c71eb5f3819eb3df66bf5e68d3。2026-10-18 UTC 開工無參數 D1：374 支、2765 則留言，待裁 0；開著 PR 0。預選 17 路徑 D5 均屬專案自有。預約後依下列公開裁示施工，正式核收見 [#712](https://github.com/teacherjung/personal-finance-webapp/pull/712)。

## 已重現的問題

- 自訂 STORE_FILE 時，真 server 啟動橫幅及開庫錯誤仍寫預設 data/store.db。非 .db 名稱也誤稱固定舊 JSON 搬家檔。
- 正式 repo 開庫的原生 ENOTDIR 會透過 /api/db、銀行預覽 JSON 及 NDJSON error frame 暴露本機合成路徑。
- 真損毀檔會顯示先刪主檔／WAL／SHM、再改名唯一備份的舊指引。
- LOCAL 側欄仍寫預設位置；HTML 同時由 HOSTED 使用，不能直接改共享來源後宣稱只改本機。

## 實際技術裁示

GPT‑6.1 Sol／xhigh 的終端／開庫、側欄、HTTP 接線三份全文已核讀；不是 William 本人原話或正式放行。實際問答已在 #712 逐份公開配對，路由 finance-backlog-20261019。派生 HTML 的有限生命週期第四份補充亦已核讀：初始化失敗立即清理、exit 同步盡力清理，不接管信號／listen／close；異常退出的非敏感自身產物殘留明列限制。大小寫依每個實際本機／CI來源對照，不對異質掛載作未測保證。

- guidance：[配對](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256298195)、[完整答覆](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256298010)。
- sidebar：[配對](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256298643)、[完整答覆](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256298495)。
- routing：[配對](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256299147)、[完整答覆](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256298978)。
- lifecycle：[配對](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256299558)、[完整答覆](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256299425)。

## 施工邊界

1. store.js 沿模組載入時選定的 FILE 提供零 IO 定位資料：有效主檔、原樣後綴 -wal／-shm／.bak。保持未設定／空值 fallback、相對 cwd、空白、中文、URI 保留符號及非 .db 名稱；不 trim、補副檔名、展開家目錄或 realpath。
2. repo 新轉供維持 async；server await。只供 LOCAL 橫幅，絕不為印字開庫、讀帳本、驗備份或提供公開路徑 API。
3. 安全建立失敗、未證損毀、明確損毀的 Error.message 本身不帶路徑與低階 cause；原因及定位只印到本機診斷，以有界、引號及必要字元跳脫顯示。保留內部 cause 及分類，不把 cause／stack 序列化給 HTTP。
4. 損毀判準保持合法數值主碼 11／26 或當次 quick_check 明確壞結果。唯讀、IO、未知／缺碼／字串碼及 quick_check 例外／缺結果不指示還原；失敗仍 close、清空連線，第二入口重驗。
5. 還原指引只供人看：先停所有使用同資料檔的實例、確認候選備份存在；不明就保留並停止。原主檔及存在 WAL／SHM 成組另存、候選備份也另存，再從備份副本恢復主檔，原組不留在新有效檔名旁。重啟驗證失敗即保留求助。不新增自動還原／搬移／刪除／備份。
6. LOCAL 側欄只把唯一完整 foot-note 的 code 文字換成通用 SQLite 描述，其餘原始 HTML 位元組與 DOM 保持。派生 index 只進 LOCAL 單檔 static overlay；其他資產落原 public，HOSTED 不建立或掛此層。初始化失敗不得回舊指引假裝成功。
7. 靜態協定用現成 serve-static／send：既有等價 index 入口、GET／HEAD、當前表示的條件式快取、單一 bytes Range 206／416／If-Range 均保持。不得新增 SPA fallback、無條件 lowercase、通用回應改寫或套件修改。
8. 不改 schema 搬家衝突、每日備份、CAS、HOSTED 部署／修補、手機、禁區清單或任何交易能力。來源內相鄰過度現況註解僅限本題必要收窄。

## 正式考題與反例

- 已有權限題維持原生故障、兩次入口、內容／備份保存、close 次數與真正 SQLite 使用。損毀舊字句斷言改為正面驗證保存順序及公開／私有診斷分界，不能只刪斷言。
- 定位與真程序 banner：未設定、空值、絕對 .db、相對 cwd、非 .db，及有界／跳脫名稱；預設情況只讀定位，不開真實預設庫。確認所有量測僅在自有外置暫存資料下進行。
- 正式 repo 損毀及 ENOTDIR；實際 JSON／NDJSON 出口不含唯一合成路徑、編碼變體、原始原因或堆疊，私有診斷仍能定位。主檔／候選備份存在與缺席都不自動修復。
- 用 node:http 原始 path／headers、Buffer body 比較實際 HTML。根、index、query、編碼、雙斜線及原檔案系統接受的大小寫入口同一投影；原不存在／畸形／POST／尾斜線保持不命中。
- HEAD 無 body、長度／型別／validator 對應 GET；當前 ETag／Last-Modified 可 304，舊或不相符 validator 得當前內容。Range 切片跨過改字區域並以投影 Buffer 比對，另驗 416／If-Range 及非 index 資產 Range。
- HOSTED 只用既有離線 fake auth 驗原表示及身分牆保存，不連雲端。/api/mode 保持單一 hosted 布林，HTML 量測不建庫。
- 自有派生資產的初始化失敗、清理及重新啟動內容更新依最後窄裁落實；不把 SIGKILL 清場或所有掛載環境當成已證。
- 有效突變分別撤掉 banner 定位、錯後綴／相對錨點／非 .db、公開 message 注入路徑、恢復刪除指引、放鬆損毀判準或失敗連線沿用；HTML 撤線／漏別名／舊 Range／Range 200／舊 validator／HEAD body／污染其他資產或 HOSTED。每個替換先 assert，基準綠、預期斷言紅、還原綠。

## 交付及驗收

預期涉及 server、store、repo、LOCAL index helper、相關新／舊考題、責任路由與 MANIFEST、資料契約及 PROJECT。所有完整路徑先當場 D5；新增 helper／test 明確歸戶。公開計畫不含本機絕對路徑。

正常完整三關與 CI、K5 逐項處置、Grok 正式複審、完整最後回覆公開、F7、合併閘及主目錄乾淨快轉。依當版驗收分級重啟隔離本機服務，實際桌機側欄及核心流程；所有 ROUTES reload、server syntax／seed summary。推薦代選沿本人委任，不冒稱本人實看，不改真資料、不宣稱真備份還原成功。

## 施工檔案預選

預約路徑：server.js、lib/store.js、lib/repo.js、lib/local-index.js、test/store-guidance.test.js、test/local-index.test.js、test/helpers/store-guidance-case.js、test/helpers/local-index-case.js、test/store-file-permissions.test.js、test/helpers/store-permission-case.js、test/vault-and-backup-integrity.test.js、test/hosted-auth.test.js、docs/contracts/README.md、docs/contracts/data-storage.md、docs/contracts/frontend-features.md、docs/sync-index.md、test/contract-split.test.js、本文、PROJECT.md。新增 lib/local-index.js 與 test/local-index.test.js、test/helpers/local-index-case.js 歸前端功能；資料指引的 test/store-guidance.test.js、test/helpers/store-guidance-case.js 歸資料與儲存；同步 README 與 test/contract-split.test.js 的 MANIFEST。送審前依實際差異核實清單。

優先重用現有權限題的真故障分類、close 與內容保存，只加每次診斷輸出的觀察。新 HTTP 題沿已重現的 /api/db、/api/bank-statement/preview（JSON 與 NDJSON）真入口，不另造錯誤路由。原版靜態來源對照用獨立 Express 靜態服務和 Buffer，對照每個實際執行環境的大小寫及負例，不能拿 Mac 既有結果當 CI 答案。

## 實作核對（送審前）

相關定位、實際開庫、權限、保存及靜態協定考題 69 題通過；離線 HOSTED 原表示保存題另通過。31 個有效突變分兩批核實（23＋8），皆先確認目標唯一、基準綠、預期斷言紅、還原綠；未完成的準備、錯誤 readiness 入口、等待逾時、替換目標不存在及沒有斷言輸出的資產失敗不採計。資產比較改用 Buffer.equals 保持逐位元組核對，避免大量失敗差異的格式化拖垮驗證。兩批產品來源雜湊相同。

IAB 原生桌機 1280×720：側欄通用文字、導航、快照按鈕與無橫向溢出已核；實際按快照成功。依 app ROUTES 逐頁 reload 12 個入口，頁面完成載入且觀察期 console 警告／錯誤為零；stock 無代號只驗選股入口。全部使用獨立合成資料，專用程序、分頁、資料及突變副本已清理。此證據不涵蓋其他瀏覽器、手機版面、真帳本或真備份可用性。

[E10 推薦代選](https://github.com/teacherjung/personal-finance-webapp/pull/712#issuecomment-6256471800)依本人明確委任留痕，不冒稱本人實看。完整推送檢查、CI、正式 Grok 結論及合併後分級核收，以 #712 當版公開紀錄為準。
