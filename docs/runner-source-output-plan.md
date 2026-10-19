# 正式複審輸出上限與有限磁碟來源帳施工計畫

本工作處理正式複審共用 runner 的最後一段輸出超限未被標記，以及收據缺少來源觀測時點的問題。技術範圍依本輪實際 GPT‑6.1 Sol／xhigh 裁示；推薦代選不代表 William 本人已驗收。本計畫先以預告提交與草稿完成路徑登記，之後才在常設實作樹施工。

## 修改範圍與順序

單一目的為正式複審產物的有限完整性檢查。預計路徑：

- `scripts/grok-scan.js`
- `scripts/grok-review.js`
- `scripts/grok-disk-snapshots.js`
- `test/grok-output-cap.test.js`
- `test/grok-disk-snapshots.test.js`
- `test/grok-review.test.js`
- `test/grok-scan-flow-review.test.js`
- `docs/project-collaboration.md`
- `docs/runner-source-output-plan.md`
- `PROJECT.md`
- `settings.json`
- `PROJECT-SETTINGS.md`
- `test/acceptance-table.test.js`

先將完整範圍登記為草稿並完成施工計畫，再於常設實作樹加入來源 helper、輸出收集器與正式用途接線，同步契約及待辦狀態。按高風險準備全審，正式送審時仍依當時差異重算。共用檔清單的樹外準備查核沒有命中套件檔；正式改檔後須再核對。列入快照的套件入口只讀取，不修改。

## 輸出保留與拒收

stdout、stderr 各自保留 `8 * 1024 * 1024` 個 UTF‑16 碼元。資料事件使用既有 UTF‑8 串流解碼；接入每段前檢查目前長度加本段長度。恰等上限可收，跨線段整段不收，超限旗標保持，後續資料排空但不累加。兩通道不改為合計門檻，也不更改 final 選取使用的 UTF‑8 位元組座標。

任一通道超限沿原無效與清理路徑返回，沒有可採計 review、結果包或正式前端收據；診斷不得帶出受控輸出內容。既有非零、模型資格、DLP、程序群組收尾與 final 選取檢查保留。

## 磁碟來源與觀測時點

固定宣告位於 helper，來源根取實際模組位置。專案來源為 provider、runner、relay、canary、audit、auth refresh、final selection、來源 helper、gitEnv、isMain 及 sandbox profile。套件來源另標為列名入口：review launcher、platform、協作欄位閘、待裁清單、風險分級與結論閘。套件入口不是所有間接相依的閉包。

| 擁有者 | 階段 | 用途 |
| --- | --- | --- |
| provider | `before-preparation` | 開始本輪準備前讀取固定來源 |
| provider | `before-provider-output` | 寫正式輸出與收據前重新核對 |
| runner | `before-box` | 建盒及第一次未信任程序前讀取 |
| runner | `before-relay-spawn` | 實際 relay 子程序啟動前核對來源與 profile |
| runner | `before-runner-result` | 形成正式 runner 產物前重新核對 |

每列保存相對檔名、固定角色、SHA‑256 及位元組長度。實際啟動的 relay 另記，受控測試替身標為 `test-substitute`，不以預設 relay 的雜湊代替。正式入口不增加任意來源路徑參數。

固定檔案缺失、不是一般檔案、讀取失敗、階段或集合不完整、角色或值格式異常、來源前後不同，均拒收。前置已知錯誤在啟動模型前停止；後置錯誤清除本輪可採計產物。provider 驗證並承接 runner 回傳的同一份帳與其雜湊，自身快照另列。

`scanScriptSha256` 保留為 runner 建盒前磁碟快照的相容欄位；`profileSha256` 沿同一張前置快照取值。正式用途的人讀配方指明磁碟快照時點。舊 provider／runner 事後單一雜湊欄位由具時點的來源帳取代，歷史收據不重寫。

## 證據界線

前後雜湊相同只支持所列檔案在各次觀測時內容相同。它不能證明 Node 已載入映像、所有間接相依、每次 profile 的實際讀取映像，或排除中途 A→B→A 與讀檔競態。未來若以載入身分作安全判定、改換載入方式、擴充來源，或發現有限來源帳漏掉的替換反例，再另裁受控載入架構。

來源帳不讀真認證檔、個人帳本或憑證，也不對這些機密計算公開雜湊。既有材料、版本、模型與 final 證據各自維持原射程。relay 診斷收取上限不在本支修改；本支不宣稱 relay 全輸出完整保存。

## 驗證與交付

輸出直接題涵蓋低於、恰等、超過、最後段跨線、兩通道各自上限、中文與非 BMP 符號、拆開 UTF‑8 字元的串流保存。正式用途以假模型和假 relay 真走原生沙箱，驗超限拒收、無 review 及清理；不發模型請求或替代正式複審。

