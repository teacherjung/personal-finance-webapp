# 考題暫存根收尾計畫（原第 27 項）

依公開 GPT-6.1 Sol 極高代裁：https://github.com/teacherjung/personal-finance-webapp/pull/679#issuecomment-6126118521 。不清歷史殘骸、不改正式掃描結果保留，不新增清理框架。

修改 audit-grok-scan 考題的 tmp()：登記該函式建立的根，after 用既有 rmSync recursive/force 方式逐根收尾。無法列舉的權限夾具只在原安全斷言完成後以 finally 還原自己 ws 的權限，再交總收尾，原 fail-closed 安全判準及 root 跳過不動。

流程考題沿用既有 keep()/cleanupTempRoots()，將各檔直接 mkdtemp 根登記；現有立即 finally 清理保留。不動正式 scripts 或真實財務資料。

驗證用薄的子行程觀察器：攔截實際 mkdtempSync 並以 syncBuiltinESMExports 更新具名匯入，記錄建立結果而不是讀登記表。每支受影響考題各跑正常完成與 afterEach 主動失敗場次；失敗須在實際夾具出現後觸發，根 hook 應仍收尾。外層在斷言之前量測殘留，之後 finally 只清本場自己建立的夾具。

觀察器用原始 mkdtemp 建獨立未登記控制根，放唯一內容；在一個受登記夾具內放指向控制根的 symlink。斷言夾具根已消失、未登記控制根及目標內容仍在。不同生產路徑自己建立並獨立登記的根要按自身所有權收掉，不能把「捷徑目標保留」讀成所有目標都不可收。

獨立突變：逐個新 keep 呼叫、audit 根登記、audit after、權限 finally 各移除一次；對應生命週期斷言須因具體根殘留轉紅，還原後綠。故意失敗場次預期退出碼非零，不算突變證明。新增考題不只掃 after/keep 字面。平台未執行、能力跳過獨立列出，不算完成該平台驗證。

施工計畫先備；待常設指示 #682 合併後再接最新主幹開草稿，草稿後才改考題。開工前再核對 Claude 開著 PR 和完整路徑。預計路徑：test/audit-grok-scan.test.js、test/grok-scan-flow-credentials.test.js、test/grok-scan-flow-breach.test.js、test/grok-scan-flow-preflight.test.js、test/grok-scan-flow-incident.test.js、新增生命週期考題及薄觀察器 helper、施工計畫與 PROJECT 指路。
