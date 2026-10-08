# 既有帳單格式回歸基準

本基準以全合成輸入與手寫答案，記錄既有本機解析行為；不代表銀行歷年版型都已驗證，也不增加支援銀行。新銀行試點另案決定。

## 信用卡代表格式

資料與答案在 [card-formats.json](../test/fixtures/statements/card-formats.json)，執行入口在 [statement-format-baseline.test.js](../test/statement-format-baseline.test.js)。每例的 `source` 說明參照哪一段既有程式或考題；人名、帳號、交易與密碼均不取自真實帳單。商店與銀行字樣中，只有識別格式所需或既有公開考題已使用的字樣沿用。

| 案例 ID | 輸入欄位與案例重點 | 答案中的原始明細來源（列號從 1 起算） |
|---|---|---|
| fubon-mail | 消費日／說明／入帳日／台幣金額；跨年、退款、繳款、摘要四格 | 第 8、9、10 列 |
| fubon-web | 日期／入帳日／TWD／台幣金額，下一列說明；同日同額兩筆、店名數字、外幣附註及頁尾 | 第 5＋6、7＋8、9 列 |
| taishin-mail | 消費日／入帳日／說明／台幣金額／外幣碼／原幣額；服務費、退款、截止日跨月 | 第 6、7、8 列 |
| taishin-reprint | 七碼民國日期；說明在前一列，全形字、跨年 | 第 5＋6、7＋8 列 |
| taishin-xlsx | 消費日第 1 欄、入帳日第 2 欄、說明第 3 欄、台幣額第 5 欄、外幣附註第 8 欄；小數與結帳日優先 | 第 6、7、8 列 |

每例比對交易陣列整體，包含順序、重複筆數、消費日、入帳日、說明、正負金額、繳款與退款標記；另比對機構、證據種類、末四碼、帳單月份、應繳與摘要四格。沒有印出的摘要欄位以 `null` 表示。分類、清理後店名與品牌鑰匙由既有專卷驗證，不列入這份格式答案。

兩層考題都對同一份手寫答案：一層直接餵文字列，一層在記憶體建出 PDF／XLSX 後呼叫 `parseStatement`。答案不由受測解析器生成。PDF 使用既有 `cjkPdf` 的等寬文字層，不能用它宣稱真實欄位座標、字型、跨頁或解密已校準。

## 其餘既有回歸的落點

| 範圍 | 既有考題 | 驗證限制 |
|---|---|---|
| 台新銀行概要、帳戶、幣別、存入支出、餘額、備註 | [bank-statement.test.js](../test/bank-statement.test.js) | 合成座標與隔離測試庫；不是實帳校準 |
| 銀行與證券 PDF 文字、字寬、跨頁、正式解析入口 | [pdf-extract-integrity.test.js](../test/pdf-extract-integrity.test.js) | 檔尾列明有限頁數、後頁表頭重印未覆蓋等限制；不新增證券功能 |
| 信用卡預覽、期別傳遞、匯入與重匯 | [statement-pipeline.test.js](../test/statement-pipeline.test.js) | 既有合成案例與隔離資料庫，不表示上表各版型都逐一走了匯入 |
| 摘要驗算與提醒／阻擋分工 | [statement-reconcile.test.js](../test/statement-reconcile.test.js) | 沿用既有判準，不把提醒改成阻擋 |
| 機構、誤認、認不得時的處置 | [card-identity.test.js](../test/card-identity.test.js) | 含既有缺口的 documenting test，不把其輸出宣稱為正確格式 |
| 密碼池與錯誤分流 | [statement-password-pool.test.js](../test/statement-password-pool.test.js) | 假密碼；新代表檔未加密 |
| 規則卡與 AI 備援 | [parse-recipe.test.js](../test/parse-recipe.test.js)、[parse-recipe-card.test.js](../test/parse-recipe-card.test.js)、[ai-card-pipeline.test.js](../test/ai-card-pipeline.test.js) | 合成規則與假引擎，不呼叫外部 AI，不等於新增內建銀行 |

## 重跑

在施工或審查工作樹執行，不在放真實資料的主目錄執行：

```sh
NOTEASY_HOSTED=0 node --test --test-reporter=spec test/statement-format-baseline.test.js test/statement.test.js test/statement-parsers.test.js test/statement-pipeline.test.js test/bank-statement.test.js test/pdf-extract-integrity.test.js test/statement-reconcile.test.js test/statement-password-pool.test.js test/card-identity.test.js test/parse-recipe.test.js test/parse-recipe-card.test.js test/ai-card-pipeline.test.js
```

既有需要資料庫的考題會先把 `STORE_FILE` 指向暫存測試庫，新格式專卷只解析記憶體內容。正式送審另依專案三關；本文件不宣告任何一輪三關或複審已通過，當輪證據留在 PR。

修改基準時先分清楚：輸入版型、手寫答案、或產品判準哪一項要變。若發現既有缺口，另外記錄與決定修正，不能為了讓新考題通過而順手改解析器。測試材料的新增範圍與真實資料界線依 AGENTS.md；實測突變與還原結果記在當支 PR，勿從歷史綠燈推定新版本有效。