來源直接題以獨立期待值驗固定列名、角色、hash、階段與實際 relay。正式流程放同名受審誘餌，核對帳仍來自執行來源；以各自新建的隔離副本在準備、relay 啟動前或模型執行後更動來源，驗拒收與清理。provider 收到缺帳、缺列、缺階段或錯值時不產出。反例須區分單張帳的有效性與多張帳的前後一致性，不能讓後者代替前者的獨立證明。

各新核對接縫使用有效突變：保留來源更動或實際替身執行，移除比較、改錯取值位置或放過無效帳，對應行為斷言須失敗；每次先有正常基線，最後還原並重驗。原失敗與修正重跑分開留存。

樹外匯出副本沒有 `.git`。既有 Git 身分／髒環境題須在真正實作工作樹原樣補驗，不能改 ROOT、加 skip、借另一棵 `.git` 或以其他測試代替。正式推送三關、最新 CI、Grok 全審與 F7 核對照常完成；未完成前不把樹外候選登記為交付。合併後驗收由工具算出，再依本輪代選授權執行並如實留痕。

## 回復與停止線

未合併時只撤本支登記差異並保留證據；合併後如需回復，循正式程序回復本支 squash commit。沒有資料格式搬家，不改帳本、備份或共用相依。來源拒收不是跳過檢查或改填歷史雜湊的理由。

本支不改禁區設定、安裝或信任，不新增金融操作。原生工具、手機及 HOSTED 的既有停止線保持，掃描仍停止；保留本人對 Gemini 複審試用的新授權，本支不宣稱其認證、登記或正式資格已完成，也不新增 adapter 或模型請求。若實際差異擴及 A5 登記範圍或放寬既有安全條件，依原規範另行處理，不以本計畫視為本人同意。

## 正式落地前的候選補證（2026-10-19 UTC）

- 依實際Sol全文 https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6276357034 與配對 https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6276358161，新自有副本只補本候選新增／改到的失敗指路；六檔逐項位置反轉可還原原位元組，四個靜態常數只供assert message，來源helper保持原hash。provider原stop已有通用指路，本次只是補精確來源帳落點，不誇稱原診斷完全沒有指路。
- 新版容量／來源帳直接24題、provider9題、原生合成flow7題通過，均無skip；型別、lint與六檔格式檢查通過。證據finance-runner-message-repair-proof.json、finance-runner-message-candidate-audit.json，以及各類message檢查收據。
- 容量代表反控保留append操作，只退化跨線判斷，指定斷言因abcde對空字串紅，且實際印出collectDecodedOutput及重跑指令；基準／突變／還原0／1／0，見finance-runner-message-mutation-proof.json。
- 舊來源帳digest編排依賴完整診斷字面值，本次另以唯一比較式定位重驗該組，保留假runner壞帳與收件操作，指定result.code由0對2紅，0／1／0，見finance-runner-message-digest-mutation-proof.json。其餘舊編排若以完整assert結尾定位，正式承接須改按同一斷言的參數前綴／語法位置核唯一性，不把定位失敗算成保護紅。舊有效反控按原hash保留，不宣稱全部在新版本重跑。
- 獨立runtime訊息probe核provider1題與flow6題，保留原code、無正式產物及清理斷言，另核來源帳hash／前後來源拒收及stdout、stderr超限的完整診斷包含修改位置、完整啟動指令與相應合成題命令；均通過，見finance-runner-runtime-message-proof.json。probe不是正式候選測試，沒有把新判準混進候選。
- 先前gitless副本未能驗的既有Git身分／髒環境題，仍須在真實實作樹原樣補驗。正式三關、CI、Grok全審、F7、合併及驗收未完成；不以這些樹外結果代替。依正式順序裁示，#719收官之後才開始本支D3與實作，之後接D5、S4。

## 逐槽完整性的行為補證（2026-10-19 UTC）

