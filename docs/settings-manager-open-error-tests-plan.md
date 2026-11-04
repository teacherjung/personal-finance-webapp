# 設定管理同步開窗例外補題計畫

承接 FIN-002 與 #743 保留缺題；#750 已正式合併後才開本支。Codex 實作、Grok 正式複審，掃描維持暫停。

只新增獨立 no-TCP 考題與 helper，保留既有 HTTP 卷與產品程式；使用完整前端模組、真按鈕回呼、正式開窗及通知，合成 fetch／DOM 不冒稱 HTTP、帳本保存或原生瀏覽器證據。

六入口各自隔離，核指定 GET、正式取得彈窗所有權、專屬同步例外及確切新增錯誤通知。以唯一同步 catch 的資格守衛及錯誤前綴各做有效突變，先綠、指定斷言紅、還原綠；環境錯誤或逾時不算有效紅題。

預計修改：本計畫、test/settings-manager-open-error.test.js、test/helpers/settings-manager-open-error-case.js、docs/backlog-status.md。後者只補本項承接連結與完成判準，初盤52保持快照；本支正式合併且完成實際分級核收前，仍列未結。

依 Sol 續作及記帳裁示：

- https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6628398035
- https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6629221656

本次先提交計畫以建立草稿 PR；候選尚未套用，不預先宣稱正式檢查或交付完成。
