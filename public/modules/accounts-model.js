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
//    ⚠️ **「靜靜換成第一項」那個機制已於 #415 修掉**（`public/modules/form-options.js`：現值不在選項裡
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
 *（#415 之前更糟：那種帳戶一被打開儲存就靜靜變成第一個選項 `TWD`、之後每次換算都用錯匯率
 *  ——機制同檔頭②，那一半現在由 `form-options.js` 擋住了。⚠️ 幣別清單是**純字串陣列**，
 *  撐住這句話的是 `test/form-options.test.js` 的「純字串選項也要保留現值」那題：#415 自審實測過，
 *  只讓字串選項那一型退回舊行為，其餘考題照樣全綠——所以那一題不是裝飾，是這句話的唯一保證。）
 */
export const ACCOUNT_CURRENCIES = ['TWD', 'USD', 'GBP', 'JPY'];
