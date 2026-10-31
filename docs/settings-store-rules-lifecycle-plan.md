# 店名規則預覽與保存生命週期

## 範圍

承接有限 GS-F04，限設定頁的店名規則入口、編輯窗、影響預覽、保存及必要設定頁重讀接縫。Codex 實作、官方 Grok 正式複審；掃描暫停。計畫先於產品施工建立，草稿 PR 公開指定 GPT-6.1 Sol／xhigh 的原題與逐字答覆、核 D1 配對後才實作，不以本計畫表示驗證完成。

預計修改本計畫、`public/modules/settings-store-rules.js`、`public/modules/settings.js`、`docs/contracts/frontend-features.md`、`test/settings-store-rules-lifecycle.test.js`、`test/helpers/settings-store-rules-lifecycle-case.js`。D5 核對均為專案自有，不改共用 API、彈窗框架、後端或端點。

驗證前置另涉及專案自有 `test/modal-ownership.test.js`：依 [原題](https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6443331578) 與 [Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6443364611)，移除綁死產品回呼識別字的形狀斷言，保留共用 helper 的名稱行為題；由正式預覽 DOM 的返回名稱斷言及移除名稱的有效突變驗證接線。失敗紀錄保留，不更改檢查門檻。

管理意圖的突變考題依 [原題](https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6444489974) 與 [Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6444522787) 使用完成旗標：等待原操作完成或多餘請求出現，先驗請求數才等待操作。保留 finally 屏障釋放及事件收尾，避免錯誤追加的保存被測試自身扣住而只得到逾時。原逾時拒收紀錄不追認為有效紅。

## 流程與保護

- 店名規則入口接既有 `bindManagerEntry` 與共享管理意圖，以既有 GET `/statement/rules` 取編輯資料。初載快取只能作卡片計數，不能在新讀取失敗時充當編輯備援。
- 編輯與預覽各自持有原 root、dialog、完整 hash、導覽世代、管理意圖及開窗後的唯讀觀察資格。背景重畫不撤銷有效編輯窗，整頁成功重讀另核呈現、讀取代次與未存輸入。
- 預覽與保存共用在途鎖；首個 await 前由原 dialog 固定正式 payload 與含半填列的返回草稿。等待時文字 readonly 可選取，選項及結構動作停用，取消、×、Esc 保留。
- 預檢晚回失格不得 confirm 或追加保存，原生確認前後皆核資格。有效的預覽失敗、沒有變化、確認取消及 needsConfirmation 恢復操作；過期結果不操作新窗。
- 實際保存 rejection 不推定未寫入，保留鎖與原草稿，要求關閉重開 GET 核對，不自動重送或 GET。共用 API 無可靠 HTTP status，400 同樣重開是明列退讓。
- 正常成功才關有效原窗、通知，關窗後重新觀察並依設定頁資格重讀。GET 失敗獨立處理，不冒稱保存失敗或重開 POST。
- 預覽使用自身資格返回固定半填草稿，不 GET；跨頁或較新意圖失格時，返回、×、Esc 只可關自己的窗，不復活編輯窗或清新窗。

## 不變量與退讓

五種規則、trim、半填列處理、真實總數、原確認文案及判準、正常外觀維持。未知草稿不自動帶入新窗，可先選取保留；GET 只是當時快照，不證明原請求已停止。不提供跨分頁、外部寫入或預檢與保存的原子一致性。設定頁有新輸入或新呈現時可能延後卡片計數更新。逐列改名、孤兒清理、體檢及信用卡批次另支。

## 驗證計畫

先以獨立合成 LOCAL HTTP 與真 DOM 證明原版失敗；不接真帳本或外連 AI。入口驗新 GET、同／跨管理器交錯、最新失敗、舊按鈕與背景重畫。編輯驗五規則精確 payload、半填草稿、模式、結構重畫、特殊字元、readonly 選取、重複預覽／保存及交錯。

預檢驗失敗、無變化、取消、不可逆分類及自訂名影響、超過明細上限的真總數、確認前後失格零追加保存。晚回驗關窗重開、他窗、後開又關、換頁返回、完整 hash、root 替換、新意圖等待及失敗；成功及錯誤都不得碰新窗。

未知保存分已寫、未寫與真 400，核零自動 GET／重送、草稿持續鎖定可選取、重開確實 GET、讀取失敗可再次開啟。成功重讀驗 dirty、背景重畫、較新讀取、新窗、導航與 GET 失敗分流。預覽返回驗按鈕／×／Esc、有半填列且不 GET、失格只關自己與舊回呼不能清新窗。

有效突變先基線綠，移除各保護後對應行為題必紅；保存型保留受測操作，只破壞保存機制。區分預覽 POST 與保存 POST，不以語法、逾時或工具失敗冒充有效紅。原生以專用合成資料驗實際 ROUTES 及關鍵流程、可選取草稿與有效突變。保留既有規則、安全、分類／內轉保存與管理入口回歸；完整三關、CI、Grok 正式複審、獨立對帳、正式合併及工具驗收各自留證據。

主網站、私人資料、憑證、依賴與暫停工作線不動；不擴全庫掃描、手機、雲端、外觀設計或新服務，不冒稱本人實看與主網站同步。
