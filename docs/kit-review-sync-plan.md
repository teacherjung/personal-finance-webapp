# 理財正式審查前置同步計畫

## 目的與授權

將套件已合併的 #128／#129／#130 經官方整批同步帶回理財，處理阻擋正式複審的必要相容前置，再續辦 #747。Codex 實作、真正 Grok 4.7／xhigh 正式複審；技術取捨交實際 GPT-6.1 Sol／xhigh，不能把技術裁示或測試通過當正式結論。

本人在本工作線授權必要時暫關 #747、保留分支與證據後恢復。讓道留痕見 [#747](https://github.com/teacherjung/personal-finance-webapp/pull/747#issuecomment-6497817034)。#737、Gemini／Argon 與所有掃描繼續暫停，不動其他工作線、主網站、真實帳本、憑證或依賴安裝。

## 固定基準與單一目的

- 理財基底：`8fbfe45ee0bbb6bb0ab61357d97edb1df7fb6f31`；本支不包含 #747 的店名規則產品差異。
- 套件來源：已合併 `1a1e3954fe606b3da178b1d4bd8fe07073e1e008`；前次同步 `ec3817253faf77d2ed615ca8c7385c6c9c37fc3b` 的保存與已知失敗另記下節，原清單版本 `c7125618592b757e29c6b76160dd517665987edf`。
- 套件完成證據：[#128 工具核對](https://github.com/teacherjung/ai-collab-kit/pull/128#issuecomment-6497292184)、[#129 工具核對](https://github.com/teacherjung/ai-collab-kit/pull/129#issuecomment-6488406048)。這些不替代理財本支的新驗證與正式審查。
- 同步只用來源版本的 `tools/kit-lock.js --sync`；先預演、核五類獨有改動與所有權，再加 `--apply`。不手改共用檔、不跳過檢查。
- 目的限於恢復理財正式審查前置。若相容修補超出必要前置或涉及新的安全判準，先交 Sol 裁範圍，不自行擴張；與本支無關的既有缺口不順修。

## 預計路徑與歸屬

官方同步的差異：`MACHINES.md`、`templates/scan-record.md`、`tests/grok-strict-regression.test.js`、`tests/manifest.json`、`tests/review-launch.test.js`、`tests/run-checks.test.js`、`tools/review-launch.js`，以及官方產生的 `kit-lock.json`。

專案自有路徑的修補面：`scripts/grok-final-reply.js`、`test/grok-final-reply.test.js`、`test/helpers/grok-scan-flow-fixtures.js`、`test/grok-scan-flow-review.test.js`、`test/grok-review.test.js`。必要說明限本計畫與公開證據；`docs/project-collaboration.md` 與暫停的 #737 宣告範圍交集，本支排除該文件。若須動 `scripts/grok-review.js` 或 `scripts/grok-scan.js` 的正式接線，先以具體差異補公開範圍與裁示，不將列名當作預先授權改安全邊界。

以上完整路徑已查領域路由；沒有專屬契約命中，仍適用共用底層契約。共用檔歸套件；專案自有檔必須另核 D5，不能把套件修法抄進共用路徑。

## 已核實的缺口與待裁事項

理財 `scripts/grok-final-reply.js` 的末列守門只收精確五鍵。#747 舊正式嘗試在模型完成後被 `FINAL_KEYS` 拒收，沒有有效正式結論。只同步套件並不改變專案自有選取器；也不能僅憑錯誤碼推定應放行哪些新鍵。

先比對已固定版本的公開 CLI 程式、合成正常／異常形狀與套件完成證據，交實際 Sol 決定最小相容範圍。不得讀被隱私檢查攔截的原文、不得改舊結果或回溯冒稱通過；不得刪除精確末列、來源、雜湊、模型、DLP、程序清理與正式結論檢查。

[Sol 範圍裁示](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6498273082)准先官方同步，收件相容必須等待固定版本合法證據。未取得與固定執行檔連結的公開來源時，允許以該執行檔、全合成材料、假認證及沒有轉送能力的 loopback 假服務，沿用 OS 隔離做原生持久化取證；不能啟真模型、讀私人設定或歷史 session。先公開對帳實際形狀與完成條件，再改封閉接受契約；探針失敗或語意不明維持拒收。此裁示不代替正式複審。

## 固定版本收件契約（2026-10-30）

[完整技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6501106212)及[開工範圍更正](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6513112098)限定以下修補，不更動正式 runner/provider 接線或安全設定。

- 固定 CLI 1.0.46，正式入口仍核 binary SHA-256 `e8daa302364c9c3b6a5546d511cfbd1ab5e5d407a9b04282f660665ea405f9f3`。第四次合法合成實驗證明四鍵末列與完整正文，不證明真模型推理或所有版本格式；公開來源 commit 與該 binary 同版未獲證明。成功供給的主／輔預算外另有摘要用途被拒，不能概括成全程只有兩次請求。前次失敗保留，不再起第五次探針。
- 精確列舉四鍵 `content,model_id,reasoning_effort,type`，只收 assistant／grok-4.7／xhigh；保留五鍵 `content,model_fingerprint,model_id,reasoning_effort,type` 與既有模型資格。未知欄、缺核心欄、tool_calls 即使為空仍拒收；不猜補 fingerprint。
- metadata 非空與受選原始末列解碼後重複鍵拒收是新增防線，不是原先已有。字串內的鍵樣文字不誤判，Unicode escape 同名鍵拒收；只守末列、不宣稱全日誌重複鍵皆受檢。
- 保留唯一 workspace/session、完整 JSONL/LF、最後列、UTF-8、stdout 唯一逐字對應與尾端限制、全 stdout 的 DLP 先行、模型資格、工具足跡、完整性與清理；正文及既有 v1 收據不改寫。
- 紅題先行；假 CLI 分列四／五鍵，四鍵通過真正 runner→provider→官方 prepareVerdict 合成鏈。拒收及保存各有正反控，突變先核目標與基準綠、紅在預期斷言；不以語法錯或前置失敗計數。
- [錯工作區考題技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6513386225)要求移走本場工作區的整合題精確驗上游日誌拒收，而非誤套後段 selector 碼；同題核 CLI 完整終態、拒收時序、無 selector 診斷、無正式結果與清理。原失敗保留，不追認尚未執行的清理斷言，不改產品防線。

## 驗證與停線條件

1. 草稿與原題／逐字答覆配對先行；D1 待裁未結，不實作該待裁項目或合併。
2. 同步前後核清單版本、blob／權限與實際差異；確認錢攔截器指紋來源未變，不調整全域鉤子或信任。
3. 相容修補先補能重現缺口的合成紅題，再修；合法正例與拒收反例都走正式使用路徑。每個關鍵守門以拿掉修法／破壞保存的有效突變證明，先斷言替換目標存在，保留原失敗。
4. 合成原生驗證以假模型入口與隔離材料執行，證明入口確有執行且沒有外送；不啟動掃描。真正 Grok 只在正式複審階段依官方材料及當版指定模型啟動。
5. 完整型別、格式、考題與正常推送關卡、新 CI 必須成功；任何新失敗先核原因與範圍，不弱化考題或把啟動失敗當有效突變。
6. 官方備審、主代理全文核提示、真正 Grok 完整正文與原生證據、官方代貼、Codex 獨立對帳、全部正式合併關卡、合併後分級與工具驗收逐步完成。輸出零不等於正式通過。

## 回復與續辦

### 前次同步的本機保存點（2026-10-30）

前次官方同步至 `ec3817253faf77d2ed615ca8c7385c6c9c37fc3b` 的成果尚未通過驗證：完整三關止於 lint 的五處錯誤，型別檢查成功不代表整輪成功。原始失敗、官方同步輸出、七份共用成果、同步鎖與計畫全文均在樹外保留；本機保存點只保存這些既有成果，**已知 lint 失敗、未驗證通過**，不得單獨推送、發審或合併。

依 [Sol 技術接續裁示](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6512766824)，先核全部共用項目的原始位元組、模式及來源清單，另道指令建立本機保存點；再以已合併套件 `1a1e3954fe606b3da178b1d4bd8fe07073e1e008` 的官方工具預演及整批同步。來源為 [#130 合併後工具核對](https://github.com/teacherjung/ai-collab-kit/pull/130#issuecomment-6511979875)，不以套件通過替代理財新版驗證。預演非零就停；不得手改共用檔、同步鎖、忽略名單或檢查判準。

兩份來源未明的重複副本依 [本人答覆](https://github.com/teacherjung/personal-finance-webapp/pull/748#issuecomment-6512636403) 完整備份後移到工作樹外保留，未刪除、未提交，不歸因其他工作線。所有新驗證與失敗另列，不改寫舊結果；只有新版完整驗證成功後才正常提交推送，取得新 CI 與 Grok 正式複審。

未合併時保留分支、提交與逐字證據，不重設或覆蓋任何他線內容。官方同步若中途失敗，依工具印出的精確回復方式處理，先核原因，不手工拼成套件不存在的版本。合併後如驗收失敗，依正式程序處理回復，不直接改主網站。

本支完成後重新開啟 #747，承接新版主幹、重驗店名規則差異，重新取得有效 Grok 正式複審再合併驗收。其後僅續有限體檢與信用卡批次既有待辦，不擴為全庫掃描或新服務。
