# 市場查詢例外修復計畫

技術邊界依[實際 GPT‑6.1 Sol／xhigh 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/728#issuecomment-6295503142)，非本人實際驗收。

## 問題與範圍

GS-B01 的異常報價 query 可在 Express 4 裸 async handler 造成未接住的 rejection，使本機服務退出。本支只修改市場查詢入口；正常市場服務、快取、外部來源、資料寫入及前端流程保持。

## 輸入與錯誤邊界

`GET /api/quotes` 依實際 query parser 的結果處理：缺省、單一字串與單層字串陣列可進服務，每個字串依逗號拆分、trim、移除空項。物件及帶非字串元素的陣列在呼叫服務前拒絕，回 400 `{error:'請求格式不正確'}`。不將物件轉字串，不增設代號字元白名單；去重、快取與數量上限沿用服務。

報價、CAPE、實質利率以既有 `asyncRoute` 將未預期例外交既有全域中介；服務原有 null／manual 退路照常回 200。自動報價與每日洞察保留各自的 200 降級形狀，不併入新錯誤口徑。

## 驗證

- 正式 `server.js` 在獨立子行程及新暫存資料庫啟動，HTTP 限隨機本機埠。服務替身只由考題 loader 注入；不改產品函式介面。
- 驗缺省、空字串、CSV、重複參數及單層陣列；拒絕物件、混合與巢狀陣列，並核拒絕前未呼叫服務。
- 各查詢分別注入 async reject，核真中介的 500／帶 status 回覆、實際服務呼叫及錯誤後下一次正常請求。
- 無服務替身的整合題以合成上游回覆／失敗驗報價、CAPE、實質利率原成功與回退；前後比對本題合成帳本，唯讀查詢不能改持倉或設定。
- 先在舊路由看新題紅；修正後轉綠。於樹外副本分別撤參數防護及各查詢 wrapper，每次須見對應題紅；保存型題保留操作、破壞保存結果。替換先斷言目標唯一存在。
- 推送三關、CI、Grok 正式複審、F7 及合併照正常程序。掃描依現行本人指派跳過。

## 驗收與界線

依分級腳本輸出填 PR 的驗收步驟。隔離 HTTP 是工具驗證，不是本人實際重啟或原生瀏覽器驗收。不對真實帳本送異常請求，不把前端待辦或雲端復工併入本項。

## 證據

- 技術範圍：[Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/728#issuecomment-6295503142)；驗收界線：[限定工程交付裁示](https://github.com/teacherjung/personal-finance-webapp/pull/728#issuecomment-6295506513)。
- 2026-10-20 UTC，未包裝路由的新題先出現預期四項失敗；修正後，市場路由、服務、route-helpers、契約索引及註解引用的針對性測試 63 題通過，typecheck、指定檔 lint、server 語法與 seed buildSummary 通過。
- 樹外副本的綠色基準通過後，分別撤參數型別防護、退化陣列 CSV 支援、撤三個查詢 wrapper，均使對應題失敗。保存型另外保留查詢但強制改寫合成設定，及分別把 auto／insights 的既有降級改為 500，亦各被對應題攔下；還原後全綠，來源路由雜湊未變。
- 初次突變副本缺啟動版本檢查檔，控制組即失敗；該次不計入突變證據。補齊版控來源後才取得上述綠／紅／綠結果。
- 基線推送曾有驗證程序的暫存根殘留失敗；有界診斷及一次正常完整重推通過，原失敗內因仍未證實，見 PROJECT.md 的 GS-D04。正式送審、CI、完整推送及合併紀錄以 [#728](https://github.com/teacherjung/personal-finance-webapp/pull/728) 為準。
