# 舊驗收腳本名單清理施工計畫

原第18項已由 [#696](https://github.com/teacherjung/personal-finance-webapp/pull/696) 合併；本項以該合併版本 6186384af2eb3ecd0e7240583d3fb9c495a610a9 為基底。開工重核理財沒有其他開放 PR、待裁未回0則，五路徑均非共用檔，套件109筆一致；保留套件文件工作及其他實作樹的未提交改動。先提交本計畫並開草稿預約，再改程式及設定。

## 目的

移除已刪舊腳本的驗收 E 豁免。若未來有人重建同名檔，應依未登記路徑的 C 分級，不因歷史名字直接免驗收。保留其他明確腳本分級、Gemini 原生 C 家族、F 級、順序及 unknownTier。

## 證據前置

- 原刪除合併、當前不存在及未追蹤、刪除提交為祖先：已有準備收據；實作前對本支真正基底重核。
- #613、#614 2026-10-16 UTC 的官方補算均 F＋E，#624 為 E，退出均0，路徑總數對帳成功；明標現在補核，不追認歷史執行。
- 原三支公開收官已具體記分級與適用動作；Sol 依原收官與當時差異確認歷史分類前置已足。這不代替本支的基底／最終固定來源與投影比對。
- 公開裁示與補充：
  - https://github.com/teacherjung/personal-finance-webapp/pull/695#issuecomment-6223320263
  - https://github.com/teacherjung/personal-finance-webapp/pull/695#issuecomment-6223320933

## 最小範圍

- `settings.json`：只刪腳本 E 正規式裡的八個完整 alternatives。
- `PROJECT-SETTINGS.md`：正式產生器重產，只對應該設定差異。
- `test/acceptance-table.test.js`：改延期理由及舊名 E 斷言，新增逐名 unknown/C 守門；保留其他家族與表的完整性。
- `docs/acceptance-old-script-cleanup-plan.md`：本計畫定稿。
- `PROJECT.md`：本項及本 Session 已完成階段的必要狀態歸位，不覆寫其他工作線或把未驗收項結清。

八個舊名：check-ci-really-ran、check-cross-pr-merge、check-pr-collab-fields、check-pr-merge-gate、check-review-verdicts、check-worktree-integrity、acceptance-tier、pending-rulings，均為 `scripts/<名稱>.js`。

## 機械層與驗收

保留整支 F 分級。依真正基底與最終提交比較 forbiddenOnly 投影位元組、三個其他固定輸入及總指紋、guard-copy、hook 範本與現有接線來源；僅在全部不變時記本支沒有新增安裝差異。既有 Codex 實機完成及 Claude 待補分開保留，不以此項結清。

不抽新複本、不換路徑或命令、不編輯活動 hooks、不代按信任或試用金融工具。若需要變更固定輸入或接線，停止套用無新增本人動作的結論，依具體來源另處理。

## 驗證與程序

1. 先用原表跑既有守表題，保留基準。
2. 實作後八個完整路徑逐名斷言 known:false、既有 C；其餘腳本明確 E 及 Gemini 原生 C／未知、F 與表序保護保留。
3. 分類候選對照：完整 acceptance 結構只差八名；固定投影及其他來源完整位元組不變。
4. 在獨立副本把每個舊名各自放回 E，對應題應逐次紅；先確認唯一替換目標存在。
5. 產物同步、共用檔查核、舊文字掃描、自審、推送三關、雲端成功、Grok 正式複審及 F7；第一次通過後核 Gemini 合法入口，不可用如實記未執行，不阻擋合併。
6. 正式合併與合併後分級維持 F；以具體不變證據說明沒有新增安裝動作。完成後更新 Notion、公開收官與逐項佇列，收自有暫存。

## 回復與風險

回復本支提交可恢復歷史 E 名單；回復本身不授權修改禁區。主要風險為刪錯正規式項目造成分類過輕，或把 F 誤解成免驗收；因此逐名負面考題、其他家族保持與完整差異核對是本項驗證重點。

## 階段歸位範圍（施工前明列）

依 [Sol 窄範圍裁示](https://github.com/teacherjung/personal-finance-webapp/pull/695#issuecomment-6223788006)，PROJECT 只更新本線原第2、7、10、18、22、23六條：各按實際合併與本人驗收來源分列；第7移除原生選單的能力全稱並保留未驗範圍，第10保留Claude待補，第18按#696已合併結果記限定欄位完成，第23用本PR來源式記錄不預填合併。其他工作線與全UI7未完成範圍保留，不附帶新產品決定或改驗收門檻。
