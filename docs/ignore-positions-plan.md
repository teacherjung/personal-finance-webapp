# 忽略清單位置整理（交接原第 12 項）

範圍依 [本次授權的 GPT-6.1 Sol 代裁](https://github.com/teacherjung/personal-finance-webapp/pull/679#issuecomment-6129379236)，不是 William 本人原話。忽略樣式的正本是 .gitignore；settings.json 的 ignoreLists 與 test/no-hiding-places.test.js 同序登記，PROJECT-SETTINGS.md 由 build-settings 產生。

審查殘留、tmp、output 只匹配根目錄的目錄；grok 升版暫存只匹配 scripts/grok-scan.js 及 test/grok-scan-flow-preflight.test.js 的同目錄暫存檔，尾碼依正式產名的十二個小寫十六進位字元。PDF 探針只匹配 /test-doubles/_probe_*/、/test-doubles-evil-*/、/lib/_seam_probe_*/、/public/_seam_probe_*/ 的目錄。一般檔與根部捷徑不因目錄樣式被忽略；被忽略的實體目錄內含捷徑仍由祖先目錄樣式忽略。

新增 test/ignore-positions.test.js，用本題自建 Git 沙盒、實際 .gitignore 與 check-ignore --no-index --verbose 驗命中樣式及退出碼；Git 環境從零只給 PATH 與本題 HOME，控制模板與外部 excludes。各位置分開驗正確位置、錯深度、相似名、一般檔與捷徑；升版兩個目標用正式 createExclusiveTemp 取得真產名，正式檔與非法尾碼要看得見。各獨立樣式拿掉或放寬位置、型別與尾碼時，行為題須在指定斷言紅、還原綠；先確認基準綠及替換目標存在。

ESLint 的探針糾察維持由既有 PDF 接縫考題驗證；獨立加入探針忽略的突變須使該題紅。這份 Git 忽略驗證不代替 ESLint 糾察，也不檢查其他目錄的忽略檔或未納入版控的外部忽略設定。不清歷史殘骸，不改其他真實資料、憑證與相依套件樣式。

大小寫依 [本支追加代裁](https://github.com/teacherjung/personal-finance-webapp/pull/684#issuecomment-6133286174) 劃界：在獨立沙盒以命令參數驗 core.ignoreCase=false／true，另核原生探測值；[Git 會探測檔案系統設定](https://git-scm.com/docs/git-config)，不改使用者 Git 設定。大寫與混合大小寫的目錄、固定目標及尾碼獨立驗，不併入跨模式都應拒絕的錯名；嚴格小寫只在 false 模式成立。目錄類樣式驗一般檔與根部捷徑的拒絕；升版樣式是 basename 匹配，也會匹配同名目錄或捷徑，不宣稱它能區分同名物件的建立來源。

PDF 家族正例依 [第一輪後的追加代裁](https://github.com/teacherjung/personal-finance-webapp/pull/684#issuecomment-6134086085) 用真正 mkdtemp 產名；固定 fixture 名不能代替真殘骸的匹配。四個家族各做固定名收窄突變，指定行為題須紅、還原綠，不以宣告未同步的紅代替。位置、深度、型別與大小寫劃界仍保留；升版產名的舊註解同支改為原因與指路，不新增正式接縫或匯出。

升版 nonce 的反例在每個位置分別放一個非十六進位的 g，其餘保持合法；兩個目標各自每一格放寬為可收 g 時，指定行為題須紅、還原綠。這項證據只涵蓋該單格放寬突變，不宣稱窮舉所有可能的字元類改法。

本項也在 PROJECT 歸位 [#683 第三輪發現 2](https://github.com/teacherjung/personal-finance-webapp/pull/683#issuecomment-6132842497)：整組 describe 跳過會多收 suite 明細、往安全方向紅；位置為暫存回報器及生命週期考題，FILES 任一支開始使用 describe 時才補強。
