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

/**
 * @param {{ stock:number, equity:number, country:number, china:number, lev:number, maint:number }} caps
 */
/** 缺匯率說明（乙）：總覽的「為什麼？」與投資頁的「為什麼不算進去？」共用同一份文案（文案由 William 審改）。 */
export const MISSING_FX_INFO_TITLE = '有外幣資產沒有匯率';
export const MISSING_FX_INFO_HTML = `<p>英鎊、日圓兌台幣的匯率，是在<b>投資頁按「更新報價」</b>時抓回來的。還沒有匯率之前，這些外幣帳戶與持股<b>不會算進淨資產、槓桿與配置</b>。</p>
<p>方向要分清楚：缺的是<b>資產</b>，淨資產會比實際<b>少</b>；缺的是<b>負債</b>（例如 IB 的外幣負現金），負債、融資與槓桿會比實際<b>小</b>、淨資產比實際<b>高</b>——這一種最危險，提醒會用紅色講出來。</p>
<p>以前系統會先用一個猜的匯率把它們算進去；現在不猜：<b>看得見的「沒算」勝過默默算錯</b>。到投資頁按一次「更新報價」，匯率補上後這些部位就會回到數字裡。</p>`;

export function disciplineInfoHtml(caps) {
  return `
    <p><b>口徑</b>：所有上限以「<b>% 淨資產</b>」衡量（不是投組市值——有融資時淨資產較小，規則自動更嚴格）。國家曝險採<b>穿透</b>計算：ETF 內含成分（如 EIMI 裡的中國、台灣）都拆進對應國家一起計。</p>
    <p><b>軟上限</b>：超標＝<b>凍結加碼</b>（禁止再買進），但不強制賣出，讓部位隨時間自然稀釋。在「編輯持股」把凍結中的標的加碼時，會跳出確認提醒。</p>
    <p><b>怎麼看圖</b>：黑色刻度＝上限位置；長條＝目前部位，<span style="color:var(--pos)">綠色</span>＝上限內、<span style="color:var(--neg)">紅色</span>＝超出上限的部分。</p>
    <p><b>目前上限</b>：單一個股 ${caps.stock}%・股票總曝險 ${caps.equity}%・單一國家 ${caps.country}%（中國 ${caps.china}%）・IB 融資槓桿 ${caps.lev}x（<b>任何時期適用</b>；估值訊號期加碼只用新資金與現金，不舉新債）。到「設定 → 投資原則」即可調整。</p>
    <p><b>斷頭距離</b>：市場跌時借款不會跟著縮水，跌到「淨值 ÷ 持倉」低於 IB 維持保證金率（${caps.maint}%，設定頁可調）的那一刻，IB 會<b>即時自動強制平倉，不打電話、無寬限期</b>。這個數字＝從現在起市場還能跌多少。它是假設全部持倉維持率一致的近似值；IB 在危機時會調高維持率（2020 年 3 月發生過），所以旁邊附了壓力情境。最高指導原則：<b>要一個在所有環境都活著的系統，而不是在多數環境賺更多的系統</b>。</p>`;
}
