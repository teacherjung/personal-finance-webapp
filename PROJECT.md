# 個人理財中心（榮祥森）— 專案共同記憶

> 本檔是給三方協作者（William／Claude／Codex）的**進度與決策快照**。
> **技術慣例與鐵則的單一真相仍是 [AGENTS.md](AGENTS.md)**——兩者衝突時以 AGENTS.md 為準；本檔只回答「做到哪、誰在做、拍板過什麼」。
> 最後更新：2026-07-28（Claude 建檔；Codex 依 Git 紀錄、合併後複審與新主線規劃補正）。

## 目標

- **為誰**：William（老師，無程式背景）的個人理財管理。個人財務資料庫只存本機 `data/store.db`（SQLite），不交給第三方代管；Yahoo Finance／IBKR 等外部服務只在明確功能需要時由後端連線。
- **做什麼**：本機優先的理財 dashboard（Node + Express + vanilla JS，port 4321）——銀行收支、信用卡費、資產配置、投資組合、證券交易、訂閱／卡片／保險追蹤、每日洞察。
- **北極星**：長期發展成「人生管理遊戲」（跨財務／健康／工作／學習等領域），理財只是第一塊；哲學＝簡單、實用、邊用邊學、漸進式深度。
- **成功標準**：①數字要對（money-critical 正確性優先於一切）②看得懂（必懂概念一律在頁面上就地白話解釋）③財務資料不交第三方代管、機密不進瀏覽器④William 不需要懂程式就能用與維護。

## 目前狀態

