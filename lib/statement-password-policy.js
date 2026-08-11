// @ts-check
// 匯入密碼池的上限常數（P0.5 r2#5：零依賴共用 policy）——讀取端（statement-import）與寫入端（schema）
// 都 import 這一份，兩處各寫一份數字會走鐘（Codex r2 抓到硬編碼風險）。
//
// 為什麼有上限：**池大小＝每次上傳帳單的 PDF 解析嘗試次數**。密碼來自使用者資料（記住的密碼、
// 各卡 pdfPassword），而備份匯入可以塞進大量卡片／大量記住的密碼——沒有總上限，一次上傳就能跑
// 上千次重型 PDF 解析（HOSTED 繞過請求級限速）。三個層級各有上限、彼此獨立守：
export const MAX_REMEMBERED = 8;      // 「記住的帳單密碼」最多幾組（記住端點＋讀取／寫入端 fail-safe）
export const MAX_PW_LEN = 100;        // 每組密碼字數上限（身分證字號級，遠低於此）
export const MAX_POOL_ATTEMPTS = 25;  // **整個池**（含所有卡密碼）的總嘗試上限——這才是 DoS 的真正閘門
                                      // （卡片數量本身無總上限，靠這道把「解析次數」封頂；優先序在前的先進池）
