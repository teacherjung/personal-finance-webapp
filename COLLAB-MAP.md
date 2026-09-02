# 協作規矩地圖：哪一條規矩住在哪裡

> **這是路由表，不是規則。** 本檔不寫任何一條規則的內容，只回答「我想查 X，要翻哪一份的哪一節」。
>
> 為什麼刻意只給地址：同一條規則曾經同時抄在六個地方，六份**各自漏掉不同的一項**
> （`Codex #457` 連三輪抓到不同份漏不同項，最危險的一份「例外寫了兩條、漏掉第三條」——
> 看起來完整，實際上少一個守備範圍）。**會漂的不是規則，是複本。**
>
> ⚠️ **本檔沒有規則效力、不擋任何合併。** 與正本不一致時一律以正本為準，然後回頭修本檔。
> ⚠️ **機械保證只有一格**：[test/collab-map.test.js](test/collab-map.test.js) 驗「下表指到的檔案還在、
> 引用的節名字串還在」。它**驗不到那一節是不是還在講那件事**——地址對、內容整段換掉，它照樣綠。

## 三份正本，各管一層

| 檔案 | 管哪一層 | 什麼時候翻 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | **規矩本身**：誰是誰、能做什麼、誰拍板 | 想知道「這件事我可不可以自己決定」 |
| [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md) | **程序**：審查與合併實際怎麼跑 | 要送審、要合併、要跑閘的時候 |
| [CLAUDE.md](CLAUDE.md) | **只有 Claude 需要的幾條**＋開工入口 | 每個 session 自動載入，不必特地翻 |

兩份講到同一件事時：**AGENTS.md 是規則正本，REVIEW-AND-MERGE.md 是執行正本**。
（例：「修不修由誰拍板」的例外清單只在 AGENTS，REVIEW-AND-MERGE 那邊刻意只留指路。）

## 我想查⋯⋯

### 誰能做什麼

| 問題 | 去哪讀 |
|---|---|
| 誰是誰、各自負責什麼、不負責什麼（角色表） | [AGENTS.md](AGENTS.md)「三方協作框架」 |
| Codex 的三種模式：審查／代合併／實作 | [AGENTS.md](AGENTS.md)「三方協作框架」 |
| Grok 能碰什麼、材料怎麼給、掃描什麼時候做 | [AGENTS.md](AGENTS.md)「Grok 的邊界」 |
| 「不可自審」到底在講什麼 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「唯一要守的不變量」 |
| 合併是誰決定的、誰按鍵 | [AGENTS.md](AGENTS.md)「合併的決策與執行是兩件事」 |
| 為什麼實作的人不能按自己的合併鍵 | [AGENTS.md](AGENTS.md)「實作者不按自己的合併鍵」 |
| 審查意見要不要改、哪幾種一定要問 William | [AGENTS.md](AGENTS.md)「審查回饋處置」 |
| 錢相關的操作 AI 能不能做 | [AGENTS.md](AGENTS.md)「錢的絕對邊界」 |
| 什麼事一做就會壞（全域鐵則） | [AGENTS.md](AGENTS.md)「鐵則（違反會壞事）」 |

### 一支 PR 怎麼走

| 問題 | 去哪讀 |
|---|---|
| 從開工到合併，整條流程長什麼樣 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「五步驟審查循環」 |
| 實際怎麼發起一輪審查（叫 Codex 的指令、時機） | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「怎麼執行」 |
| 發審查提示時那幾串一字不能改的機械字串 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「發審查提示」 |
| 合併前要過哪幾道閘、順序是什麼 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「合併步驟」 |
| 審查的人要守什麼紀律、審查樹誰備誰收 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「你的角色（唯讀審查者）」 |
| 不管作者叫我看什麼，都一定要跑的那幾條 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「固定維度」 |
| 審查期間 PR 要不要掛草稿、CI 跑不跑 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「省額度慣例」 |
| Codex 自己實作時的額外規矩 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「實作模式」 |
| 開審之前審查者要先自己檢查什麼 | [REVIEW-AND-MERGE.md](REVIEW-AND-MERGE.md)「自我檢查（開審前）」 |

