# 暫存夾具生命週期覆蓋計畫

本計畫處理 #683 留下的 repo／redaction 覆蓋與空回報錯誤原因。它依本輪 GPT‑6.1 Sol／xhigh 的技術裁示，只延伸合成考題的觀察與失敗接縫；不啟動真掃描、真 Grok、完整金絲雀或金融工具。

## 問題與改動

`test/scan-fixture-cleanup.test.js` 的受測集合補入 `test/grok-scan-flow-repo.test.js` 與 `test/grok-scan-flow-redaction.test.js`。各檔在獨立 child 及私有 TMPDIR 下驗正常完成、夾具建立後的 afterEach 故意失敗、假設定初始化寫入失敗。觀察來源維持實際 `fs.mkdtempSync` 返回值，不能改抄待清清單。

新增初始化接縫限於該場已觀察的 `fake-scan-settings-*` 根內第一次寫入 `settings.json`。根已建立並經原 `keep()` 登記，但 `isolated()` 尚未返回；故意失敗只注入一次。核對實際根存在、故障階段與退出碼，再驗檔級收尾。平台沒有走到該分支時，明記未驗證。

觀察器的 afterEach 同時記題名、該段實際新建根與 `mkdtempSync` 接線身分。repo 題的局部包裝情境須有 `scan-decoy-cwd-*` 建立正控，還原後須接回原觀察器，後續另一條建立路徑仍須可被觀察。

`grok-fixture-host-*` 父根由本行程同步建立，可以直接觀察。已知 child 的 TMPDIR 位於該父根內；既有 child 載入回報、內部空目錄斷言、父端空目錄斷言與 finally 保持。沒有父根時須有該題的官方跳過證據。這只核對這條 contained 子程序路徑，不宣稱逐筆直接觀察 child 內每次建立。

回報解析只濾空行。空字串與全空白須由缺官方摘要斷言明確拒收；有效摘要加空行保持原判斷；非空壞 JSON 仍拋錯。既有摘要、hook、根殘留、未登記對照、捷徑目標及逐題 skip 保存檢查保持。

## 檔案與範圍

- `test/scan-fixture-cleanup.test.js`：新增受測檔、初始化情境、接線／contained 正控與空回報反例。
- `test/helpers/temp-root-lifecycle-observer.js`：有限初始化故障及實際建立階段記錄。
- `docs/fixture-lifecycle-plan.md`：本計畫。
- `PROJECT.md`：按正式交付結果分別對帳，不把尚未驗證或未觸發的事項結清。

上述路徑經 D5 查核均屬專案。正式實作前重查實際差異與契約路由。既有 reporter、共用清理 helper、repo／redaction 原測試先保持；有效突變僅在外置候選暫時破壞後還原，不是交付內容。若行為題發現原收尾缺陷，先交指定 Sol 依實證分流。

## 驗證與證據

正常場與每種故障場均須在清理前證明實際夾具仍在，故障場由指定故障造成非零退出，不能由訊號、逾時、語法錯或沙箱能力不足代打。先讓殘留／保存斷言讀到結果，外層才收回本場暫存；不掃除歷史暫存。

有效突變分別移除新納入兩檔的 cleanup hook；保留初始化故障而漏登記設定根；保留清理操作而改壞捷徑目標的本題唯一 sentinel；保留 child 執行而在私有父根內留下子目錄；退回直接解析空白；移除缺摘要拒收。每項先驗綠、確認替換目標、使預期斷言紅，再還原驗綠。初始化突變另留故障已在實際根上注入的診斷，避免只看到其他根殘留就誤稱覆蓋該接縫。

需跑生命週期整檔、相關註解／字元守門、型別與格式檢查，並依正式程序完成完整檢查及獨立 Grok 複審。樹外準備結果與正式提交版本分開記帳；任何尚未完成的驗證不得回填為已通過。

## 保留事項

非同步 mkdtemp、以 mkdir 自建獨立根、child 在既有父根之外另建根，仍以實際採用為擴充觸發。本次不建立通用檔案／程序追蹤框架。

FILES 來源開始採用 describe 時，再處理 suite skip 與 test skip 的官方事件差別；本次不改 reporter，也不降低零題、缺 hook 或無操作證據的拒收。#683 整組跳過的保守紅限制繼續保留。

正式程序完成後，PROJECT 只結清 repo／redaction 的指定覆蓋與空回報錯誤原因；觀察器射程分開記已知 contained 路徑與其餘條件，不宣稱整組待辦全數解決。
