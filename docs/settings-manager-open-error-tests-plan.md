# 設定管理同步開窗例外補題計畫

承接 FIN-002 與 #743 保留缺題；#750 正式合併後建立[本支](https://github.com/teacherjung/personal-finance-webapp/pull/751)。Codex 實作、Grok 正式複審，掃描維持暫停。

## 限定範圍

只新增獨立 no-TCP 考題與 helper，保留既有 HTTP 卷與產品程式。完整載入前端模組，走真按鈕回呼、正式開窗及通知；fetch／DOM 是合成替身，不提供 HTTP、真帳本保存或原生瀏覽器證據。

六入口各題隔離，核指定 GET、正式開窗取得自身所有權、唯一專屬同步例外及確切新增錯誤通知。每次前端請求先登記，未知請求拒收；本卷只驗所觀測的前端請求，不推成後端或帳本保存保證。

## 有效反控與來源

同步 catch 加回開窗前的 eligible 守衛，須在指定通知斷言失敗；只移除 failure 前綴，須在指定前綴斷言失敗。每次先 assert 替換目標唯一、核副本差異，先綠、指定斷言紅、還原綠；環境錯誤、逾時或初始化失敗不算有效紅題。

私人 v2 作者試驗六入口取得基線／守衛突變／還原／前綴突變／還原的有限證據，真退出 0／1／0／1／0。套入本支前逐檔比對必要公開前端閉包與兩新題的雜湊；它不代表完整依賴映像或正式複審已完成。本支仍須正常三關、當版 CI 及 Grok 自行重跑基線、有效突變與還原。

## 檔案與記帳

本計畫、test/settings-manager-open-error.test.js、test/helpers/settings-manager-open-error-case.js、docs/backlog-status.md；D5 共用檔清單無命中。既有 HTTP 卷、正式產品及安全設定不在改動範圍。

清單保存 #750 初盤52快照，FIN-002 補承接連結與完成判準。正式合併且完成實際分級核收前仍列未結；實際交付與當下數量以本支結案紀錄、共同進度及回報核對，不在草稿預先扣數。

- [Sol 續作裁示](https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6628398035)
- [Sol 完成判準裁示](https://github.com/teacherjung/personal-finance-webapp/pull/750#issuecomment-6629221656)

沒有產品畫面變更；驗收與風險以本支實際分級工具核對，不解除本人本機更新題或任何停止範圍。