### 在哪工作、跟誰撞車

| 問題 | 去哪讀 |
|---|---|
| 我該在哪個目錄開工（主目錄／實作樹／審查樹） | [AGENTS.md](AGENTS.md)「協作流程」 |
| 同時開好幾支 PR 怎麼不互相打架、堆疊怎麼合 | [AGENTS.md](AGENTS.md)「協作流程」 |
| 我要改的檔案跟別支在途 PR 重疊了 | [AGENTS.md](AGENTS.md)「重疊 PR 讓道」 |
| 一支 PR 上有好幾個審查者、分不出誰是誰 | [AGENTS.md](AGENTS.md)「審查者，而且分辨不出來」 |
| 為什麼審查者會漏看——作者的提示詞決定它看不到什麼 | [AGENTS.md](AGENTS.md)「審查者的注意力是被作者塑造的」 |
| 改一處要連帶檢查哪些地方 | [AGENTS.md](AGENTS.md)「同步點清單」＋[docs/contracts/README.md](docs/contracts/README.md) |

### 只有 Claude 要看的

| 問題 | 去哪讀 |
|---|---|
| 對 William 回報要講什麼、講多少 | [CLAUDE.md](CLAUDE.md)「只有 Claude 需要知道的幾條」 |
| 開工前一定要先做的那幾件 | [CLAUDE.md](CLAUDE.md)「開工前」 |

## 規矩的手腳：哪幾條真的有機器在管

規則寫在文件裡，但**只有下面這些有東西在合併前擋人**。其餘全靠自律。

下表的閘**不是手寫名單**：`test/collab-map.test.js` 拿它跟「腳本自己宣告的 `MERGE_GATE`」對帳，**日後加了新閘卻沒列進來，考題就會轉紅**。（下半部那幾支考題不在對帳範圍內——它們不是合併閘，是一般考題。）

| 管什麼 | 誰在管 |
|---|---|
| PR 的協作欄位有沒有填（實作者／審查者／基準版本…） | [.github/pull_request_template.md](.github/pull_request_template.md)＋[scripts/check-pr-collab-fields.js](scripts/check-pr-collab-fields.js) |
| 複審結論取聯集（任一人說不行就是不行） | [scripts/check-review-verdicts.js](scripts/check-review-verdicts.js) |
| CI 真的在這顆 commit 上跑過而且綠 | [scripts/check-ci-really-ran.js](scripts/check-ci-really-ran.js) |
| 堆疊 PR（base 不是 main、或有 PR 疊在上面） | [scripts/check-pr-merge-gate.js](scripts/check-pr-merge-gate.js) |
| 跨 PR 試合併會不會撞 | [scripts/check-cross-pr-merge.js](scripts/check-cross-pr-merge.js) |
| 合併步驟裡那幾道閘的名字有沒有被偷偷拿掉 | [test/collab-invariant-docs.test.js](test/collab-invariant-docs.test.js) |
| 三方共用的文件，名字不可以只掛一方 | [test/doc-naming.test.js](test/doc-naming.test.js) |
| Grok 掃描那個固定小標還在不在 | [test/grok-scan-docs.test.js](test/grok-scan-docs.test.js) |

⚠️ **下面這些沒有任何機器在看**（照實劃界，別以為有網子接著）：
Grok 複審後掃有沒有做、掃描與複審的先後時序、審查提示詞有沒有涵蓋固定維度、
以及本表以外的一切自律條款。漏做不會有東西擋你。

## 一條住在別的 repo 的規矩

**Grok 材料檔標準邊界前綴**（每份給 Grok 的材料要逐字照抄的那幾行）——
逐字正本在 `../teaching-videos/AGENTS.md`「Grok 材料檔標準邊界前綴」節，本 repo 刻意不存副本
（抄一份就是第二份會漂的模板）。射程與沿革見 [AGENTS.md](AGENTS.md)「Grok 的邊界」。

⚠️ 這一條**故意不寫成連結，本檔的考題也驗不到它**：那是另一個 repo、不保證在這台機器上。
