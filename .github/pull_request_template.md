## 協作欄位

- **實作者**：<識別值>
- **複審者**：<識別值；不可與實作者相同>
- **預計修改的檔案**：<全部列出；太多可以寫資料夾>
- **這支若完全失敗，最糟失去什麼**：<一句話>

<!--
四欄是機器讀的（雲端「協作欄位」檢查與合併指令都跑 tools/gates/check-collab-fields.js）：
它只讀說明**開頭那一段**——第一個 HTML 註解／引用／表格之前——所以四欄要留在最上面、前面不要放任何東西。
角色填識別值（settings.json 的 participants：William／Claude／Codex）；實作者與複審者不可同一位（RULES A2、E1）；沒有逐支指定就照 settings.json 的預設分工（RULES A1）。
「預計修改的檔案」全部列出、太多可以寫資料夾，讓後開工的 Session 查得到誰在改哪些檔（RULES D3）。「最糟失去什麼」一句話，決定這支的流程重量（PR 分級見 AGENTS.md「PR 分級與契約」節）。
-->

## 改了什麼

<!-- 逐處列；每輪複審的逐條對帳（四選一：屬實·已修／屬實·進待辦／誤報／待裁）與結論留言連結（RULES F7）。 -->

## 怎麼驗收

<給 William 的三句白話：①開哪一頁 ②做什麼 ③看到什麼算對。級別與動作不要自己算：跑 `node tools/acceptance-tier.js <PR 編號>`、照它印的寫（RULES H6）>

### 複審後掃

_待補——照 templates/scan-record.md 填；這行還在＝還沒填。_

<!--
時機與規格＝RULES G1〜G4 與 templates/scan-record.md（這裡不抄）；掃描發射者＝settings.json 的 scanner。
小標字串 `### 複審後掃` 是固定的 grep 鍵（2026-09-17 切換日起用套件的小標；之前的支用「### Grok 複審後掃」，歷史不改）。
-->
