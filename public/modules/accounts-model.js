// @ts-check
// 帳戶型別與負債判準：**前端的單一真相**（純資料＋純函式，不碰 DOM／API，所以考題可以直接 import 跑行為級斷言）。
//
// 為什麼要有這一檔（#409 r8，Codex 用兩條實測繞法逼出來的）：
// ① `public/modules/assets.js` 原本自己寫死一份負債判準
//    `['mortgage','loan','liability'].includes(x.type) || Number(x.balance) < 0`——
//    **它現在就已經少了 `creditcard`**：同一筆信用卡帳戶在 `lib/derive.js`（淨資產）與
//    `fxExposure`（幣別曝險）都算負債，資產頁卻畫成藍標籤、餘額不標紅。
//    把它再改成 `['loan']`（連房貸都不算負債）全套 1501 題照樣全綠＝**零考題**看著這份判準。
// ② 帳戶表單的型別選項原本手抄七個，而 `lib/schema.js` 的 `FIELD_SCHEMA.accounts.type` 枚舉有
//    九個合法值——`liability` 與 `creditcard` 存得進去卻**選不到**。當時 `public/app.js` 的下拉
//    只在值完全相同時才加 `selected`、送出時讀 `select.value`，沒有 option 命中時瀏覽器選第一個
//    （`cash`）⇒ 在資產頁打開這種帳戶、只改個名字按儲存，就靜靜 PUT `type:'cash'`：
//    50 萬負債變成 50 萬資產、淨資產一次跳 100 萬。這是活著的病，不是假設。
//    ⚠️ **「靜靜換成第一項」那個機制已於 #409 修掉**（`public/modules/form-options.js`：現值不在選項裡
//    就保留它並標 selected）。本檔仍必須涵蓋每一個合法型別——保留只擋住「值被改掉」，
//    使用者仍然選不到、而且下拉裡看到的是原始代碼而不是中文標籤。
//
// ⇒ 兩者都改成從**同一份 `LIABILITY_TYPES`** 長出來：表單選項與資產頁的紅字判準不再是複本。
//    新增一個負債型別**還要改的地方**（刻意逐一列名、不寫「共幾處」——這一族的數字已經漂過兩次：
//    「兩處」→ r5 改成「三處」→ r8 實測發現還有第四第五份）：
//      ・本檔的 `LIABILITY_TYPES`
//      ・`lib/derive.js` 的同名複本（前端不能 import `lib/`，所以後端那份仍是刻意的複本）
//      ・`lib/schema.js` 的 `FIELD_SCHEMA.accounts.type` 枚舉（寫入牆；漏改＝算得出負債卻存不進去）
//    「是不是還有第六份藏在別的檔案」不靠人記：`test/exposure-sync-integrity.test.js` 有一題
//    全站掃描，只准上面三個檔案出現這些型別字串（該題自己寫了擋不住什麼）。

/**
 * 負債型帳戶白名單（前端）。與 `lib/derive.js` 的同名複本是刻意同步點——
 * 兩份走散＝淨資產與幣別曝險方向相反而沒有紅燈（考題：`test/exposure-sync-integrity.test.js`）。
 */
export const LIABILITY_TYPES = new Set(['loan', 'liability', 'mortgage', 'creditcard']);

/**
 * 負債型別的中文標籤；**鍵集合必須與 `LIABILITY_TYPES` 精確相等**（考題釘住），
 * 而且這個物件的**鍵順序＝下拉裡負債選項的顯示順序**。
 * 漏寫標籤不會讓使用者選不到（`accountTypeOptions()` 會退回 `型別（負債）` 的通用標籤），
 * 所以那是體感問題、不是資料問題——考題釘的是「有沒有人幫新型別寫中文」。
 * @type {Record<string, string>}
 */
export const LIABILITY_TYPE_LABELS = {
  mortgage: '房貸（負債）',
  loan: '其他貸款（負債）',
  creditcard: '信用卡未繳餘額（負債）',
  liability: '其他負債',
};

/** 非負債的帳戶型別選項（順序＝下拉顯示順序）。 */
export const ASSET_TYPES = [
  { value: 'cash', label: '現金 / 存款' },
  { value: 'investment', label: '投資（股票/ETF/IB）' },
  { value: 'property', label: '房地產' },
  { value: 'insurance-cv', label: '保單現金價值' },
  { value: 'other', label: '其他資產' },
];

