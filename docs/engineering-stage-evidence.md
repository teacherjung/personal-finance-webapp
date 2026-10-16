# 工程階段證據盤點

## 範圍與來源

本次只把已量到的反例、有限桌機證據及未完成範圍歸回共同快照：本索引、PROJECT 原5／6後續／24／7／23、UI驗收矩陣相關證據欄。不改程式、CSS、契約判準、考題、手機或雲端。

受測來源固定為 `6186384af2eb3ecd0e7240583d3fb9c495a610a9`，測量日為2026-10-17（台灣時間）。Codex 在 IAB 操作1280×900桌機，使用獨立種子資料；外部來源以不可用的合成回應代替，沒有接真實財務資料。這是實作者瀏覽器證據，不等於 Grok 正式複審、William 視覺驗收或全部瀏覽器。不能把本次案例數當成未來路由上限。

## 原5：整組刪除前提不成立

[#656原複審](https://github.com/teacherjung/personal-finance-webapp/pull/656#issuecomment-5936658121)所列三條為 `.cashflow-summary-head span`、桌機 `.cashflow-stat p` 及手機同類規則。受測版本第一個選擇器命中兩個可見的年月選單箭頭 `.cashflow-select-arrow`，不能再依「三段都沒人用」整組刪除。這不證明每一個CSS屬性都影響圖示，也不證明刪除必然改變外觀。

`.cashflow-stat p` 只在本次桌機DOM命中0；不能延伸為所有狀態、手機都永遠不用。保留為樣式整理時重新查核的候選；現有其他工作線的樣式預約未解除，本支不改樣式，也不回改#656歷史原文。

## 原7：有限桌機與原生操作

受測版 ROUTES 對應的12個頁面逐頁載入，取頁面DOM寬度、頂部截圖及逐頁console error／warn；該次逐頁紀錄均為空。頂部截圖不是全頁視覺驗收，僅銀行收支及訂閱截圖另經實作者目視。沒有保存表單、實際上傳、券商同步、列印或手機操作。

下表每案均以原生Enter開窗，取一次Tab、一次Shift+Tab後仍在彈窗內，再以Escape關閉並回到該入口；不是完整Tab循環或該頁全部彈窗。

| 路由 | 入口 | 彈窗標題 | 開窗焦點 |
|---|---|---|---|
| `#dashboard` | `fxInfo` | 匯率從哪裡來、預設值是什麼 | dialog |
| `#cashflow` | `addCf` | 記一筆收支 | `f_flow` |
| `#transactions` | `uploadStmt` | 上傳信用卡帳單 | `f_file` |
| `#assets` | `editTargets` | 設定目標資產配置 | dialog |
| `#bank` | `addBankAcc` | 新增帳戶 | `f_name` |
| `#ib` | `totalValueInfo` | 總市值 | dialog |
| `#securities` | `secBatches` | 匯入紀錄 | dialog |
| `#subscriptions` | `addSub` | 新增訂閱 | `f_name` |
| `#cards` | `addCard` | 新增卡片 | `f_type` |
| `#insurance` | `addIns` | 新增保單 | `f_policyName` |
| `#settings` | `manageCatsBtn` | 支出分類管理 | dialog |
| `#stock?symbol=AAPL` | `編輯研究` | AAPL 研究卡 | `f_thesis` |

另在銀行收支「記一筆」表單的 `f_flow` 原生選單，以Space展開並觀察AX expanded，再Down／Return，由「收入」變「支出」，焦點仍在選單，最後取消。沒有程式選值或派送事件替代；此證據只涵蓋這個IAB選單，其他選單與瀏覽器仍未驗。

銀行收支寬表格實測寬1080、容器968、overflow auto，頁面DOM寬1280與viewport相同。這支持該次頁面未整體溢出、表格在自己的容器內捲動；不是全內容無截斷、無捲動或本人視覺已通過。其餘完整主要流程、跨瀏覽器、列印適用範圍及手機仍依[驗收矩陣](ui-acceptance-matrix.md)保留。

## 原6後續與原24：仍未修的反例

- **原6後續，同頁重畫。** 專屬種子資料先顯示7列，以原生Enter啟動現有快照，1次snapshot POST後觸發同頁router；1次transactions GET合成503後，工作區消失、0列，只剩「載入失敗：合成讀取失敗」，沒有重試按鈕。這只重現同頁清空的路徑；不是銀行匯入與全部競態已測，更不是修法已通過。
- **原24，訂閱列操作。** 合成訂閱s3以原生Enter啟動「標記考慮停用」，1次PUT與1次subscriptions GET後按鈕成「已標記考慮停用」，焦點卻落BODY。另有既有cards／history讀取；不由請求數推算全部render次數。未修缺口不因共用彈窗抽樣通過而結清。

原3的鍵盤外框、原4／6的四種重讀狀態、原24的八種回焦情境另有獨立HTML候選演示，原4／6也有技術準備。示意不是正式來源回歸、正式功能修復或本人E10定案；產品文字、位置與回焦選擇仍待定案後另支施工。

## 原23真正收官

[PR #697](https://github.com/teacherjung/personal-finance-webapp/pull/697)已合併為 `0ee33e9e70abb41f4ba594e2ea67fbcd5fb1d315`；[完整收官](https://github.com/teacherjung/personal-finance-webapp/pull/697#issuecomment-6225245094)分列正式Grok通過、合併閘、合併後F＋E與沒有新增安裝差異的依據。本支不把F降為E，也不把#692的Claude待補、平台直接量測或全25項一起結清。

## 私有收據索引

下列是本 Session 保存的私有收據檔名與SHA-256，**不是公開附件連結**。未將實體機器路徑、暫時預覽網址或原始財務內容寫入公開倉庫。公開可讀的是上述有限結果；日後採計原始收據須另核實際位元組與適用來源，不能只憑摘要推廣。

| 私有收據檔名 | SHA-256 |
|---|---|
| `next-item5-source656-20261017.json` | `9e667c61a4de19e17d1f8a01bf99c348e70be257c801ea6f2106ee85f2484d7a` |
| `next-item5-unused-css-dom-20261017.json` | `dec54eaeee1d616e3a3bd1a1192c1ef5e2b83a58cadacde9de6de9a391ac3a2d` |
| `next-item5-summary-spans-20261017.json` | `d024b9e117dad7ad3570aad4ca3d76fd5ae12ca1f8845a73130371d1c4b1fe4d` |
| `next-item7-desktop-routes-20261017.json` | `3d808d7c14dea401a0e37ff9657df890951d460137a4a826507d3dea556adb30` |
| `next-item7-route-controls-20261017.json` | `0256c2bf467ca18486ceca0132bdfd13c497c09b1cdda9144a618e02dcd5e5fe` |
| `next-item7-native-keyboard-20261017.json` | `b12032dbe479265ab80fe1a75fa4c789060b206e8980edf06f81d419ec7a6a54` |
| `next-item7-native-select-20261017.json` | `21757bc52b479a16a1afa8d468402b894b4141e06a334bd9dd8d2ae71ee5e41f` |
| `next-item7-cashflow-clipping-20261017.json` | `b3359236f6fac303616198ea6ea8ca1bec18b2f373592c30436c96d096859681` |
| `next-item24-native-enter-20261017.json` | `ffd9e5eed06683bb5f04ac0f4a00f9cf833118bc05319253836c42ea567ed8f8` |
| `next-items4-6-router-failure-baseline-20261017.json` | `b2674afec85fc40c94ffccea7b434d0f7a4a91a1c879580c87c932dd5bdd07a2` |

## 續作與復原

本索引不改「何時算已驗收」的門檻，不批准任何候選畫面。原5待樣式預約解除及相關狀態查核；原3／4／6／24的正式畫面變更仍須各自E10，並完成正式回歸、突變與獨立複審。全UI7、Claude待補、歷史證據及手機／雲端停止線各自保留。

本支只歸位證據，正式推送、雲端、Grok、掃描可用性、合併及合併後分級依共同入口；實際結果留本支PR，不預寫通過。回復本支文件提交即可撤銷歸位，不改資料或程式行為。
