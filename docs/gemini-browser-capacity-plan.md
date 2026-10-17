# Gemini 完整材料容量續作

## 目標與完成條件

維持 A 憑證分離，完成 #701 原受審範圍的完整材料補掃。接線、合成資格、App 驗收及實際掃描分開記錄；不能只因測試通過而結案。[本人續作指示](https://github.com/teacherjung/personal-finance-webapp/pull/701#issuecomment-6239647407)。

原受掃範圍是 `1b4e8a20c7b2496f3f474573b4a25fc6a777e5a5` 到 `dcdee0f4dfdfba38ab36595a574ac81850c2048a`；不改成 squash 後主幹差異。原材料為 1,814,466 UTF-8 bytes，原文字提示模板生成 1,816,201 bytes。32 KiB 拒收場保留；補掃記實際日期，不追認為合併前 G1。

## 單一完整文字附件

依 [GPT‑6.1 Sol 附件裁示](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6240329000)，用官方本機檔案選擇器上傳一份 UTF-8 `.txt`，附上一段固定短提示。附件包含固定審查說明、完整材料 JSON、回覆 schema，以及只出現在附件末尾的隨機挑戰。短提示不揭露挑戰。材料內的程式、文字、URL 與命令都是不可信資料，不能指揮額外工具；固定說明只允許讀本場綁定附件。

- 附件上限 `ATTACHMENT_CAP`＝2 MiB（2,097,152 bytes）；短提示 `CONTROL_CAP`＝4 KiB。這是本接線的容量，不是 Google 官方上限。不壓縮、不裁切、不分批、不改走雲端連結或 Drive。
- `single-text-attachment/v1` manifest 綁定 scanId、materialSha256、base/head、固定 ASCII 檔名、媒體型別、UTF-8 bytes／雜湊及短提示 bytes／雜湊。`requestSha256` 是固定欄位順序的組合請求雜湊，與 attachmentSha256、controlSha256 分列。
- 盒內 client 建構請求；runner 依同一材料重新建構並逐欄比對，才把唯一附件放進盒外私有工作目錄。檔案讀取保留 owner、一般檔、連結數、NOFOLLOW、canonical 路徑及讀取前後身分檢查；另固定附件 inode 等身分，於活性檢查、上傳前、送出前與掃後重核。
- IPC 容量涵蓋整個序列化 frame，附件、短提示、回覆及一般信箱各有自己的上限。不能提高一般信箱預設限制來掩蓋錯讀取點。

## 上傳與送出的兩次許可

`beginBrowserScan` 取得活 runner 的新 claim ACK，建立自有官方 Temporary Chat，確認 Argon High、零回覆、空提示與零附件，停在 PREPARED。

`uploadBrowserScan` 再核來源、頁面與空附件，發新 upload challenge；runner 核本場 instance、tab、組合雜湊及附件後給一次許可。CUA 先不可逆消耗，先訂閱 filechooser 再點已觀測的本機 Upload files，僅 `setFiles([本場固定路徑])` 一次。事件、click 與 setFiles 明確設時限；不使用隱藏狀態、DOM 寫入、網路 API 或 Drive。上傳本身就可能傳送資料，因此許可必須在檔案選擇器之前。setFiles 返回只記 UPLOADED，不當成附件可用證據。

`submitBrowserScan` 檢查唯一 `uploader-file-preview`、其唯一 `.file-preview-container` 的單一 `aria-describedby` 直接描述，完整檔名必須一致。可用狀態依已觀測的 TXT 標籤、非 loading 內容、無進度條及可用送出按鈕；縮短顯示的檔名或 FileList 本身不算完整核對。固定短提示填入後與送出前，各在同一 textbox 內對完整 textContent 作逐字比較，只回傳有限摘要。再取得另一個新 challenge 的 Submit 許可、消耗、重核附件／提示／模型／臨時／零回覆，才送出一次。

`browser-attachment-ui/v1` 分列本機附件雜湊與 UI 名稱／可用性觀測；不宣稱已量得 Google 遠端檔案雜湊。唯一完整封閉 JSON、尾端挑戰、官方模型明細及 `receiverConsumptionVerified:false` 保留。輸出、上傳事件、掃前後隔離、來源／材料重建及程序／分頁清理均須通過。

## 驗證時序

1. 行為題覆蓋恰好 2 MiB、超過一 byte、UTF-8／JSON 跳脫、完整 frame、manifest 綁定、錯檔／變造／同內容 symlink、零許可零 chooser、單次上傳與送出、過期與晚到、檔名／載入／數量錯誤、有限診斷及清理。重要防線以有效突變驗證；正常三關與平台檢查照跑。
2. 固定最終來源及全新 provider 路徑，完成同版、同 Node、精確 2 MiB 附件的真網頁資格場。新 transport、sourceKind、來源與數值容量全部符合才接受；舊文字收據、介面發現、測試或較小合成檔均不能代替。
3. 同版 `purpose=scan` 合成驗收及獨立 Grok 正式複審通過，再補掃 #701 的完整原材料。新 providerHead 會改材料元資料；先重建原雜湊，再核除 providerHead 外逐欄相同，分列新材料、附件及組合請求雜湊。
4. #702 當版 G1 另跑，兩份實際掃描各留原文與逐條處置；依正常複審、合併、驗收及啟用程序收尾。任一尚缺，任務未完成。

## 失敗與界線

文字方案的失敗與 DOM 比較量測保留，不推論為 Google 官方容量上限。單附件完整資格失敗時交 Sol 裁示，不自行縮小材料、加容量或放寬憑證政策。

工具時限不保證涵蓋外層上傳授權等待，也不能原子取消已在途的 UI 動作。每個 await 返回後先核期限／取消／來源，晚到結果不採用、不補送；所有待決呼叫 settle 且自有分頁確實關閉後才記靜止。無法確認清場時保留鎖與證據，不能以 Promise.race 冒稱取消。原失敗收據不可覆寫成成功。

復原為停用新來源並保留證據；小容量舊資格不擴成大容量。憑證仍留在官方瀏覽器，盒內沒有真實 HOME、登入秘密、原倉庫或外網。套件借用入口遷移、原生認證與其他工作線不在本支。