- 原純訊息候選的有限驗證入口接受了 files 同索引洞位與單槽 sparse progress；原探針與舊 helper hash 原樣保存。這只證記憶體驗證入口缺口，不證正式流程曾保存稀疏壞帳。依實際 Sol 全文 https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6276538392 與配對 https://github.com/teacherjung/personal-finance-webapp/pull/718#issuecomment-6276539555，同一 runner 工作、正式 D3 前補正，不另開產品待辦或混入 #719。
- 新行為版只改來源 helper 與來源帳考題。files 與 snapshots 保留原陣列／長度判準，每個索引先驗 Object.hasOwn，再跑原列名、角色、hash、位元組、phase、時間及前後一致性驗證。缺槽與由私有陣列原型提供合法元素皆明確拒收，不用整理輸入掩蓋缺列，不建立通用原型或 Proxy 安全框架。
- 新版完整來源帳20題、provider9題及來源流程5題通過，均無skip；型別、七檔lint及格式核對通過。四組反控分別退回 files／snapshots 跳洞迭代，或只移除相應自有槽位條件；每組基準／突變／還原0／1／0，指定拒收斷言因 Missing expected exception 紅，沒有語法、模組或 TypeError 代打。逐場日誌、來源／考題／突變 hash 與清場證據見 finance-runner-sparse-mutations-proof.json。
- 新 helper hash 2a2e27180064921013654015ac1162bc6d192a3364ef457bfefabc40eb1b7bb0；考題 hash 816c3295b271e1e5436bcb8e25332ce609c5dd9449355082074f3d753f3cf053。來源表及檢查收據見 finance-runner-sparse-latest-preparation.json。這是行為變更，前節六檔反轉只證當時純訊息版本，不能套用於新 helper；未變容量與舊來源反控保留各自 hash，不稱全部在新版本重跑。
- 真實工作樹的 Git 身分／髒環境題、正式三關與 CI、Grok 全審、F7、合併及驗收仍待正式流程。正式順序維持 #719 收官後才開本工作，之後 D5、S4。

## 新來源檔分級與設定適用核對（2026-10-19 UTC）

依[實際 Sol 全文](https://github.com/teacherjung/personal-finance-webapp/pull/719#issuecomment-6277148693)及[本題配對裁示](https://github.com/teacherjung/personal-finance-webapp/pull/719#issuecomment-6277149848)，在本工作精確完成新 helper 的初次 E 級登記，正式預約涵蓋上述十三路徑。settings 的既有完整錨定 scripts 名單只新增 grok-disk-snapshots 一名，其他家族、未知 C、級別順序及原考題保持；人讀產物由 node tools/build-settings.js 重產，不修改套件工具。

守表題新增 helper 完整結果的 E／known:true 正控，及 future 後綴、不同副檔名、前面多一段目錄等有限近名未知 C 負控。新檔真正追蹤後執行原全追蹤檔題與既有正控，不用樹外無 git 的結果替代。移除精確新名稱及放寬成接受指定近名兩組反控，均先綠、唯一定位、因預期分類斷言紅、還原綠；保留 hash 與原日誌。新增診斷帶 settings.json、產物重建與守表重跑指路。

本支包含 settings.json，正式預期為 F＋E，仍以當版工具輸出記錄。依現行 F 適用規則核對 settings 除該 acceptance 名稱外語意不變、forbidden 完全相同，固定複本其餘輸入、已用範本、生成接線、測試鈕本體／登記皆無差異；留存純指紋或等效完整輸入對帳。核實符合時記錄本支不觸發換組、重新信任或安裝驗收，不宣稱兩側實機或歷史缺項已完成，不讀真實家目錄信任資料、不做安裝。若真正安全輸入改變即停下重新走適用手續與本人保留事項。這項精確初次登記不新增 A5 同意；仍查叫停與未答待裁。

#719 已完成正式合併、交付及收樹；這只解除施工排序前置，不代替本支的正常推送、CI、高風險全審、F7與合併。其非阻塞型別射程註解待辦在本支 PROJECT 歸位，保留一句話、落點及觸發條件；本支不順手改那則註解。

## 正常推送的入口失敗與限定修復（2026-10-19 UTC）

f16b3ac9 的正常推送被入口守門擋下：新 helper 直接執行為空輸出，當趟 5269 題、5261 通過、1 失敗、7 略過；型別與 lint 通過。原日誌及版本保留，不能以先前直接組通過取代完整門。依[實際 Sol 全文](https://github.com/teacherjung/personal-finance-webapp/pull/720#issuecomment-6277570534)及[配對裁示](https://github.com/teacherjung/personal-finance-webapp/pull/720#issuecomment-6277571875)，在同支原十三路徑內沿既有同族模式，補 isMainModule 的直接啟動固定拒絕診斷與退出2；正常 import 不自行觀測來源。入口守門與 NO_OBSERVABLE_OUTPUT 完全不改，不移動 helper 或另開 PR。

來源帳考題的實際 is-main 依賴使用真來源；新行為題走直接兩次、連結一次及真檔案 import，並在私有子程序觀察已用 readFileSync／lstatSync 接縫。此觀察不代表所有檔案 API、網路或任意背景副作用已受監控。移除拒絕分支、讓 import 也執行拒絕、錯回退出0及載入時真呼叫採集的有限反控須各自先綠、斷言紅、還原綠。新 helper／考題 hash 與直接組、反控另留，舊版證據不改寫成新版本重跑。

[K5 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/720#issuecomment-6277506973)的 PROJECT 容量待辦補正一併完成，保留共用整輪拒收旗標的真實設計。新 HEAD 仍需正常三關、最新 CI、Grok 全審、F7 與合併後適用核收；本節不是交付證明。
