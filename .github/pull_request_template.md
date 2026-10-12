## 協作欄位

- **實作者**：<識別值>
- **複審者**：<識別值；不可與實作者相同>
- **預計修改的檔案**：<全部列出；太多可以寫資料夾>
- **這支若完全失敗，最糟失去什麼**：<一句話>

<!--
欄位與填法＝RULES A1、A2、D3、D4、E1 及 templates/pr-body.md；開頭四欄的位置限制見 tools/gates/check-collab-fields.js。
本專案角色識別值與預設分工＝settings.json 的 participants 與預設分工；技術驗證補充見 docs/development-workflow.md。
-->

## 改了什麼

<!-- 逐條對帳與結論連結照 RULES F7、templates/pr-body.md。 -->

## 怎麼驗收

<給 William 的三句白話：①開哪一頁 ②做什麼 ③看到什麼算對。級別與動作不要自己算：跑 `node tools/acceptance-tier.js <PR 編號>`、照它印的寫（RULES H6）>

### 複審後掃

_待補——照 templates/scan-record.md 填；這行還在＝還沒填。_

<!--
時機與規格＝RULES G1〜G4 與 templates/scan-record.md（這裡不抄）；掃描發射者＝settings.json 的 scanner。
小標字串 `### 複審後掃` 是固定的 grep 鍵（2026-09-17 切換日起用套件的小標；之前的支用「### Grok 複審後掃」，歷史不改）。
-->
