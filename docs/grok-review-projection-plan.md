# Grok 正式複審的私有原件與公開路徑投影

依據：[本人 B 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6246727209)、[GPT‑6.1 Sol 技術契約](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6246824717)。這是正式收件判準變更；舊拒收不追認。

## 範圍與可信來源

只改正式複審前端、新投影模組、相應測試及協作附則；[Sol 登記補充](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6247059592)准許在 settings.json 的驗收表加入該精確檔名，並由原產生器同步 PROJECT-SETTINGS.md。新模組同既有複審輔助模組列 E，不改整支 PR 的風險或其他驗收動作。安全 runner、final-selection、F3 範本與結論閘維持既有版本。私有結果包先驗選取、原文雜湊、模型與用途，再交叉核對 runner 保存的 launch／manifest 與 workspace 編碼；讀取使用一般檔案、owner、不可跟隨 symlink、前後身分與容量檢查。盒子清理後只核當場保存的 canonical 路徑，不重建盒子。

## 固定投影政策 v1

- 本場 box 根本身換成 `[REVIEW_BOX]`。`src`、`base`、`mutation`、與 launch TMPDIR 一致的 `tmp` 分別換成固定代號，保留邏輯相對尾段。
- 宿主 canonical tmp 與 UID 決定的 Gemini jobs 根，只准根本身或字面 `/<runId>`；其他真實工作代號不接受。
- 只明列 `browser-capacity-test-` 與 `browser-capacity-test-XXXXXX` 這兩個容量測試示例，接受系統 tmp 的一般與 canonical 拼法，換掉 tmp 根、保留示例名稱。
- 左右 token 邊界須明確；不接受相近前綴、`.`／`..`、重複分隔、反斜線、百分比編碼或模糊尾段。其他路徑交既有公開檢查拒收。精確合成例外維持原射程。
- 完整原件先通過有限解碼的憑證檢查；安全 runner 原 DLP 不變。先遮蔽再查憑證不算有效驗證。

## 產物及驗證

完整 stdout 與 final 分別投影。原 selection 仍指向原始 stdout；投影另記 UTF‑8 原始／公開起訖、規則代號、替換值與完整來源摘要。驗證器重算政策結果，逐 byte 比較全部未替換區間，拒收重疊、越界、非字元邊界及跨 final 選取範圍。公開 final 必須完整對應公開 stdout 中的同一段。

私有原件、投影與區段證明使用不可覆寫的產物；收據最後建立，分列原件與公開稿的 bytes/hash、政策／context、原 selection、接收器／投影模組／runner 來源指紋。舊 `replySha256`、`stdoutSha256` 保留原件意義。原始結構檢查與嚴格公開 API 分開；不新增任意略過檢查開關。

實際發布本文＝完整公開 final＋固定「發審者附記（非 Grok 原文）」。附記列政策版本、原件與公開稿雜湊及替換數量，不含原始路徑、context 或完整 selection。發布器重讀私有證據、重新核對，再逐 byte 核對整則平台回讀，最後跑既有 F7。

## 驗證、首次複審與完成條件

行為題與有效突變至少守：context／launch／manifest／head 失配、未知根與相近前綴、編碼、原件憑證、區段外改字、stdout 前段遺失、發布稿偽造、舊收據誤採。行為題先綠再突變；不靠被測投影器產生唯一預期答案。

候選正常檢查通過後，固定完整新收件來源，開全新 Grok 全審場。這一場是受控自舉複審，不能先宣稱普遍啟用。只有完整安全鏈與投影證明都成立才發布；有效通過並做 F7 後，可作本契約的獨立複審證據。修改則更版再審。

Gemini 仍使用 ae9 固定提供者，完整來源、載入依賴、Node 及 Gemini 契約須保持已驗內容；本次前端工程未進其載入依賴，受掃 HEAD 可以更新。新受掃版完整材料重算容量；原 #701 保留原完整受審範圍。實際掃描、合併、H6 與啟用完成前不結案。合併後差異需逐一歸屬並行工作與本次前端修改。

## 回復與誠實界線

失敗保留證據且不發布、不補造結論。若需要新路徑政策，先裁示再更版，不自動學習或重試。這是文字公開投影，不是任意秘密辨識器，也不擴充任何檔案存取權。舊提供者及舊結果保持可核對；新契約未核收前不切正式啟用紀錄。
