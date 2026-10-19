# 接縫考題的來源隔離修補計畫

## 問題與指定範圍

[#718 計畫版 CI](https://github.com/teacherjung/personal-finance-webapp/actions/runs/39285125124) 在 store-guidance 遞迴複製來源時遇到瞬時目錄不存在。`test/pdf-isolate.test.js` 的接縫架構題會在共用 lib／public 內建立、寫入及刪除探針，來源支持兩者交錯的風險；尚未控制重現原生中止，沒有唯一根因證明。

依 [Sol 範圍裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6273414290)，本支只動：

- `test/pdf-isolate.test.js`：指定接縫架構題改用真正 ESLint 的 `lintText`，保留 lib／public 虛擬路徑、正式設定、原反例，補正常正控及操作期間的有限寫入觀察。
- `docs/test-source-isolation-plan.md`：本施工計畫與證據界線。
- `PROJECT.md`：來源隔離項目的階段對帳，並依 [#718 r1 訊息待辦裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6275029271)歸入共同待辦；本支不改生命週期斷言。

本支不改複製來源的 consumer、正式 PDF 隔離、接縫規則、依賴或 workflow。這是測試來源隔離維護，不恢復 HOSTED 產品施工。內容風險依上述裁示上調高、每輪全審；沒有新增 A5 本人點頭事項。

## 實作與驗證

1. ESLint 明確使用 ROOT 與正式設定，fix／cache 關閉。每份文字須未忽略、對應虛擬路徑、單份結果、無解析 fatal 或 warning；拒收只認 `no-restricted-syntax`、severity 2 與指定接縫識別。其他錯誤不能代替接縫命中，但反例不要求「只有接縫錯誤」：既有換行樣本亦符合 `no-unexpected-multiline`。正常文字須 errorCount=0 且無接縫命中。
2. 觀察該題舊 producer 的 `mkdtempSync`／`writeFileSync` 字串目的地，以本題私有暫存根中的真建立及寫入作正控；操作期間不得寫入共用 lib／public。finally 還原 mock 及 builtin ESM exports，只清本題私有根。此觀察不涵蓋其他 API、非字串路徑或其他程序，不宣稱通用檔案監控。
3. 新增或修改的失敗訊息提供核對落點及 `node --test test/pdf-isolate.test.js`。其餘既有考題保持。
4. 正式套入後跑整份 PDF 隔離考題、相關 consumer 考題、lint、型別及完整正常推送檢查，再查當版 CI，交獨立 Grok 正式全審。正式驗收級別由工具實算，不把測試維護當作實機驗收。
5. 保存型反控保留真 lint 操作，恢復共用來源寫入時須由寫入觀察斷言紅；修法生效型反控分別縮去 public 規則範圍、移除換行樣本的接縫選擇器，須由指定接縫斷言紅。基線及還原須綠，設定每次由新程序載入。

## 開案與復原

#718 已完成正式複審、合併及收樹。本支以本計畫作唯一 D3 預告提交，正常推送並建立完整三路徑草稿；回讀預約後才套測試與 PROJECT 修改。開案重核 D1、D5 及完整路徑路由；`test/pdf-isolate.test.js` 命中雲端與安全契約，其餘兩路徑未列入領域責任清單，共用底層仍必讀。

復原方式為回復本支合併提交；沒有資料遷移。只核收指定 producer 的共用寫入，不宣稱結清所有來源複製風險。掃描仍未恢復，正式複審與掃描分開計。

## 開案前證據與限制

樹外候選以 #718 受審版 `577f548b14c7370549954637659100a093edf8e4` 的真實 git archive 為基底，沒有假 `.git`。訊息補正前候選 SHA-256 `f15987be849635d0e1d5ba65980ee262398c5c17c188edd2383074a7791ce44b` 的指定題與 lint 通過；上述三組突變各為基線0／指定斷言1／還原0。

K3 訊息補正後候選 SHA-256 `b9aaf100d4b170ecf2946b23db5e7c2698c3fb67b505a8b5ee2279568179a394`，逐項反轉訊息後全文回到舊 hash，斷言邏輯未變。新 hash 的指定架構題、lint、型別通過；型別依正式 jsconfig 射程，不宣稱直接型別化這份測試。依賴失敗訊息辨認紅因的共用寫入突變以新證據重驗0／1／0；其餘舊突變不冒稱新版本重跑。這些是開案前有限證據，不代替正式版本整檔、三關、CI 或複審。

首次候選因總錯誤數相等而誤拒收，依 [Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6273056535)改正。首次失敗日誌曾被後續成功覆寫，依[保存裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6273057882)保留更正，不以舊路徑當失敗原件、未記時間列未知。首次突變短錨點命中四處，由前置斷言擋住、未修改來源；依[定位裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6273058847)改用唯一完整錨點後，才取得有效突變。舊失敗與有效證據分開保存。
