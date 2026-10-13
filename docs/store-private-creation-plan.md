# 本機主檔私有建立施工計畫

依交接原第 9 項續作；新快照的權限已由 #681 處理。新資料目錄及主資料庫在寫入財務內容前即以私有權限建立；缺檔或搶先建立不得悄悄走預設權限補建。

## 已核範圍

GPT-6.1 Sol（極高）代裁：#679／6129508468（新目錄 0700、新主檔排他預留 0600、既有目錄不在啟動時批改），#679／6134846213（一次性元資料描述符方法及界線），#679／6137799060（Node 支援範圍 `^22.23.1 || >=24.0.0`，排除 Node 23、必要最小啟動檢查配套）。代裁與本人原話分開，不寫成 William 親自核定這些技術細節。

## 程式與契約

- lib/store.js：新目錄 recursive 0700；新主檔 SQLite 前以 wx／0600 排他建立並關閉。pathToFileURL 正確編碼 URI，加 mode=rw 避免預留後移走而自行補建；既有模式不 chmod。只有 SQLite 主碼11／26或當次quick_check明確壞結果沿用還原指引，其餘開庫錯誤要求保留原檔及備份。檔案建立與SQLite前重用既有Node支援函式。
- package.json、package-lock.json 的專案根 engines；scripts/check-node-version.js、test/runtime-version.test.js、README.md、docs/project-overview.md：只支援上述範圍，仍以 package 為正本，既有釘版與依賴自己的 engines 不變。
- test/store-file-permissions.test.js、test/helpers/store-permission-case.js：隔離 SQLite、合成資料、正式 repo getDb/saveDb 入口；新責任在 docs/contracts/README.md、test/contract-split.test.js 的資料與儲存集合同步登記。
- docs/contracts/data-storage.md：補新主檔與 WAL／SHM 的已驗射程，保留快照及真實／歷史界線。PROJECT.md：第九項狀況、#687 掃描待辦與本人已確認的理財範圍／F11 後備引用；不加塞其他待辦修法。

## 驗證

1. umask=0 的隔離子行程，真正 open fd／fstat／close 與首個 SQLite SQL 時點；新各層目錄700、主檔600且預留為空；本題新內容經櫃檯寫入與重開讀回。既有目錄及主檔模式保持。一般與包含空白中文#?%:的檔名走同一櫃檯。
2. 原生 WAL／SHM 在開庫寫入後實際存在，關閉後實際消失，重開再次寫入後實際重建；分別觀測600與既有644主檔的生命週期，不把準備 probe 當永久考題。
3. mkdir／wx／close 回報失敗、競爭者 EEXIST、新預留後移除、既有確認後移除：核注入命中，兩次嘗試不沿用失敗快取、不補建、不損失合成競爭者或舊備份 bytes。close故障控制只模擬呼叫報錯，不宣稱窮舉作業系統關閉錯誤。
4. 版本函式及真正 CLI 啟動入口注入22.23.0、22.23.1、23、24、26；不把注入版本題說成該版本SQLite實跑。正式CI既有22.23.1與26才提供實際版本證據。
5. 每一道獨立拿掉 mode700、mode600、wx排他、URI mode=rw、Node23拒絕／啟動檢查等，assert替換存在、指定考題紅，各自還原綠；原損毀與快照題保持。後端檢查及seed buildSummary、本機三關、最新CI、K5、自審。

## 掃後補正範圍

依[#688技術代裁](https://github.com/teacherjung/personal-finance-webapp/pull/688#issuecomment-6140572669)，健康唯讀主檔與不可寫父目錄以原生SQLite各驗連續呼叫中止、連線關閉、主檔與備份完整。注入SQL錯誤主碼／延伸碼、缺碼、非數值碼，及quick_check壞結果／例外／缺結果作分類對照；例外文字不能冒充查詢結果。版本注入走正式櫃檯，拒絕時不得先建檔或執行SQL，支援版本則須實際讀寫合成資料；這仍不是舊runtime相容性證明。責任集合同步登記既有checker，不改is-main存量清單。本支唯一掃描原文照留，不重掃，補正送Opus下一輪全審。

## 真資料與歷史

一次性現存元資料收緊在倉庫外另留私有精確清單及舊mode。只准已核owner/type/dev/ino／regular nlink／全路徑nofollow的event descriptor fstat/fchmod/close；不讀內容／算內容hash／開SQLite／改owner／碰seed，不以pathchmod回退。方法已測合成案例，但正式操作前仍須刷新清單及核故障journal。

這一支不承諾排除所有替換窗口、同使用者程序隔離或加密；現存權限、主檔新建及9/23歷史鑰匙掃描證據分開報，後者缺原始證據仍未核實。原#681本人C驗收尚未回報。雲端與手機暫停；Claude其他施工樹不動。

## 程序與復原

版本檢查器的契約抽取配套依[#688精確路徑裁示](https://github.com/teacherjung/personal-finance-webapp/pull/688#issuecomment-6140786178)：只新增 scripts/check-node-version.js 的辨識，不涵蓋整個scripts目錄；合法宣告、內文引用、欠登記及非法形狀皆受測。

獨立暫存施工區；先提交本計畫、推送三關、建立草稿並宣告所有路徑後才改程式。高風險每輪由Claude Opus最高推理且不開自動模式全審，額度用完按本人確認及F11改Fable並回報。第一次正式通過後唯一掃描、公開G3、Claude G4、最新CI、五閘合併、分級驗收及收自有樹。程式復原為revert本支squash；不回復真資料內容，私有權限元資料另有舊mode紀錄。
