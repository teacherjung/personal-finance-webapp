# 協作規矩地圖：哪一條規矩住在哪裡

> **這是路由表，不是規則。** 本檔不寫規則內容，只回答「我想查 X，要翻哪一份的哪一節」。
>
> 為什麼刻意只給地址：同一條規則曾經同時抄在六個地方，六份**各自漏掉不同的一項**
> （`Codex #457` 連三輪抓到不同份漏不同項，最危險的一份「例外寫了兩條、漏掉第三條」——
> 看起來完整，實際上少一個守備範圍）。**會漂的不是規則，是複本。**
>
> ⚠️ **本檔沒有規則效力**：與正本不一致時一律以正本為準，然後回頭修本檔。
> ⚠️ **但它的考題會擋合併**（`npm test`／CI）——「沒有規則效力」不等於「不擋合併」。
>   會擋的是**考題實際守到的那幾件**（地址、行的寫法、閘表對帳），不是整個版面。
> ⚠️ 下面「我想查⋯⋯」與「合併步驟專用的閘」兩區請維持**固定窄版面**：一格一個連結、
>   表頭與分隔列照抄、不放註腳、不放 HTML 註解。**但這是給人看的寫作約定，不是考題守得住的**——
>   實測拿掉表頭與分隔列／第一格塞兩個連結／在閘區塊加註腳，考題都**不會紅**。
>   會紅的版面事項包括：路由列本身的寫法、全檔不准有 HTML 註解、受稽核的節標題被改名或重複、
>   閘表把同一支腳本列兩次——**這是量過的例子，不是完整清單**。

## 先讀這段：這張表做不到什麼

- **它不完整，而且刻意不完整。** 下面只收「常被查」的問題。
  **表上沒有 ≠ 規矩不存在**——查不到就去翻正本本身的目錄，不要反推成「沒這條規定」。
- **有些地方有機器盯著，有些沒有。** 哪些有＝以 [test/collab-map.test.js](test/collab-map.test.js)
  的題目為準（這裡不列舉、也不寫幾項——摘要與數字都自己會漂）。大致上它盯的是**地址與行的寫法**：
  指到的檔案還在不在、目標檔**某處**還找不找得到一行「長得像那個節名」（標題、行首粗體標籤，或整行就是 `節名：`）、
  閘表跟**合併步驟裡實際會跑的那一組**對不對得上。⚠️ **只保證「某處找得到」**——不保證它還在原本那一章底下、
  也不保證階層或語意關係：把真標題改名、再把 `**節名**` 搬到完全無關的章節，考題照樣綠（實測）。
- **那道檢查是行級的，看不懂 Markdown 結構**（William 2026-09-02 裁定的射程）：
  例如把閘表包進程式碼區塊、拿掉表頭、在儲存格裡插一個沒跳脫的 `|`、把錨點搬到別的章節——它都看不出來。
  它防的是**自然的腐爛**（檔案搬家、節改名、加了新閘沒登記），不是有人刻意把地圖寫成怪格式。
  **實測過的例子（哪幾發綠、哪幾發紅；不宣稱列完）**在 [test/collab-map.test.js](test/collab-map.test.js) 檔頭。
- **驗不到的**：那一節是不是還在講那件事（節名沒動、內容整段換掉，考題照樣綠）；
  本檔有沒有偷偷把規則判準抄進來（機器讀不出「這句是規則還是指路」——那條紀律只有人在守）；
  以及下面標明「選錄」的每一張表。

## 三份正本，各管一層

| 檔案 | 管哪一層 | 什麼時候翻 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | **規矩本身**：誰是誰、能做什麼、誰拍板 | 想知道「這件事我可不可以自己決定」 |
| [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md) | **程序**：審查與合併實際怎麼跑 | 要送審、要合併、要跑閘的時候 |
| [CLAUDE.md](CLAUDE.md) | **只有 Claude 需要的幾條**＋開工入口 | 每個 session 自動載入，不必特地翻 |

## 我想查⋯⋯

### 誰能做什麼

| 問題 | 去哪讀 |
|---|---|
| 誰是誰、各自負責什麼、不負責什麼 | [AGENTS.md](AGENTS.md)「三方協作框架」 |
| Codex 的三種模式：審查／代合併／實作 | [AGENTS.md](AGENTS.md)「三方協作框架」 |
| Grok 能碰什麼、材料怎麼給、什麼時候掃 | [AGENTS.md](AGENTS.md)「Grok 的邊界」 |
| 「不可自審」到底在講什麼 | [AGENTS.md](AGENTS.md)「協作的唯一不變量」 |
| 合併是誰決定的、誰按鍵 | [AGENTS.md](AGENTS.md)「合併的決策與執行是兩件事」 |
| 為什麼實作的人不能按自己的合併鍵 | [AGENTS.md](AGENTS.md)「實作者不按自己的合併鍵」 |
| 審查意見要不要改、哪幾種一定要問 William | [AGENTS.md](AGENTS.md)「審查回饋處置」 |
| 錢相關的操作 AI 能不能做 | [AGENTS.md](AGENTS.md)「錢的絕對邊界」 |
| 什麼事一做就會壞 | [AGENTS.md](AGENTS.md)「鐵則（違反會壞事）」 |

### 一支 PR 怎麼走

