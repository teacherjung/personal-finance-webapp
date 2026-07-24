# 個人理財中心（榮祥森）— 專案共同記憶

> 本檔是給三方協作者（William／Claude／Codex）的**進度與決策快照**。
> **技術慣例與鐵則的單一真相仍是 [AGENTS.md](AGENTS.md)**——兩者衝突時以 AGENTS.md 為準；本檔只回答「做到哪、誰在做、拍板過什麼」。
> 最後更新：2026-07-24（Claude）。

## 目標

- **為誰**：William（老師，無程式背景）的個人理財管理。所有資料只存本機 `data/store.db`（SQLite），永不上傳。
- **做什麼**：本機優先的理財 dashboard（Node + Express + vanilla JS，port 4321）——銀行收支、信用卡費、資產配置、投資組合、證券交易、訂閱／卡片／保險追蹤、每日洞察。
- **北極星**：長期發展成「人生管理遊戲」（跨財務／健康／工作／學習等領域），理財只是第一塊；哲學＝簡單、實用、邊用邊學、漸進式深度。
- **成功標準**：①數字要對（money-critical 正確性優先於一切）②看得懂（必懂概念一律在頁面上就地白話解釋）③資料不離開本機、機密不進瀏覽器④William 不需要懂程式就能用與維護。

## 目前狀態

