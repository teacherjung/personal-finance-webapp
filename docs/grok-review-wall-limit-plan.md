# Grok 正式執行上限 60 分鐘施工計畫

## 需求與授權

本人要求：「正式入口有既定的 50 分鐘執行上限：幫我改成60分鐘」。[本人原話留痕](https://github.com/teacherjung/personal-finance-webapp/pull/704#issuecomment-6247514029)。這只延長後續 Grok 執行的牆鐘上限，不承諾模型需時，也不重新受理舊結果。#704 的正式場來源與 50 分鐘計時保持原紀錄；本工程另支處理。

技術接法由實際 GPT‑6.1 Sol／xhigh 核定：Grok 60 分鐘、預換門檻 70 分鐘、Gemini 自有上限 50 分鐘。預換與牆鐘維持 600 秒差額；這是原接線的數值餘裕，不是已量到服務端憑證剩餘壽命或任何前置準備後仍有完整餘裕的保證。

[接線完整裁示](https://github.com/teacherjung/personal-finance-webapp/pull/705#issuecomment-6247914729)與[歷史凍結稿歸屬裁示](https://github.com/teacherjung/personal-finance-webapp/pull/705#issuecomment-6247916264)分別保留，不作正式複審放行。

## 範圍

- `scripts/grok-scan.js`：`GROK_WALL_MS = 60 * 60_000`；原整場 timer、程序群組終止及收尾繼續使用此值。
- `scripts/grok-auth-refresh.js`：預設提前刷新門檻 4200 秒，保留既有父程序 refresh、白名單重建假 key、原子寫回及錯誤拒收；修正時間關係的說明。
- `scripts/gemini-scan.js`：用本模組固定 50 分鐘常數，同時供預設和最大值檢查，解除對 Grok 常數的耦合。
- `test/grok-scan-flow-repo.test.js`、`test/grok-scan-flow-preflight.test.js`、`test/gemini-scan.test.js`：延伸既有合成測試，既有保護斷言保持；量真正排入的 timer 與 refresh 邊界，不能只測常數。
- 本計畫。

不改 CLI 模型／推理、版本釘值、CPU／檔案／程序數限制、sandbox profile、網路、轉送器白名單、憑證欄位、DLP、final-selection、正式收件判準或合併閘。Gemini 固定提供者不自動換版、舊資格不轉用為新來源資格。不讀真憑證、不啟動裸 CLI 或額外認證探針。

## 分工

獨立暫存樹從已合併的主幹開始，不在 App 主目錄施工。開工、送審及合併前重新核 D1、D5、理財 PR 名額及其他 Session 的實際／預約路徑。#702 的瀏覽器掃描擴容與收件工作不碰；其固定提供者、資格與實際掃描仍由原工作線處理。

既有歷史凍結稿不作本支來源、也不覆蓋或刪除；其精確來源與當場分工核對保留在本支技術留痕。新增重疊或未完成裁示不能沿用舊快照放行。

## 驗證與突變

1. 正常合成基線先綠。Grok 精確 3600000 ms，與預換門檻差額 600000 ms，原 wall 小於預換門檻保護保持。攔截合成程序內真正排入的 timer，受控觸發後仍終止原程序群組、拒收並收尾；不真的等待一小時。
2. 用固定現在時間與本題專屬假認證，實走預設 refresh：剩65分鐘應換、70分鐘等號應換、超過70分鐘不換；核呼叫次數、釘住目的地、寫回與給盒子用的假key。既有失敗保留舊檔等測試保留，不打真服務。
3. Gemini 不傳 wallMs 時排入3000000 ms；既有合法短值能跑，超過50分鐘即使未滿Grok60分鐘也拒絕並清理。
4. 有效突變至少涵蓋 Grok 留回50、timer錯值或不終止、預換留回3600／等號錯放行、零差額，以及 Gemini 預設或上限任一處再接 Grok。先核替換目標，正常基線先綠；保留受測操作，紅必是斷言，不能拿語法或fixture崩潰充數。
5. 正常完整型別、格式與考題及當版雲端照跑。高風險，正式Grok全審、F7核對、通過後試當場合法Gemini入口並依G3留實際結果，再原官方全閘合併。候選 timer 考題與正式入口實跑分列；不宣稱整輪跑滿60分鐘。H6依正式分級執行。

## 完整驗證失敗與測試接法補正

第一次完整推送的型別與風格檢查通過，但新增整場 timer 題在清理初始群組 SIGKILL 收到 EPERM，runner 拒收、整場退出1。舊夾具在 shell 回覆前插入外部 sleep，並將 timer 加速至50ms；本次觀測的原因仍未確定，不把稍後程序群組查無列倒推為失敗當時已空。

依[實際 GPT‑6.1 Sol 限定裁示](https://github.com/teacherjung/personal-finance-webapp/pull/705#issuecomment-6248117085)，只修本題合成執行分支：保留版本及安裝位元組核對，exec 單一有限 Node；ready 後才受控觸發正式 runner 排定的 callback。另核正常結束會取消 timer。負 PGID 真終止、拒收、盒子／live／results 清場斷言及既有 EPERM／後代清理考題保持，production 清理未改。

原始證據保留為 `grok-wall60-implementation-push-20261018.log`、`grok-wall60-implementation-push-attempt1-20261018.json`、`grok-wall60-failed-test-group-observation-20261018.json`，不改列通過。觀測放置於本支 timer 題與 `scripts/grok-scan.js` 的 `killGroupAndWait`；若單一握手夾具或正式場再次出現同類拒絕、資源殘留或可獨立重現的清理反例，再依 F8 裁 production 排障範圍。測試接法綠不代表 production EPERM 成因已解決。

## 回復

回復本支壓縮提交可恢復 Grok50／預換60／Gemini原接線；不重設帳號、不還原憑證或修改已開始場次的 timer。不因回復把已拒收或未完成結果改成有效。