| 問題 | 去哪讀 |
|---|---|
| 合併要走哪些步驟、過哪幾道閘 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「合併也由 Codex 代執行」 |
| 找問題→提修法→審修法→實作→審實作 的循環 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「五步驟審查循環」 |
| 這支要走多重的流程（風險分級） | [AGENTS.md](AGENTS.md)「PR 分級」 |
| PR 說明要填哪幾欄 | [.github/pull_request_template.md](.github/pull_request_template.md)「協作欄位」 |
| 實際怎麼發起一輪審查 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「怎麼執行」 |
| 發審查提示時那幾串一字不能改的機械字串 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「發審查提示」 |
| 結論標頭寫壞了怎麼補救 | [AGENTS.md](AGENTS.md)「重述＝壞標頭救濟的入口」 |
| 來源字串被打成兩種寫法、變成兩個身分怎麼收 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「已經漂掉的補救」 |
| 審查者的紀律、審查樹誰備誰收 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「你的角色（唯讀審查者）」 |
| 不管作者叫我看什麼，都一定要跑的那幾條 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「固定維度」 |
| 審查期間要不要掛草稿、CI 跑不跑 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「省額度慣例」 |
| Codex 自己實作時的額外規矩 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「實作模式」 |
| 開審之前審查者要先自己檢查什麼 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「自我檢查（開審前）」 |

### 在哪工作、跟誰撞車

| 問題 | 去哪讀 |
|---|---|
| 我該在哪個目錄開工（主目錄／實作樹／審查樹） | [AGENTS.md](AGENTS.md)「協作流程」 |
| 堆疊 PR 怎麼合、同時開多支要注意什麼 | [AGENTS.md](AGENTS.md)「協作流程」 |
| 同時可以開幾支 PR | [AGENTS.md](AGENTS.md)「同時最多 2 支」 |
| 我要改的檔案別人也在改，怎麼先講好 | [AGENTS.md](AGENTS.md)「共享檔案預約」 |
| 已經跟在途 PR 重疊了怎麼辦 | [AGENTS.md](AGENTS.md)「重疊 PR 讓道」 |
| 一支 PR 上有好幾個審查者、分不出誰是誰 | [AGENTS.md](AGENTS.md)「審查者，而且分辨不出來」 |
| 為什麼審查者會漏看——作者的提示詞決定它看不到什麼 | [AGENTS.md](AGENTS.md)「審查者的注意力是被作者塑造的」 |
| 改一處要連帶檢查哪些地方 | [AGENTS.md](AGENTS.md)「同步點清單」 |
| 我要動的檔案屬於哪個領域契約 | [docs/contracts/README.md](docs/contracts/README.md)「領域契約路由表」 |

### 只有 Claude 要看的

| 問題 | 去哪讀 |
|---|---|
| 對 William 回報要講什麼、講多少 | [CLAUDE.md](CLAUDE.md)「只有 Claude 需要知道的幾條」 |
| 開工前一定要先做的那幾件 | [CLAUDE.md](CLAUDE.md)「開工前」 |

## 規矩的手腳：哪些是機器在管的

### 合併步驟專用的閘

這張表＝**合併步驟裡實際會跑的那幾支**（從 `REVIEW-AND-MERGE.md` 的「合併也由 Codex 代執行」
那段的標準指令行反查，判準與合併閘盤點考題**共用同一份**）。左欄是該腳本自報的名字。
所以**加了新閘卻沒列進來會轉紅；表上多列一支沒接進合併步驟的（幽靈閘）也會轉紅**。
想知道每道閘在防什麼，去讀該腳本的檔頭。

| 閘 | 腳本 |
|---|---|
| 協作欄位 | [scripts/check-pr-collab-fields.js](scripts/check-pr-collab-fields.js) |
| 複審結論取聯集 | [scripts/check-review-verdicts.js](scripts/check-review-verdicts.js) |
| 真考卷 | [scripts/check-ci-really-ran.js](scripts/check-ci-really-ran.js) |
| 堆疊 | [scripts/check-pr-merge-gate.js](scripts/check-pr-merge-gate.js) |
| 跨 PR 試合併 | [scripts/check-cross-pr-merge.js](scripts/check-cross-pr-merge.js) |

⚠️ 另有一道兜底，防「自報自己是閘、卻永遠不會跑」的東西留在 `scripts/` 裡。
**兩者認得到什麼、認不到什麼（副檔名、指令形狀、只認哪個名字、哪種閘會完全隱形），
逐條寫在 `test/collab-map.test.js` 檔頭——這裡刻意不複述**：
那是考題的判準，抄進路由表就是第二份會漂的複本（本檔唯一的紀律就是只給地址）。

### 其他也會擋人的（**選錄，不對帳，不完整**）

| 管什麼 | 誰在管 |
|---|---|
| 型別／格式／考題三關 | [scripts/git-hooks/pre-push](scripts/git-hooks/pre-push)＋[.github/workflows/ci.yml](.github/workflows/ci.yml) |
| 文件命名 | [test/doc-naming.test.js](test/doc-naming.test.js) |
| 合併閘名單 | [test/collab-invariant-docs.test.js](test/collab-invariant-docs.test.js) |
| Grok 掃描紀錄 | [test/grok-scan-docs.test.js](test/grok-scan-docs.test.js) |

⚠️ 這一節是**選錄**：`npm test` 裡還有很多支考題，紅了同樣會擋合併（它們經由三關與 CI 生效）。
不要把這張表當成「會擋人的東西的全集」。

### 這些**沒有任何機器在看**（例）

Grok 複審後掃有沒有做、掃描與複審的先後時序、審查提示詞有沒有涵蓋固定維度——
漏做不會有東西擋你，全靠自律。

## 一條住在別的 repo 的規矩

**Grok 材料檔標準邊界前綴**——逐字正本在 `../teaching-videos/AGENTS.md`「Grok 材料檔標準邊界前綴」節，
本 repo 刻意不存副本。射程與沿革見 [AGENTS.md](AGENTS.md)「Grok 的邊界」。

⚠️ 這一條**故意不寫成連結，本檔的考題也驗不到它**：那是另一個 repo、不保證在這台機器上。
