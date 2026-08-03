# PROJECT 完工紀錄（凍結於 2026-07-31）

> 📦 **歸檔（2026-07-31，D3）**：這是 PROJECT.md 瘦身時搬出的**歷史紀錄**——完工表、戰史敘事與協作沿革，內容自原檔照搬、不再更新。
> **本檔凍結：之後的完工紀錄＝GitHub 的 merged PR 清單**（`gh pr list --state merged`），不在這裡續寫。
> 現在進行式（目標／狀態／待辦／已拍板決定）看 [../../PROJECT.md](../../PROJECT.md)；技術單一真相仍是 AGENTS.md。

## 主線戰史（原 PROJECT「目前狀態」敘事，2026-07-31 快照）

三方協作進行中。**證券交易主線 S0–S3 已全部合併**（S3＝[PR #244](https://github.com/teacherjung/personal-finance-webapp/pull/244)）；Codex 合併後複審的 1 高／3 中／1 低已由 Claude 於 r2 全數修正（含 William 2026-07-24 拍板的 **A′ 裁決**），r2 已合併（#246）。**真實對帳單首戰（2026-07-24）**：被解析守門誤擋，診斷出五個真版面與合成假設的落差（守門關鍵字/年月位置/@日期註記/表頭拆字/應收付在下層）——已全數修正並以合成考題鎖住（r3＝#247 已合併）。r3 後逐月上傳又收三個版面變體（帳號含字母、表尾合計列誤當交割彙總、混合買賣淨額語意）＝r4（#248）已合併；Codex 收官複審 2 條＝r5（#250）已合併。**2026-07-24 William 已實際匯入 03–06 四份真實對帳單（台新 17 筆＝3+1+5+8、去重鍵零重複）——證券交易主線 S0–S3＋複審 r1–r5 正式收官** ✅。目標追蹤（D5-③）三段全數合併收官、深審零需修。月度回顧 P0–P2 與後續空月改善已上線（#230–#232、#235）。**個股研究頁 P1–P5 已全數完工並經 Claude 複審**（#268、#271、#277、#281、#283）；下一條獨立主線「研究方法＋SEC 官方基本面＋Chrome 式頁籤」F1 已合併（#327）、F2 頁籤改版已合併（#328）、F3 SEC 純解析器已合併（#330），F4 SEC 服務／快取／API 已合併（#335；2026-07-30 Claude 補做高風險複審＝六路對抗式、23 項發現，紀錄在 #335 留言；①流動債務 #357 ②錯誤歸因 #358 ③考題假綠五條 #359 ④SEC 全站佇列護欄 #361 已修畢合併）。

## 已完成

| 項目 | 主要檔案位置 | PR |
|---|---|---|
| 收支三層分家（信用卡明細／現金流／帳戶餘額；`isCardTx` 判準） | `public/modules/categories.js:66`、`lib/derive.js` | #171–#191 |
| 防撞護欄 G1–G5（欄位白名單、服務欄位所有權、READONLY 集合、必填整列擋下） | `lib/schema.js`（FIELD_SCHEMA／WRITABLE_FIELDS／READONLY_COLLECTIONS） | #188、#192 等 |
| 每日洞察引擎 D0–D4（提醒牆、Δ chips、穩定 key、insightState 書籤） | `lib/derive.js`、`docs/每日洞察引擎-施工計畫.md` | #192–#198 |
| Node 啟動版本護欄（Codex：要求 Node ≥22.13.0；桌面捷徑白話擋下不相容版本） | `scripts/check-node-version.js`、`start.command` | #200 |
| 大型上傳分流（Codex：一般 1 MB、帳單 15 MB、備份還原 50 MB；保住資料救援入口） | `lib/http-body.js`、`test/request-limits.test.js` | #201 |
| 測試覆蓋率地圖（財務風險導向；Codex 製作、經 teacherjung 帳號提交） | `docs/測試覆蓋率地圖.md` | #202（`b69989d`，2026-07-22） |
| 投資頁拆分收官（Codex：`portfolio.js` 1,581 行→223 行、拆出 25 個 `portfolio-*` 子模組、只搬家不改公式；AGENTS.md 已立**拆分停止線**） | `public/modules/portfolio-*.js` | #203–#229（27 支） |
| 月度回顧＋退款配對抵減（Codex：P0 退款匯入、P1 計算/API、P2 總覽卡；#235 改善預設空月與比較基準） | `public/modules/monthly-review-card.js`、`docs/archive/月度回顧-施工計畫.md` | #230／#231／#232／#235 |
| 目標追蹤 D5-③（Claude 設計；Codex 審查＋實作：淨值目標、雙速度 ETA、達標報喜進提醒牆） | `lib/derive.js`（computeGoalTracking）、`public/modules/goal-tracking.js`、`docs/archive/目標追蹤-施工計畫.md` | 計畫 #237；P1–P3＝#238／#240／#241 |
| 證券交易 S0 改名（銀行收支／信用卡費）＋設計藍圖 | `docs/archive/證券交易-設計藍圖.md`（Codex 設計、Claude 審查；使用者裁決與實作修訂記於 §十三） | #236（後續隨 #242 修訂藍圖） |
| 證券交易 S1 台新座標解析器＋共同格式正規化器（純函式） | `lib/taishin-securities.js`、`lib/services/security-trades.js` | #239 |
| 證券交易 S2 儲存＋API＋IB 雙寫（reconcile 去重、機密投影、密碼設定） | `lib/services/securities-import.js`、`lib/routes/securities.js`、`lib/secret-fields.js` | #242＋#243 |
| 證券交易 S3 前端頁（查閱／篩選／排序／上傳預覽／匯入紀錄／就地解釋×5） | `public/modules/securities.js`＋`securities-view.js`、`test/securities-ui.test.js` | #244 |
| 機密投影體系（pdfPassword／flexToken／accountNo／taishinSecPdfPassword／sourceRef 不進瀏覽器） | `lib/secret-fields.js` | 多支 |
| 帳務體檢 7 偵測器、店名規則資料化、銀行收支學習 | `lib/statement.js`、`lib/store-rules.js`、設定頁 | 大檢討期間 |
| 系統優化階段一＋二（Claude：共用積木歸戶 U1–U4＋13 窗彈窗外殼；大檔四刀搬家不裝修，全部機械 diff 證明唯一改動＝export；攤提抽純函式＋**前後端公式對照考題**） | `public/modules/`：`file-util`、`route-helpers`（lib/routes）、`modal-shell`、`month-select`、`transactions-import`、`subscriptions-model`、`subscriptions-report`、`settings-store-rules` | #252–#261 |
| 個股研究頁 P1（持股／研究模型、空狀態、占比組裝、五構面完整評分與同日歷史） | `public/modules/stock-research-model.js`、`public/modules/stock-research-score.js` | #268 |
| 個股研究頁 P2–P5（資料驗證牆／純畫面／路由與互動／入口）：研究深層資料契約與同代號防重複、七區塊純呈現＋四段就地解釋、`#stock?symbol=` 路由與事件接線、投資主表與研究卡雙入口（只給個股層、正規化代號、新分頁） | `lib/schema.js`／`lib/routes/crud.js`、`public/modules/stock-research-view.js`／`stock-research-page.js`／`portfolio-tables.js`／`portfolio-research.js`、`public/stock-research.css` | #271、#277、#281、#283 |
| 教學影片定稿文件（流程分工＋EP01 生存優先腳本） | `docs/教學影片/`（**尚未 commit**） | — |

## 已完結主線的結案紀錄（原「待辦事項」長段）

- **系統優化主線（Claude 實作、Codex 審核；定稿＝`docs/系統優化-施工計畫.md`）**：**階段一收官 ✅**（U1 #252、U2 #253、U3 試點 #254＋擴大 11 窗 #256/#257、U4 #255）。**階段二大檔四刀收官 ✅**——①`transactions-import.js`（#258）②`subscriptions-model.js` 攤提純函式＋前後端對照考題（#259；抓到的兩處走散點已裁決結案＝#264：後端補 RECORD_START 地板、月份型 endsOn 邊界考題化，Codex 收官複審通過）③`subscriptions-report.js`（#261）④`settings-store-rules.js`（#262）。四刀皆機械 diff 證明唯一改動＝export 字；③④另過三鏡頭對抗審查 workflow。**階段三收官 ✅（本 PR）**【歸檔註：「本 PR」＝當時寫下此段的階段三 PR】：三路查證 workflow（安全地圖逐項／覆蓋率地圖差距／缺口獵捕）→ 兩份地圖全面重寫至 2026-07-24 現況、補 4 條 money-critical 缺口考題（銀行方向退路中線判向 H1／日線時鐘倒退護欄 H2／IB fxToBase 換匯與 income 寫回 M3／帳單對卡判定含同末四碼候選 M4）、3 條誠實缺口記錄在案（pdfjs 抽字三胞胎／匯入落盤薄殼／證券路由殼）、AGENTS 同步點補三份抽取器刻意分工。**階段四收官 ✅（2026-07-27，William 出門授權全自動化期間完成）**：A 每日滾動備份（#295＝data/backups/ 每天一顆保留 30 天、三種備份共用 snapshotTo、失敗畫面警告連續失敗升級）＋B 異常輸入防線（#297＝字串長度兩級制 200/20000、長度 400 只擋新輸入、還原路放行、Codex 抓到帳單匯入端點繞道已封）。兩支皆 Codex 全自動審查→修正→合併。**停止線三題收官答**：①降低改壞風險？✅（備份＝最後防線、長度牆＝新輸入不再無上限）②交接更容易？✅（AGENTS 各補一列、三種備份寫法歸一）③下一階段收益＞風險？**系統優化主線至此全部完結**——後續資安強化併入多人上線階段 C（見 `docs/多人上線-施工計畫.md`，settings 字串盤點已列 C 前置），不再另開優化階段 — **完結**
- **個股研究頁：裁決已完成、Codex 已把裁決寫回計畫（#251 定稿）**——A–F 全採 Codex 推薦＋三件約束性指示（總分五項全評才顯示／E 保留「無持股有研究可開」但入口只從持股表進／F 的 P5 追加 portfolio-research.js）。**Claude 完整審查（5 路查證）與裁決正式紀錄＝`docs/個股研究頁-裁決與審查回覆.md`**。P1 純模型與評分器已合併（#268）；**P1–P5 全數完工並經 Claude 複審**：P2 資料驗證牆（#271）、P3 純畫面（#277；複審 1 中 2 低，Codex 已於 P4/P5 全數修掉——`cap` 就地解釋改成永遠顯示且文案補上「軟上限不會叫你賣、分母＝淨資產」、評分理由改多行、雙版型實測）、P4 路由與互動（#281）、P5 雙入口（#283；Claude 複審無需修，另獨立驗過只有個股層產生連結、惡意代號零注入、手機 375 零溢出）。**個股研究頁主線收官** ✅ — **Codex**
- 大型前端檔拆分：`portfolio.js` ✅ 停止線；三大檔責任分析已做、值得拆的四刀已隨系統優化階段二全部完成（`transactions.js` 563→286、`subscriptions.js` 949→677、`settings.js` 894→683）——**其餘明確不拆**（settings 八個編輯器、subscriptions 頁面協調層等；不以行數論） — **已完成** ✅

## 協作沿革（唯一現行版本＝AGENTS.md「三方協作框架」節）

- **角色分工 v3（William 2026-07-24 定）**：Claude＝主實作、修程式、開 PR；Codex＝獨立審核、找漏洞、確認三關、提修正單；William＝產品方向、實測、需求、合併 PR。**Codex 空檔任務＝個股研究頁**（獨立分支與 PR、避開 Claude 進行中的檔案；先交規劃給 William 裁決再動工）。
- **三方協作框架 v4（William 2026-07-24 裁決；Codex 起草＋Claude 三處修訂＝全流程只適用高風險與新功能／預約表初始內容校正／低風險仍過三關）**：PR 三級分級（**高風險＝金額公式/資料庫/搬家/匯入/機密/共用底層，Codex 複審後才合併**；中風險＝共用 UI 雙版型截圖驗證；低風險文件文案快速通道）、角色分工含「不負責」邊界＋CI、PR 單一目的（搬/修/加/改畫面）、模組契約清單＋契約改變當支 PR 同步五項、復原對照表、**合併前一句話檢查＋合併後五分鐘檢查**、共享檔案預約表（歷史紀錄——2026-07-31 已退役改 Draft PR 制，見上方專節【歸檔註：「上方專節」指原 PROJECT.md 的預約專節，該節已隨退役刪除】）、插隊四條件、文件五套各有更新時機、停止線。**唯一版本＝`AGENTS.md`「三方協作框架」節**（已整併同日稍早的裁決補則）；計畫專屬部分（備份警告/異常輸入防線/停止線細節）仍在 `docs/系統優化-施工計畫.md`。
- 之後的沿革：2026-07-30 合併決策與執行分離＋三模式邊界、2026-07-31 預約表退役改 Draft PR 制＋審查一律 xhigh——這些**現行規則**全在 AGENTS.md 與 REVIEW-AND-MERGE.md，本檔不重複。

---
*原 PROJECT.md 由 Claude 於 2026-07-24 撰寫；同日 Codex 依 Git 紀錄與 #244 複審補正、William 裁決 A′、Claude 隨 r2 修正 PR 更新；歷經多次三方增補至 2026-07-31 D3 瘦身時搬入本檔。*
