// @ts-check
// 投資頁說明彈窗：只把已算好的數字與規則排成 HTML，不碰 DOM、API 或頁面狀態。

/**
 * @param {{ total:number, equity:number, bond:number, gold:number }} values
 * @param {{ formatMoney:(value:number)=>string }} formatters
 */
export function totalValueInfoHtml(values, formatters) {
  const { total, equity, bond, gold } = values;
  const money = formatters.formatMoney;
  return `
    <p><b>總市值 ＝ 股票市值 + 債券市值 + 黃金市值</b></p>
    <p style="font-family:var(--serif);font-size:20px;margin-top:10px">${money(total)} ＝ 股票 ${money(equity)} + 債券 ${money(bond)} + 黃金 ${money(gold)}</p>
    <p class="muted small" style="margin-top:10px">這裡只計算投資持股市值，不包含現金，也不扣除融資。</p>
  `;
}

/** 匯率說明（丙）：總覽的「為什麼？」與投資頁的「匯率從哪裡來？」共用同一份文案（文案由 William 審改）。 */
export const FX_INFO_TITLE = '匯率從哪裡來、預設值是什麼';
export const FX_INFO_HTML = `<p>匯率的來源依序是：<b>Yahoo 報價</b> → 抓不到就走<b>備援匯率 API</b>（兩個）→ 都抓不到就沿用<b>上次抓到的匯率</b> → 從來沒抓到過才用<b>預設值</b>（美元 31、英鎊 41、日圓 0.2）。開 app 時會自動抓一次（超過一小時才抓），投資頁「更新報價」可再抓（十分鐘內會沿用剛抓到的值）。</p>
<p>用預設值算出來的數字會有一點誤差，但匯率通常波動不大，先算進去比把整筆藏起來好——頁面會標出「有幾筆用的是預設匯率」，讓你知道哪些數字還在等即時匯率。</p>
<p>只有<b>系統不支援的幣別</b>（表單裡選不到的）才真的算不出來：那幾筆不會計入，頁面會分開標示，請把它改成支援的幣別。</p>`;

/**
 * @param {{ stock:number, equity:number, country:number, china:number, lev:number, maint:number }} caps
 */
export function disciplineInfoHtml(caps) {
  return `
    <p><b>口徑</b>：所有上限以「<b>% 淨資產</b>」衡量（不是投組市值——有融資時淨資產較小，規則自動更嚴格）。國家曝險採<b>穿透</b>計算：ETF 內含成分（如 EIMI 裡的中國、台灣）都拆進對應國家一起計。</p>
    <p><b>軟上限</b>：超標＝<b>凍結加碼</b>（禁止再買進），但不強制賣出，讓部位隨時間自然稀釋。在「編輯持股」把凍結中的標的加碼時，會跳出確認提醒。</p>
    <p><b>怎麼看圖</b>：黑色刻度＝上限位置；長條＝目前部位，<span style="color:var(--pos)">綠色</span>＝上限內、<span style="color:var(--neg)">紅色</span>＝超出上限的部分。</p>
    <p><b>目前上限</b>：單一個股 ${caps.stock}%・股票總曝險 ${caps.equity}%・單一國家 ${caps.country}%（中國 ${caps.china}%）・IB 融資槓桿 ${caps.lev}x（<b>任何時期適用</b>；估值訊號期加碼只用新資金與現金，不舉新債）。到「設定 → 投資原則」即可調整。</p>
    <p><b>斷頭距離</b>：市場跌時借款不會跟著縮水，跌到「淨值 ÷ 持倉」低於 IB 維持保證金率（${caps.maint}%，設定頁可調）的那一刻，IB 會<b>即時自動強制平倉，不打電話、無寬限期</b>。這個數字＝從現在起市場還能跌多少。它是假設全部持倉維持率一致的近似值；IB 在危機時會調高維持率（2020 年 3 月發生過），所以旁邊附了壓力情境。最高指導原則：<b>要一個在所有環境都活著的系統，而不是在多數環境賺更多的系統</b>。</p>`;
}