三方協作進行中。**證券交易主線 S0–S3 已全部合併**（S3＝[PR #244](https://github.com/teacherjung/personal-finance-webapp/pull/244)）；Codex 合併後複審的 1 高／3 中／1 低已由 Claude 於 r2 全數修正（含 William 2026-07-24 拍板的 **A′ 裁決**，見「重要決定」），r2 已合併（#246）。**真實對帳單首戰（2026-07-24）**：被解析守門誤擋，診斷出五個真版面與合成假設的落差（守門關鍵字/年月位置/@日期註記/表頭拆字/應收付在下層）——已全數修正並以合成考題鎖住（r3＝#247 已合併）。r3 後逐月上傳又收三個版面變體（帳號含字母、表尾合計列誤當交割彙總、混合買賣淨額語意）＝r4（#248）已合併；Codex 收官複審 2 條＝r5（#250）已合併。**2026-07-24 William 已實際匯入 03–06 四份真實對帳單（台新 17 筆＝3+1+5+8、去重鍵零重複）——證券交易主線 S0–S3＋複審 r1–r5 正式收官** ✅。目標追蹤（D5-③）三段全數合併收官、深審零需修。月度回顧 P0–P2 與後續空月改善已上線（#230–#232、#235），但**過去六個月信用卡帳單尚未重匯**，退款配對尚未在舊月份實際生效。**個股研究頁 P1–P5 已全數完工並經 Claude 複審**（#268、#271、#277、#281、#283）；下一條獨立主線「研究方法＋SEC 官方基本面＋Chrome 式頁籤」F1 已合併（#327）、F2 頁籤改版已合併（#328）、F3 SEC 純解析器已合併（#330），F4 SEC 服務／快取／API 已實作，待 Claude 高風險複審。教學影片主線已啟動（定稿文件在 `docs/教學影片/`，尚未 commit；學習專區尚未開工）。

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
| 月度回顧＋退款配對抵減（Codex：P0 退款匯入、P1 計算/API、P2 總覽卡；#235 改善預設空月與比較基準） | `public/modules/monthly-review-card.js`、`docs/月度回顧-施工計畫.md` | #230／#231／#232／#235 |
| 目標追蹤 D5-③（Claude 設計；Codex 審查＋實作：淨值目標、雙速度 ETA、達標報喜進提醒牆） | `lib/derive.js`（computeGoalTracking）、`public/modules/goal-tracking.js`、`docs/目標追蹤-施工計畫.md` | 計畫 #237；P1–P3＝#238／#240／#241 |
| 證券交易 S0 改名（銀行收支／信用卡費）＋設計藍圖 | `docs/證券交易-設計藍圖.md`（Codex 設計、Claude 審查；使用者裁決與實作修訂記於 §十三） | #236（後續隨 #242 修訂藍圖） |
| 證券交易 S1 台新座標解析器＋共同格式正規化器（純函式） | `lib/taishin-securities.js`、`lib/services/security-trades.js` | #239 |
| 證券交易 S2 儲存＋API＋IB 雙寫（reconcile 去重、機密投影、密碼設定） | `lib/services/securities-import.js`、`lib/routes/securities.js`、`lib/secret-fields.js` | #242＋#243 |
| 證券交易 S3 前端頁（查閱／篩選／排序／上傳預覽／匯入紀錄／就地解釋×5） | `public/modules/securities.js`＋`securities-view.js`、`test/securities-ui.test.js` | #244 |
| 機密投影體系（pdfPassword／flexToken／accountNo／taishinSecPdfPassword／sourceRef 不進瀏覽器） | `lib/secret-fields.js` | 多支 |
| 帳務體檢 7 偵測器、店名規則資料化、銀行收支學習 | `lib/statement.js`、`lib/store-rules.js`、設定頁 | 大檢討期間 |
| 系統優化階段一＋二（Claude：共用積木歸戶 U1–U4＋13 窗彈窗外殼；大檔四刀搬家不裝修，全部機械 diff 證明唯一改動＝export；攤提抽純函式＋**前後端公式對照考題**） | `public/modules/`：`file-util`、`route-helpers`（lib/routes）、`modal-shell`、`month-select`、`transactions-import`、`subscriptions-model`、`subscriptions-report`、`settings-store-rules` | #252–#261 |
| 個股研究頁 P1（持股／研究模型、空狀態、占比組裝、五構面完整評分與同日歷史） | `public/modules/stock-research-model.js`、`public/modules/stock-research-score.js` | #268 |
| 個股研究頁 P2–P5（資料驗證牆／純畫面／路由與互動／入口）：研究深層資料契約與同代號防重複、七區塊純呈現＋四段就地解釋、`#stock?symbol=` 路由與事件接線、投資主表與研究卡雙入口（只給個股層、正規化代號、新分頁） | `lib/schema.js`／`lib/routes/crud.js`、`public/modules/stock-research-view.js`／`stock-research-page.js`／`portfolio-tables.js`／`portfolio-research.js`、`public/stock-research.css` | #271、#277、#281、#283 |
| 教學影片定稿文件（流程分工＋EP01 生存優先腳本） | `docs/教學影片/`（**尚未 commit**） | — |

測試現況：**1097 題全綠**（node --test）＋ typecheck ＋ lint（三關＝pre-push 與 CI 門檻）。

## 待辦事項（依優先序）

1. **系統優化主線（Claude 實作、Codex 審核；定稿＝`docs/系統優化-施工計畫.md`）**：**階段一收官 ✅**（U1 #252、U2 #253、U3 試點 #254＋擴大 11 窗 #256/#257、U4 #255）。**階段二大檔四刀收官 ✅**——①`transactions-import.js`（#258）②`subscriptions-model.js` 攤提純函式＋前後端對照考題（#259；抓到的兩處走散點已裁決結案＝#264：後端補 RECORD_START 地板、月份型 endsOn 邊界考題化，Codex 收官複審通過）③`subscriptions-report.js`（#261）④`settings-store-rules.js`（#262）。四刀皆機械 diff 證明唯一改動＝export 字；③④另過三鏡頭對抗審查 workflow。**階段三收官 ✅（本 PR）**：三路查證 workflow（安全地圖逐項／覆蓋率地圖差距／缺口獵捕）→ 兩份地圖全面重寫至 2026-07-24 現況、補 4 條 money-critical 缺口考題（銀行方向退路中線判向 H1／日線時鐘倒退護欄 H2／IB fxToBase 換匯與 income 寫回 M3／帳單對卡判定含同末四碼候選 M4）、3 條誠實缺口記錄在案（pdfjs 抽字三胞胎／匯入落盤薄殼／證券路由殼）、AGENTS 同步點補三份抽取器刻意分工。**階段四收官 ✅（2026-07-27，William 出門授權全自動化期間完成）**：A 每日滾動備份（#295＝data/backups/ 每天一顆保留 30 天、三種備份共用 snapshotTo、失敗畫面警告連續失敗升級）＋B 異常輸入防線（#297＝字串長度兩級制 200/20000、長度 400 只擋新輸入、還原路放行、Codex 抓到帳單匯入端點繞道已封）。兩支皆 Codex 全自動審查→修正→合併。**停止線三題收官答**：①降低改壞風險？✅（備份＝最後防線、長度牆＝新輸入不再無上限）②交接更容易？✅（AGENTS 各補一列、三種備份寫法歸一）③下一階段收益＞風險？**系統優化主線至此全部完結**——後續資安強化併入多人上線階段 C（見 `docs/多人上線-施工計畫.md`，settings 字串盤點已列 C 前置），不再另開優化階段 — **完結**
2. **匯入 2025 年更早月份的信用卡帳單**讓舊退款配對生效——已驗證：Klook 3/16 退款 8,800 **已自動抵減 2 月**（二月旅遊淨額 999、三月不計）；目前未對應退款 7 筆（含**友邦人壽 5,198＋15,235**、林口運動中心×3 等，皆 2025-12 的退款），需匯入其原始消費所在的更早月份帳單才配得到；悠遊卡贖回、點數折帳單類本來就無對應消費＝維持不計入 — **William**
3. **個股研究頁：裁決已完成、Codex 已把裁決寫回計畫（#251 定稿）**——A–F 全採 Codex 推薦＋三件約束性指示（總分五項全評才顯示／E 保留「無持股有研究可開」但入口只從持股表進／F 的 P5 追加 portfolio-research.js）。**Claude 完整審查（5 路查證）與裁決正式紀錄＝`docs/個股研究頁-裁決與審查回覆.md`**。P1 純模型與評分器已合併（#268）；**P1–P5 全數完工並經 Claude 複審**：P2 資料驗證牆（#271）、P3 純畫面（#277；複審 1 中 2 低，Codex 已於 P4/P5 全數修掉——`cap` 就地解釋改成永遠顯示且文案補上「軟上限不會叫你賣、分母＝淨資產」、評分理由改多行、雙版型實測）、P4 路由與互動（#281）、P5 雙入口（#283；Claude 複審無需修，另獨立驗過只有個股層產生連結、惡意代號零注入、手機 375 零溢出）。**個股研究頁主線收官** ✅ — **Codex**
4. **個股基本面研究＋頁籤改版（Codex 獨立主線）**：D0 規劃稿＝`docs/個股基本面研究-施工計畫.md`，William 2026-07-28 已裁決五項全採建議。第一版只做美股 SEC 一般 US-GAAP 公司；建立八組研究問題、官方／衍生指標契約、六個 Chrome 式頁籤與 F1–F6 分段。**F1 純研究方法與證據契約已合併（#327）；F2 Chrome 式頁籤已合併（#328）；F3 SEC 純解析器已合併（#330）；F4 SEC 服務／快取／API 已實作，待 Claude 高風險複審** — **Codex**
5. **教學影片**：EP01 腳本審稿**擱置**（William 2026-07-24 定）；學習專區未開工（PR 需一併帶入 `docs/教學影片/` 兩份文件）。**分工已議定（2026-07-24 會議，Claude／Codex 共識、與角色分工一致）：Claude 起草腳本＋就地解釋文案，Codex 做 YouTube 嵌入前端** — **暫停**
6. 證券交易 S4 對帳洞察（可選：台新期末持股 vs 投資組合唯讀差異提示） — **未分配**
7. D5 第二批剩餘：①股息換算 ②大盤基準（皆比③重，②需新增大盤資料源） — **未分配**
8. 大型前端檔拆分：`portfolio.js` ✅ 停止線；三大檔責任分析已做、值得拆的四刀已隨系統優化階段二全部完成（`transactions.js` 563→286、`subscriptions.js` 949→677、`settings.js` 894→683）——**其餘明確不拆**（settings 八個編輯器、subscriptions 頁面協調層等；不以行數論） — **已完成** ✅
9. （遠期）電子發票載具 API 即時預算系統（財政部 API，需申請；見「重要決定」） — **未分配**

## 共享檔案預約（開工前登記、合併後釋放；規則見 AGENTS.md「三方協作框架」）

| 檔案／區域 | 目前持有人 | 工作 | 釋放條件 |
|---|---|---|---|
| `PROJECT.md`、`AGENTS.md`、`docs/個股基本面研究-施工計畫.md`、`docs/C6-部署與對抗審查-操作手冊.md`、`render.yaml`、`server.js`、`lib/routes/stock-fundamentals.js`、`lib/services/stock-fundamentals.js`、`lib/schema.js`、`lib/types.js`、`lib/store.js`、`lib/repo.js`、`test/stock-fundamentals-api.test.js`、HOSTED 隔離／auth 考題 | Codex | 個股基本面主線 F4：SEC 服務、每租戶快取與 API | F4 PR 合併 |
| 其餘（含 `app.js`） | 無人持有 | — | 開工前登記 |

> 列的 PR 一合併＝該列自動視為釋放；**下一位動本檔的人順手清掉已合併列**（不必為釋放單開 PR——Codex #263 複審建議的落地方式）。

## 重要決定（已拍板，勿重議）

**記帳語意**
- 銀行對帳單＝現金流唯一真相；信用卡明細只做消費分析、**不計入收支**；內轉（transfer）不計收支；繳卡費空分類防重複計算。
- 分類預算**暫緩**（William 2026-07-22 定）：刷卡消費要等一個月後帳單才看得到，「即時踩煞車」價值不成立。**先做回顧型功能**；即時預算的前提＝電子發票載具 API 補時間差（明定為未來方向）。
- 退款＝**配對抵減**：彙總時往前配對同卡同店同額的消費、抵減該消費月份；配不到＝不計入、角落一行提示。部分退款 v1 精準配、配不到先擱。
- 月度回顧只看前六個**已結清月**、不含本月；預設選最近有資料的月份。分類金額是「消費視角」，透支是「現金流視角」，兩者數字不同是刻意設計。

**目標追蹤**
- v1 只設一個「淨資產目標」（台幣；設定頁以萬元輸入），顯示兩種到達速度：可控制的每月現金結餘，以及會受市場／匯率影響的整體淨值變化。
- 速度採最近六個已結束月的中位數、至少三個月才估；資料不足仍顯示進度，達標由新聞牆以 info 級 `goal-reached` 報喜一次。

**投資／證券**
- 最高指導原則：**在所有環境活著 > 多數環境賺更多**（生存優先）；投資原則 v1（軟上限、個股 5%／中國 15%／國家 15%、槓桿 1.3x、ECY 動態股債比）已實作於 app。
- `securityTrades` 獨立集合、**原幣保存**、買賣方向與現金方向分開存（不靠正負猜）；台新應收付金額**以對帳單為準**，程式只核對不改寫、不符就整份擋下（fail-closed）。
- **「批內出現序」不能當跨批身分**（三條 HIGH 實證）：去重＝內容比對＋計數對帳（`reconcileFingerprintRows`）、序號只在插入時取庫內最大＋1、台新鍵**不含**對帳單年月。
- IBKR 同步＝重疊期間 upsert **永不刪歷史**；`ibTrades` 鏡像與 `securityTrades` 的關係是「同步窗內 ⊆」不是相等。
- **查帳頁不改持股＝A′ 裁決（William 2026-07-24）**：「不改持股」精確定義為「證券頁上沒有任何編輯持股的功能」；「同步 IBKR」保留**唯一一套完整同步**（會一併更新持股與現金，文案講明、在哪頁按效果相同），不另造只寫成交紀錄的第二套；「可能已出清」在證券頁只提醒＋指路投資組合頁，刪除動作留在投組頁。台新資產概況不寫入投資組合。
- 台新 PDF 密碼**比照信用卡存起來**（settings.taishinSecPdfPassword，機密投影；推翻藍圖原「每次輸入」）。
- 幣別牆：只支援 TWD／USD／GBP／JPY；缺幣別**不猜 USD**，分原因跳過＋回報。
- app「均價」＝IB Flex `costBasisPrice`，與 IBKR 手機 Avg Price 不同**是正常、非 bug 別修**。

**產品鐵則**
- **就地解釋**（William 2026-07-22 定）：「懂了才不會把正常數字當算錯」的概念一律在網頁上 `.info-link` 白話解釋，只放文件＝驗收不過。文案 Claude 起草、William 審改。
- 解釋一律白話＋生活比喻（William 無程式背景），重點放「對你有什麼用」。

**協作流程**
- AGENTS.md＝技術單一真相，新慣例必須寫進去（Codex 看不到 Claude 的 memory）。
- **一步一 PR、三關全綠（test／typecheck／lint）、開 PR 前對抗式自審**；PR 由 William 合併（Squash and merge＋勾 delete branch）；改後端要重啟。
- 驗證會寫入的功能：**絕不碰真實資料**——瀏覽器只走唯讀或隔離 DB＋合成資料；正確性靠隔離 DB 的 node --test。
- 教學影片：成片走 YouTube 嵌入（影片不進 git）、示範截圖一律合成資料。
- **投資頁拆分停止線**（AGENTS.md）：`portfolio.js` 剩下的是資料載入、頁面協調、圖表生命週期等合理職責，**不應再為了縮短行數硬拆**；其他大檔拆不拆看職責分析、不看行數。
- **角色分工 v3（William 2026-07-24 定）**：Claude＝主實作、修程式、開 PR；Codex＝獨立審核、找漏洞、確認三關、提修正單；William＝產品方向、實測、需求、合併 PR。**Codex 空檔任務＝個股研究頁**（獨立分支與 PR、避開 Claude 進行中的檔案；先交規劃給 William 裁決再動工）。
- **三方協作框架 v4（William 2026-07-24 裁決；Codex 起草＋Claude 三處修訂＝全流程只適用高風險與新功能／預約表初始內容校正／低風險仍過三關）**：PR 三級分級（**高風險＝金額公式/資料庫/搬家/匯入/機密/共用底層，Codex 複審後才合併**；中風險＝共用 UI 雙版型截圖驗證；低風險文件文案快速通道）、角色分工含「不負責」邊界＋CI、PR 單一目的（搬/修/加/改畫面）、模組契約清單＋契約改變當支 PR 同步五項、復原對照表、**合併前一句話檢查＋合併後五分鐘檢查**、共享檔案預約表（見上方專節）、插隊四條件、文件五套各有更新時機、停止線。**唯一版本＝`AGENTS.md`「三方協作框架」節**（已整併同日稍早的裁決補則）；計畫專屬部分（備份警告/異常輸入防線/停止線細節）仍在 `docs/系統優化-施工計畫.md`。

## 技術規則放哪裡

循環 import、欄位所有權、機密投影、排序、測試隔離、啟動與其他容易踩坑的技術規則，全部以 `AGENTS.md` 為準，本檔不另存副本，避免兩份規則日後漂移。協作者的個人 memory 彼此不可見：新技術慣例寫 `AGENTS.md`；進度、分工與產品裁決才更新本檔。


---
*本檔由 Claude 於 2026-07-24 撰寫；同日 Codex 依 Git 紀錄與 #244 複審補正、William 裁決 A′、Claude 隨 r2 修正 PR 更新。之後誰完成工作，誰順手更新本檔的「目前狀態／已完成／待辦」；技術規則仍只更新 AGENTS.md。*
