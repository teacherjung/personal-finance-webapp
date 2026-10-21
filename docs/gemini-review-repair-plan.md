# Gemini 正式複審接線與核收修復

本計畫適用 #730 的原生 Gemini 單輪例外。依[本人續辦指示](https://github.com/teacherjung/personal-finance-webapp/pull/730#issuecomment-6312741329)及 [Sol 完整裁示](https://github.com/teacherjung/personal-finance-webapp/pull/730#issuecomment-6313026036)，先修工程問題、維持草稿，確認新版本後重新全審；有效通過才繼續合併。前端延後。舊回覆及診斷保留，不能以新收據追認舊輪。

## 責任與生效邊界

- `scripts/gemini-review.js` 核官方 launch、F3 原文、受審來源、原生退出及完整回覆；只在本次 CLI 子程序早設信任環境，不改全域信任或上層政策。
- `scripts/gemini-review-evidence.js` 核登記的原生公開來源釘值，產生樹外 literal-import 預載器；資料綁定 HEAD、launch、workspace 設定及 observer。CLI 原生 relaunch 的子程序才建立旁錄。入口結束後重核來源及旁錄計數，輸出仍是 `pending-human-acceptance`。
- `scripts/gemini-runtime-observer.js` 在真 Config 的認證／初始化入口核必要欄位，以程序、物件識別和本輪綁定區分 partial 與正式 Config。主請求須綁同一個已核 Config，固定模型且明示 HIGH，正式 registry 的工具集合也要符合。失敗後鎖住後續主請求，不補設定、不替換請求內容。
- 工具事件只挑公開 `recordToolCalls` 參數；同 id 更新保留順序、計數採末態。Shell 另錄自然執行的終態，不從工具 success 猜退出碼；沒有可靠 tool id 時由發審者按命令、目錄和時序配對。旁錄不讀模型 contents、systemInstruction、thoughts 或認證參數。

原先的強制信任、手造 Config 預檢不再作真啟動等價證據。有限來源釘值不是完整依賴圖或載入映像證明，前後來源相同也不能證明中途未改回；Shell 可執行任意考題程式，沒有 OS 隔離。

## 輸出與私有證據

原生 workspace 的工具呈現上限為 12000 字元，保留原生頭尾與完整輸出檔指路，用來避開已量到的二次縮短。原生服務交出的 Shell output 可能先經正規化或截短，旁錄不把它冒稱成完整子程序原始位元組。選定工具文字旁錄有個別及總量上限；摘要附原長度與雜湊，缺事件、壞序列、錯綁定或來源變動拒收。

標準 JSON、stdout、stderr、退出碼、原生角色統計與完整 response 分別保存。完整 response 不裁前言、不挑範例、不代改矛盾句；公開前仍走既有隱私判準。格式受理不是內容通過。

## 驗證與正式恢復條件

- 合成依賴驗真委派前拒絕、原 this／參數／返回及錯誤、同 id 工具更新、拒絕、真 Shell 零／非零／signal／abort／未知／promise 拒絕，以及觀測失敗後不得再送主請求。
- 原完整 bytes、完整 response 尾換行、嚴格標頭、角色計數、隱私、髒 Git 環境及子考題環境的直接題保留。既有反例整理不得把六拒絕變零，或把還原檔案、本機綠冒充還原重跑與雲端已核。
- 一次合成 HOME 的真 CLI 驗證在認證前 `isInteractive` 邊界截停；它只證早期設定與 relaunch 路徑，不算正式初始化、主審請求或複審。多位元長輸出驗頭尾、完整檔指路及舊上限反控。
- 於樹外副本移除實質守衛或破壞保存機制，須取得指定斷言紅及還原後綠；語法錯、缺模組或工具拒絕不算。完成自審、正常完整推送及最新 CI 後，才重備新 HEAD 的 Gemini 正式全審。

發審者須逐項核對拒絕揭露、本機與雲端區分、有效突變紅、同情境還原後實跑綠、必要邊界及十九項清單的落點。機器不靠正規表示式宣稱判懂內容；缺證或回覆矛盾保持不採計，不能補做後冒稱 Gemini 已做。新輪同類問題再發時帶具體證據交 Sol 裁處，不重送同提示碰運氣。有效通過後依 F7、F6、後掃紀錄、官方合併與適用驗收續行。
