# 訂閱刪除成功回焦與呈現順序：施工計畫

## 狀態與來源

草稿 PR [#709](https://github.com/teacherjung/personal-finance-webapp/pull/709)，施工中，尚未送複審。本輪本人委任：理財待辦全部處理、技術裁示問 GPT‑6.1 Sol 極高、驗收推薦代選。原 #699 問題 6249739119、實際 Sol 全文 6249806599 與本人 6251189159 的「選 A，把流程補齊…繼續修訂閱刪除後的鍵盤操作問題」分列；#708 已合併；[原題標準留痕](https://github.com/teacherjung/personal-finance-webapp/pull/699#issuecomment-6254138336)已補。

必要前置的[實際 Sol 全文](https://github.com/teacherjung/personal-finance-webapp/pull/709#issuecomment-6254212864)已逐字公開，SHA-256 cfc499ae2d9e41f0d19c9dc5a9de9b9e07a754a00cddb279e7fdaf45953a96a6；[標準配對](https://github.com/teacherjung/personal-finance-webapp/pull/709#issuecomment-6254213190)保留技術身分，不冒稱本人實看或正式複審。

## 單一目的與推薦操作

刪除成功、自己的有效最新讀取已呈現後，符合等待期間未接管條件才回焦一次。仍有資料時到唯一可用的「訂閱與近期扣款」h2；成功全空時到唯一可用的「訂閱追蹤」h1。DELETE 失敗、讀取失敗或候選不唯一／不可用時不補其他目的地。新鍵盤操作、移焦、滾輪、觸控、換頁、視窗失焦、文件隱藏、新窗或較新呈現均撤銷，不能由晚回覆復活。

產品推薦依本輪授權選 A；[E10 代選與有限工具代驗](https://github.com/teacherjung/personal-finance-webapp/pull/709#issuecomment-6254343907)已公開，不稱本人實看或 H6 本人驗收通過。保留既有確認、錯誤與金額／攤提／歷史口徑，不改 CSS、手機、雲端或其他列操作。

## 必要順序保護

原生確認回 true、操作被接受時取得既有呈現 owner。較舊刪除 ACK 不另起 GET、不寫全域成功通知、不整頁重畫、不回焦。資料確認與焦點資格分開；失去焦點不取消合法刪除，失去呈現權不丟掉已確認刪除事實。

以本模組私有在途刪除 operation 保存確認至其正常讀取／交接結束；每個實際 GET 回合保存僅與自身相關的排除集合。ACK 只附到當時仍有效的讀取回合；確認後開始的 GET、包括 autoExpire 另發的新回合，以新的資料邊界接手，不繼承永久 ID 遮罩。GET 取得快照後、autoExpire 前先消化確認；跨 await 後及提交衍生畫面前再消化。

較新 owner 接管時，須消化前一個已 ACK 但尚等自己 GET 的刪除，以守住「A 已確認，B 接管但 PUT 失敗、沒有新讀取」；不能只等晚 ACK 分支。確認清理只管自己的 operation／回合，不清另一個有效讀取或標記確認。

對有效目前呈現，穩定身分及 DOM 列都唯一時，從同一個 subs 陣列 splice，移除該唯一列。由更新後模型按既有公式重算摘要、即將停用數、失效卡提示、續費時間線、分析圖與卡片總額；維持頁面外殼、存活列／按鈕、仍適用控制與通知節點。列事件、列印及計算明細閉包繼續讀同一陣列。不為這個同步新增 autoExpire、freeze、歷史或其他補寫。

全空時保留既有 page、仍適用的頁首／新增入口、通知及歷史，切成現有空狀態，不由晚作業補 h1 焦點。身分不唯一或局部同步失敗不能猜第一列或吞錯；須留明確、可操作、可驗證的待重載處置，由使用者重載發起新讀取，舊 ACK 不自行起 GET。

DELETE 不進 flagOperation、flagWriteTails、flagConfirmationRevision，不新增跨寫入佇列。新 owner 接管須明確結束舊標記／刪除焦點工作。標記既有同 ID PUT 順序、不同 ID 不互等、嚴格 ACK 及確認後合併都保持；刪除排除後只對存活資料合併標記。

## 焦點工作

保存原按鈕及確認前有效條件，確認回 true 後重核；不因焦點不合格取消仍合法的資料操作。私有刪除工作持有 host、page、routeSeq、navSeq、完整 hash、owner、讀取世代及 watchModalRoot 世代。只接自己的實際成功提交點，包含 autoExpire 遞迴鏈。

同步替換自己持焦節點的 blur 只在那次同步提交期間區分，不橫跨 await，不忽略外部 focusin 或 modal。嘗試 focus 前後重核資格與可見性，一次消費；臨時 tabindex 只移除自己加且未被外改的值，離焦／移除後清理。

## 驗證責任

正式真 DOM 按鈕及合成 API：每題獨立種資料，斷言 DELETE／PUT／GET 的實際次數及操作結果。正常刪除保留列與成功空白、兩種失敗、使用者取消及等待期間各接管路徑；重複身分、不可見／inert、候選 focus 失敗與重入、一次性及清理均有針對性反例。

交錯只測有限必要集合：A DELETE 晚 ACK 而 B 已呈現；B GET 早抓包含 A 的快照；B 已呈現含 A 的快照後 A ACK；A ACK 自己 GET 等待而 B PUT 失敗；晚 flag 確認與較新 delete GET 合併；不同列刪除逆序、較新一般呈現／換頁、autoExpire 前後邊界、確認後新 GET 接手與無永久遮罩。要同時驗 page／存活列／按鈕／通知／焦點、同模型閉包與衍生合計，不把單一 page assertion 當成各點獨立證明。

有效突變保留實際操作，分別拿掉接受 owner、晚續行限制、模型移除、舊 GET 排除、交接保留、同陣列或衍生重算；各先 assert 替換目標，再證明對應 assertion 紅、還原綠。真瀏覽器用專屬種子庫及原生鍵盤另量正常／空白與接管，誠實區分 jsdom 精確節點相等與 IAB AX 身分。正常三關、雲端、Grok 正式複審及 F7／合併程序照常，掃描依目前本人指示跳過。

## 預計路徑

- public/modules/subscriptions.js
- test/subscriptions-row-focus.test.js
- test/subscriptions-states-ui.test.js
- test/subscriptions-forest-ui.test.js
- docs/contracts/frontend-features.md
- docs/subscriptions-delete-focus-plan.md
- docs/contracts/README.md
- PROJECT.md
- docs/ui-acceptance-matrix.md

沿既有考題責任增加行為，不增新考題路徑或任意改 MANIFEST。開工 D1、D5、開啟 PR 與髒樹路徑查核均已留痕；#708 合併後才修改本支與其重合的 PROJECT.md。送審前另查當版 D1、D5 與實際修改路徑。回復程式提交只撤掉本修法，不回滾已確認刪除或其他合法寫入。

## 驗證紀錄（送審前）

- 真 DOM 專項含既有標記題共 134 題通過；連同模型、時間線、結構及文件相關檢查共 200 題通過。完整三關由正常推送鉤子另跑，不能用專項數字替代。
- 13 個有效突變各先確認替換目標存在、保留實際操作並產生 assertion 失敗，還原後專項全綠。分別破壞 owner 取得、晚續行限制、模型移除、舊 GET 排除、交接保留、同陣列閉包、衍生重算、校正前排除、GET 回合邊界、新窗世代、空白回焦、可見性與監聽清理。清理的第一個嘗試仍有另一條清理路徑而未紅，未採為證明；改破壞實際解除監聽後才紅。
- 隔離 IAB 以原生 Return 發起兩次確認視窗，成功後分別觀察 H2「訂閱與近期扣款」及 H1「訂閱追蹤」持焦。另以專屬合成庫及回覆延遲代理重現 A DELETE 晚 ACK、B 標記已完成：釋放後保留所觀察的同一按鈕、焦點、通知，產品請求數不增加。開新表單輸入未儲存文字後再釋放 ACK，表單焦點與文字保持。瀏覽器警告／錯誤紀錄為空。
- 上列原生量測僅支持 IAB、合成資料與列出的路徑；精確 DOM 節點相等由 jsdom 行為題另守，不把 AX 識別當成全 DOM 證明。未宣稱跨瀏覽器、全站鍵盤或本人實看。量測後僅恢復 JSDoc 的 chain 型別註記，解析的可執行語法樹相同；專屬伺服器與合成帳本已清理。
- 抽出摘要計算 helper 後，既有畫面結構考題仍比對舊呼叫文字而失敗；同支調整接線檢查至 renderer 使用 helper 與 helper 使用原 amortizedForMonth 的呼叫，保留年化與路由突變。此項接線調整不更改公式。
- 完整三關、雲端、正式 Grok 結論及 F7 依 PR 當版收據對帳；本計畫不預先宣稱通過。