三方協作進行中。**證券交易主線 S0–S3 全部完工並合併**（S3＝[PR #244](https://github.com/teacherjung/personal-finance-webapp/pull/244)，2026-07-24 已合併）——William 重啟 app 後即可上傳真實台新對帳單。目標追蹤（D5-③）三段全數合併收官、深審零需修。月度回顧＋退款配對已上線（#235），但**過去六個月信用卡帳單尚未重匯**，退款配對尚未實際生效。教學影片主線已啟動（定稿文件在 `docs/教學影片/`，尚未 commit；學習專區尚未開工）。

## 已完成

| 項目 | 主要檔案位置 | PR |
|---|---|---|
| 收支三層分家（信用卡明細／現金流／帳戶餘額；`isCardTx` 判準） | `public/modules/categories.js:66`、`lib/derive.js` | #171–#191 |
| 防撞護欄 G1–G5（欄位白名單、服務欄位所有權、READONLY 集合、必填整列擋下） | `lib/schema.js`（FIELD_SCHEMA／WRITABLE_FIELDS／READONLY_COLLECTIONS） | #188、#192 等 |
| 每日洞察引擎 D0–D4（提醒牆、Δ chips、穩定 key、insightState 書籤） | `lib/derive.js`、`docs/每日洞察引擎-施工計畫.md` | #192–#198 |
| 月度回顧＋退款配對抵減（彙總時配對、未對應不計入） | `public/modules/monthly-review-card.js`、`docs/月度回顧-施工計畫.md` | 至 #235 |
| 目標追蹤 D5-③（淨值目標、雙速度 ETA、達標報喜進提醒牆） | `lib/derive.js:441`（computeGoalTracking）、`public/modules/goal-tracking.js`、`docs/目標追蹤-施工計畫.md` | #238／#240／#241 |
| 證券交易 S0 改名（銀行收支／信用卡費）＋設計藍圖 | `docs/證券交易-設計藍圖.md`（374 行，Codex 設計、Claude 背書＋修訂 §十三） | #236 |
| 證券交易 S1 台新座標解析器＋共同格式正規化器（純函式） | `lib/taishin-securities.js`、`lib/services/security-trades.js` | #239 |
| 證券交易 S2 儲存＋API＋IB 雙寫（reconcile 去重、機密投影、密碼設定） | `lib/services/securities-import.js`、`lib/routes/securities.js`、`lib/secret-fields.js` | #242＋#243 |
| 證券交易 S3 前端頁（查閱／篩選／排序／上傳預覽／匯入紀錄／就地解釋×5） | `public/modules/securities.js`＋`securities-view.js`、`test/securities-ui.test.js` | #244 |
| 機密投影體系（pdfPassword／flexToken／accountNo／taishinSecPdfPassword／sourceRef 不進瀏覽器） | `lib/secret-fields.js` | 多支 |
| 投資頁拆分收官（Codex：`portfolio.js` 1,581 行→223 行、拆出 25 個 `portfolio-*` 子模組、只搬家不改公式；AGENTS.md 已立**拆分停止線**） | `public/modules/portfolio-*.js` | #203–#229（27 支） |
| 測試覆蓋率地圖（財務風險導向；Codex 製作、經 teacherjung 帳號提交） | `docs/測試覆蓋率地圖.md` | #202（`b69989d`，2026-07-22） |
| 帳務體檢 7 偵測器、店名規則資料化、銀行收支學習 | `lib/statement.js`、`lib/store-rules.js`、設定頁 | 大檢討期間 |
| 教學影片定稿文件（流程分工＋EP01 生存優先腳本） | `docs/教學影片/`（**尚未 commit**） | — |

測試現況：**746 題全綠**（node --test）＋ typecheck ＋ lint（三關＝pre-push 與 CI 門檻）。

## 待辦事項（依優先序）

1. **重啟 app**（桌面捷徑會自動 git pull 到含 #244 的 main）＋**拿真實台新對帳單試匯入**（解析器目前只過合成考題與加密版面校準，真版面首戰）；有 blocker 訊息就原文回報 — **William**（問題修正 → Claude）
2. **重匯過去六個月信用卡帳單**，讓退款配對真的生效（2026-07-24 確認尚未做；友邦人壽退款卡在這一步） — **William**
3. **教學影片**：審 EP01 腳本＋錄 HeyGen 分身素材 — **William**；學習專區（YouTube 嵌入版，尚未開工；PR 需一併帶入 `docs/教學影片/` 兩份文件） — **Codex**
4. AGENTS.md 鐵則 5 例外清單補登證券頁自製金額格式器（下次動 AGENTS 順手） — **Claude**
5. 證券交易 S4 對帳洞察（可選：台新期末持股 vs 投資組合唯讀差異提示） — **未分配**
6. D5 第二批剩餘：①股息換算 ②大盤基準（皆比③重，②需新增大盤資料源） — **未分配**
7. 大型前端檔拆分：`portfolio.js` ✅ 完成並抵達停止線（不再拆）；`subscriptions.js`（949 行）、`settings.js`（883 行）、`transactions.js`（572 行）**待責任分析後再決定是否拆**——不以行數論 — **未分配**
8. （遠期）電子發票載具 API 即時預算系統（財政部 API，需申請；見「重要決定」） — **未分配**

## 重要決定（已拍板，勿重議）

**記帳語意**
- 銀行對帳單＝現金流唯一真相；信用卡明細只做消費分析、**不計入收支**；內轉（transfer）不計收支；繳卡費空分類防重複計算。
- 分類預算**暫緩**（William 2026-07-22 定）：刷卡消費要等一個月後帳單才看得到，「即時踩煞車」價值不成立。**先做回顧型功能**；即時預算的前提＝電子發票載具 API 補時間差（明定為未來方向）。
- 退款＝**配對抵減**：彙總時往前配對同卡同店同額的消費、抵減該消費月份；配不到＝不計入、角落一行提示。部分退款 v1 精準配、配不到先擱。

**投資／證券**
- 最高指導原則：**在所有環境活著 > 多數環境賺更多**（生存優先）；投資原則 v1（軟上限、個股 5%／中國 15%／國家 15%、槓桿 1.3x、ECY 動態股債比）已實作於 app。
- `securityTrades` 獨立集合、**原幣保存**、買賣方向與現金方向分開存（不靠正負猜）；台新應收付金額**以對帳單為準**，程式只核對不改寫、不符就整份擋下（fail-closed）。
- **「批內出現序」不能當跨批身分**（三條 HIGH 實證）：去重＝內容比對＋計數對帳（`reconcileFingerprintRows`）、序號只在插入時取庫內最大＋1、台新鍵**不含**對帳單年月。
- IBKR 同步＝重疊期間 upsert **永不刪歷史**；`ibTrades` 鏡像與 `securityTrades` 的關係是「同步窗內 ⊆」不是相等。
- **查帳頁不改持股**：證券交易頁只查閱對帳，持股／分析歸投資組合頁；台新資產概況不寫入投資組合。
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
- 角色分工（2026-07-23 起雙線）：目標追蹤＝Claude 設計、Codex 審＋實作；證券交易＝Codex 設計、Claude 審＋實作。**現行原則（William 2026-07-24 定）：先完成手上工作，之後再重新分工**——新主線開工前先問 William 分工。

## 給協作者的備註（容易踩的坑）

1. **循環 import TDZ（會讓整個 app 開不起來）**：新前端模組**不可在檔案頂層**取用 `app.js` 的任何綁定（`esc`／`money`…）——app.js ↔ 模組互相 import，頂層取用時 app.js 還沒初始化完。要嘛包箭頭延遲取用，要嘛只在函式內用。`theme.js` 與 `securities.js` 都有註記，S3 期間實際踩過一次。
2. **退出碼別被管線吃掉**：`npm run lint 2>&1 | tail -1; echo $?` 回的是 tail 的退出碼——曾因此漏掉 4 條 lint 錯誤。直接看 npm 的 exit code。
3. **主工作區別 `git add -A`**：根目錄有未追蹤的老 PDF（`三層店名模型…pdf`）與 `docs/教學影片/`（拍板由學習專區 PR 帶入）。
4. **`.claude/launch.json` 是被追蹤檔**：臨時加測試用 server 設定後務必 `git checkout --` 還原——留髒會讓桌面捷徑「重啟理財網頁.command」的自動 git pull 被略過。
5. **sanitizeInsightState 白名單**：insightState 新增書籤欄位必須登記白名單，否則會被**靜默剝除**（洞察引擎最大陷阱）。
6. **securityTrades 是 READONLY 集合**：只能走服務層（台新匯入／IB 同步）寫入，一般 CRUD 路由進不去；服務欄位（sourceRef／importBatch…）不在 CRUD 白名單。
7. **機密投影是全站合約**：任何新的 GET 回應路徑（含 preview 類）都要檢查有沒有把指紋／去重鍵／密碼漏出去；`/api/export` 是唯一例外（備份必須完整，漏了密碼還原後就永久遺失）。
8. **動態鍵查物件一律 `Object.hasOwn` 或 null-proto**：使用者文字當鍵時 `__proto__`／`toString` 會撈到原型（歷史上真踩過）。
9. **排序第二鍵固定**（tx-sort 鐵則）：降冪只反轉主鍵，第二鍵固定日期新→舊，不可整個比較器乘 −1。
10. 桌面捷徑重啟會**先自動 git pull main**（非 main 分支或有未提交變更則略過）——所以合併後叫 William 重啟即可，不用手動拉。
11. Claude 的個人 memory Codex 看不到——任何要共用的慣例，寫 AGENTS.md；進度快照更新本檔。

---
*本檔由 Claude 於 2026-07-24 撰寫；同日依 William 回覆補齊（覆蓋率地圖出處 #202、拆檔進度與停止線、分工原則、#244 已合併），目前無待確認項。之後誰完成工作誰順手更新本檔。*
