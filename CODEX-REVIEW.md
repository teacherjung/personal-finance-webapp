# Codex 定期審查指令

> **使用方式（給使用者）**：每批 PR 合併進 `main` 後，對 Codex 說一句：
> 「**請讀 CODEX-REVIEW.md 並照它執行審查**」。
> 拿到清單後整段複製、原文貼給 Claude（不用挑、不用轉述）。

---

你是這個專案的程式審查者。開始前請先讀 repo 根目錄的 AGENTS.md，
特別是「審查分工」「⚠️ 同步點清單」「投資領域語意」三個段落——那是你的
職責邊界與這個專案的刻意設計，務必遵守。

你的角色（唯讀審查者）：

- 只提意見，不改任何檔案、不 commit、不 push。
- 審查對象＝目前的 main 分支（審查前先 `git checkout main && git pull` 確認最新）。
- 絕對不要讀取 `data/store.db`（含 `.bak`/`-wal`/`-shm`）與 `data/store.json`（真實個資與 token；B3 起主資料庫為 SQLite `store.db`、舊 `store.json` 保留為備份）；要看資料形狀請看 `data/seed.json`，要實測請用 `STORE_FILE` 指向暫存 `.db` 檔。

開始審查前，先跑三道自動關卡並確認全過（若有不過，直接把輸出列為發現）：

```
npm run typecheck && npm run lint && npm test
```

（若 node_modules 不存在先 `npm install`。這三關已涵蓋型別/格式/回歸，你的審查火力請放在它們抓不到的：邏輯錯誤、口徑不一致、同步點漏改、安全性。）

## 本輪審查重點（2026-07-19；上輪審到 #96，本輪範圍＝#97–#111 店名系統大改）

這一批把「店名」拆成三層：**帳單原文**（stmtRef 第 4 段，不可變）→ **身分鑰匙 storeKey**
（品牌層＝`storeKeyOf(desc)`，辨識「同一家店」、學習與店家檔案聚合靠它）→ **顯示名 note**
（`cleanStore(desc)`＋`applyDisplayLabels` 顯示標記，帶分店、可自訂）。請特別檢驗這些不變量：

1. **鑰匙純淨性**：storeKey 絕不可含顯示標記（（FP）（UE）停車費（））或分店括號。
   檢查 `storeKeyOf`/`storeKeyOfName`/`stripBranch` 與所有寫入 storeKey 的路徑
   （finalize、importRows、normalizeBranches、renameStoreDisplay）。
2. **學習兩層分工**（learning.js）：分類學品牌層 key、顯示名只學原文級——
   `learnFromStmtEdit` 分兩層寫；但**舊資料**若品牌層 key 未變（remap 時 nk===k）、
   其 entry 裡殘留 name，會不會繼續連動改到同品牌其他分店？（remap 只在 key 變動時丟 name）
3. **整理的自訂 vs 自動**（statement-import.js normalizeBranches）：自訂名以學習表為準、
   平台殘骸名（isPlatformArtifactName）丟棄重生——邊界對嗎？會不會誤殺真自訂名？
   nameByOrig 搬家與 skMap 撞 key 的先後順序有沒有漏洞？
4. **優步分流**（statement.js）：叫車（TAXI_FLEET）→「Uber（車隊）」鑰匙 Uber；
   外送→餐廳本身＋（UE）。cleanStore 裡 UBER_PREFIX 在規則鏈與分流兩處出現，順序/重複剔除有沒有問題？
5. **reset 共用學習**（renameStoreDisplay）：鑰匙改品牌層後「被其他原文共用」變成常態，
   reset 幾乎永遠不刪品牌層學習——這是刻意保守，但有沒有反而清不掉錯誤學習的死角？
6. **店家檔案彈窗**（transactions.js openStoreProfile）：聚合口徑 storeIdOf、排行、月平均
   （不含本月）的計算正確性；手動記帳（無 storeKey）用 note 聚合的邊界。
7. **同步點**：AGENTS.md 的 cleanStore/顯示標記/學習列是否與程式一致（這輪改了很多次）。

（此段每輪審查後由 Claude 更新範圍；常青規則在下方不變。）

---

請針對以下面向檢視程式，找出值得處理的問題：

1. 正確性 bug（邏輯錯誤、邊界條件、多幣別/匯率換算、日期時區）
2. 死碼、重複程式、可簡化處
3. 同步點是否有一邊改了另一邊沒跟上（對照 AGENTS.md 的同步點清單）

每一條意見在提出前，請先自己驗證：

- 指出確切的「檔案:行號」。
- 說明為什麼是問題（能重現的用什麼輸入會出錯；不能重現的別當 bug 提）。
- 如果你懷疑某處「看起來重複/奇怪但可能是刻意設計」（例如 COMPOSITION
  表在前後端各一份是刻意的同步點），請照樣列出，但標註「可能為刻意設計，
  待 Claude 判斷」，不要直接斷定是錯的。
- 之前輪次已判定為「刻意設計」的項目（記錄在 AGENTS.md 的同步點清單與
  例外說明中）**不要重複提出**。特別提醒：AGENTS.md 鐵則 6 的前端型別放寬
  （byId any／onMount any／Chart any／fxGaugeSection 休眠停放）與
  devDependencies（typescript/eslint/@types）都是刻意引入，非問題。

輸出格式（讓使用者可以整段複製轉交）：把發現條列，每條用這個格式——

```
[編號] [嚴重度: 高/中/低] 檔案:行號
問題：一句話講清楚
證據：為什麼是問題 / 什麼情況會出錯
建議：怎麼改（只描述，不要真的改）
```

最後附一句總結：總共幾條、其中幾條是你較有把握的。

不要修任何東西，也不要幫使用者 commit。你的產出就是這份清單，使用者會
轉交給 Claude 判斷後再決定要不要做。
