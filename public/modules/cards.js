// @ts-check
import { api, view, byId, wan, money, esc, daysUntil, openForm, openInfo, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';
import { issuerOptions, issuerFormFields, resolveIssuerFields, issuerById, issuersNamed, ISSUER_OTHER } from './card-issuers.js';

const NETWORKS = ['VISA', 'Mastercard', 'JCB', '銀聯', '美國運通', '—'];
// 就地解釋（專案鐵則：懂了才不會把正常行為當成程式算錯的概念，一律在網頁上白話講，不可只寫在文件裡）。
// ⚠️ 文案由 Claude 起草、老師審改；改字要連 `test/card-issuers.test.js` 的文案題一起改。
const ISSUER_INFO_HTML = `
  <p><strong>因為光看名字，分不出是哪一家銀行。</strong></p>
  <p>「富邦」這兩個字，<strong>香港的富邦銀行</strong>和<strong>台北富邦銀行</strong>都在用——兩家是不同的銀行，
  只是同一個集團、名字撞在一起。所以就算你打得很精確，只寫「富邦」，程式還是不知道你手上這張卡是哪一家發的。</p>
  <p>這件事會影響到錢：上傳帳單時，程式會用發卡銀行去猜「這份帳單是哪一張卡的」。認錯家，
  這個月的消費就會記到<strong>別張卡</strong>上。所以現在改成從清單挑——挑「台北富邦銀行」或
  「富邦銀行（香港）」，就沒有猜的空間了。</p>
  <p><strong>但挑了清單，不等於帳單一定會自動對上。</strong>那是兩件事：清單解決「這是哪一家銀行」，
  另一件是「程式看不看得懂這家的帳單格式」。目前內建的格式只有<strong>台新</strong>和<strong>台北富邦</strong>兩家：</p>
  <ul>
    <li>帳單<strong>讀得懂、但認不出是哪張卡</strong> → 跳出清單請你選一次。</li>
    <li>帳單<strong>整個讀不懂</strong>（多半是其他銀行的格式）→ 會停下來告訴你讀不動，<strong>不會</strong>跳出選卡、也不會硬記。
    這種情況目前沒有別的辦法，只能等我們補上那家的格式。</li>
  </ul>
  <p>這兩件事跟這次的清單無關，以前也是這樣。</p>
  <p><strong>清單裡沒有你的銀行怎麼辦？</strong>選最下面的「其他（自行輸入）」再自己打，跟以前一樣。
  自己打的名字，程式會先用舊的方式盡量認（像「台新國際商業銀行股份有限公司」還是認得出台新）；
  認不出來就會請你自己選是哪一張卡，多按一下而已。</p>
  <p><strong>挑清單還多做了一件事：把「是哪一家」記成一個固定編號。</strong>
  以前程式是拿你填的那串字去認銀行，所以字改了、寫法不一樣，認出來的結果就可能跟著變。
  從清單挑過之後，這張卡記住的是一個<strong>不會變的編號</strong>，名字只拿來顯示給你看——
  之後不管顯示的字怎麼改，<strong>信用卡</strong>帳單都不會因此歸到別張卡。</p>
  <p>⚠️ <strong>這件事目前只做到信用卡</strong>。簽帳金融卡（刷卡直接從帳戶扣的那種）走的是另一條路，
  那條路現在還是<strong>只看你填的名字</strong>——所以簽帳金融卡請不要隨意改發卡行的字，
  改了下次匯入銀行帳單可能會多長出一張同末四碼的卡、消費紀錄從此分成兩半。
  這一點以前就是這樣，這次沒有一起修（要修得動到另一套比對規則，會影響帳戶餘額，得另外處理）。</p>
  <p><strong>那些還沒挑過的舊卡呢？</strong>照舊用文字認，<strong>行為跟以前完全一樣</strong>——
  這次的改動不會讓任何一張卡突然變成要你手選。
  只是那些卡片上會多一小塊提示，請你打開挑一次；挑完提示就消失。
  提示只在「清單裡真的有你那一家」時才出現——自己打的機構名（像某某會員俱樂部）不會被一直念。</p>
  <p><strong>本來就填好的卡片，打開表單、什麼都不改就儲存，會怎樣？</strong>發卡行原本是文字時（正常操作存進去的都是），只有這幾種情況：
  自己打的名字<strong>原字留著</strong>；名字剛好是清單上同一家的另一種寫法
  （像「臺新銀行」之於「台新銀行」）會被寫成清單上的那一種——同一家，換個字形，<strong>並且順便補上那個編號</strong>；
  整格都是空白會被清成「未設定」。除這幾種之外不會動你的字。</p>
  <p>另外有一種舊寫法要請你動一下：發卡行只填「<strong>富邦</strong>」兩個字的卡。
  以前程式會當它是台北富邦，現在改成不猜了（因為它也可能是香港富邦），所以那張卡的帳單會變成要你自己選。
  打開那張卡、從清單挑「台北富邦銀行」或「富邦銀行（香港）」，就恢復自動對上。</p>
`;
const TYPE_LABEL = { credit: '信用卡', membership: '會員卡', debit: '簽帳金融卡' };
// 簽帳金融卡（Stage 5b）：刷卡直接從存款帳戶扣，**沒有結帳日、繳款日、年費**；它存在的理由是讓金融卡帳單的
// 「刷卡消費明細」有一本自己的消費帳本（跟信用卡一樣做分類分析），銀行匯入時會自動建一張。

// 卡片效期只記年/月（卡面 MM/YY），有效到該月「月底」——倒數與停用判斷都以月底計。
// 兼容舊資料的完整日期（YYYY-MM-DD 原樣沿用）。
const expiryEnd = (e) => /^\d{4}-\d{2}$/.test(e || '')
  ? `${e}-${String(new Date(Number(e.slice(0, 4)), Number(e.slice(5, 7)), 0).getDate()).padStart(2, '0')}`
  : e;

function cardSummary(list) {
  const credit = list.filter(c => (c.type || 'credit') === 'credit');
  const member = list.filter(c => c.type === 'membership');
  const debit = list.filter(c => c.type === 'debit');
  return {
    credit,
    member,
    debit,
    annualFees: credit.reduce((sum, c) => sum + Number(c.annualFee || 0), 0),
    expiringSoon: list.filter(c => {
      const days = daysUntil(expiryEnd(c.expiry));
      return days >= 0 && days <= 30;
    }).length,
  };
}

function expiryMeta(expiry) {
  const month = (expiry || '').slice(0, 7);
  if (!month) return { text: '未設定效期', tone: 'neutral' };
  const days = daysUntil(expiryEnd(expiry));
  if (days < 0) return { text: '已到期', tone: 'danger' };
  if (days <= 60) return { text: `${days} 天後到期`, tone: 'warning' };
  return { text: `有效至 ${month}`, tone: 'neutral' };
}

/**
 * 這張卡要不要提示「發卡行還是文字寫法，挑一下清單」——回空字串＝不提示。
 *
 * William 2026-09-02 裁示「照舊自動＋提示升級」：舊卡照舊能自動歸卡（判準退回文字那條路），
 * 但畫面上要有一個看得到的入口，否則沒有人會知道該去挑。
 *
 * ⚠️ **只在「挑下去真的有終點」時才提示**，否則這句話會變成永遠清不掉的嘮叨，
 *    更糟的是變成**對使用者的錢說假話**（叫他去做一件不會改變任何結果的事）：
 *   ・已經有代號 ⇒ 升級完了，不提示。
 *   ・**清單裡沒有任何一家自稱這個寫法** ⇒ 挑下去只能選「其他」，而「其他」本來就發不出代號
 *     ⇒ 提示了也清不掉（例：「某某會員俱樂部」、「台新國際商業銀行股份有限公司」）。不提示。
 *   ・**只提示信用卡**（`type` 缺席＝信用卡）。另外兩種都不提示，理由**不同**：
 *     ・**會員卡**＝沒有帳單要歸，代號一個結果都改不了。
 *     ・**簽帳金融卡**＝有帳單要歸，但**那條路今天不讀代號**（預審 2026-09-02 抓到，三個視角各自獨立
 *       發現、九票零駁倒）：`lib/services/statement-import.js` 的兩個入口都先
 *       `filter(c => (c.type || 'credit') === 'credit')`，簽帳卡整批被濾掉；簽帳卡唯一會被歸帳單的
 *       地方是 `lib/services/bank-import.js` 的 `(!c.issuer || sameBank(String(c.issuer), bank))`
 *       ——`grep -c issuerId lib/services/bank-import.js` ＝ **0**。
 *       ⚠️ 所以對簽帳卡而言，「挑清單」不但沒有終點，方向還是**反的**：那條路上真正承重的
 *       就是 `issuer` 顯示字串（實測 `sameBank('台新 Richart', '台新') === false` ⇒ 把自動建的
 *       簽帳卡改名成「台新 Richart」，下一期銀行帳單會**另外新建一張同末四碼的簽帳卡**、
 *       帳本從此分家）。**那是 base 既有行為、本支一個字都沒動 `bank-import.js`**，
 *       但本支第一版的提示文案對它宣稱了相反的事（「不管顯示的名字怎麼改都不會影響帳單歸到哪一張卡」）
 *       ——那正是這個 repo 的鐵則要擋的形狀。要讓簽帳卡也走代號＝另案（要動 `bank-alias` 那把尺，
 *       撞了會蓋掉別家餘額，契約寫明是另案裁決）。
 * ⚠️ **誠實劃界**：判準用的是 `issuersNamed`（清單的名稱與別名），**不是**「這張卡現在判不判得出
 *   身分」。所以「台新國際商業銀行股份有限公司」這種**靠樣式**才認得出來的寫法**不會**被提示到，
 *   即使它挑清單也有終點——前端 import 不到 `lib/card-identity.js` 的樣式那條路，這裡不重抄一份
 *   （抄一份＝同一件事兩把尺，這個 repo 反覆踩過）。提示是入口，不是覆蓋率保證。
 * @param {any} c
 */
function issuerUpgradeNote(c) {
  if ((c.type || 'credit') !== 'credit') return '';
  if (issuerById(c.issuerId)) return '';
  const named = issuersNamed(c.issuer);
  if (!named.length) return '';
  // 歧義的那些（今天＝「富邦」「富邦銀行」）現在就**已經**判不出身分＝帳單本來就要手選；
  // 其餘只是「還靠文字認」。兩種處境不同，話要分開講。
  // ⚠️ **兩支都不可以承諾「（恢復）自動對上」**（預審 2026-09-02：e09dced 只修了下面那一支）：
  //    歧義今天唯一的實例是「富邦」「富邦銀行」，而它的兩個選項是台北富邦（有內建範本）與
  //    **富邦銀行（香港）（`bank: ''`＝沒有範本）**——香港富邦真的發卡、那正是這份清單存在的理由，
  //    所以「照著挑」的人裡有一整類挑完**永遠不會自動對上**。能承諾的只有「程式從此分得出是哪一家」。
  return named.length > 1
    ? `<div class="card-issuer-upgrade"><span>要動一下</span><p>「${esc(c.issuer)}」這個寫法有 ${named.length} 家在用，程式不會猜是哪一家——<strong>這張卡的帳單現在要你自己選</strong>。打開這張卡、從清單挑一次，程式就<strong>分得出這是哪一家</strong>了（帳單能不能自動記到這張卡是<strong>另一件事</strong>，要看程式讀不讀得懂那家的帳單格式）。</p></div>`
    // ⚠️ 這一句**刻意不說「現在照舊會自動」**（自審 2026-09-02 抓到的過度宣稱）：這個提示也會出現在
    //    沒有內建範本的機構上（遠東商銀、玉山…），那些卡的帳單本來就讀不動、從來沒有自動過——
    //    對他們說「照舊會自動」是對使用者的錢說假話。改成只講**這次挑選會改變什麼**（身分不再靠文字），
    //    以及**不會改變什麼**（現在的行為）。
    : `<div class="card-issuer-upgrade"><span>可以更保險</span><p>發卡行還是文字寫法。打開這張卡、從清單挑一次同一家，這張卡的身分就<strong>不再靠文字認</strong>——現在的行為不會變，但之後不管顯示的名字怎麼改，都不會影響帳單歸到哪一張卡。</p></div>`;
}

function cardNoticeHtml(message) {
  if (!message) return '';
  return `<div class="card-tracker-notice" role="status" aria-live="polite">
    <span>${icon('check', 17)}</span><strong>${esc(message)}</strong>
  </div>`;
}

function cardsLoadingHtml() {
  return `<div class="cards-page">
    <div class="page-head cards-page-head">
      <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
    </div>
    <section class="card-tracker-state card-tracker-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="card-state-icon">${icon('card', 27)}</span>
      <div><span>正在整理</span><h2>正在讀取卡片資料</h2><p>只會讀取卡片清單，不會修改任何資料。</p></div>
    </section>
  </div>`;
}

function cardsLoadErrorHtml(message) {
  return `<div class="cards-page">
    <div class="page-head cards-page-head">
      <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
    </div>
    <section class="card-tracker-state card-tracker-error" role="alert" aria-labelledby="cardsErrorTitle">
      <span class="card-state-icon">${icon('alert', 28)}</span>
      <div class="card-state-copy">
        <span>載入未完成</span>
        <h2 id="cardsErrorTitle">卡片資料暫時載入失敗</h2>
        <p>這次只讀取失敗，沒有新增、刪除或修改任何卡片。可以直接重新載入。</p>
      </div>
      <button class="btn-ghost" id="retryCards">${icon('refresh', 16)}重新載入</button>
      <details><summary>查看錯誤訊息</summary><code>${esc(message || '無法連線')}</code></details>
    </section>
  </div>`;
}

let cardNotice = '';

function rerenderCardsAfterSave(seq, message) {
  if (seq !== currentRouteSeq()) return;
  cardNotice = message;
  return renderCards();
}

export async function renderCards() {
  const seq = currentRouteSeq();
  const notice = cardNotice;
  cardNotice = '';
  view().innerHTML = cardsLoadingHtml();
  let list;
  try {
    list = await api('/cards');
  } catch (error) {
    if (seq !== currentRouteSeq()) return;
    view().innerHTML = cardsLoadErrorHtml(error instanceof Error ? error.message : '無法連線');
    byId('retryCards').onclick = () => renderCards();
    return;
  }
  if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁（Codex r10#6 idiom；r11#2 補上漏掉的兩頁）——寫 DOM 前必守，router 的事後檢查救不了 renderer 內部的寫入
  const summary = cardSummary(list);

  view().innerHTML = `
    <div class="cards-page">
      <div class="page-head cards-page-head">
        <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
        <div class="page-actions"><button class="btn" id="addCard">${icon('plus', 16)}新增卡片</button></div>
      </div>

      ${cardNoticeHtml(notice)}

      <section class="card-tracker-summary" aria-label="卡片摘要">
        <div class="card-summary-item"><span>全部卡片</span><strong>${list.length} 張</strong></div>
        <div class="card-summary-item"><span>信用卡</span><strong>${summary.credit.length} 張</strong></div>
        <div class="card-summary-item"><span>信用卡年費合計</span><strong>${wan(summary.annualFees)}</strong></div>
        <div class="card-summary-item"><span>30 天內到期</span><strong>${summary.expiringSoon} 張</strong></div>
      </section>

      <div class="card-privacy-note">
        <span class="card-privacy-icon">${icon('shield', 17)}</span>
        <div><strong>卡號只顯示末四碼</strong><p>帳單密碼不會回填到頁面；需要更新時再於編輯表單輸入。</p></div>
      </div>

      <div class="card-privacy-note">
        <span class="card-privacy-icon">${icon('bank', 17)}</span>
        <div><strong>發卡銀行請從清單挑</strong><p>清單把「這是哪一家銀行」講清楚，降低帳單歸錯卡的機會。<button type="button" class="info-link" id="issuerInfo">為什麼不能自己打字？</button></p></div>
      </div>

      ${cardSection('信用卡', '帳務與繳款', summary.credit, 'credit')}
      ${cardSection('簽帳金融卡', '直接扣帳戶，只記消費', summary.debit, 'debit')}
      ${cardSection('會員卡', '會籍與權益', summary.member, 'membership')}
    </div>
  `;

  byId('issuerInfo').onclick = () => openInfo('為什麼發卡銀行要從清單挑？', ISSUER_INFO_HTML);
  byId('addCard').onclick = () => openCardForm();
  view().querySelectorAll('[data-add-type]').forEach(b => b.onclick = () => openCardForm(null, { defaultType: b.dataset.addType }));
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openCardForm(list.find(c => c.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const c = list.find(x => x.id === b.dataset.del);
    confirmDelete(c.name, async () => {
      await api('/cards/' + c.id, { method: 'DELETE' });
      cardNotice = '卡片已刪除';
    });
  });
}

function cardSection(title, eyebrow, list, type) {
  const emptyText = type === 'credit' ? '尚無信用卡' : type === 'debit' ? '尚無簽帳金融卡' : '尚無會員卡';
  const emptyGuide = type === 'credit'
    ? '新增後可一起查看結帳日、繳款日、年費與效期。'
    : type === 'debit'
      ? '上傳金融卡帳單時會自動建立；刷卡消費明細會記到它的消費帳本做分類分析。'
      : '新增後可記錄會員編號、等級、權益與效期。';
  return `<section class="card-tracker-section">
    <div class="card-tracker-section-head">
      <div><span>${eyebrow}</span><h2>${title}</h2></div>
      <p>${list.length} 張</p>
    </div>
    ${list.length
      ? `<div class="card-tracker-grid">${list.map(cardPanel).join('')}</div>`
      : `<div class="card-tracker-empty">
        <span>${icon('card', 22)}</span>
        <div><strong>${emptyText}</strong><p>${emptyGuide}</p></div>
        <button class="btn" data-add-type="${type}">${icon('plus', 16)}新增${emptyText.slice(2)}</button>
      </div>`}
  </section>`;
}

function cardPanel(c) {
  const credit = (c.type || 'credit') === 'credit';
  const debit = c.type === 'debit';
  const expiry = expiryMeta(c.expiry);
  const dueLabel = c.dueDay
    ? `${Number(c.statementDay) && Number(c.dueDay) < Number(c.statementDay) ? '次月' : '每月'} ${c.dueDay} 日`
    : '未設定';
  const facts = credit ? [
    ['末四碼', c.lastFour ? `•••• ${c.lastFour}` : '未設定'],
    ['卡片組織', c.network || '未設定'],
    ['年費', c.annualFee === '' || c.annualFee == null ? '未設定' : money(c.annualFee)],
  ] : debit ? [
    ['末四碼', c.lastFour ? `•••• ${c.lastFour}` : '未設定'],
    ['發卡銀行', c.issuer || '未設定'],
    ['卡片組織', c.network && c.network !== '—' ? c.network : '未設定'],
  ] : [
    ['會員編號', c.memberId || '未設定'],
    ['會員等級', c.level || '未設定'],
    ['發卡機構', c.issuer || '未設定'],
  ];
  return `<article class="card-tracker-item">
    <div class="card-tracker-item-head">
      <div class="card-tracker-identity">
        <span class="card-tracker-mark">${icon('card', 18)}</span>
        <div><h3>${esc(c.name)}</h3><p>${esc(c.issuer || (credit ? '發卡銀行未設定' : '發卡機構未設定'))}</p></div>
      </div>
      <span class="card-type-tag ${credit ? 'credit' : debit ? 'debit' : 'membership'}">${TYPE_LABEL[c.type || 'credit'] || '信用卡'}</span>
    </div>

    ${credit ? `<div class="card-schedule" aria-label="結帳與繳款日">
      <div><span>結帳日</span><strong>${c.statementDay ? `每月 ${esc(c.statementDay)} 日` : '未設定'}</strong></div>
      <div><span>繳款日</span><strong>${esc(dueLabel)}</strong></div>
    </div>` : ''}

    <div class="card-facts">
      ${facts.map(([label, value]) => `<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}
    </div>

    ${issuerUpgradeNote(c)}

    <div class="card-expiry-row">
      <span class="card-expiry-tag ${expiry.tone}">${icon('history', 14)}${esc(expiry.text)}</span>
    </div>

    ${c.benefits ? `<div class="card-benefits"><span>主要權益</span><p>${esc(c.benefits)}</p></div>` : ''}
    ${c.note ? `<p class="card-note">${esc(c.note)}</p>` : ''}
    <div class="card-tracker-actions">
      <button class="btn-link btn-sm" data-edit="${esc(c.id)}" title="編輯" aria-label="編輯 ${esc(c.name)}">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${esc(c.id)}" title="刪除" aria-label="刪除 ${esc(c.name)}">${icon('trash', 15)}</button>
    </div>
  </article>`;
}

function openCardForm(c, { defaultType = 'credit' } = {}) {
  const seq = currentRouteSeq();
  openForm({
    title: c ? '編輯卡片' : '新增卡片',
    fields: [
      { key: 'type', label: '卡片類型', type: 'select', options: [{ value: 'credit', label: '信用卡' }, { value: 'debit', label: '簽帳金融卡' }, { value: 'membership', label: '會員卡' }], default: 'credit' },
      { key: 'name', label: '卡片名稱', type: 'text', required: true, placeholder: '例：台新 GOGO 卡' },
      // 發卡行＝**清單＋其他（自行輸入）**（2026-08-28）：自由文字本身無法消歧——香港富邦與台北富邦
      // 官方都自稱「富邦銀行」，填得再精確也分不出是哪一家，而分錯的代價是帳單自動歸到錯的卡。
      // 清單以外的機構（會員卡的發卡商店、清單漏掉的銀行）走「其他」，行為與清單化之前的自由文字相同。
      // ⚠️ **欄位鍵是 `issuerPick`、不是 `issuer`**（2026-09-02）：這個下拉送回來的值是**機構代號**
      // （`issuerOptions()` 的 `value`），不是要存進 `card.issuer` 的名字。刻意分兩個名字，
      // 免得有人看到 `data.issuer` 就以為那是顯示字串、直接存進去（那會把代號當名字存）。
      // 送出時由 `resolveIssuerFields` 一次算出 `issuer`（顯示名）與 `issuerId`（代號）兩欄。
      { key: 'issuerPick', label: '發卡銀行 / 機構', type: 'select', options: issuerOptions() },
      // 只在選了「其他」時顯示（onMount 切換）。⚠️ 隱藏時它仍然會被送出，所以合併規則一律走
      // `resolveIssuerFields`：沒選「其他」就無視這一欄，不會把舊的自訂字偷偷寫回去。
      { key: 'issuerOther', label: '其他發卡銀行 / 機構名稱', type: 'text', placeholder: '例：某某銀行、某某會員俱樂部' },
      { key: 'network', label: '卡片類別（信用卡）', type: 'select', options: NETWORKS, default: 'Mastercard' },
      { key: 'lastFour', label: '末四碼', type: 'text', placeholder: '1234' },
      { key: 'statementDay', label: '結帳日（信用卡，幾號）', type: 'number', placeholder: '5' },
      { key: 'dueDay', label: '繳款日（信用卡，幾號）', type: 'number', placeholder: '20' },
      { key: 'annualFee', label: '年費（信用卡）', type: 'number' },
      { key: 'pdfPassword', label: '帳單 PDF 密碼（只存這台電腦、永不上傳）', type: 'password', placeholder: c?.pdfPasswordSet ? '已設定，留空＝不變更' : '通常是身分證字號' },
      // 明確清除入口（Codex r10#10）：只在已設定時出現；勾了才真的清空（留空仍是「不變更」，避免誤刪）
      ...(c?.pdfPasswordSet ? [{ key: 'clearPdfPassword', label: '清除已存的帳單密碼（改回未設定）', type: 'checkbox', full: true }] : []),
      { key: 'memberId', label: '會員編號（會員卡）', type: 'text' },
      { key: 'level', label: '等級（會員卡）', type: 'text', placeholder: '例：金卡 / 鑽石' },
      { key: 'expiry', label: '有效期限（年/月，卡面 MM/YY）', type: 'month' },
      { key: 'benefits', label: '權益 / 回饋', type: 'textarea', full: true, placeholder: '例：國內 3% 回饋、機場接送 2 次' },
      { key: 'note', label: '備註', type: 'text', full: true }
    ],
    // 機密不預填（自主體檢）：GET /api/cards 已剝掉 pdfPassword，編輯時本來就沒有值可填
    // 發卡行拆成兩欄餵進表單：清單上有這個正式寫法就預選它，其餘（既有自由文字、自訂機構）
    // 一律落到「其他」並**原字**填進文字框——不可趁使用者打開表單就把 issuer 靜靜改寫（見 card-issuers.js）。
    values: c ? { ...c, ...issuerFormFields(c), expiry: (c.expiry || '').slice(0, 7) } : { type: defaultType, ...issuerFormFields(null) },
    onMount: (root) => {
      // 「其他（自行輸入）」的文字框只在選了「其他」時出現。⚠️ 用 hidden 屬性（`.form-grid` 沒有
      // 覆寫 display 的規則，UA 預設的 `[hidden]{display:none}` 就把這一格從格線裡拿掉）。
      const sel = /** @type {HTMLSelectElement|null} */ (root.querySelector('#f_issuerPick'));
      const other = /** @type {HTMLInputElement|null} */ (root.querySelector('#f_issuerOther'));
      const cell = /** @type {HTMLElement|null} */ (other?.closest('div') || null);
      if (!sel || !other || !cell) return;
      const sync = () => { cell.hidden = sel.value !== ISSUER_OTHER; };
      sel.onchange = () => { sync(); if (sel.value === ISSUER_OTHER) other.focus(); };
      sync();
    },
    onSubmit: async (data) => {
      // 下拉送回來的是代號 ⇒ 一次算出要存的兩欄。⚠️ `issuerPick`／`issuerOther` 都是表單自用、
      // 不是 schema 欄位，送出前一定要刪掉（留著會被櫃檯的白名單濾掉，但那是靠別人幫我們收尾）。
      const picked = resolveIssuerFields(data.issuerPick, data.issuerOther);
      data.issuer = picked.issuer; data.issuerId = picked.issuerId;
      delete data.issuerPick; delete data.issuerOther;
      const clearPw = data.clearPdfPassword; delete data.clearPdfPassword;   // 非 schema 欄位，送出前移除
      // 勾「清除」→ 明確送空字串清空（後端接受 '' ＝清除）；否則留空＝不變更（PUT 部分合併保留舊密碼）
      if (c && clearPw) data.pdfPassword = '';
      else if (c && (data.pdfPassword == null || data.pdfPassword === '')) delete data.pdfPassword;
      if (c) await api('/cards/' + c.id, { method: 'PUT', body: data });
      else await api('/cards', { method: 'POST', body: data });
      toast('已儲存');
      if (seq === currentRouteSeq()) {
        const message = c ? '卡片資料已更新' : `${TYPE_LABEL[data.type] || '卡片'}已新增`;
        rerenderCardsAfterSave(seq, message);
      }
    }
  });
}
