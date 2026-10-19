# 單報表配息參考換算施工計畫

## 目的與範圍

在投資活動的 IB 現金流卡提供「報表配息等值換算」：使用者自填參考單價（USD／單位），以該報表股息與替代股息的稅前合計除以單價，得到參考單位。完整列出報表起訖日與資料品質；不選證券、不帶入報價、不持久保存單價，不表示可動用現金或購買建議。零與負值保留中性金額／沖回語意。

本支承接 [Sol 排程裁示](https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6276042088)，在 #720 交付後先做 D5 有限首版，再接 S4。期間與品質技術裁示原文隨本支公開；這份計畫不代表已實作或驗收。

## 資料資格與保存

- 新增可選封閉來源欄位 `income.periodBasis: 'ib-flex-single-statement-v1'`，只由同步服務在 `statementCount === 1`、完整真實日期且起訖有序時，與當次收入一同產生。缺計數不能視作一份，多 statement 仍整包拒收。
- 日期沿原 Flex 字串保存；只把完整八碼字串轉成 ISO 形來驗真。抽出 schema 原樣 `isRealDate` 至零依賴日期模組，保留 schema 原具名 export，不改年份、閏年或時區語意。
- 新收入缺失照既有流程清空；新收入期間不合格時，不繼承舊標記。同步之外的讀頁、還原、目前月份與 lastSync 不產生新來源證據。
- 兩個 settings sanitizer 共用 metadata 版本及跨欄判準。合法 metadata 隨同一收入備份還原，只代表恢復記錄，不代表重新向 IB 核對。一般設定 PUT 仍不能寫 income。
- 同支窄修還原入口漏驗 `skippedNoCurrency`：共用收入數字欄名及既有有限 number 判準；不改全域 isNum、一般 PUT 白名單或匯入整包拒收政策。負數、小數的既有保存容忍保持，換算資格另驗。

## 換算與畫面

- G 僅為有限數字的 dividends＋paymentInLieu；不含扣稅、利息或其他金額，缺值不能補零。四個品質欄 count、skippedNoFx、skippedNoCurrency、estimatedNoFx 均須實際存在且為非負安全整數；已知略過不出結果，含估算時明示。
- P 必須完整解析為有限正數，單位固定 USD／參考單位；缺值、非法值與溢位各有具體原因。非零 G 除以合法正 P 下溢成零時拒算；真零及可表示的極小非零結果保留，不加任意最小門檻。Y 以「約…參考單位」顯示，負號含指數均用 U+2212，不取整成下單數量。
- 缺標記、未知版本、壞日期與倒序不產生 Y。活動卡與列印共用完整日期／未知說明；舊紀錄列日期時明說期間尚未核對，不能簡寫成完整某月。
- G 的顯示由既有 moneyCur 注入，固定 USD；計算使用未經顯示四捨五入的記錄 G 與本次輸入 P。就地說明兩者差別，以 G=12.5／P=2 得6.25、小額顯示四捨五入及下溢反控驗證，不改共用格式器。[Sol 數值／呈現原文](https://github.com/teacherjung/personal-finance-webapp/pull/721#issuecomment-6279143714)。
- 純模型與輸入事件分檔；注入本輪 income 快照、格式工具及 isCurrentRender。每次重繪重建輸入，舊 generation 事件不得修改目前頁面。不把臨時單價／結果加進列印。
- 沿現有桌面樣式與格式器，不新增手機版面、外連、API 或券商操作。整塊換算 panel 使用專屬 class，預設 display:none，僅在 @media screen and (min-width:901px) 顯示；不借其他工作面的類別，不改窄版既有卡片結構，不增加 resize listener。就地說明替代股息、稅前口徑及沒有核算可動用現金。

## 完整預計路徑

- `lib/services/ib-sync.js`
- `lib/types.js`
- `lib/schema.js`
- `public/modules/calendar-date.js`（新）
- `public/modules/ib-income-period.js`（新）
- `public/modules/portfolio-dividend.js`（新）
- `public/modules/portfolio-dividend-actions.js`（新）
- `public/modules/portfolio-activity.js`
- `public/modules/portfolio.js`
- `public/modules/portfolio-report.js`
- `public/styles.css`
- `test/ib-sync-integrity.test.js`
- `test/settings-roundtrip.test.js`
- `test/settings-value-kinds.test.js`
- `test/portfolio-dividend.test.js`（新）
- `test/portfolio-dividend-actions.test.js`（新）
- `test/portfolio-activity.test.js`
- `test/portfolio-report.test.js`
- `docs/contracts/investment-sec.md`
- `docs/contracts/data-storage.md`
- `docs/field-ownership.md`
- `docs/contracts/README.md`
- `test/contract-split.test.js`
- `docs/daily-insights-engine-plan.md`
- `PROJECT.md`
- `docs/dividend-equivalence-plan.md`（本計畫）

日期 helper 歸資料儲存，期間／換算 helper 歸投資；依實際責任在路由與 MANIFEST 同步登記。這次不改同步點節標題或「改這裡」的既有觸發入口；若實作需要改到同步點索引，先補 D3／D5 再動。不修改 lib/ib.js 彙總、repo/store/core、seed 或套件擁有檔。

## 驗證與交付

1. 合成正式服務：單份短期與跨月可產生資格；多帳戶、同帳戶不同期、同期間 bundle 及末份無收入均保持整包拒收及本題原庫。保留同步操作、破壞拒收時題目須紅。
2. 合法日期但缺標記須獨立拒絕；新收入缺／壞期間不能沿用前次標記。服務、櫃檯、匯出還原與普通 PUT 分別走真操作；保存型種本題新值並見證操作確實執行。
3. 兩 sanitizer 各自驗明確期望。非法品質剝除且回報，缺欄保留未知；LOCAL HTTP 驗還原及 PUT 保存，直接 repo 非法數值仍拒收並保留原庫。正式當版證據不借修前探針代替。
4. 純模型驗 G／P、PIL、稅息排除、四品質欄、缺值、估算、負沖回、完整日期與溢位；每項必要守衛有有效突變。原 schema 日期入口與抽出 helper 結果一致。
5. DOM 行為驗輸入、清空、非法值、鍵盤操作及重新渲染／離頁的舊事件失效。核對整塊 panel 的預設隱藏、screen 901px 顯示及列印排除，避免窄版殘留輸入或文字。CSS／DOM 題不能冒稱瀏覽器實際排版、鍵盤 Tab 順序、本人實看或跨瀏覽器驗收。
6. 直接題與有效突變完成後正常三關推送、最新 CI、Grok 當版正式全審及 F7，才走官方合併與 H6。內容涉及收入資料資格，按高風險完整審查；新檔已有 public／test／docs 家族，不調驗收表。

預計分級 C＋D＋E，以官方當版結果為準。核心驗收：開本機投資活動；在合成單份有效報表上輸入參考單價；完整日期、稅前合計與 G÷P 結果一致，無資格時顯示原因且不出數字。既有原生工具停止限制保留，無法實測的項目明列，驗收代選不冒稱本人已看。

## 未完成邊界

本支不完成月別／逐檔事件、稅後可購股數、大盤比較、期末持股對帳或真帳核對；這些仍各有來源與定義缺項。沒有讀真實 store、帳單或憑證。HOSTED、手機設計及掃描仍暫停。有限首版完成不可寫成原 D5 全數完成。
