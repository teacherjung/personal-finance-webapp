# Gemini 條件式原生掃描接線計畫

依 2026-10-20 本人條件式 CLI 授權與 [2026-10-24 GPT-6.1 Sol／xhigh 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/735#issuecomment-6380893345)，本支在 [#735 已合併](https://github.com/teacherjung/personal-finance-webapp/pull/735#issuecomment-6381927906)後，以獨立高風險 PR 承接。Codex 實作、Grok 正式複審；Gemini 只任第三方掃描者。原上游修復 #121 及理財 #731 同步已完成，不能仍寫成待同步；本支只補專案入口、具名用途證據及精確狀態指路。手機、HOSTED、缺資料項與前端修改仍停止。

## 問題與完成條件

原生正式複審入口依賴 launch.json、七種工具及十九項核收，不能直接當成掃描入口。掃描須使用官方 scan.json 生命週期、四種唯讀工具及完整原生 response，不以正式複審收據冒充後掃；保留原本 review 的資格與工具標準。

完成條件：正常三關與當版 CI、獨立正式複審；符合本人條件且取得第一次有效通過後，才由官方 --scan 起一次真 Gemini 掃描，再 --scan-post／--scan-close。掃描失敗留真終態回裁；普通失敗依 G3 記未執行，不無限重試。格式受理仍須人工核對發現與來源，不屬正式放行。

## 預計修改的完整路徑

- scripts/gemini-scan-native.js：新正式掃描適配入口。
- scripts/gemini-review.js：具名匯出既有 modelObservation；nativeSettings 的固定用途參數，review預設保持。
- scripts/gemini-review-evidence.js、scripts/gemini-runtime-observer.js：封閉review／scan用途；按用途核正式紀錄、工具集合、binding與人工核收欄。
- test/gemini-scan-native.test.js、test/gemini-runtime-observer.test.js、test/gemini-review-evidence.test.js、test/gemini-review.test.js：新掃描行為、跨用途拒收及review不退化證明。
- settings.json、PROJECT-SETTINGS.md、test/project-collaboration-settings.test.js、test/acceptance-table.test.js：明確scanner命令、模型／HIGH與精確驗收檔名登記，生成表由正式工具產生。
- docs/gemini-native-scan-plan.md、docs/project-collaboration.md、PROJECT.md：本計畫、操作邊界與上游完成狀態。AGENTS.md只在必要本人新指示落點需要時另核範圍，先不加入預約。

15個預計路徑已核D5，0個共用檔；完整路徑搜尋領域路由表未命中額外領域，共用底層仍依入口一律適用。正式預約前重核當版；共享tools／templates／RULES不在施工範圍。

## 設計邊界

1. purpose僅review／scan，未提供為相容既有review；任何其他值拒絕，不能用不可信文字作普通物件原型查表。每層scan明示purpose，不從檔名猜。
2. 官方scan.json欄位：change、scanner、source、reviewer、implementer、tier、head、base、passCommentId／Link、root、tree、promptFile、outFile、startedAt。新入口逐欄核固定完整SHA、角色、來源、路徑與本場設定，不猜有mutation或round。
3. scan固定core為glob、grep_search、list_directory、read_file；不載Shell、replace、write_file。真Config及主模型請求前registry皆精確核同一固定集合。預設review維持原七工具；不可取聯集或接受呼叫者任意expectedTools。
4. 共用五份原生來源pins仍只取現有Gemini登記，不複製成第二份scannerpins。沿用CLI版本核對、relaunch預載旁錄、真Config/HIGH與真main請求觀察；用途、正式紀錄hash、head/base、提示／差異／設定hash進binding及收據，跨用途證據不得採計。
5. 主模型、輔助循環角色、成功main及API／角色請求錯誤計數由既有純modelObservation共用，判準不變。scan獨立核完整response第一行的本輪🔍標頭，拒絕前言、範例標頭、錯版本／來源、正式結論記號；不能先裁切再收。公開正文沿用publicReply，不能公開就拒絕代貼，不修飾原文。
6. 外層從本輪原始blob／固定base、head取得完整文字差異，避免屬性遮蔽、外部diff／textconv與任意二進位當文字；原官方提示不改，差異作有界資料附後。私有保存原提示、差異及組合輸入hash；公開明說模型未跑git或考題。二進位另列未文字掃描範圍。
7. 依既有nativeSettings停自動memory、hooks、skills、agents、擴充；-e none，隨機不存在的MCP排他名稱，既有上下文檔存在即停止不讀內容。認證由CLI正常處理；不把認證／私人設定加入材料，不改全域信任或權限。這不是OS隔離；讀檔工具仍可能循路徑越出掃描樹，前後一致不證明中途未改回。
8. 正式工具仍負責備樹、發射命令、代貼與收樹。新入口不貼文、不轉正式、不合併、不手造生命週期紀錄。無Shell時仍保留工具終態對帳；scan不要求十九項複審或突變還原清單，review既有核收要求不鬆動。
9. 保存完整stdout/stderr、真code/signal、分階段failures及清理。回覆失敗不能省略來源/runtime/policy/pins/旁錄核查；只刪本輪實建且hash與種類仍符的配置，未知產物保留並拒收。沒有必要完整性或終態就不產生可代貼成功收據。

## 必要驗證矩陣

- review未填purpose維持原行為；缺任一工具／誤套scan表拒收，未知purpose、兩種正式紀錄或事件交叉使用拒收。
- scan四工具與真HIGH／模型正控；加入Shell、寫檔、MCP、擴充、錯模型／HIGH／同Config綁定時，真正委派次數仍零，fatal後再次請求亦不委派。
- scan完整原生回覆、角色及計數正反例；非零／signal／缺response／錯首行／前言範例與隱私拒收；來源或runtime／pins漂移、缺旁錄、清理失敗及未知檔的完整診斷保存。
- 固定差異不受-diff屬性遮蔽；文字與二進位分列，不執行外部過濾器；git／gh整族環境清理直接觀察。
- 每一新實質守衛在樹外副本單獨有效突變：assert替換存在、指定結果紅、還原hash相同再綠。保存型保留操作，只破壞保存機制；不依賴前題狀態。
- 當版完整三關、當版CI及正式全審；真掃描僅在規定時序與條件符合後一次執行。沒有通過不啟動真掃描；失敗回裁，不自行更換正式複審者。

## 回復與限制

若要回復，回復本支提交並將scanner恢復未設定；不變動帳號、憑證、guard安裝或全域信任。舊#730／#734紀錄保留，不能因新用途已核而追認舊輪或結清原客戶端安裝、平台直接量測、任意私人上下文與完整執行映像證明。