/** 負債選項的顯示順序：標籤表列到的照它的順序，沒列到的排在最後。 @param {string} t */
const liabilityOrder = (t) => {
  const i = Object.keys(LIABILITY_TYPE_LABELS).indexOf(t);
  return i < 0 ? Object.keys(LIABILITY_TYPE_LABELS).length : i;
};

/**
 * 帳戶表單的型別下拉選項＝資產型別 ＋ **每一個** `LIABILITY_TYPES` 成員。
 * ⚠️ 刻意做成**函式**而不是模組層常數：這樣它讀的一定是「當下那個 Set」，
 *    考題的動態探針（往 Set 塞一個型別、要求選項立刻長出來）才證明得了
 *    「選項是從那份白名單長出來的，不是另一份手抄複本」。
 * @returns {{value: string, label: string}[]}
 */
export function accountTypeOptions() {
  const liabilities = [...LIABILITY_TYPES]
    .sort((a, b) => liabilityOrder(a) - liabilityOrder(b))
    .map(value => ({ value, label: LIABILITY_TYPE_LABELS[value] || `${value}（負債）` }));
  return [...ASSET_TYPES, ...liabilities];
}

/**
 * 這個帳戶算不算負債（資產頁的橘標籤與紅字判準）。
 * 口徑與 `lib/derive.js` 的 `computeAssets` 一致：**型別在白名單，或餘額是負的**
 *（負債型帳戶填正數是允許的資料形狀，兩邊都兜住）。
 * @param {{type?: string, balance?: any}} x
 */
export const isLiabilityAccount = (x) => LIABILITY_TYPES.has(x?.type || '') || Number(x?.balance) < 0;

/**
 * 帳戶表單的幣別下拉選項。**必須與 `lib/schema.js` 的 `CURRENCIES` 精確相等**（考題釘住）：
 * 枚舉有、這裡沒有的幣別根本選不到（只能靠改資料庫設上去）。
 *（#409 之前更糟：那種帳戶一被打開儲存就靜靜變成第一個選項 `TWD`、之後每次換算都用錯匯率
 *  ——機制同檔頭②，那一半現在由 `form-options.js` 擋住了。⚠️ 幣別清單是**純字串陣列**，
 *  撐住這句話的是 `test/form-options.test.js` 的「純字串選項也要保留現值」那題：#409 自審實測過，
 *  只讓字串選項那一型退回舊行為，其餘考題照樣全綠——所以那一題不是裝飾，是這句話的唯一保證。）
 */
export const ACCOUNT_CURRENCIES = ['TWD', 'USD', 'GBP', 'JPY'];

/**
 * ISO 瞬間 → **當地**日曆日 `YYYY-MM-DD`；不是真瞬間就回空字串。
 * 刻意不用 `slice(0, 10)`（那取的是 UTC 日，台北凌晨的同步會少一天），
 * 也刻意不靠 locale 字串（不同環境的 ICU 給的格式不保證一樣）——直接讀本地時間的年月日。
 * @param {any} iso
 */
