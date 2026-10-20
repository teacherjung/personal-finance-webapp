# 本機銀行收支編輯保存

## 問題與範圍

另一客戶端確認更新摘要後，已開啟的銀行收支編輯窗只改備註，完整舊表單仍會把摘要蓋回初值。合成 LOCAL HTTP 核對以基底 `84379be265b715babd610ae9da52e22f358d6b0e` 重現：兩次 PUT 均成功，最終回讀顯示未修改欄位被覆寫。另兩場對照為同欄明確後寫、刪除後舊 PUT 回 404；不把它們另列缺陷。

依 [本人後台優先指示](https://github.com/teacherjung/personal-finance-webapp/pull/725#issuecomment-6285303047)，只承接這個已證資料保存問題；畫面調整與新功能隨使用需求再做，不繼續清空整份待辦。原探針只執行正式表單 callback 與 API，未跑 DOM／onMount；本支以真正表單補驗。原生瀏覽器停止線、手機、HOSTED、Gemini 與掃描停止安排保持。

[實際 GPT‑6.1 Sol／xhigh 技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/725#issuecomment-6286054768)。

## 修改預約

- `public/modules/cashflow.js`：開窗 primitive 基準與編輯 payload。
- `test/cashflow-edit-preservation.test.js`：隔離情境與結果核對。
- `test/helpers/cashflow-edit-case.js`：真表單、LOCAL HTTP 與合成庫。
- `docs/cashflow-edit-preservation-plan.md`：本計畫、考題索引及證據界線。
- `docs/contracts/frontend-features.md`：既有銀行收支編輯段補保存契約。
- `docs/contracts/income-expense.md`：既有文字編輯段補關聯。
- `AGENTS.md`：本人最新原話與來源。
- `PROJECT.md`：後台優先、其餘按使用需求承接。

內容風險採高、每輪全審。開案前 D1 無未決，D5 命中零共用檔，無開啟中的理財 PR。命中契約為前端功能、收支與雲端安全；另核對資料儲存與欄位所有權。只在既有契約段落補文，不增標題、責任路徑或索引；新測試索引放本計畫，不空改 README、MANIFEST 或同步清單。

## 保存語意

編輯基準於 onMount 完成選項初始化後同步取得，使用本窗實際字串及數字值；數字空字串為 null，其餘 Number(raw)。基準只含白名單 primitive，不借可變交易列，也不在 submit／重試更新。缺基準或欄位失效時保留表單與錯誤，不發 PUT。

date、account、amount、summary、remark 各自只送相對基準改變的值；主動清空仍送空字串。改過又回到相同值算未改，不宣稱辨認重選相同值的意圖。未改的舊文字後備、缺席欄位與自動預設不因改別欄而回填。

type／category／subcategory 為一組：任一改動完整送組，全未改整組省略；嚴格 true 的 applyAll 且有 bankKey 也強制送組，沿單次 PUT 完成學習與傳播。組內明確修改可能覆蓋另一客戶端的新組，同欄明確修改仍採既有後寫語意。applySameSummary／applySameRemark 各自須文字改變才送旗標與文字。不回填 note、帳單原文、bankRef、bankKey 或 dir。

POST 保留完整 payload。無變更編輯仍可走一次空 patch PUT。editRevision 拒收、寫入登記、只核本次送出文字的回音確認與錯誤保輸入維持。沒有新增 GET 合併、CAS、跨視窗同步框架或畫面設計。

## 驗證與交付

正式題每題全新 child、專屬合成 STORE_FILE。A 用 JSDOM 的真正 openForm／onMount／submit；B 由獨立 HTTP 客戶端寫入及回讀，不共享 A 的 editRevision。以真 PUT／POST 完成和回讀作見證，不把 fetch 替身當資料庫保存證據。啟動維護請求使用明示合成邊界，禁止外連，不讀真實帳本。

情境涵蓋獨立欄位、同欄後寫、刪除後 404、POST、明確清空、0／負數、數字正規化、後備與缺值、選項初始化、固定基準與重試、分類組及各類明確套用。既有銀行收支卷補核同 session 舊表單拒收、回音不符、取消與錯誤保輸入。

保存反控保留真正寫入，拿掉保護後只因最終資料不符而紅；分開記錄基準綠、指定紅、還原綠及來源雜湊。對應範圍包括帶回未改欄位、破壞固定基準、分類只送子欄、拿掉 applyAll 強制組，以及清空／POST。失敗原件與真退出狀態保留；不得以環境錯誤、缺模組或刪掉 submit 充當有效紅。

正常推送三關、同 HEAD CI、Grok 正式複審及 F7、官方合併閘與適用驗收完成後收尾。只宣稱這個入口的有限保存修正；不宣稱全部客戶端衝突、原生瀏覽器驗收或所有後台安全。

## 本輪實作證據（2026-10-20）

- 真正 DOM／onMount／LOCAL HTTP 的新卷於修正等待後 24 題通過；先前連同銀行收支重讀、雙帳本與文字規則卷 312 題通過。型別與 lint 的初次錯誤已修正，重跑均退出 0；正式推送仍跑完整三關。
- 以舊程式跑保存題時，B 摘要及 A 備註的寫入均完成，但最終摘要回舊值，保存斷言確實失敗。最早錯用帳戶型別的 fixture 在 HTTP 前即失敗，不算反控。
- 有效反控共 11 組：未改一般欄位、摘要、備註、可變列基準、拆開分類組、applyAll 漏送組、漏清空、漏 0、把空數字當 0、送出時重設基準與 POST 不完整。每組先綠、突變紅、還原綠，真退出為 0／1／0，紅點在真 PUT／POST 200 後的結果斷言。
- 可變列反控最早存活，追查為篩選重讀尚未完成而拿錯舊列引用；helper 每次篩選後等待，固定開窗列並核初值後再突變。保留原存活紀錄，修正後同一突變轉紅；未以重設基準的另一突變代替此證明。
- 反控後產品來源還原核對一致：cashflow 模組 SHA256 `31a1fada288d11088ee04422527730c4718c8c768040ccca4ef16eefd168c316`。新卷 SHA256 `7e3cc1bccf241c478db89b68e498acc4d304b2cdb19a697a2940007d2763d259`，helper SHA256 `404aa2769a075d6589b0177efd39b1789072b8d89a4f68722b4e7cf0057d43f6`。

- 全頁核對 v6 依當版 ROUTES 逐路起獨立行程，共 12 路均退出 0；每路核初始化與一次明確 router 重畫（序號 1→2）、有界穩定期、請求終態、非預期錯誤、主內容與載入失敗文字。外置探針先前漏等非阻塞請求、缺少估值隔離與 history 寫入登記的失敗原件保留，不能當產品缺陷或拼接成通過。
- 全頁核對的明示邊界：開機維護使用替身；精確 GET insights 回 error:true，精確 GET cape／realyield 回固定合成時間與 value:null／source:manual（協定標記，不是本人手填）。投資組合缺值提示已核；未知外連在 native dispatch 前拒絕，每路都有獨立拒絕正控制。Chart／canvas 只有介面替身，不驗版面、圖表或市場服務。訂閱精確 POST history 走真合成 LOCAL 庫，核初始訂閱及歷史皆空、送出 body／回應列，最後回讀由 RECORD_START 至上個月各一列、數字 0、無重複；不是唯讀載入。v5 亦通過，但缺上述部分觀測，v6 補齊後整批重驗，沒有覆寫原件。

上述結果只對相應版本與合成情境有效；完整程序結果及正式結論另在本支 PR 留痕，不把施工證據寫成合併或本人驗收。
