# 訂閱表單的未操作欄位保存

本支 [#713](https://github.com/teacherjung/personal-finance-webapp/pull/713) 先以計畫預約，再套用產品、直接考題與契約；直接組、型別、lint、原生合成操作與有效突變已完成，正常完整三關、當版 CI 及正式複審仍待完成。基底為 #712 合併版。實際 Sol／xhigh 的[完整答覆](https://github.com/teacherjung/personal-finance-webapp/pull/713#issuecomment-6259440223)及[標準裁示](https://github.com/teacherjung/personal-finance-webapp/pull/713#issuecomment-6259440487)可核，並非本人實看或正式複審放行。

## 問題與範圍

既有原生 IAB 合成操作只改服務名稱後，原本 `card:''` 變成 `台新`，缺席的 `email` 變成 `Yahoo`。焦點正常回到 H1，不把它另列焦點缺陷。實際 GPT‑6.1 Sol／xhigh 裁為 F6③，採本表單限定修法；完整裁示已在本支公開配對。

產品只改 `public/modules/subscriptions.js` 的 `openSubForm`，讓 category、card、email 有真正 `value=''` 的可空選項。類別標籤為「未分類」，卡片與信箱為「未指定」。新增保留娛樂與 Gmail，卡片明確未指定。有卡、無卡都能新增；非空失效舊卡保留原值與失效提示。

編輯時以開窗顯示基準比較三欄最終值。缺席、null、空字串顯示空項，非空清單外值沿共用 helper 保留；信箱仍依 normEmail 顯示。最終值沒變就省略該 PUT key，讓原保存值保留；明確從非空改空送空字串。重試沿用開窗基準，新建 POST 不套省略，取消不寫入。

不改共用 `openForm`／`selectOptionsHtml`、匯出的分類與信箱常數、週期／狀態／日期／攤提、回焦或後端 schema。此保存只涵蓋列出的三欄，不宣稱整筆表單或並行編輯都有衝突保護。

## 檔案與同步

預計產品、直接考題與必要契約檔：

- `public/modules/subscriptions.js`
- `test/subscriptions-form-preservation.test.js`
- `test/helpers/subscriptions-form-case.js`
- `docs/contracts/frontend-features.md`
- `docs/contracts/README.md`
- `docs/sync-index.md`
- `test/contract-split.test.js`
- `docs/subscription-form-preservation-plan.md`
- `PROJECT.md`

契約新增「訂閱表單可空資訊與保存」同步點；路由與 manifest 登記直接考題及 helper。D5 依正式預約時的完整路徑重跑。含契約，正式風險依工具判最高級；不以幾行程式自行降級。

## 必要證據

| 操作 | 斷言與邊界 |
|---|---|
| 只改名稱 | 真列表編輯鈕開真表單，真 PUT 確認名稱更新，真 GET 核三欄值與 Object.hasOwn；缺席、null、空字串、正常、未知、空白字串各獨立起點。 |
| 信箱顯示投影 | 合成 Gmail／Yahoo／me.com 原字串未操作仍保留；未知 HTML 字元只作文字及 option 值。 |
| 新增 | 有卡／無卡兩種各走真 POST；娛樂與 Gmail 不被省略，卡片為空字串。 |
| 明確選值／清空 | 真 change 與儲存後請求含對應新值或空字串，GET 對得上。 |
| 切走再還原、取消 | 最終回開窗值省略；取消零訂閱寫入，回讀不變。 |
| 傳送失敗重試 | 第一次控制 503 不送進後端；同一窗改值重試，沿開窗基準，不把第一輪新值當基準。 |
| 保存對照 | 合法月繳、終身、即將停用的金額／狀態／日期／錨點及另一獨立列保持。 |

每題新建專屬 canonical 暫存根，父程序在啟動子程序前固定 STORE_FILE／TMPDIR；子程序僅以 repo 櫃檯種合成資料。正式 DOM、表單提交與 LOCAL HTTP CRUD 不替換；開機維護及歷史圖採有限明列替身，未知請求直接失敗。子程序在操作、斷言與必要清理完成後才排他寫本題私有報告；父題先核退出碼，再核檔案、版本、nonce、名稱及通過欄位，stdout／stderr 留作診斷。種資料以正式 GET 核精確訂閱 id 集合與卡片資料；父題待子程序結束後清自己的根，測試不是原生版面證據。

有效突變必先基準綠、assert 唯一替換目標、取得相應斷言紅並還原綠。依新增保護分別移除三個空選項、讓編輯空分類套新增預設、取消未變省略、誤省略明確空值、把省略套新 POST、失敗後重設基準。保存型突變保留真儲存與名稱變更，只強制將原空／缺／品牌原文改壞。準備失敗、連線錯誤或 timeout 不算有效紅。

正式施工後另以原生 IAB 的列表、表單選單與儲存核對空欄保存、明確選空、新增及焦點回 H1；全部頁面 reload 以 app.js ROUTES 當時內容為準。只用合成帳本，不碰真實訂閱、付款、綁卡或扣款。驗收依常設推薦代選，不寫成本人實看。

## 程序與停止線

開支前 D1、同檔／PR 上限與 D5、裁示公開配對；實作後差異、直接考題與有效突變、正常三關／CI、當版 Grok 正式全審、F7、官方合併與分級代驗。每輪失敗依本 goal 的實際 Sol 技術委任分流。Gemini／掃描、HOSTED 與手機工作線保持停止。

若另量到合法週期／日期被改、未分類漏算或其他真產品反例，先保留具體輸入／請求／回讀，交 Sol 窄裁；不把本次欄位保存擴成全站表單重寫。

## 本支已取得的施工證據

直接組 66 題全過；新增各題獨立的 18 種案例。原生 IAB 實測空值／缺席／null、品牌信箱原文保存、明確清空、新增與取消，五次真寫入回讀相符；全部 12 個 ROUTES 入口重整，當場 console warn/error 為空。個股僅驗未指定代號入口；其他瀏覽器、手機與真實帳本未驗。

隔離突變第二次先 18 題基準全綠，產品 11 項、卡片公開預期 4 項及私有收據 8 項故障均觸發相應斷言紅，各自還原綠；非 JSON stdout 正向案例與最後完整基準通過。來源雜湊已核對，依賴連結已移除。首次因副本缺正式版本檢查依賴而全敗、沒有 mutant 執行，另存原紀錄，不採計有效紅。

結果通道、卡片預期、lint 與隔離準備的失敗均經實際 Sol 分題裁同支修正；[準備裁示](https://github.com/teacherjung/personal-finance-webapp/pull/713#issuecomment-6259673369)、[PR 證據及失敗對帳](https://github.com/teacherjung/personal-finance-webapp/pull/713)、[推薦代選紀錄](https://github.com/teacherjung/personal-finance-webapp/pull/713#issuecomment-6259540728)可核。這些是實作者驗證，不能替代正式 Grok 複審或冒稱本人實看。
