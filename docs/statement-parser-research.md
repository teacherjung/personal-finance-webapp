# 帳單解析器開源候選研究

2026-10-08 查核下列專案的公開說明與當時 GitHub 檔案樹，未找到合作金庫每月存款 PDF 的專用解析器。這個結論只涵蓋所查清單與檔名，不代表全網沒有，也未證明通用工具無法解析。

| 候選 | 可借鏡的方向 | 合庫施工的限制 |
| --- | --- | --- |
| [Mailquill](https://github.com/kylinfish/mailquill) | 台灣帳單的本機規則與格式分流 | 公開支援清單未找到本次存款版型 |
| [monopoly](https://github.com/benjamin-awd/monopoly) | 各銀行分開解析與固定輸出 | 所查銀行清單未找到合庫 |
| [banksheet](https://github.com/tio-ze-rj/banksheet) | 依機構擴充解析器 | 所查檔案未找到合庫專用實作 |
| [pdfcsv](https://github.com/stexz01/pdfcsv) | 通用 PDF 表格抽取 | 欄位抽出不等於交易方向、帳戶與去重語意正確 |

合庫第一版優先重用專案既有的 PDF 抽字、密碼池、預覽、驗算與匯入流程，只增加有版型證據的分流與欄位解析。沒有直接複製外部程式碼，也沒有量得節省多少工時。日後若選定外部片段，需先核對該版本授權與相依，再決定整合方式。

既有版型固定考題見 [回歸基準](statement-format-baseline.md)；本次施工範圍見 [合庫計畫](tcb-transfer-statement-plan.md)。
