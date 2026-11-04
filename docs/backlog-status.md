# 理財未結事項現況（2026-11-04）

初始盤點基準為 [#748][pr748] 合併後主幹 `484e92b1dd83b8e943562433e609d0997cfda78a`，對照 [PROJECT.md][p] 及近期 PR 的明確交付與待辦。**初盤 50＋新 minimatch 1＋獨立覆核補回原保存前提 1＝52**：優先工作（含待交付）**2**、條件候選／技術未驗 **18**、欠來源／產品決定／功能前提 **15**、停線／封存／其他擁有線 **17**。

一束以可追溯的目的與完成條件計算，重複記載只算一次；GS-F04 依未交付入口拆分。52 包含候選與未驗責任，不能稱為 52 個已證缺陷或 52 支已准開工的 PR。**功能候選清單的 124 列是不同集合，不與此處相加。**

#747 繼續封存，#737 保持關閉與原稿保全；手機、HOSTED、Gemini／Argon、掃描及他線停止安排保持，不因本表恢復。真帳本／憑證、交易與資金工具、受限私有原件及原圖／完整 Console 的用途授權，依共同入口與既有個案界線辦理。技術裁示交實際 GPT-6.1 Sol／xhigh；未完成的正式審查、本人保留事項與合併／驗收條件不因整理清單解除。

## 優先工作（2；含待交付）

- **FIN-001｜qs 安全通報修補的本機交付**。位置：package.json 的 qs override、package-lock.json 與既有本機更新入口。新鎖檔的 CI 安裝與實際檢查、Grok r1、F7 及第2趟完整合併閘已通過，#749 已合併。首次因仍為草稿被拒的紀錄與 Sol 程序續裁保留。B級本機安裝、重啟及核心流程仍須依實際操作分開核收；既有不重裝限制不由技術代理解除，安裝同意與實際結果見[本次本人題](https://github.com/teacherjung/personal-finance-webapp/pull/749#issuecomment-6626768319)。未完成的本機交付保留未結，不將遠端合併寫成本機已生效。來源：[#749][pr749]；[既有優先裁示][qs-sol]。

- **FIN-002｜設定管理入口開窗取得所有權後同步拋錯的直接行為題**。位置：待新增 test/settings-manager-open-error.test.js 與 test/helpers/settings-manager-open-error-case.js，保留既有 test/helpers/settings-manager-entry-case.js 的 HTTP 覆蓋。原真 LOCAL HTTP 補題候選未套用；依 [Sol 初次前提裁示](https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6627860626) 改備無 TCP 獨立補題，作者與未變更的既有沙箱能力驗證已完成，兩場六入口皆取得有效基線／指定同步 catch 突變／還原的有限證據。依 [Sol 續作裁示](https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6628398035)，可排施工，須先完成 #750 當版 CI、Grok 正式複審與合併；本項正式施工／複審／合併未完成，Grok 仍須獨立重跑基線、有效突變及還原。只補指定同步例外的缺題，不改產品 catch、資格、錯誤判準、沙箱或接線；能力收據不代替正式放行，也不提供 HTTP、真帳本保存或原生瀏覽器證據。來源：[#743 採納待辦][pr743]。

## 條件候選與技術未驗（18）

- **FIN-003｜信用卡批次管理晚回應與續行保護**。位置：public/modules/transactions-import.js 的 openBatchManager。先以完整 LOCAL 正常／晚回應案例核具體缺口，再裁最小修法；原生及正式複審不得以 HTTP／DOM 替代。本入口不是 #737，也不是 #739 預覽／完成窗已交付範圍。 來源：[GS-F04][p]；[#739 範圍排除][pr739]。

- **FIN-004｜設定體檢入口晚回應保護**。位置：public/modules/settings.js 體檢入口。逐入口完成行為重現後才裁修法；不把 GS-F04 原碼觀察寫成全站已證故障。 來源：[GS-F04][p]；[#743 明列排除][pr743]。

- **FIN-005｜前端排序鍵自有屬性防禦**。位置：public/modules/tx-sort.js、transactions.js、cashflow.js。取得正常操作可達反例，或下次修改共用排序時再評估；固定表頭提供的現有鍵不能推成已證攻擊可達。 來源：[GS-D01][p]。

- **FIN-006｜保費週期標籤防禦候選**。位置：lib/derive.js、lib/schema.js、提醒考題。既有有限 LOCAL HTTP 核對完成、防禦候選未觸發；取得正常操作或可信舊資料反例再裁，不為清零純重構。 來源：[GS-D02][p]。

- **FIN-007｜本機分支、工作樹、暫存與 stash 整理**。位置：tools/tidy-list.js 的使用端、本機環境。先唯讀列清單，核持有人、未提交成果、保留證據及其他整理線；舊數量不作刪除依據，受限證據目錄不可遞迴掃描。 來源：[GS-D03][p]。

- **FIN-008｜完整執行身分與來源記帳的未驗界線**。位置：scripts/grok-scan.js、scripts/grok-relay.js、provider。有限磁碟來源帳已交付；若載入身分成為安全判定、載入架構／範圍改變或有漏替換反例，再裁受控載入架構。不能把有限帳說成完整映像保證。 來源：[掃描來源帳原條][p]；[#720][pr720]。

- **FIN-009｜型別射程註解的過時 PDF 例子**。位置：test/ts-check-coverage.test.js 的 trackedJs 註解。下次修改該註解／題目或實際誤導診斷時移除例子或標歷史；保留正確追蹤檔判準。既有裁示不另開純註解 PR。 來源：[型別射程註解待辦][p]；[#719][pr719]。

- **FIN-010｜生命週期舊斷言的修法指路**。位置：test/scan-fixture-cleanup.test.js。下次實改指定斷言或依其失敗輸出排障時，只補核對位置與重跑指路；不改判斷、不另開純訊息 PR。 來源：[生命週期斷言指路待辦][p]；[#718][pr718]。

- **FIN-011｜暫存觀察器擴及新的建立方式**。位置：test/helpers/temp-root-lifecycle-observer.js、相關生命週期題。新增 async mkdtemp、mkdir 自建獨立根，或 child 在既有 contained 父根外另建根時，才對實際路徑擴觀察及有效反控；既有有限 contained 交付不重開。 來源：[暫存觀察器射程][p]；[#718][pr718]。

- **FIN-012｜reporter 區分整個 suite 的 skip**。位置：test/helpers/temp-root-lifecycle-reporter.js、scan-fixture-cleanup.test.js。FILES 任一受觀察考題開始用 describe 時，帶 details.type 並分 suite／個別題，補真行為及反控；現有缺口向安全方向拒收，不是已證假綠。 來源：[暫存整組跳過待辦][p]；[#683][pr683]。

- **FIN-013｜CI 支援版本判斷的直接反例**。位置：test/deploy-config.test.js。調整 CI 前瞻版本或 HOSTED 復工時，採既有支援判斷補不支援版本反例；現行支援版本不能當作已修此題。 來源：[CI 版本靜態覆蓋待辦][p]。

- **FIN-014｜銀行與信用卡匯入服務拆分候選**。位置：lib/services/bank-import.js、lib/services/statement-import.js。有具體維護需求且必要後台修正完成，再核當版循環與職責、交 Sol 裁架構；不照舊規格的時態直接施工。 來源：[#729 收件][issue729]；[#732][pr732]；[共同待辦][p]。

- **FIN-015｜銀行收支樣式逐條重核**。位置：public/styles.css 的銀行收支段。下次整理該頁樣式且他線預約解除後，逐條核實再決定；原整組刪除前提已被可見箭頭反例推翻，不照舊估計刪除。 來源：[交接原5][p]；[既有階段證據][stage]。

- **FIN-016｜銀行收支跨視窗與外部寫入的一致性未驗範圍**。位置：public/modules/cashflow.js 及相關讀寫接縫。先界定具體使用路徑與反例，再裁最小承接；#700/#703/#704/#706 已有有限交付，不以未驗泛稱重開整批。此項是保留責任，不是已證所有外部寫入皆壞。 來源：[交接原6後續][p]。

- **FIN-017｜訂閱其他列操作與完整並行一致性的未驗範圍**。位置：public/modules/subscriptions.js 及相關入口。先界定仍未涵蓋的具體入口與保存／回焦目標再承接；標記、刪除、三欄保存、表單晚成功及記帳保存的有限交付不重做，不承諾完整並行已驗。 來源：[交接原24][p]；[#724][pr724]；[#725][pr725]。

- **FIN-018｜歷史公開倉庫憑證檢查的原證據未核實**。位置：交接原9的歷史查核紀錄。取得可核原始證據才判定該歷史主張；快照機制與現存元資料操作不代替原證據，不讀真帳本／憑證，不藉本項恢復掃描。 來源：[交接原9][p]。

- **FIN-019｜證券重畫中舊匯入紀錄按鈕的可按狀態**。位置：public/modules/securities.js 的 showLoading:false 重畫。實際重畫 GET 久候或下次處理入口狀態時修；已證是看似可按但入口拒收的體驗落差，不是已證重複刪除或資料遺失。 來源：[#742 r1#2／r2採納待辦][pr742]。

- **FIN-051｜minimatch 既有相依安全通報**。位置：package-lock.json 的開發相依 minimatch 10.2.5；ESLint／config-array 消費者。公告列受影響版本 <11.0.1、修補版 11.0.1，GitHub Advisory Database 於 2026-10-30 收錄／複核。原鎖 ESLint 10.7 與 config-array 0.23.5 皆宣告 ^10.2.4；本輪核官方 ESLint 10.14 仍宣告 ^10.2.6，config-array 仍為 ^10.2.4，未找到可採的相容窄修補，不強制跨主版 override。已查消費者呼叫所見選項為 dot:true／flipNegate，未指定 optimizationLevel（預設 1）；未證產品 HTTP 可利用，不能推為全部安全。上游提供適用修補、消費者正式支援已修補版、取得本案不可信 glob 且啟用 optimizationLevel >= 2 的可達反例，或必要檢查受阻時立即重裁。基線 audit 的 minimatch 五項相依列屬同一通報；qs 候選移除 qs 通報後，本通報仍在，未結清。 來源：[GitHub 公告][minimatch-ghsa]；[ESLint v10.14.0][eslint-package]；[config-array][config-array-package]；[#749 查核紀錄][pr749]。

## 欠來源、產品決定或功能前提（15）

- **FIN-020｜信用卡費現金流概念說明入口**。位置：public/modules/transactions.js。本人後續要求此頁保留概念說明時，再設計獨立入口；不自行恢復已依指定文案移除的副標。 來源：[信用卡費桌機現金流說明條][p]。

- **FIN-021｜更早月份信用卡原始帳單匯入**。位置：原始帳單來源與匯入功能。缺原始帳單；由本人提供或自行使用既有功能後再核範圍。此稿不複製私人情境、帳務數字或店家。 來源：[PROJECT 編號1][p]。

- **FIN-022｜學習專區與詞彙牆實作**。位置：docs/learning-hub-contract.md、未啟動前端／資料實作。詞彙短片累積達既定前提後才排；影片製作產線屬獨立專案，本線不接管或催辦；但[交付契約][learning]第三節的兩項跨線責任仍由本專案承接，不以短片累積為前提：讀者測試的「看不懂的句子」要餵回本專案的就地解釋文案；本專案正本的投資規則數字（個股 5%／單一國家 15%／槓桿 1.3 倍等）改變時，須依影片線規則檢查並修改所有尚未發布的 EPxx 正片 scripts/ 與 Notion 詞彙短片腳本。 來源：[PROJECT 編號2][p]；[交付契約][learning]。

- **FIN-023｜S4 自動期末部位對帳**。位置：投資組合對帳功能、台新期末來源。取得可靠帳戶、期末持股及同口徑部位日期後再裁；#722 手動單筆參考首版不結清自動目標，原生未驗範圍保留。 來源：[PROJECT 編號3][p]；[#722][pr722]。

- **FIN-024｜D5 月別／逐檔股息與投組對大盤目標**。位置：配息參考功能、對應來源與期間。先補可靠對應來源與比較口徑再裁；#721 單報表有限換算已交付，原生驗收未完成；不以有限換算結清原 D5。 來源：[PROJECT 編號4][p]；[#721][pr721]。

- **FIN-025｜電子發票 API 即時預算**。位置：未定遠期服務與申請。先有 API 申請及產品規格；不因整頓待辦自行新增第三方服務、訂閱或付費設定。 來源：[PROJECT 編號5／重要決定][p]。

- **FIN-026｜合庫實際多頁版型**。位置：lib/bank-statement.js、TCB 計畫。首次實際多頁帳單被拒時先核版型，再裁校準範圍；合成版型反例不當作銀行真版面已證。 來源：[#678 r1#2][pr678]；[共同待辦][p]。

- **FIN-027｜合庫本人內轉身分判定**。位置：lib/services/bank-import.js 的末碼與分類。實際反覆手改時先提出具體比對方案，交本人保留事項裁示；不可自行放寬本人帳戶判準。 來源：[#678 r1#6][pr678]；[共同待辦][p]。

- **FIN-028｜合庫其他存款種類**。位置：lib/bank-statement.js、TCB 計畫。首次需匯入該類帳單時，由本人選擇跳過該種類或分開列管，再施工。 來源：[#678 r2#3][pr678]；[共同待辦][p]。

- **FIN-029｜合庫密排／多行備註歸屬**。位置：lib/bank-statement.js、test/tcb-transfer-statement.test.js。取得實際版型佐證後，以可公開合成案例核對行距及歸位限制；不讀或保存真實帳單作任意掃描。 來源：[#678 掃描#5][pr678]；[共同待辦][p]。

- **FIN-030｜合庫名稱別名與分類接縫**。位置：lib/bank-alias.js、bank-import.js、相關考題。首次出現實際機構戳時核法人同一性，再請本人決定是否增列；同時核短末碼分類，不逕擴名稱。 來源：[#678 r3#4／r4#1][pr678]；[共同待辦][p]。

- **FIN-031｜AI 解析舊文案本人審改是否結清**。位置：ai-consent.js、ai-key-settings.js、parser-generalization-plan.md。下次調整告知／設定說明或本人提出意見時，比對 #449/#450/#474 及本人後續留痕，只承接仍未結句子，不整份套回舊稿。 來源：[#729 收件][issue729]；[#732][pr732]；[共同待辦][p]。

- **FIN-032｜彈窗焦點外框僅鍵盤操作顯示**。位置：彈窗樣式、前端契約、相關考題。先有本人外觀範圍定案與可完成跨瀏覽器驗證，再獨立處理；不混入後端修補。 來源：[交接原3／#648 待辦][p]。

- **FIN-033｜UI7 與整體原生驗收未驗部分**。位置：docs/ui-acceptance-matrix.md。保留原生選單、跨瀏覽器、列印及手機未驗；#694 個案與有限樣本不能推為全 UI7 完成。手機仍停，其他原生操作需有效授權與可核證據。 來源：[交接原7][p]；[#695][pr695]；[既有階段證據][stage]。

- **FIN-052｜本機加密備份／異地保存的架構與同意前提**。位置：PROJECT.md 的後端前提清單、docs/system-optimization-plan.md 的本機滾動備份段。靜態加密／異地保存屬未定架構；iCloud／外接碟自動備份維持暫緩，須先有「加密備份格式＋明確使用者同意」。待具體架構經技術裁示及本人明確同意後，才評估對應實作與驗證。本項補回既有前提，不新增施工授權；現有 LOCAL 明文取捨不列為缺陷，不承諾改資料庫加密，也不新增服務。 來源：[共同保存前提][backup-project]；[加密格式與同意前提][backup-plan]。

## 停線、封存或其他擁有線（17）

- **FIN-034｜店名規則預覽與保存保護**。位置：原 #747 分支、程式、測試與既有證據。繼續封存、不補驗、不重開、不另 PR 繞過正式阻擋。全部成果保留；只有本人新的明確指示才能重議，且仍須原生核收及正式放行。 來源：[#747 結案][close747]。

- **FIN-035｜Argon High 正式複審接線**。位置：原 #737 分支的 docs/gemini-argon-review-plan.md（主幹未收錄此檔）。維持關閉、停工、停掃；目前只有授權與施工計畫，正式入口未實作。原定等 #747 合併才重開的條件未成；由本人另定時點。本束不含信用卡 openBatchManager。 來源：[#737][pr737]；[#747 結案交代][close747]。

- **FIN-036｜舊 Gemini 初始化與事件容許契約**。位置：scripts/gemini-native-protocol.js。舊方案已停，不因新待辦指派或新掃描入口而自動恢復；需本人新的明確恢復指示及當版裁示。 來源：[GN-01][p]。

- **FIN-037｜舊 Gemini 正式入口錯誤分類**。位置：scripts/gemini-native-runner.js catch。舊方案停線與未啟用沿革保留；不另起通道或補探針來結清。 來源：[GN-03][p]。

- **FIN-038｜信用卡手機隱藏狀態回歸**。位置：test/ledger-split-behavior.test.js、public/styles.css。手機停止；桌機定案並正式啟動手機整體設計，或改到該規則時才補，不提前調手機畫面。 來源：[手機 M10 待辦][p]。

- **FIN-039｜銀行收支手機讀屏順序**。位置：銀行收支手機版面。依 C32 等本人啟動手機整體設計時處理。 來源：[交接原1][p]。

- **FIN-040｜舊 scan archive 建盒改造**。位置：scripts/grok-scan.js 舊 scan 路徑。掃描停止；下次採用舊建盒工作前須先處理各層 attributes、漏檔／改字及盒外 filter 風險。formal blob 路徑已有限處理，不混稱整條完成。 來源：[#675 r1／共同待辦][p]。

- **FIN-041｜舊 scan 的 Git 子行程實收環境覆蓋**。位置：test/grok-scan-flow-repo.test.js、helpers/grok-scan-flow-fixtures.js。掃描停止；與舊 archive 改造同次補直接環境觀察與有效退化反控。formal／previousHead／標籤的有限交付不重做。 來源：[#675 r2／共同待辦][p]。

- **FIN-042｜外部 attributes 遮蔽 diff 的證據與材料修正**。位置：scripts/grok-scan.js 組材料段。掃描停止；若實際當版材料被屬性遮蔽，須先修材料再正式複審。缺完整外部證據不判安全，不逕加 --text 或新增全域診斷。 來源：[#675 掃描反駁／共同待辦][p]。

- **FIN-043｜Codex 平台直接環境量測**。位置：docs/money-guard-operations.md、實際客戶端與全域接線環境。平台／啟動方式變動、反證或已備具體隔離方案才續；不自行新增旁觀 hook 或診斷 wrapper，考題 shell／canary 不替代直接量測。 來源：[平台量測待辦][p]；[既有 Sol A 裁示][platform-sol]。

- **FIN-044｜HOSTED 過期 storeRulesHash 覆寫**。位置：HOSTED 匯入／CAS 路徑。HOSTED 停線；原樣反例限 HOSTED，LOCAL 有限探針未重現。若有新的原樣 LOCAL 反例再窄裁，不藉同檔其他工作恢復 CAS 修補。 來源：[交接原8][p]；[#649][pr649]。

- **FIN-045｜Claude 固定複本安裝與實機驗收**。位置：錢的機械層兩側安裝手續。由原擁有線依本人指示補安裝／實機驗收；Codex 那側通過不結清 Claude 未驗。不自行改全域設定、信任或安全接線。 來源：[交接原10][p]；[#692][pr692]。

- **FIN-046｜HOSTED 寫入版本衝突的使用者提示**。位置：前端寫入錯誤處理。HOSTED 復工時盤點實際寫入點再修；不提前改雲端。 來源：[交接原11][p]。

- **FIN-047｜service_role 等價寫法的考題保護**。位置：test/hosted-store-pg.test.js。HOSTED 復工時補等價反例與有效反控；不能只靠字面形狀題。 來源：[交接原25][p]。

- **FIN-048｜overwrite 第二入口等價寫法的考題保護**。位置：test/hosted-import-overwrite.test.js。HOSTED 復工時補等價反例與有效反控；不提前開雲端修補。 來源：[交接原26][p]。

- **FIN-049｜Grok 放行表對新版 CLI 的真請求核實**。位置：掃描工具、真請求觀測與考題。掃描停止；下次 Grok 升版或放行表實際誤擋時才裁具體方案，不因本稿啟真掃描。 來源：[交接原17][p]。

- **FIN-050｜Grok 腳本升版沿革補記**。位置：scripts/grok-scan.js、scripts/grok-relay.js 檔頭。下次真正升版時順手補日期沿革；不另開純註解 PR，也不因本稿啟動升版或掃描。 來源：[交接原19][p]。

已交付對帳：GS-B01 由 [#728][pr728]、GS-D04 由 [#730][pr730]、Gemini 核收與角色直接回歸由 [#734][pr734]／[#735][pr735] 交付；[#736][pr736] 的新掃描入口程式已合併，不能再列成尚未實作，啟用與實際掃描另按停止安排。

GS-F01／F02 已由 [#741][pr741]、F03 由 [#740][pr740]、F05 由 [#739][pr739] 交付。GS-F04 的資產目標、證券批次、設定管理初載／刪除／分類／內轉保存已由 [#738][pr738]、[#742][pr742]、[#743][pr743]、[#744][pr744]、[#745][pr745]、[#746][pr746] 分別交付；信用卡批次、設定體檢與店名規則分別留 FIN-003、FIN-004、FIN-034。#737 是 Argon 正式複審接線，與 FIN-003 不重複。

桌機欄寬、年月切換、本機保存指引與 TCB 指定拒收題由 [#710][pr710]／[#711][pr711]／[#712][pr712]／[#714][pr714] 交付；F 級文件、favicon、暫存指定覆蓋、記憶體 lint、有限來源帳與輸出超限由 [#716][pr716]／[#717][pr717]／[#718][pr718]／[#719][pr719]／[#720][pr720] 交付。訂閱確認／記帳保存與銀行舊表單未改欄位保存由 [#724][pr724]／[#725][pr725]／[#726][pr726] 交付。這些有限交付不結清來源、原生、並行、平台、歷史根因或其他明列未驗責任；[#721][pr721]／[#722][pr722] 的有限首版不結清 FIN-023／FIN-024 全目標。

以上以實際 merged 狀態及各支限定範圍對帳；PROJECT 的舊「承接／尚待程序」文字作收件與交付沿革閱讀。既有未驗邊界不得推成已證故障，也不得升為已完成。#749 尚未交付的現況列於 FIN-001。

[p]: ../PROJECT.md
[qs-sol]: https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6514104671
[platform-sol]: https://github.com/teacherjung/personal-finance-webapp/pull/689#issuecomment-6171974004
[close747]: https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6620889615
[stage]: engineering-stage-evidence.md
[learning]: learning-hub-contract.md
[issue729]: https://github.com/teacherjung/personal-finance-webapp/issues/729
[pr649]: https://github.com/teacherjung/personal-finance-webapp/pull/649
[pr678]: https://github.com/teacherjung/personal-finance-webapp/pull/678
[pr683]: https://github.com/teacherjung/personal-finance-webapp/pull/683
[pr692]: https://github.com/teacherjung/personal-finance-webapp/pull/692
[pr695]: https://github.com/teacherjung/personal-finance-webapp/pull/695
[pr710]: https://github.com/teacherjung/personal-finance-webapp/pull/710
[pr711]: https://github.com/teacherjung/personal-finance-webapp/pull/711
[pr712]: https://github.com/teacherjung/personal-finance-webapp/pull/712
[pr714]: https://github.com/teacherjung/personal-finance-webapp/pull/714
[pr716]: https://github.com/teacherjung/personal-finance-webapp/pull/716
[pr717]: https://github.com/teacherjung/personal-finance-webapp/pull/717
[pr718]: https://github.com/teacherjung/personal-finance-webapp/pull/718
[pr719]: https://github.com/teacherjung/personal-finance-webapp/pull/719
[pr720]: https://github.com/teacherjung/personal-finance-webapp/pull/720
[pr721]: https://github.com/teacherjung/personal-finance-webapp/pull/721
[pr722]: https://github.com/teacherjung/personal-finance-webapp/pull/722
[pr724]: https://github.com/teacherjung/personal-finance-webapp/pull/724
[pr725]: https://github.com/teacherjung/personal-finance-webapp/pull/725
[pr726]: https://github.com/teacherjung/personal-finance-webapp/pull/726
[pr728]: https://github.com/teacherjung/personal-finance-webapp/pull/728
[pr730]: https://github.com/teacherjung/personal-finance-webapp/pull/730
[pr732]: https://github.com/teacherjung/personal-finance-webapp/pull/732
[pr734]: https://github.com/teacherjung/personal-finance-webapp/pull/734
[pr735]: https://github.com/teacherjung/personal-finance-webapp/pull/735
[pr736]: https://github.com/teacherjung/personal-finance-webapp/pull/736
[pr737]: https://github.com/teacherjung/personal-finance-webapp/pull/737
[pr738]: https://github.com/teacherjung/personal-finance-webapp/pull/738
[pr739]: https://github.com/teacherjung/personal-finance-webapp/pull/739
[pr740]: https://github.com/teacherjung/personal-finance-webapp/pull/740
[pr741]: https://github.com/teacherjung/personal-finance-webapp/pull/741
[pr742]: https://github.com/teacherjung/personal-finance-webapp/pull/742
[pr743]: https://github.com/teacherjung/personal-finance-webapp/pull/743
[pr744]: https://github.com/teacherjung/personal-finance-webapp/pull/744
[pr745]: https://github.com/teacherjung/personal-finance-webapp/pull/745
[pr746]: https://github.com/teacherjung/personal-finance-webapp/pull/746
[pr748]: https://github.com/teacherjung/personal-finance-webapp/pull/748
[minimatch-ghsa]: https://github.com/advisories/GHSA-g3hv-75wg-m249
[pr749]: https://github.com/teacherjung/personal-finance-webapp/pull/749
[eslint-package]: https://raw.githubusercontent.com/eslint/eslint/v10.14.0/package.json
[config-array-package]: https://raw.githubusercontent.com/eslint/rewrite/main/packages/config-array/package.json
[backup-project]: ../PROJECT.md
[backup-plan]: system-optimization-plan.md
