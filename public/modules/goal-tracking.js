// @ts-check
// 目標追蹤的純呈現層：只接後端已算好的 goalTrack，不在前端重算任何財務公式。

export const GOAL_TRACKING_INFO = Object.freeze({
  speeds: {
    title: '「存錢速度」和「含市場」差在哪？',
    html: '<p><b>每月現金結餘</b>＝你每個月實際留下來的錢，是比較能由自己控制的速度。</p><p><b>整體淨值變化</b>＝連投資漲跌與匯率變化一起算，會忽快忽慢。</p><p>兩個都列出，是因為市場不該被誤當成你的努力；前者較保守，後者只適合當參考。</p>',
  },
  market: {
    title: '為什麼「含市場」會變來變去？',
    html: '<p>整體淨值會跟著股市、匯率與帳戶更新而改變。市場好時，看起來會比較快；市場差時，可能變慢甚至倒退。</p><p>這個時間只是依最近資料推估，<b>不是保證的達成日</b>。</p>',
  },
  unavailable: {
    title: '為什麼有時候不顯示到達時間？',
    html: '<p>至少要累積三個已結束月份，才會開始估算。若資料還太少，或最近沒有正成長，硬算只會得到一個假的精確答案。</p><p>所以 App 會先顯示目前進度，等資料足夠、速度回到正數後，再提供時間估算。</p>',
  },
});

/** @param {unknown} raw @returns {number|null} 空白＝null；非法＝NaN；合法＝台幣元整數 */
export function netWorthTargetFromWan(raw) {
  const text = String(raw ?? '').trim().replaceAll(',', '');
  if (!text) return null;
  const wan = Number(text);
  return Number.isFinite(wan) && wan > 0 ? Math.round(wan * 10000) : NaN;
}

/** @param {unknown} targetTwd @returns {string} */
export function netWorthTargetWanInput(targetTwd) {
  const target = Number(targetTwd);
  return Number.isFinite(target) && target > 0 ? String(target / 10000) : '';
}

/** @param {unknown} raw @param {(v:number)=>string} money */
export function netWorthTargetPreview(raw, money) {
  const target = netWorthTargetFromWan(raw);
  if (target == null) return '留空後儲存，就會停止顯示目標追蹤。';
  if (!Number.isFinite(target)) return '請輸入大於 0 的數字。';
  return `換算為完整金額：${money(target)}`;
}

/** @param {any} goal @param {'savings'|'netWorth'} kind */
function etaText(goal, kind) {
  const months = Number(kind === 'savings' ? goal?.monthsSavings : goal?.monthsNetWorth);
  if (Number.isFinite(months) && months > 0) {
    return `約 ${Math.max(1, Math.ceil(months)).toLocaleString('en-US')} 個月`;
  }
  const samples = Number(kind === 'savings' ? goal?.savingsSamples : goal?.netWorthSamples) || 0;
  if (samples < 3) return '資料累積中';
  return kind === 'savings'
    ? '最近沒有淨存入，暫時估不出到達時間'
    : '最近淨值在下滑（含市場）';
}

/**
 * @param {any} goal 後端 computeGoalTracking 的結果
 * @param {{wan:(v:any)=>string, pct:(v:any)=>string}} fmt
 */
export function goalTrackingHtml(goal, fmt) {
  if (!goal) return '';
  const target = Number(goal.target);
  if (!Number.isFinite(target) || target <= 0) return '';
  const current = Number.isFinite(Number(goal.current)) ? Number(goal.current) : 0;
  const gap = Number.isFinite(Number(goal.gap)) ? Math.max(0, Number(goal.gap)) : Math.max(0, target - current);
  const progress = Math.max(0, Math.min(100, Number(goal.progressPct) || 0));
  const reached = Boolean(goal.reached);

  const etaHtml = reached ? '<div class="gt-reached">已達成</div>' : `
    <div class="gt-etas">
      <div class="gt-eta">
        <button type="button" class="info-link gt-label" data-goal-info="speeds">依每月現金結餘</button>
        <b>${etaText(goal, 'savings')}</b>
      </div>
      <div class="gt-eta">
        <button type="button" class="info-link gt-label" data-goal-info="market">依整體淨值變化</button>
        <b>${etaText(goal, 'netWorth')}</b>
      </div>
    </div>
    <button type="button" class="info-link gt-help" data-goal-info="unavailable">為什麼有時候不顯示到達時間？</button>`;

  return `<section class="goal-track" aria-label="淨值目標進度">
    <div class="gt-top">
      <div><div class="gt-kicker">淨值目標</div><div class="gt-title">${reached
    ? `目標 ${fmt.wan(target)}`
    : `距離 ${fmt.wan(target)} 還差 <b>${fmt.wan(gap)}</b>`}</div></div>
      <span class="gt-pct">${fmt.pct(progress)}</span>
    </div>
    <div class="gt-bar" role="progressbar" aria-label="淨值目標完成進度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.toFixed(1)}"><i style="width:${progress.toFixed(2)}%"></i></div>
    <div class="gt-scale"><span>目前 ${fmt.wan(current)}</span><span>目標 ${fmt.wan(target)}</span></div>
    ${etaHtml}
  </section>`;
}