function localDay(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  // ⚠️ `new Date()` **不會**擋掉不存在的日子：`2026-02-30T…` 會被悄悄滾成 3/2 而不是 NaN
  //（實測過才發現——同一種「格式對、日子不存在」的病，`balanceAsOf` 那邊也擋著同一件事）。
  //    所以先驗字串自己的日期部分過不過真實日曆，滾過的一律當成沒有時間戳。
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!m) return '';
  const utcDay = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(utcDay.getTime()) || utcDay.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/**
 * 餘額旁邊那一行小字：**這個餘額是被哪一天的對帳單更新的**。
 *
 * ⚠️ 文案為什麼不是「餘額截至 X 日」——那會說謊。`balanceAsOf` **只有銀行對帳單匯入會寫**
 *（服務層寫、非 CRUD 白名單，見 `lib/schema.js` 該欄註解）：使用者事後在帳戶表單手動改餘額，
 * 這個日期**不會跟著動**。所以它能誠實宣稱的只有「最後一次用對帳單更新到哪天」，
 * 不是「餘額現在正確到哪天」。兩者的差別由頁面上的說明窗補完（assets.js 的 `openBalanceAsOfInfo`）。
 *
 * 日期先驗過再顯示。⚠️ **這不是在補一個活著的洞**：寫入端 `lib/schema.js` 的 `'date'` 已經用
 * `isRealDate` 擋掉假日曆（實測 `save()` 對 `2026-02-30` 直接丟例外），`null`／`''` 也會被矯正成 `''`。
 * 這裡再驗一次的理由只有一個——**顯示層不該相信自己的輸入**：資料庫檔被手動改過、
 * 或日後有人寫出繞過 `save()` 的路徑時，壞掉的方式應該是「這格看起來沒日期」，
 * 而不是把 `2026-13-45` 原樣印在使用者的餘額旁邊、讓他當成真的。
 *
 * ⚠️ **IB 同步的現金帳戶要分開講**（2026-08-14 預審抓到）：`lib/services/ib-sync.js` 只寫
 * `balance`、**不寫 `balanceAsOf`**——**沒有下面這個分支的話**，那幾列會被打成
 * 「未由對帳單更新過」，而「去匯一份對帳單」這條路對它們**永遠走不通**（IBKR 不出這種帳單）。
 * 判準用 `ibCashCur`（IB 同步擁有的欄位，非 CRUD 白名單）。
 *
 * ⚠️⚠️ **文案只能講「上次同步」，不可以講「這筆餘額更新到那天」**（#454 r1 阻擋①）：
 * `ib.lastSync` 是**每次同步結束無條件寫上去的**，而現金餘額在 Cash Report 缺失／不完整／
 * 幣別不支援時是**刻意沿用舊值**（`lib/services/ib-sync.js` 的保守路線）。
 * 兩者合起來＝「同步時間前進、餘額其實沒動」是**正常會發生的狀態**；
 * 寫成「IB 同步更新至 X」就是拿一個沒更新的舊餘額冒充當天的數字——
 * 那正是這支 PR 要消滅的那種謊話，只是換了個殼。
 * 所以文案只講「上次 IB 同步 X」——**單純陳述同步這件事**，不對這個數字的新舊做任何保證。
 * ⚠️ 它也**不是上界**（#454 r2 阻擋①）：帳戶表單可以手動改餘額（銀行帳戶頁的編輯鈕就能到），
 * 改完 `lastSync` 不會動 ⇒ 畫面上的數字反而**比那個日期新**。兩個方向都會對不上，
 * 所以文案只講「上次連線是什麼時候」，差別由說明窗補完。
 *
 * ⚠️ 日期要換成**當地日曆日**（r1 阻擋②）：`lastSync` 是 ISO 瞬間，直接 `slice(0,10)` 取的是 UTC 日，
 * 台北時間 08-14 凌晨 01:30 的同步會顯示成 08-13。而且備份還原進得來的字串不保證是真瞬間
 * （`2026-02-30T…`），驗不過就只講來源、不編一個不存在的日期出來。
 *
 * @param {{balanceAsOf?: any, ibCashCur?: any}} [acc]
 * @param {string} [ibLastSync] `settings.ib.lastSync`（ISO 字串）；沒有／驗不過就只講身分、不講時間
 * @returns {{has: boolean, date: string, text: string, source: 'statement'|'ib'|'none'}}
 */
export function balanceAsOfNote(acc, ibLastSync) {
  if (acc && acc.ibCashCur) {
    const day = localDay(ibLastSync);
    // ⚠️ 沒有合法同步時間時**只能講身分**（#454 r3 阻擋）：`data/seed.json` 的預設就是
    //    `ib.lastSync: null` 配兩個 IB 現金帳戶——那時「由 IB 同步更新」是**假的**
    //    （根本還沒同步過），而餘額也可能是使用者自己填的。時間不知道就說不知道。
    return { has: !!day, date: day, source: 'ib',
      text: day ? `上次 IB 同步 ${day}` : 'IB 現金帳戶（尚無同步時間）' };
  }
  const raw = acc && typeof acc.balanceAsOf === 'string' ? acc.balanceAsOf : '';
  // 過真實日曆：`2026-02-30` 格式對、日子不存在——回填後再讀出來對得上才算數。
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
    && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  return ok
    ? { has: true, date: raw, source: 'statement', text: `對帳單更新至 ${raw}` }
    : { has: false, date: '', source: 'none', text: '未由對帳單更新過' };
}
