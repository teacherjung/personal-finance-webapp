// 「資料不會靜靜消失」考題（夜班稽核第三批A，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢在寫入櫃檯與備份這一片找到一整族「註解寫明理由、
// 弄壞卻全綠」的規則。這一片的共同特徵最危險：**壞掉的時候畫面會說成功**。
//   - 唯一寫入口的「集合必須是陣列」煞車：改成默默清空 ⇒ 整個集合被抹掉並回 200。
//   - 承諾「儲存前會自動備份」的文案：畫面一旦這樣寫，而那個備份不存在或存不成，那句話就是謊話——
//     而使用者正是讀了它才敢按下不可逆的操作。
//   - 備份的原子替換與 .tmp 清理：硬碟滿的那一次會兩頭空。⚠️ 損毀時的還原指引（lib/store.js:49）
//     叫使用者改名回去的 `store.db.bak` 是**啟動備份 `backupOnce` 產的**，不是第三節主要受測的
//     `snapshotTo`——這兩支是各自獨立的 VACUUM→rename 實作，所以第三節兩邊各自立題（劃界見該節）。
//   - 資料庫損毀的 fail-closed：守衛拿掉之後損毀檔照常開起來讀寫，使用者只覺得「數字怪怪的」。
//
// ⚠️ **本檔的射程就劃在這裡**：第二節那幾題守的文案，把使用者的自保押在設定頁「資料與備份」的
//    〈匯出備份〉那顆鈕上。本檔只證明得出「那顆鈕在、名字對得上、按下去匯出的內容含分類樹」，
//    **不**證明「使用者真的拿到一份完整的檔案」——那一塊由 `test/backup-export.test.js` 的行為題守著
//    （先驗再存的關卡／落檔／出聲／接線真的走 public/modules/backup-export.js），
//    本檔不重複、也不宣稱守到。
//
// 隔離：`STORE_FILE`（含各子行程自己的 env）一律指向 os 暫存檔，**不寫入**真實 `data/`。唯一碰到真實
//   `data/` 的是**唯讀**讀 `data/seed.json`：`SEED`（lib/store.js:19）不隨 `STORE_FILE` 走，任何「還沒有
//   settings 鍵的新庫」首開都會種子化——pre-ledger-migration 那一題的前置①正是靠這份種子的 11 筆
//   無 ledger 交易成立（見該處註解）。
// 有幾題另開子行程，兩種理由：①要讓 `open()` 真的失敗（`STORE_FILE` 在模組 import 時就定案、db 連線
//   又被模組快取，同一個行程裡改不動）；②`backupOnce`／`migrateLedgerIfNeeded` 未 export、
//   只在 `open()` 裡跑、每個行程只跑一次。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_STORE = join(tmpdir(), `finance-vault-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { sanitizeDbForWrite, ALL_COLLECTIONS } = await import('../lib/schema.js');
const { stripSecretsForBackup } = await import('../lib/secret-fields.js');

/** 本檔製造出來的暫存檔（含各種 .bak）收工一起刪。 */
const TRASH = [TEST_STORE];
after(() => {
  for (const f of TRASH) {
    for (const suf of ['', '.bak', '.tmp', '-wal', '-shm', '.json',
      '.pre-rules.bak', '.pre-normalize.bak', '.pre-ledger-migration.bak', '.pre-sec-contract.bak']) {
      try { rmSync(f + suf, { recursive: true }); } catch { /* 可能不存在 */ }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 一、唯一寫入口的 fail-loud（lib/schema.js 兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('寫入櫃檯｜**每一個**集合、**每一種**非陣列形狀都要 fail-loud（不是只有 transactions、也不是只有 {}）', () => {
  // ⚠️ 這是全批最嚴重的一條：改成 `out[col] = []` 之後，任何一條寫入路徑
  //    （例如任何直接呼叫 `store.save()`／`saveDb()` 而漏傳集合的服務層路徑）會把**整個集合的資料抹掉並回 200**——
  //    無聲毀資料＋畫面說成功，本專案自己列為最嚴重的一族。
  // ⚠️ 判準為什麼是**形狀 × 集合 × mode** 三重遍歷（少任何一維都被實測的繞法穿過去，各自都「弄壞卻全綠」）：
  //    ・只送 transactions ⇒ 保留 transactions 的 throw、其餘集合靜默清成 []，全批照樣全綠＝空包彈。
  //    ・遍歷集合但**只送一種形狀 `{}`** ⇒ 在守衛前插一行 `if (out[col] == null) out[col] = [];`
  //      （null/undefined 默默清空）就全綠。而 null/undefined 正是 JS 裡最可能誤傳的非陣列：
  //      服務層早退回傳 undefined、整包寫入自己拼物件。
  //    ・只跑一種 mode ⇒ 另一種 mode 下的放行不會被看見。
  //    ⇒ 三維全遍歷，任何一個組合被放行都會紅。
  // ⚠️ 攔截拓樸要講清楚（別把它講反）：`replaceCollection`（lib/repo.js:222）的契約把逐筆驗證的
  //    責任交給呼叫端；而它的呼叫端（lib/routes/crud.js:120 `if (!Array.isArray(list)) … 400`，再往下傳的是
  //    本地新建的陣列）自己就擋掉非陣列 body，`/api/import` 也有 lib/routes/core.js:193-194 的 400。
  //    所以本題守的**不是**那兩條路由，而是「繞過路由層直接寫入」那一類——在寫入管線裡
  //    （`mutate` 不檢查、`save()` 只過 sanitizeDbForWrite）這道 Array.isArray 是唯一的攔截點。
  const NON_ARRAYS = /** @type {[string, any][]} */ ([
    ['物件 {}', {}],
    ['null（JSON body 送 null／欄位被清掉）', null],
    ['undefined（服務層早退、忘了回傳）', undefined],
    ['字串', 'x'],
    ['數字', 42],
    ['布林', true],
  ]);
  assert.ok(ALL_COLLECTIONS.length >= 10, `集合清單至少該有 10 個（實際 ${ALL_COLLECTIONS.length}）——清單被縮小的話本題會變成空轉`);
  for (const col of ALL_COLLECTIONS) {
    for (const mode of ['throw', 'strip']) {
      for (const [label, shape] of NON_ARRAYS) {
        assert.throws(
          () => sanitizeDbForWrite({ settings: {}, [col]: shape }, { mode }),
          /陣列/,
          `集合「${col}」在 mode=${mode} 下收到「${label}」時必須丟錯（不論寬鬆或嚴格模式都不可默默清空）`,
        );
      }
    }
  }
  // 反面：合法的空集合要照常通過（避免整段守衛被改成「一律 throw」也綠）。
  for (const col of ALL_COLLECTIONS) {
    const ok = sanitizeDbForWrite({ settings: {}, [col]: [] }, { mode: 'throw' });
    assert.deepEqual(/** @type {any} */ (ok)[col], [], `合法的空陣列（${col}）要照常通過`);
  }
  // 行為面（不只函式面）：走真正的唯一寫入口 store.save()，確認被擋下的那一次**沒有動到已存的資料**。
  //  ——「默默清成 []」的災情不是「函式回錯值」，是**磁碟上那一集合真的沒了、而畫面回成功**。
  store.save({ ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] });
  assert.throws(() => store.save(/** @type {any} */ ({ ...store.load(), history: null })), /陣列/,
    '唯一寫入口收到 null 集合時必須當場炸開（回 200 等於騙使用者「存好了」）');
  assert.equal(/** @type {any} */ (store.load()).history.length, 1,
    '被擋下的那次寫入不可動到磁碟上既有的資料——默默清空＝整個集合無聲消失');
});

test('寫入櫃檯｜insightState 正規化真的接上：合法書籤要保留、壞欄位要剝掉', () => {
  // ⚠️ 又是「函式有考題、接線沒考題」那一族：sanitizeInsightState 自己逐項有考題
  //    （test/insights.test.js:205），但**除本題以外**沒有第二條驗它掛在唯一寫入口
  //    （lib/schema.js:869）。**本題就是那一條**——接線拆掉，「還原壞備份／手改 store 不會讓差異引擎崩」
  //    這個防護就不存在了，而那條單元考題照樣全綠、看起來守著。
  // ⚠️ 考題設計（第一版是空包彈，Codex #410 r1 H② 抓到）：第一版只送 'oops' 並檢查「結果是某個
  //    object」⇒ 把接線改成 `out.insightState = {}`（每次寫入都清空書籤）照樣綠。
  //    這一版**混入合法與非法欄位**，斷言合法值逐一保留、壞值剝除——清空型的突變會被抓到。
  const bad = sanitizeDbForWrite({
    settings: {},
    insightState: {
      lastSeenAt: '2026-08-05T00:00:00.000Z',      // 合法：字串
      netWorth: 1234567,                            // 合法：有限數字
      usdTwd: 'not-a-number',                       // 壞：該剝掉
      reminders: [
        { key: 'goal-reached', title: '達標', module: '總覽', level: 'info' },   // 合法
        { title: '沒有 key 的要被丟掉' },                                        // 壞：沒有 key
        'not-an-object',                                                        // 壞
      ],
      junkField: 'should be dropped',                // 壞：不在白名單
    },
  }, { mode: 'throw' });
  const st = /** @type {any} */ (bad.insightState);
  assert.equal(st.lastSeenAt, '2026-08-05T00:00:00.000Z', '合法的字串欄位必須保留（清空型突變會在這裡紅）');
  assert.equal(st.netWorth, 1234567, '合法的數字欄位必須保留');
  assert.equal(st.usdTwd, undefined, '型別不對的欄位要剝掉');
  assert.equal(st.junkField, undefined, '白名單外的欄位要剝掉');
  assert.equal(st.reminders?.length, 1, '沒有 key 的與非物件的提醒都要丟掉，只留合法那一筆');
  assert.equal(st.reminders?.[0]?.key, 'goal-reached');
  // 非物件整包 → 空物件（原本那一半的行為，保留）
  const notObj = sanitizeDbForWrite({ settings: {}, insightState: 'oops' }, { mode: 'throw' });
  assert.deepEqual(notObj.insightState, {}, '整包不是物件時正規化成空物件');
});

// ─── 畫面文案類考題的共用小工具（第二節那兩題文案考題共用） ─────────────────────────────
/**
 * 去掉 JS 註解——**畫面上看不到的字不算文案**。
 * ⚠️ 為什麼一定要這一步（#410 r6）：舊版的「指路」判準直接在原始碼裡搜尋，複驗者只要把
 *    `// 「資料與備份」「匯出備份」` 寫成一行註解，就湊出「有兩處在指路」的假綠。
 * ⚠️ 行註解只在 `//` 前面不是 `:`／引號／反斜線／文字時才剝：否則 `https://`、`split('//')`、
 *    正規表示式 `/\/\//` 會被誤剝掉半行（那會讓真文案憑空消失＝另一種假綠）。
 * @param {string} s @returns {string}
 */
const stripJsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`\w\\])\/\/[^\n]*/g, '$1');

/** 剝掉 HTML 標籤，留下畫面上看得見的字。 @param {string} s @returns {string} */
const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/** 抓元件上**看得見的那幾個字**：剝掉標籤，再丟掉 `${icon(...)}` 那截樣板插值。 @param {string} html */
const label = (html) => (stripTags(html).split('}').pop() || '').trim();

/**
 * 「真正的文案段落」＝模板字串裡的每一個 `<p>…</p>`（畫面上的一段字）。先去註解。
 * @param {string} src @returns {string[]}
 */
const copyParagraphs = (src) => [...stripJsComments(src).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);

/**
 * 畫面上按得到／看得到的元件字面（按鈕、連結、區塊標題）。
 * @param {string} src @returns {string[]}
 */
const uiLabels = (src) => [...stripJsComments(src).matchAll(/<(a|button|h2|h3|h4|label)\b[^>]*>([\s\S]*?)<\/\1>/g)]
  .map((m) => label(m[2])).filter(Boolean);

/**
 * 「這個說法**被否定了**嗎」——結構判準，不是否定詞列舉（#410 r6 複驗洞②）。
 * ⚠️ 為什麼不能只問「前 8 字裡有沒有否定詞」（舊判準，③-a 與掃描題共用同一個病）：
 *    複驗者把假承諾寫成「沒有問題，會自動備份。」⇒ 前 8 字＝「沒有問題，會」命中「沒有」，
 *    一句明確的假話同時通過兩題（實測 13/13 全綠）。r6 從清單裡拿掉裸字「沒」只擋到「沒問題」，
 *    多寫一個「有」就繞回來——**列舉繞法補不完就要關門**（專案模式）。
 * 現在問的是三件結構性的事，跟用哪一個否定詞無關：
 *   ① 否定詞要在**同一個小句**裡——中間夾標點就是換句話了，隔壁半句不可以替這一句作保；
 *   ② 否定詞到那個說法之間只准夾**修飾語**（「沒有 新的每日 備份」的「新的每日」＝真話，要放行），
 *      一旦夾進另一個正面謂語（會／要／一定／都／替你／幫你／自動／可以）就不算它在否定這個說法；
 *   ③ 夾的字數有上限（6 字）——離太遠就不是在講同一件事。
 *   （「不會」「沒有」「沒在做」裡那一兩個助動詞算否定詞自己的一部分，不算「夾」。）
 * ⚠️ 已知仍擋不住（收手判準，掃描題那邊列的三個之外再補這一個）：把否定詞黏在**別的東西**上、
 *    又剛好不加標點，例如「不用擔心的自動備份」——那要真的讀懂句子才擋得住，文字掃描到此為止。
 * @param {string} beforeClaim 那個說法**之前**的文字（整句或整段都可以傳，本函式自己收斂到同一小句）
 * @returns {boolean} true＝這個說法是被否定的（沒有承諾）；false＝畫面上讀起來是正面承諾
 */
const negatesClaim = (beforeClaim) => {
  const clause = beforeClaim.split(/[，,、。；;：:！!？?（）()「」『』…—–\n]/).pop() || '';
  const at = Math.max(...['不', '沒', '別', '勿', '無'].map((c) => clause.lastIndexOf(c)));
  if (at < 0) return false;                                   // 這個小句裡根本沒有否定詞
  const gap = clause.slice(at + 1).replace(/^[會有做在是能要用]{0,2}/, '');
  return gap.length <= 6 && !/會|要|一定|都|替你|幫你|自動|可以/.test(gap);
};

// ─────────────────────────────────────────────────────────────────────────────
// 二、**畫面文案不可以承諾不存在的備份**（設定頁分類管理／店名規則卡片／店名規則編輯窗）
//
// ⚠️ 本節守的是**文案面**：不可逆操作前的自動備份是本專案刻意不做的（設計註解在
//    lib/services/backup.js），所以畫面上任何「系統會替你留一份」的說法都是空頭支票。
//    節末那顆 ⭐ 裁決題守的是另一個方向：擋「好心把備份加回來」。
// ⚠️ 誠實劃界：本節全是**原始碼／文字掃描**，證明的是「畫面上寫了什麼」，
//    不是「按下去的行為正確」。行為面在 test/backup-export.test.js 與 test/server.test.js。
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ 題名要跟斷言對得上：題名誇大或過期在本專案算阻擋級，所以動到下面任何一項判準時，
//    一併把題名改對（曾經因為題名還引著舊文案的逐字，讀題的人被誤導去找一句畫面上沒有的話）。
test('畫面文案｜分類管理只留「沒有復原可以按」的警告、不承諾備份，而文案叫人按的名字都要有那顆鈕', () => {
  // ⚠️ 為什麼這一題存在：分類管理走的是「不補備份、只把話講清楚」這條路，而**承諾要有考題撐著**
  //    （專案鐵則）——改出來的文案自己又變成承諾的話，就白改了。這一題守的是三件事＋一道反面守衛：
  //      ①② 自救出口（匯出／匯入備份）真的在，而且在整頁最後一個區塊「資料與備份」底下；
  //      ③  分類管理兩段：那句不可逆警告不可被靜靜刪掉、不可再長出備份承諾、不可指向本機專屬的東西；
  //      ④  凡是文案叫使用者「按『某某』」，畫面上就要真的有那顆鈕（不寫死名單）。
  // ⚠️ 只釘「指標」不釘「文句」：本題斷言的是**名字與它們在檔案裡的實體**，不是整段句子——
  //    審改措辭的人不會被綁住。反過來，若有人把按鈕改名／搬走／刪掉，或把文案改回指向
  //    只有本機才有的檔案，本題轉紅、逼下一個人重新查證。
  // ⚠️ 誠實劃界：本題只證明「那兩顆按鈕存在、在同一頁、在整頁最後一個區塊底下，而且文案沒有
  //    重新長出假承諾」。「按下去匯得出完整資料」分別由本檔〈匯出備份｜雲端版匯出的檔案裡必須有
  //    分類樹〉那一題守分類樹（雲端版的投影）＋ test/server.test.js 的 export→import 來回（LOCAL）；
  //    機密／帳號那一半由 test/hosted-secrets.test.js 的來回題守著——本題不重複，也**不宣稱**守到那些。
  //    ⚠️ 更關鍵的一塊仍在**本題**射程外：本題不驗〈匯出備份〉按下去有沒有回饋，所以「照文案按下去
  //    就有一份備份」由 test/backup-export.test.js 的 runExport 行為族守（先驗再存的關卡／落檔／出聲，
  //    接線見 `public/modules/settings.js` 的 `exportBtn.onclick` 與 `public/modules/backup-export.js`
  //    的 `runExport`）——本題不重複、也不宣稱守到。
  //    ⚠️ ④ 末尾那道空轉門檻要求的是「至少還掃得到一段指路文案」，不是某個特定段數：
  //    指路句子本來就會隨文案增減，門檻只負責在「掃描器整個失效」時轉紅（判準寫在該處）。
  // ⚠️ 一律在**去掉註解**的原始碼上判斷（#410 r6 複驗洞①，兩面病都是同一個根因）：
  //    假綠面（複驗者實測 13/13 全綠）＝把 ③ 那句唯一承重的警告搬進 `${/* … */''}`，
  //      畫面上兩張分類管理卡片的警告**全部消失**，使用者在按下不可逆的改名／刪除前什麼提示都沒有。
  //      舊版 ③／③-a 直接在 raw src 上 grep（只經 stripTags），註解裡的字替畫面作了保。
  //      對照組證明它當時是孤立缺口：把匯出鈕整顆搬進同樣的註解會被 ④ 的 LABELS 抓到轉紅，唯獨這句沒有第二道網。
  //    假紅面（同一個根因）＝在文案旁邊留一句畫面看不見的開發者註解 `${/* 未來若要補自動備份再議 */''}`
  //      會讓 ③-a 誤紅。註解裡的字使用者看不到，兩個方向都不該算文案。
  const src = stripJsComments(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));

  // ① 自救出口與還原入口真的在檔案裡，而且字面就叫文案講的那個名字
  const exp = src.indexOf('href="/api/export"');
  assert.ok(exp > 0, '「匯出備份」那顆按鈕不見了——文案叫使用者動手前先按的東西必須真的存在');
  // ⚠️ 為什麼是「開頭」而不是「完全相等」（#410 r9 複驗 Low）：畫面上那顆的字面是「匯出備份 (JSON)」，
  //    文案只引前半段「匯出備份」。照著找得到＝可接受，但**前綴關係是刻意的**，所以釘住它：
  //    有人把按鈕改名成「下載備份」或「備份 (JSON)」時本題轉紅，逼他一起改文案。
  const expLabel = label(src.slice(exp, src.indexOf('</a>', exp)));
  assert.ok(expLabel.startsWith('匯出備份'),
    `那顆按鈕的字面必須以「匯出備份」開頭（文案引的就是這四個字），實際讀到「${expLabel}」`
    + '——名字對不上，使用者照文案在畫面上找不到它');
  const imp = src.indexOf('id="importBtn"');
  assert.ok(imp > 0, '「匯入備份」那顆按鈕不見了——文案說「真要救的時候用旁邊的匯入備份」，它必須在');
  const impLabel = label(src.slice(imp, src.indexOf('</button>', imp)));
  assert.ok(impLabel.startsWith('匯入備份'),
    `那顆按鈕的字面必須以「匯入備份」開頭，實際讀到「${impLabel}」`);

  // ② 兩顆都在「資料與備份」區塊底下，而那是整頁**最後**一個區塊（文案寫「本頁最下面」）
  const lastSection = src.lastIndexOf('class="section-title"');
  assert.match(src.slice(lastSection, lastSection + 120), /資料與備份/,
    '「資料與備份」必須是整頁最後一個區塊——文案寫「到本頁最下面」，'
    + '多排一個區塊在它後面，這句指路就不準了');
  assert.ok(exp > lastSection && imp > lastSection, '那兩顆按鈕要在「資料與備份」區塊底下');

  // ③ 兩段分類管理文案：那句「沒有『復原』可以按」的警告不可被靜靜刪掉，而且**不可以承諾任何備份、
  //    也不可以指向本機專屬的東西**（這兩段刻意不指路——指路面由 ④ 以「哪些文案真的在指路」為準
  //    守著，不寫死名單）
  //    ⚠️ 判準為什麼是「關門」而不是黑名單（兩種繞法都實測過，在只黑名單一個字串的版本下全綠）：
  //      繞法A＝把「儲存前自動備份。」這種句子加回去 ⇒ 只要不踩到那個字串就全綠，
  //             而畫面上又出現一句本機／雲端都不成立的假承諾。
  //      繞法B＝把指路改成「先重啟一次後端拿一份還原檔 data/store.db.pre-rules.bak，再按匯出備份」
  //             ⇒ 黑名單只認字面 `store.db.bak`，換一個檔名照樣全綠，而雲端版根本沒有那顆檔。
  //    ⇒ 所以禁的是**整類**：這兩段文案的射程只准是「使用者在畫面上按得到的東西」。
  for (const btnId of ['manageCatsBtn', 'manageIncomeCatsBtn']) {
    const i = src.indexOf(`id="${btnId}"`);
    assert.ok(i > 0, `前置：找不到 ${btnId}——分類管理卡片被改掉了，本題的前提要重新確認`);
    const head = src.slice(0, i);
    const p = head.lastIndexOf('<p class="muted"');
    assert.ok(p > 0, `前置：${btnId} 前面找不到說明文案`);
    const copy = head.slice(p);
    // ⚠️ r11（William 2026-08-05 第二次裁決）：分類管理這兩段**不再指路**，只留一句警告
    //    ——他的判斷是那一長串太囉嗦。所以這裡從「必須指到那三個名字」改成**必須留著那句警告**：
    //    警告是這兩段文案唯一的承重內容，被靜靜刪掉的話使用者就在毫無提示下按下不可逆的改名／刪除。
    //    （指路那一半由下面的 ④ 守——它以「哪些文案真的指路」為準，不寫死名單。）
    // ⚠️ r6 收窄（#410 r6：「無法復原」是無限定的世界斷言）：r11 那句寫「⚠️ 儲存後無法復原。」，
    //    但**既有的匯出檔可以整包匯回去**（`/api/import` 走 overwrite），所以「無法復原」講太滿；
    //    真正成立的只有「**這個編輯器沒有『復原』可以按**」這個 UI 事實（分類編輯器只有「取消」
    //    與「儲存分類」）。文案已改成「⚠️ 儲存後沒有「復原」可以按。」（William 要的是短、不是不精確），
    //    判準也跟著只守那個 UI 事實——寫回「無法復原」會紅，因為畫面撐不住那句話。
    // ⚠️ r6 複驗（假紅 FR1，**這一項最要緊：William 早上要審的就是這句**）：舊判準寫成
    //    `/沒有復原(可以按|按鈕|鈕)/`＝要求「沒有復原」後面**緊接**那三種尾巴，於是同義、甚至更明白的
    //    「沒有「復原」這個按鈕」被判紅——而 assert 訊息自己寫著「可以換措辭」，這句話當時撐不住。
    //    現在改成守那個 UI 事實的**三個零件**（否定 → 復原 → 按／鈕），中間各准夾 6 字修飾語、
    //    但**不准跨小句標點**（跨句就變成拼湊兩個不相干的半句）。
    //    仍然會紅的（刻意）：整句被刪掉、藏進註解、或寫回「無法復原／不能復原／沒辦法復原」——
    //    那三種後面接不到「按／鈕」，因為它們講的不是 UI 事實而是「救不回來」，而匯出檔整包匯回去救得回來。
    const noQuote = stripTags(copy).replace(/[「」『』"']/g, '');
    assert.match(noQuote, /(?:沒有|沒|無|不會有)[^。，；！？]{0,6}復原[^。，；！？]{0,6}(?:按|鈕)/,
      `${btnId} 的說明文案必須留著「沒有『復原』可以按」這句警告（可以換措辭，但要守住這個 UI 事實）——`
      + '分類改名會改寫全庫交易的分類、刪除會把交易改歸「其他／未分類」，而編輯器沒有復原鈕，'
      + '使用者是在按下去之前讀到這句話的；'
      + '⚠️ 也不要寫成「無法復原」——匯出檔整包匯回去救得回來，那句話比事實講得滿');
    // ③-a 承諾面：分類管理兩種模式都沒有**「儲存前的那一份」備份**（`lib/services/categories.js` 零個
    //     backupNow），所以這裡出現的每一個「自動備份」都必須是被否定的。
    //     ⚠️ 別把這句讀成「什麼備份都沒有」：本機版另有每日滾動備份與啟動 .bak（全庫、開 app 時就備，
    //       見 lib/services/backup.js:11 與 public/app.js:359），雲端版連那些都沒有（每日備份走
    //       lib/repo.js 的 `snapshotTo` 在 HOSTED 直接丟錯；雲端的寫入走 store-pg，lib/store.js 的
    //       啟動備份壓根不跑，見 lib/repo.js:129）——但那兩種都不是**這個操作**觸發的，也擋不住「一天內改好幾次分類」，
    //       所以文案不可以拿它們當儲存前的安全帶。
    //     （這一段也刻意**不接受**分模式寫法，理由見下面 ③-b 的 `本機版|雲端版` 那一條。）
    const plain = stripTags(copy);
    for (const m of plain.matchAll(/自動備份/g)) {
      // ⚠️ 「被否定了嗎」交給 negatesClaim 這**唯一一份實作**判（本節那顆「掃遍 public/」的掃描題共用同一顆，
      //    理由與判準寫在那個函式上）：#410 r6 複驗實測，只問「前 8 字裡有沒有否定詞」的舊判準
      //    會讓「沒有問題，會自動備份。」整句放行——否定詞落在窗口裡，但它否定的是「問題」不是這個說法。
      const before = plain.slice(0, m.index);
      assert.ok(negatesClaim(before),
        `${btnId} 的文案裡「自動備份」四個字必須是被否定的，而且否定詞要真的**貼著它**`
        + '（「不會自動備份」「沒在做自動備份」都算；「沒有問題，會自動備份」不算——那是在否定別的東西），'
        + '現在讀到的是：…' + before.slice(-16) + '自動備份…'
        + '——分類管理在本機版與雲端版都沒有這個備份（categories.js 零個 backupNow；'
        + '本機版的每日滾動備份與啟動 .bak 不是這個，它們不是儲存分類觸發的），'
        + '任何正面承諾都是假話，而使用者是在按下不可逆的改名／刪除之前讀到它的');
    }
    // ③-b 指路面：不可以指向「只有一種模式才有」的東西——檔名、路徑、要人去操作後端，全部關門。
    //     只列黑名單補不完（繞法B 就是換一個檔名），所以這裡禁的是**整類**：畫面按不到的東西。
    for (const [re, why] of /** @type {[RegExp, string][]} */ ([
      [/\.(bak|db|json|sqlite)\b/, '檔名／副檔名（那是本機檔案系統才有的東西）'],
      [/data\//, '本機路徑'],
      [/<code>/, '<code> 標記（等於在指一個檔案或指令）'],
      [/重啟|重新啟動|終端機|指令/, '要使用者去操作後端（雲端版的使用者沒有後端可以操作）'],
      [/本機版|雲端版|跑在自己電腦|跑在雲端/, '分模式的說法（這份 HTML 兩種模式共用、這些句子拿不到模式資訊，分模式只會生出第二句假話）'],
    ])) {
      assert.doesNotMatch(copy, re,
        `${btnId} 的文案不可以出現${why}——這份 HTML 兩種模式共用（模式資訊只有匯出告知那一個布林可用、其餘句子拿不到，見 #417 的最小分流；本檔守的正是「拿不到的那些句子要自我限定」）（原述：grep hosted public/ 零命中），`
        + '指到只有一邊才有的東西，就是在另一邊說謊（r8 那版被退回的正是這個病）');
    }
  }

  // ④ 指路面（#410 r6 重寫；r10／r11 兩版都有**實測過的假綠**）
  //    舊判準＝「三個寫死的名字（資料與備份／匯出備份／匯入備份）＋在**沒去註解**的原始碼裡搜尋
  //    ＋`pointed >= 2` 算的是兩個**不同名字**」。三宗罪：
  //      假綠A（**複驗者實測**）：把 `// 「資料與備份」「匯出備份」` 寫成**一行註解** ⇒ 湊出 pointed===2，
  //             畫面上的指路整批刪掉照樣綠（反面守衛完全失效）。
  //      假綠B（**複驗者實測**）：畫面上改成「請按『一鍵救援』」（**不存在的按鈕**）⇒ 名字不在那三個
  //             寫死的裡面，整段指路變成謊話卻照樣綠。
  //      算法C（同一顆計數器的毛病，本輪未單獨在舊版上重放）：一段文案裡引到兩個名字就滿足 `>= 2`
  //             ⇒ 另一段的指路整段刪掉也不會被發現（算的是名字數不是段數）。
  //    ⇒ 新判準三步：**先去註解** → 以畫面上的「一段文案」（`<p>…</p>`）為單位 →
  //      這一段裡凡是叫使用者「按『某某』」的名字，都必須真的有一顆**字面以它開頭**的按鈕／區塊標題；
  //      反面守衛改成算**指路的段數**（不是名字數）。
  //    ⚠️ 射程只到**自保這一族的文案段**（同一段裡出現備份／復原／還原／救的那些）：同一頁的 IBKR 設定
  //      說明也叫使用者「按『＋』」，但那是 **IBKR 網站上的**按鈕，本檔驗不到也不該驗——判準不分家的話
  //      只會逼下一個人把真話刪掉。
  //    ⚠️ 也只掃 `<p>…</p>`：店名規則面板裡五種規則的說明（`${sec.hint}` 插值進 `<p>`）不在射程內，
  //      那幾段目前沒有指路句子；有人在那裡寫假指路，本題抓不到（文字掃描擋不完，見「掃遍 public/」
  //      那一題的收手判準）。
  const panelSrc = readFileSync(join(ROOT, 'public/modules/settings-store-rules.js'), 'utf8');
  const LABELS = [...uiLabels(src), ...uiLabels(panelSrc)];
  // ⚠️ 前綴比對、不是完全相等（#410 r6 複驗假紅 FR3）：舊版寫 `LABELS.includes('資料與備份')`，
  //    於是純 UI 等價改動——區塊標題加一個計數 `資料與備份 <span class="muted">(2)</span>`——
  //    就讓本題以「uiLabels 壞了」誤紅，跟文案誠實毫無關係。判準跟下面的指路比對一致（startsWith）。
  assert.ok(LABELS.some((l) => l.startsWith('資料與備份')),
    '前置：抓不到區塊標題的字面（uiLabels 壞了）——④ 會整段變空轉');
  const PRESS = /(?:按下|點選|按|點)\s*[「『]([^」』]{1,12})[」』]/g;
  const RESCUE = /備份|復原|還原|救/;                       // 這一段是不是在講「怎麼自保」
  let pointingParas = 0;
  for (const para of [...copyParagraphs(src), ...copyParagraphs(panelSrc)]) {
    const plain = stripTags(para);
    if (!RESCUE.test(plain)) continue;                       // 不是自保族的文案（例：IBKR 網站的操作步驟）
    const names = [...plain.matchAll(PRESS)].map((m) => m[1].trim());
    if (!names.length) continue;                             // 這一段沒有在指路
    pointingParas++;
    for (const name of names) {
      assert.ok(LABELS.some((l) => l.startsWith(name)),
        `有一段自保文案叫使用者按「${name}」，但整個設定頁與店名規則面板都找不到字面以它開頭的`
        + `按鈕／連結／區塊標題——那句指路是假的（使用者照著找不到）。這一段是：\n    ${plain.trim().slice(0, 160)}`);
    }
  }
  assert.ok(pointingParas >= 1,
    '整個設定頁與店名規則面板，竟然一段「叫使用者按某顆鈕」的自保文案都找不到'
    + `（實際找到 ${pointingParas} 段）——本題會變成空轉。`
    + '⚠️ 這個門檻只問「掃描器還看得見指路文案嗎」，刻意不釘段數：指路句子會隨文案增減，'
    + '釘死段數只會逼下一個人為了過關去湊句子。掃到零段代表指路文案整批消失，'
    + '或 `<p>` 段落的抓法失效（後者是假綠的來源，所以要當場紅）');
});

// ⚠️ 題名以**那顆按鈕**為主詞、不以某一段文案為主詞：指路文案會隨畫面增減，而本題守的東西
//    （改壞分類之後唯一的自救路徑＝匯出檔裡有沒有分類樹）不隨文案變動。題名綁文案就會過期。
test('匯出備份｜雲端版匯出的檔案裡必須有分類樹（改壞分類之後唯一的自救路徑）', () => {
  // ⚠️ 這一題補的是上一題**明白劃在射程外、卻沒有別人接手**的那一塊（#410 r9 複驗：「守它的考題留了一個縫」）。
  //    上一題只證明「那兩顆按鈕還在同一頁上」；而文案真正的承諾是**按下去救得回東西**。
  //    實測那個縫是真的（在 r9 那棵樹上）：把 `stripSecretsForBackup`（雲端 /api/export 的投影）
  //    加三行 `delete copy.settings.expenseTree/incomeTree/categoryAliases`
  //    ⇒ `npm test` **1498 pass / 0 fail**、退出碼 0，無一題轉紅。
  //    後果＝雲端使用者照文案按「匯出備份」存下來的檔案裡**沒有分類樹**，改壞分類之後
  //    「匯入備份」整包還原回去，分類樹靜靜退回系統預設——而畫面全程說成功（本專案最嚴重的一族）。
  // ⚠️ 為什麼守在這一層：LOCAL 的 export→import 來回已有 test/server.test.js
  //    「匯入保留自訂分類樹與別名（Codex#1）」守著（那一題走 /api/db + /api/import 真的來回一趟）；
  //    HOSTED 在**匯出這一半**的差別就是這支投影，所以這裡問「投影有沒有把分類樹一起剝掉」
  //    ＋「雲端的匯出真的走這支」。
  // ⚠️ 誠實劃界：HOSTED 另有兩處差別**不在本題射程內**——①匯入半邊 lib/routes/core.js:265 的
  //    `if (isHosted())` 區塊（只碰 mapSecrets／mapBackupOnlyPii 兩張清單，碰不到分類樹；機密／帳號
  //    那一半由 test/hosted-secrets.test.js 的來回題守）；②寫入走 `store-pg` 的逐鍵 CAS（分類樹搭在
  //    `settings` 這顆 KV，見 lib/store.js:28 的 KV_KEYS）。兩者目前都**沒有分類樹的來回考題**
  //    （NOTEASY_HOSTED 那些考題檔裡，分類樹只出現在 test/hosted-store-pg.test.js:79 的租戶隔離題）。
  //    本題只釘「匯出的檔案裡有分類樹」。
  //    ⚠️ 也**不**宣稱「使用者真的拿到那份檔案」：`<a>` 這條路收不到落地回音（劃界寫在
  //    public/modules/backup-export.js 的誠實劃界那一節）。「按下去會不會出聲」則由
  //    test/backup-export.test.js 的 runExport 行為族守，本題不重複。
  const trees = {
    expenseTree: { 飲食: ['早餐', '晚餐'], 其他: ['未分類'] },
    incomeTree: { 工作: ['薪水'], 其他: ['其他收入'] },
    categoryAliases: { 娛樂: '休閒' },
  };
  const db = {
    settings: { ...trees, taishinSecPdfPassword: 'A123456789', ib: { flexToken: 'TOKEN-要被剝掉', flexQueryId: '123456' } },
    accounts: [{ id: 'a1', name: '台新', accountNo: '900100112233' }],
    cards: [{ id: 'c1', name: '玫瑰卡', pdfPassword: 'PW-要被剝掉' }],
  };
  const out = stripSecretsForBackup(db);
  for (const k of /** @type {('expenseTree'|'incomeTree'|'categoryAliases')[]} */ (Object.keys(trees))) {
    assert.deepEqual(out.settings[k], trees[k],
      `雲端版匯出的備份檔必須含 settings.${k}——少了它，使用者照文案「匯出備份→匯入備份」`
      + '救回來的分類樹會靜靜退回系統預設，而畫面說還原成功');
  }
  // 對照組（同時證明本題測到的是**真的有在剝東西**的那支投影，不是一個什麼都沒做的函式）：
  assert.equal(out.settings.ib.flexToken, '', '前置：機密該剝的還是要剝（否則本題等於在測一支空函式）');
  assert.equal(out.settings.taishinSecPdfPassword, '', '前置：證券密碼該剝的還是要剝');
  assert.equal(out.cards[0].pdfPassword, '', '前置：卡片密碼該剝的還是要剝');
  assert.equal(out.accounts[0].accountNo, '', '前置：完整帳號該剝的還是要剝');
  assert.equal(db.settings.ib.flexToken, 'TOKEN-要被剝掉', '前置：投影不可以就地改壞呼叫端手上的 db');
  // 接線（「函式有考題、接線沒考題」是本檔一再踩到的病）：雲端的 /api/export 真的走這支投影。
  const route = readFileSync(join(ROOT, 'lib/routes/core.js'), 'utf8');
  const g = route.indexOf("get('/api/export'");
  assert.ok(g > 0, '前置：找不到 /api/export——路由被搬家了，本題的前提要重新確認');
  assert.match(route.slice(g, g + 900), /isHosted\(\)\s*\?\s*stripSecretsForBackup\(db\)\s*:\s*db/,
    '雲端的 /api/export 必須走 stripSecretsForBackup（LOCAL 則是未投影的完整 db）——'
    + '換成別的投影，這一題的保護就落在別人身上了，改的人要自己去確認分類樹還在');
});

test('畫面文案｜任何「系統會替你留一份」的說法都要交代哪一種模式才有（掃遍 public/）', () => {
  // ⚠️ 這一題關的是**整族**的門，不是幾個特定句子：`public/` 兩種模式共用同一份畫面，而
  //    `lib/repo.js` 的 `backupNow` 在 HOSTED 一律回 false＝雲端版沒有任何自動備份。所以任何
  //    「系統會替你留一份」的句子，只要拿不到模式資訊就是對雲端使用者說謊。
  // ⚠️ 前端能拿到模式的**只有匯出告知那一個布林**（`GET /api/mode`，授權範圍見
  //    docs/contracts/cloud-security.md「匯出前告知的模式分流」）——除了那一句以外的文案都拿不到，
  //    所以本題守的是「**沒有模式資訊的那些句子**不可以承諾備份」。別把那個布林當成全面豁免。
  // ⚠️ 為什麼是掃描題而不是逐處斷言：這一族反覆用「改掉被點名的那一處、同頁另一處照樣說謊」的
  //    方式復發，「列舉繞法補不完就要關門」（專案模式）。
  //
  // ⚠️ 判準（#410 r6 重新設計，舊版三個洞複驗者都實測過）：
  //    舊版＝只認三個觸發字（自動備份／還原檔／.bak）＋否定詞清單含**裸字「沒」**＋整檔略過 backup-alert.js。
  //      洞①「沒問題，會自動備份。」⇒ 前十字含裸字「沒」被誤判成否定句。
  //      洞②「系統每次都會替你留一份可恢復的副本。」＝假承諾，但不含那三個觸發字 ⇒ 壓根掃不到。
  //      洞③ `modules/backup-alert.js` **整檔**略過 ⇒ 在那裡寫任何假承諾都綠。
  //    新版三件事：
  //      (a) 觸發面擴成兩族：**點名式**（自動備份／還原檔／.bak）一律要交代；**承諾式**＝同一句裡
  //          有「誰做的」（系統／自動／每次／每天／每日／會替你／會幫你）＋「留了一份什麼」
  //         （備份／副本／存一份／留一份／可恢復／可還原）。洞②屬後者。
  //      (b) 否定面**不再是關鍵詞清單**（洞①的真根因）：改問結構——否定詞要在同一小句、
  //          而且到那個說法之間只准夾修飾語（`negatesClaim`，與 ③-a 共用**唯一一份實作**，理由寫在函式上）。
  //          ⚠️ r6 那版只把裸字「沒」從清單裡拿掉，複驗者多寫一個字——「沒有問題，會自動備份。」——
  //             就同時通過本題與 ③-a（實測 13/13）。列舉補不完就要關門。
  //      (c) backup-alert.js 從「整檔略過」收成「**只放行回報失敗的那種句子**」（洞③）：
  //          條件是那個說法後面 24 字內出現失敗／沒有成功。在那個檔裡寫一句正面承諾照樣紅。
  // ⚠️ **收手判準（誠實劃界）**：文字掃描永遠擋不完——它擋的是「照現在的寫法再寫一句同族假話」，
  //    不是「所有可能的假承諾」。已知擋不住的四個例子：換一組完全不同的詞（「你的東西我們都留著」）、
  //    把「誰做的」與「留了一份什麼」**拆成兩句**（判準只看同一句）、
  //    把否定詞黏在別的東西上又不加標點（「不用擔心的自動備份」，見 `negatesClaim`）、
  //    或在 backup-alert.js 的句尾補一個「失敗」把承諾夾帶進來。目標是**讓下一個人踩到就紅**，
  //    不是窮舉；至於「把模式資訊送到前端」，刻意只開匯出告知那一個布林（不得擴張，見 cloud-security
  //    契約），其餘句子仍照本題的規矩自己交代（見 docs/文案審稿-雲端版的九句假話.md 附註）。
  const AGENT = /系統|自動|每次|每天|每日|會替你|會幫你/;                    // 誰做的：系統自己（＝承諾）
  const SAFETY = /自動備份|還原檔|\.bak|備份|副本|存一份|留一份|可恢復|可還原/g;
  const NAMED = new Set(['自動備份', '還原檔', '.bak']);                     // 點名式：本身就是承諾
  const MODE = /本機版|雲端版|跑在自己電腦|跑在雲端|自己電腦上/;             // 交代了哪一種模式才有
  const FAILREPORT = /失敗|沒有成功|沒成功/;                                 // 「回報失敗」不是「我會幫你備份」
  // 放行「回報失敗」句子的檔案只有一個，而且附**可查證的**理由（見下方 assert 自己盯著它還成立）：
  //   public/modules/backup-alert.js 是每日備份**失敗**時的警告文案；
  //   而且 HOSTED 一律回 failStreak:0（lib/services/backup.js 的 isHosted() 早退）⇒ 這條警告在雲端不會出現。
  const FAIL_OK = new Set(['modules/backup-alert.js']);
  const svc = readFileSync(join(ROOT, 'lib/services/backup.js'), 'utf8');
  const h = svc.indexOf('if (isHosted())');
  assert.ok(h > 0, '放行條件的理由不成立了：lib/services/backup.js 不再有 HOSTED 早退'
    + '——那 backup-alert 的本機專用指引就會出現在雲端使用者的畫面上，這條放行要重新判斷');
  assert.match(svc.slice(h, h + 400), /failStreak:\s*0/,
    '放行條件的理由不成立了：HOSTED 早退不再把 failStreak 壓成 0（雲端會顯示「請檢查電腦硬碟空間」）');

  /** public/ 底下所有畫面檔（.js/.html）的相對路徑。 @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(join(ROOT, 'public', dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return walk(rel);
    return /\.(js|html)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : [];
  });
  const files = walk('');
  assert.ok(files.length >= 20, `前置：public/ 掃到的畫面檔只有 ${files.length} 個——掃描範圍縮小了，本題會變成空轉`);

  /** 空轉守衛算的是**文案段數**（一句＝一段），不是命中次數——同一句裡命中三次不算三處。 */
  const flagged = new Set();
  for (const rel of files) {
    // 先去註解（畫面上看不到的字不算文案，也不該逼人在註解裡寫模式），再剝標籤。
    const text = stripTags(stripJsComments(readFileSync(join(ROOT, 'public', rel), 'utf8')));
    // 一句一句看。不用整段一起比對——那會讓「隔壁那句的否定詞」替這句作保（實測過：只看整段時，
    // 把「不會自動備份」改成「會自動備份」照樣綠，因為同段後面有「也沒有『復原』可以按」）。
    const sentences = text.split(/[。！？\n]/);
    for (const [si, seg] of sentences.entries()) {
      for (const m of seg.matchAll(SAFETY)) {
        const idx = m.index ?? 0;
        if (!NAMED.has(m[0]) && !AGENT.test(seg)) continue;      // 承諾式要有「誰做的」才算承諾
        const before = seg.slice(0, idx);                        // negatesClaim 自己收斂到同一小句
        const after = seg.slice(idx + m[0].length, idx + m[0].length + 24);
        // 先記帳再放行：空轉守衛要問的是「掃描器還看得到東西嗎」，被放行的句子也算掃到過
        //（記在放行之後的話，好狀態剛好卡在門檻上、日後任何文案微調都會誤紅）。
        flagged.add(`${rel}|${si}`);
        if (FAIL_OK.has(rel) && FAILREPORT.test(after)) continue;   // 回報失敗的句子，不是承諾
        assert.ok(negatesClaim(before) || MODE.test(seg),
          `${rel} 有一句說「${m[0]}」，卻沒交代那是哪一種模式才有的東西：\n    …${seg.trim().slice(0, 160)}…\n`
          + '  ⇒ public/ 兩種模式共用同一份畫面（模式資訊僅限匯出告知那一個布林；此處這些句子拿不到），而 lib/repo.js 的 backupNow\n'
          + '    在 HOSTED 一律回 false＝雲端版沒有任何自動備份。請改成否定句（否定詞要**貼著**那個說法，\n'
          + '    例：「不會自動備份」「沒在做自動備份」；「沒有問題，會自動備份」不算，那是在否定別的東西）\n'
          + '    或講明模式（「只有本機版才有那一份」），不要在雲端使用者按下不可逆動作前騙他有安全網。');
      }
    }
  }
  assert.ok(flagged.size >= 2,
    `前置：只掃到 ${flagged.size} 段「系統會替你留一份」的文案——`
    + '⚠️ 這個門檻**不是在要求畫面留著幾段承諾**（承諾愈少愈好），它問的是「掃描器還看得見東西嗎」：'
    + '每日備份警告 modules/backup-alert.js 那幾段是掃得到的最低底盤（回報失敗的句子會被放行，但仍算掃到）。'
    + '掉到門檻以下代表觸發字或掃描範圍被改壞了＝這一題在空轉，'
    + '而不是代表畫面上的假承諾變少了');
});

// ⭐ 這一題釘的是「**不做**」這個決定本身：不可逆操作前的自動備份是本專案刻意不提供的，
// 完整理由與刻意接受的代價寫在 lib/services/backup.js 的設計註解（重點：那層網自己會失敗，
// 而失敗的那一次畫面照樣說成功；要誠實交代它，一個單純的操作就得長出額外的確認框與旗標）。
//
// ⚠️ 為什麼「決定」也需要考題：下一個看到「不可逆操作居然沒有備份」的人（人或 AI）會**好心加回來**，
// 而那正是刻意不要的東西。只寫在註解裡擋不住任何人，所以這裡把「不得再出現」變成會轉紅的斷言。
// 使用者的救援手段另有其人：每日滾動備份（本檔第四節有題）、他自己按的〈匯出備份〉、啟動 .bak。
test('⭐ 裁決｜店名規則與開 app 自動整理這兩條路，不得長出「操作前自動備份」（刻意不做的，不是漏掉的）', () => {
  const paths = ['lib/services/store-rules.js', 'lib/services/statement-import.js', 'lib/routes/statement.js'];
  for (const rel of paths) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const code = stripJsComments(src);            // 只看正式程式路徑：註解裡提到名字不是呼叫
    assert.doesNotMatch(code, /backupBeforeIrreversible|backupNow\s*\(/,
      `${rel} 出現「操作前自動備份」的呼叫——這一層是刻意不做的，不是漏掉的`
      + '（完整理由與刻意接受的代價見 lib/services/backup.js 的設計註解）。真的要加，先問過 William。');
    assert.doesNotMatch(code, /backup_failed|proceedWithoutBackup/,
      `${rel} 出現「備份沒做成」的確認旗標——同上：沒有操作前備份，就不該有為它而生的旗標。`);
  }
  // 前端那兩個呼叫端同樣不該認那個 reason（認了就代表後端又長回來了）
  for (const rel of ['public/app.js', 'public/modules/settings-store-rules.js']) {
    const code = stripJsComments(readFileSync(join(ROOT, rel), 'utf8'));
    assert.doesNotMatch(code, /backup_failed|proceedWithoutBackup|NO_BACKUP_CONFIRM/,
      `public 端的 ${rel} 接起了「備份沒做成」的確認——後端不會回這個 reason，接了就是替不存在的機制留位子。`);
  }
  // 文案面：這兩處不可以承諾自動還原檔（承諾了就會變成新的空頭支票）
  const cardSrc = readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8');
  const panelSrc = readFileSync(join(ROOT, 'public/modules/settings-store-rules.js'), 'utf8');
  // ⚠️ 警告句只准講**畫面撐得住的那個 UI 事實**：編輯器裡沒有「復原」可以按。不可寫成無限定的
  //    「儲存後無法復原」——既有的匯出檔可以經 /api/import 整包匯回去，那句話比事實講得滿。
  //    這幾條同時是本題的**反面自我驗證**：掃描器讀錯檔或文案整段消失時，前置那條會先紅，本題不會靜靜空轉。
  const WARN = '儲存後沒有「復原」可以按';
  for (const [rel, src] of [['settings.js', cardSrc], ['settings-store-rules.js', panelSrc]]) {
    const shown = stripTags(stripJsComments(src));
    assert.doesNotMatch(shown, /pre-rules|pre-normalize/,
      `${rel} 的畫面文案點名了操作前備份檔——這兩條路刻意不產生它，寫出來就是承諾一個不存在的東西。`);
    assert.ok(src.includes(WARN),
      `前置：${rel} 的「${WARN}」不見了——掃描器可能讀錯檔，或那句不可逆警告被刪了，本題會空轉`);
    assert.doesNotMatch(shown, /儲存後無法復原/,
      `${rel} 把警告寫成無限定的「儲存後無法復原」——匯出檔整包匯回去救得回來，`
      + `畫面撐得住的只有「${WARN}」這個 UI 事實。`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、備份的原子替換與殘骸清理（lib/store.js：snapshotTo 三道＋啟動備份 backupOnce 兩道）
//
// ⚠️ 誠實劃界——**「大家共用同一份實作」講不得**：`lib/store.js` 裡有數支各自獨立的 VACUUM→rename，
//    改壞其中一支不會被守著另一支的題抓到。逐支交代誰有安全網、誰沒有：
//      ① `snapshotTo`：操作前 `<tag>.bak`（經 backupNow）與每日滾動備份走這裡
//         ——本節除了「啟動 .bak」那一族以外的題守著。
//      ② `backupOnce`：啟動 `.bak`，**損毀時的還原指引點名要改名回去的就是這一顆**
//         ——本節「啟動 .bak」那一族守著失敗路徑（舊備份不可被動到）與成功路徑（那顆檔裡要有當下的資料）。
//         ⚠️ 成功路徑非守不可（實測過的假綠）：把 `d.exec(VACUUM…)` 改成**從一顆全新的空白資料庫**
//         產生 `.bak`，檔案照樣建出、原子替換與 .tmp 清理都正常 ⇒ 整套全綠、退出碼 0，
//         而使用者照指引改名回去只會拿到一顆空殼。只驗「檔案有沒有生出來」擋不住這一手。
//      ③ `migrateLedgerIfNeeded`：`pre-ledger-migration.bak` ——本節末尾守著 happy path。
//      ④ `migrateSecTradesContractIfNeeded`：`pre-sec-contract.bak`
//         ——test/securities-migration.test.js 的搬家題守著 happy path。
//    ⚠️ 寫這種「都有考題」的句子之前先逐支點過：這一段曾經括號寫著「③④ happy path 都有考題」，
//       而當時③連一條斷言都沒有（把那整段備份刪掉，全批無一轉紅）＝誇大比缺口更糟。
//    ③④ 的**失敗路徑沒有考題**：要重現得先造出「還沒搬過家、且剛好 VACUUM 失敗」的庫，
//    而兩支都有 meta 鍵守著只跑一次；判斷投入產出不划算，列為**已知缺口**——
//    不寫「做不到」，因為本節那種長檔名手法同樣適用。
//    ⚠️ 這幾份重複是既有狀況，記在這裡是為了讓下一個人收斂它們時，知道①②有安全網、③④沒有。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 探測**這個資料夾**能寫出來的最長單一檔名（回傳最大可寫長度；探不到回 0）。
 * 為什麼要動態探：NAME_MAX 因檔案系統而異（APFS/ext4＝255、部分網路磁碟更短），
 * 寫死 255 的題目換一台機器就會在別的地方失敗、或根本不失敗＝靜靜通過。
 * 二分搜尋成立的前提：長度限制單調（能寫 n 就能寫 n-1）。
 * 順帶好處：探測用的是同一個 dir，所以 PATH_MAX 若先卡住，探到的就是「這個 dir 的實際上限」。
 * @param {string} dir @returns {number}
 */
function probeMaxNameLen(dir) {
  const canWrite = (/** @type {number} */ n) => {
    const p = join(dir, 'p'.repeat(n));
    try { writeFileSync(p, ''); rmSync(p); return true; } catch { return false; }
  };
  if (!canWrite(1)) return 0;          // 連 1 字元都寫不出來＝這個 dir 有別的問題
  let lo = 1, hi = 4096;
  if (canWrite(hi)) return 0;          // 沒有實際上限（或高到本題造不出來）
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (canWrite(mid)) lo = mid; else hi = mid; }
  return lo;
}

/**
 * 探測**這個資料夾**能讓 SQLite `VACUUM INTO` 成功寫出來的最長單一檔名（探不到回 0）。
 * 為什麼不直接沿用 `probeMaxNameLen`：SQLite 開一顆 db 時會先替 `-journal`（8 字元）留位，
 * 所以「fs 寫得出來的檔名」比「SQLite 開得起來的檔名」寬——實測 macOS APFS 上是 255 vs 247。
 * 那個差幾字元是 SQLite 的實作細節，寫進考題就是另一個會漂的數字；直接**功能性地問 VACUUM 本人**。
 * 二分搜尋的前提同上：長度限制單調（寫得出 n 就寫得出 n-1）。
 * @param {string} dir @returns {number}
 */
function probeMaxVacuumNameLen(dir) {
  const src = join(dir, 'probe-src.db');
  const d = new DatabaseSync(src);
  try {
    d.exec('CREATE TABLE t(x)');
    const canVacuum = (/** @type {number} */ n) => {
      const p = join(dir, 'v'.repeat(n));
      try { d.exec(`VACUUM INTO '${p}'`); return true; }
      catch { return false; }
      finally { try { rmSync(p); } catch { /* 失敗時可能根本沒建出來 */ } }
    };
    if (!canVacuum(1)) return 0;          // 連 1 字元都寫不出來＝這個 dir 有別的問題
    let lo = 1, hi = 4096;
    if (canVacuum(hi)) return 0;          // 沒有實際上限（或高到本題造不出來）
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (canVacuum(mid)) lo = mid; else hi = mid; }
    return lo;
  } finally {
    d.close();
    for (const suf of ['', '-journal', '-wal', '-shm']) { try { rmSync(src + suf); } catch { /* 可能不存在 */ } }
  }
}

test('備份｜VACUUM 階段失敗時，舊的那一份必須逐位元組完好（不可先刪舊再做新）', (t) => {
  // ⚠️ 那段自審 r2 註解寫在**另一支**上：`backupOnce`（lib/store.js:277-278）寫著「原寫法『先刪舊再做新』，
  //    若 VACUUM 失敗（例如硬碟滿）會兩頭空——而損毀還原指引指的正是這顆 .bak」，那顆＝**啟動 .bak**，
  //    由下一題（「啟動 .bak 同樣不可先刪舊再做新」）守。**本題受測的是 `snapshotTo`**（lib/store.js:321）
  //    ——操作前 `<tag>.bak` 與每日滾動備份走它；它自己**關於這件事**只有 `renameSync(tmp, dest)` 那行的一句「原子替換：VACUUM
  //    中途失敗（硬碟滿）時，上一顆備份仍完好」，不涉還原指引。
  // ⚠️ 考題設計沿革（v1–v3 各被抓到一次「弄壞卻全綠」，v4 才真的守住，v5 修可攜性與註解失真）：
  //    v1 失敗目標用了**別的路徑** ⇒「先刪舊」刪的不是那顆。
  //    v2 只比**檔案長度** ⇒ 同長度垃圾覆寫照樣綠（#410 r1 H③）。
  //    v3 用資料夾占住 `.tmp` ⇒ 失敗發生在**前置 rmSync(tmp)**、還沒進到危險的 VACUUM 階段，
  //       所以「通過前置清理後才刪舊」的原病變體照樣綠（#410 r2 H①）。
  //    v4：讓失敗**發生在 VACUUM 那一步**——`dest` 的檔名剛好等於單一檔名上限（合法），
  //       但 `dest + '.tmp'` 超過上限 ⇒ 前置 `existsSync(tmp)` 為 false 直接跳過（不會提早失敗），
  //       VACUUM INTO tmp 則 ENAMETOOLONG 失敗 ⇒ 正確實作在此拋錯、dest 一個位元組沒動。
  //    v5（現在，#410 r3 Low）：長度改成**動態探測**（原本寫死 254/255＝綁死 NAME_MAX=255 的機器），
  //       並把「突變怎麼紅的」改寫成實測結果——原註解說「VACUUM INTO dest 反而成功 ⇒ 不拋錯 ⇒ 轉紅」
  //       是**錯的**，實測（macOS APFS、探到上限 255）是：
  //         rmSync(dest) 成功刪掉好備份 → VACUUM INTO dest **先建出 0-byte 的 dest** →
  //         SQLite 要開 `dest-journal`（上限+8 字元）失敗 → 拋 `unable to open database file`。
  //       所以 assert.throws 與 existsSync 兩行都照樣通過，真正抓住突變的是**逐位元組比對**（0 位元組 ≠ 原備份）。
  //       保護仍然成立：在本題的環境裡 `rmSync(dest)` 必定成功（dir 可寫、dest 檔名合法），
  //       好備份一定先消失，之後兩條分支都有人接——VACUUM 若成功 ⇒ 不拋錯、assert.throws 紅；
  //       VACUUM 若失敗 ⇒ dest 不是不存在（existsSync 紅）就是內容不同（逐位元組比對紅）。
  const dir = mkdtempSync(join(tmpdir(), 'finance-bak-'));
  TRASH.push(dir);
  const maxName = probeMaxNameLen(dir);
  if (maxName < 16 || maxName > 1000) {
    // 靜靜通過比沒有考題更糟（專案鐵則）：造不出「dest 合法、dest+'.tmp' 超長」的長度時大聲跳過。
    const why = `本題需要「檔名剛好合法、再加 4 字元 .tmp 就超長」的長度；`
      + `此資料夾探測到的單一檔名上限＝${maxName || '探不到（1 字元寫不出，或 4096 字元仍可寫）'}，造不出這種長度`;
    console.warn(`[skip] 備份｜VACUUM 階段失敗題：${why}`);
    t.skip(why);
    return;
  }
  store.save({ ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] });
  const seed = join(dir, 'seed.bak');
  store.snapshotTo(seed);                                      // 先用短路徑做一份合法備份
  const dest = join(dir, `${'b'.repeat(maxName - 4)}.bak`);     // 剛好等於上限；+'.tmp' 超過上限
  copyFileSync(seed, dest);                                    // 放到長檔名位置＝「上一次的好備份」
  const goodBytes = readFileSync(dest);
  assert.ok(goodBytes.byteLength > 0);

  // live DB 換成明顯不同的狀態——若失敗路徑「先刪舊再做新」，新內容就會蓋掉舊備份
  store.save({ ...store.emptyDb(), history: [{ id: 'm2', month: '2026-08', amount: 999999 }] });
  assert.throws(() => store.snapshotTo(dest), /.*/,
    'VACUUM 寫不出去時必須拋錯——不拋錯代表它繞過了 .tmp、直接動了正式的備份檔');
  assert.ok(existsSync(dest), '這一次失敗，上一顆好備份必須還在'
    + '（操作前 <tag>.bak／每日滾動備份走的就是這條；還原指引點名的啟動 .bak 由下一題守）');
  assert.deepEqual(readFileSync(dest), goodBytes,
    '舊備份必須**逐位元組**完好——只比長度的話，被同長度垃圾或新狀態覆寫都抓不到');
});

test('備份｜啟動 .bak（還原指引點名的那一顆）同樣不可「先刪舊再做新」', (t) => {
  // ⚠️ 上一題受測的是 `snapshotTo`，但**還原指引（lib/store.js:49）叫使用者改名回去的 `store.db.bak`
  //    不是它產的**——那是 `backupOnce`（lib/store.js:275-289）自己一份 VACUUM→rename。
  //    實測（把 backupOnce 逐字改回「先刪舊再做新」：`const bak = FILE + '.bak';
  //    if (existsSync(bak)) rmSync(bak); d.exec(VACUUM INTO bak);`＝拿掉 .tmp、原子替換與失敗清理）：
  //    **本檔七題全綠、`npm test` 1494 題全綠**——在這一題之前，使用者唯一的自救檔案沒有任何考題守著。
  // ⚠️ 情境造法（承上一題，但長度上限改用 `probeMaxVacuumNameLen` 功能性探測）：
  //    `STORE_FILE` 的檔名長度剛好等於「VACUUM 寫得出來的上限 V」⇒ 主庫本身開得起來
  //   （WAL 只多 `-wal`/`-shm` 4 字元），但 `.bak`（V+4）與 `.bak.tmp`（V+8）都超過 V ⇒ VACUUM 必定失敗。
  //    正確實作：失敗發生在寫 `.tmp` 這一步，舊 `.bak` 一個位元組都沒動。
  //    「先刪舊再做新」：舊 `.bak` 先被 `rmSync` 刪掉 → `VACUUM INTO bak` **先建出 0-byte 的 bak** 再失敗
  //    ⇒ 使用者到 data/ 看到 `store.db.bak` **還在**（existsSync 為 true！），改名回去卻是一顆空檔。
  //    所以判準必須是**逐位元組比對**，光看「檔案還在不在」正好是這個病最會騙人的地方。
  // ⚠️ 隔離：`backupOnce` 未 export、只在 `open()` 裡跑、每個行程只跑一次（`backedUp` 旗標），
  //    本檔前面的題目早就把它跑掉了 ⇒ 必須另開子行程（寫法比照本檔其他另開子行程的題）。
  const dir = mkdtempSync(join(tmpdir(), 'finance-startbak-'));
  TRASH.push(dir);
  const V = probeMaxVacuumNameLen(dir);
  if (V < 32 || V > 1000) {
    // 靜靜通過比沒有考題更糟（專案鐵則）：造不出這種長度時大聲跳過。
    const why = `本題需要「主庫檔名合法、再加 .bak 就 VACUUM 不出去」的長度；`
      + `此資料夾探測到的 VACUUM 檔名上限＝${V || '探不到（1 字元寫不出，或 4096 字元仍可寫）'}，造不出這種長度`;
    console.warn(`[skip] 備份｜啟動 .bak 原子替換題：${why}`);
    t.skip(why);
    return;
  }
  const target = join(dir, 'b'.repeat(V));     // 子行程的 STORE_FILE
  const bak = target + '.bak';                 // V+4：fs 放得下（copyFileSync 沒有那 8 字元的保留），但 VACUUM 開不了
  store.save({ ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] });
  const seed = join(dir, 'seed.bak');
  store.snapshotTo(seed);                      // 先用短路徑做一份合法備份
  copyFileSync(seed, bak);                     // 放到長檔名位置＝「上一次的好備份」
  const goodBytes = readFileSync(bak);
  assert.ok(goodBytes.byteLength > 0, '前置：好備份要真的有內容，否則本題會空轉');

  // 子行程自己攔 console.warn：要證明 backupOnce **真的跑了而且真的失敗**，
  // 否則哪天它改成寫別的路徑（＝還原指引失效），本題會因為「舊 .bak 沒被動到」而靜靜通過。
  const script = "const warns = [];"
    + " const ow = console.warn; console.warn = (...a) => warns.push(a.map(String).join(' '));"
    + " const s = await import('./lib/store.js');"
    + " s.load();"                              // load → open → backupOnce
    + " console.warn = ow;"
    + " console.log('OPENED');"
    + " console.log('WARN:' + JSON.stringify(warns.join('|')));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: target },
  });
  assert.match(out, /OPENED/,
    '前置：主庫本身必須開得起來（開不起來就代表長度算錯，backupOnce 壓根沒跑到、本題會空轉）');
  assert.match(out, /WARN:.*啟動備份/,
    '前置：backupOnce 必須真的跑到並失敗（沒有這行＝它寫去了別的路徑，那還原指引本身就失效了）');
  assert.ok(existsSync(bak), '這一次備份失敗，上一顆好備份必須還在（還原指引叫使用者改名回去的就是它）');
  assert.deepEqual(readFileSync(bak), goodBytes,
    '啟動 .bak 必須**逐位元組**完好——「先刪舊再做新」會留下 0-byte 的同名檔，'
    + '檔案「還在」但內容全沒了，使用者照指引改名回去只會得到一顆空資料庫');
});

test('備份｜啟動 .bak 的成功路徑：那顆檔裡要有「這次開機時的真資料」（不是一顆合法的空殼）', () => {
  // ⚠️ 這一題補的正是複驗者（#410 r8）示範的繞法：上一題只守「失敗時舊備份不可被動到」，
  //    完全沒問過「成功時那顆備份裡到底裝了什麼」。把 `backupOnce` 的 `d.exec(VACUUM INTO tmp)`
  //    換成**從一顆全新的空白資料庫** VACUUM 出來——檔案照樣建出來、原子替換與 .tmp 清理全都正常
  //    ⇒ 本檔 9/9、整套 1496/1496 全綠、退出碼 0。使用者照還原指引把它改名回 `store.db`，
  //    拿到的是一顆連 `kv` 表都沒有的空庫，而且**畫面不會有任何異狀**（＝本專案最嚴重的那一族）。
  //    ⇒ 判準必須是**打開 .bak 讀裡面的資料**，「檔案在不在／有多大」都擋不住這種繞法。
  // ⚠️ 兩層斷言缺一不可（兩種突變各殺一層，都實測過）：
  //    MUT-A＝空白庫（連 kv 表都沒有）⇒ 表格清單那行紅。
  //    MUT-B＝空白庫但先 `CREATE TABLE kv` 再 VACUUM（形狀對、資料空）⇒ 表格清單**照樣通過**，
  //           紅的是下面「本題種下去那一筆」的內容比對。
  // ⚠️ 隔離：`backupOnce` 未 export、只在 `open()` 裡跑、每個行程只跑一次（`backedUp` 旗標），
  //    本檔前面的題目早已把它跑掉 ⇒ 必須另開子行程（寫法比照本節其他題）。
  const dir = mkdtempSync(join(tmpdir(), 'finance-startok-'));
  TRASH.push(dir);
  const target = join(dir, 'startup-ok.db');
  const bak = target + '.bak';
  const boot = (/** @type {string} */ tail) => execFileSync(
    process.execPath, ['--input-type=module', '-e', "const s = await import('./lib/store.js');" + tail],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: target } });

  // ① 第一次開機：建庫，並種下**本題專屬**的值（值要獨一無二，否則抓到的可能是別處留下的東西）
  const probe = { id: 'PROBE-startbak-r9', month: '2026-08', amount: 8675309 };
  boot(` s.save({ ...s.emptyDb(), history: [${JSON.stringify(probe)}] }); console.log('SEEDED');`);
  rmSync(bak);   // ①自己也會產一顆（開機備份在 save 之前就跑完＝種之前的狀態）；刪掉，②那顆才分得出來
  assert.ok(!existsSync(bak), '前置：①留下的舊備份要先真的清掉，否則本題分不出讀到的是哪一次');

  // ② 第二次開機：backupOnce 應該把「現在這一刻的資料」照下來
  assert.match(boot(" s.load(); console.log('OPENED');"), /OPENED/,
    '前置：第二次開機要成功（開不起來的話 backupOnce 壓根沒跑到、本題會空轉）');
  assert.ok(existsSync(bak), '每次啟動都要留下一顆 .bak（損毀還原指引叫使用者改名回去的就是它）');

  const d = new DatabaseSync(bak);
  try {
    const tables = /** @type {any[]} */ (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
      .map(r => String(r.name));
    assert.ok(tables.includes('kv'),
      '備份裡連 kv 表都沒有＝它不是這顆資料庫的快照——空白資料庫也 VACUUM 得出一個合法的 .bak 檔');
    const readKv = (/** @type {string} */ k) => {
      const row = /** @type {any} */ (d.prepare('SELECT data FROM kv WHERE key=?').get(k));
      return row ? JSON.parse(row.data) : null;
    };
    assert.deepEqual(readKv('history'), [probe],
      '備份裡必須是**這次開機時的真資料**——抓不到本題種下去那一筆，代表 .bak 的內容來源不是這顆庫');
    const st = readKv('settings');
    assert.ok(st && typeof st === 'object' && st.currency,
      '備份裡的 settings 也要在——缺了它，改名回去只是一顆沒有任何設定的殼');
  } finally { d.close(); }
});

test('備份｜失敗時不可留下半截的 .tmp 殘骸（會被誤認成備份、還原到它會失敗）', () => {
  // ⚠️ docstring 明寫「失敗時一定清掉半成品 .tmp，不留下會被誤認成備份的殘骸」。
  //    每日備份會反覆呼叫這支，殘骸會在 backups/ 底下累積成一堆「看起來像備份、其實是半截檔」，
  //    而損毀還原的指引正是「把備份改名回 store.db」——改到半截檔會讓還原本身失敗。
  // ⚠️ 誠實劃界（#410 r2 M③ 起草、r3 M 訂正）：**這一題只涵蓋「VACUUM 成功、改名失敗」這條路**。
  //    r2 版註解宣稱「`.tmp` 只可能由 VACUUM 建出來，兩種寫法對所有可達路徑等價」——**那是錯的**。
  //    snapshotTo 的 try 裡依序有四件事，外層 catch 的清理實際覆蓋這些路徑：
  //      (a) VACUUM 成功、renameSync 失敗 ⇒ `.tmp` 是這一次的半成品（本題守著）
  //      (b) `open()` 就失敗（主庫損毀）⇒ 連前置清理都還沒跑到，`.tmp` 是**前一次留下的殘骸**
  //          ——把清理縮進改名的 catch 之後這條路就沒人清了（下一題守著）
  //      (c) VACUUM 自己失敗、而且**已經建出檔案**（硬碟滿寫一半）⇒ 外層 catch 會清，但**本檔沒有考題**：
  //          上一題（VACUUM 階段失敗）那種 ENAMETOOLONG 失敗連檔案都沒建出來，清不清理都一樣綠。
  //          列為已知缺口——不寫「這套 harness 做不到」，因為長檔名 journal 那種失敗其實會留下 0-byte 檔，
  //          是可構造的；只是本檔沒立這一題。
  //      (d) 前置 `rmSync(tmp)` 自己失敗（`.tmp` 位置被資料夾佔住／權限）⇒ catch 裡再刪一次同樣失敗，
  //          本來就沒有保護力。也沒有考題。
  // ⚠️ 考題設計（第一版是空包彈，突變驗證抓到）：要讓 `.tmp` **真的被寫出來**、失敗發生在
  //    後面的改名那一步，否則沒有殘骸可清，「不清理」的突變照樣綠。
  //    製造法＝把 dest 佔成一個資料夾：VACUUM 寫 .tmp 成功 → renameSync(檔案→資料夾) 失敗。
  const dir = mkdtempSync(join(tmpdir(), 'finance-tmp-'));
  TRASH.push(dir);
  const dest = join(dir, 'occupied');
  mkdirSync(dest);
  store.save({ ...store.emptyDb() });
  assert.throws(() => store.snapshotTo(dest), /.*/, '改名失敗要拋錯');
  assert.ok(!existsSync(dest + '.tmp'),
    '半成品 .tmp 必須被清掉——留著會被誤認成備份，而還原到半截檔會讓自救本身失敗');
});

test('備份｜連資料庫都開不起來時，前一次留下的 .tmp 殘骸一樣要清掉', () => {
  // ⚠️ 這一題補的正是上一題劃界裡的路徑 (b)（#410 r3 M 指出的缺口）：`snapshotTo` 第一件事是 `open()`，
  //    主庫損毀時它就丟錯，**連前置的 `if (existsSync(tmp)) rmSync(tmp)` 都跑不到**；
  //    此時能清掉殘骸的只有**外層 catch**。把清理縮進 renameSync 的 catch ⇒ 殘骸永遠留著。
  //    真實情境：主庫壞掉那幾天，每日備份服務每天照跑一次、每天照樣失敗，而 backups/ 底下那顆
  //    上一次改名失敗留下的 `.tmp` 就一直躺著——使用者要自救時看到的正是那顆「看起來像備份的半截檔」。
  // ⚠️ 隔離做法：`STORE_FILE` 在模組 import 時就決定、`db` 連線又被模組快取（本檔前面的題目早就開成功了），
  //    所以必須另開子行程才能讓 open() 真的失敗——寫法比照本檔最後一題。
  const dir = mkdtempSync(join(tmpdir(), 'finance-openfail-'));
  TRASH.push(dir);
  const dest = join(dir, 'daily-2026-08-05.bak');
  const tmp = dest + '.tmp';
  writeFileSync(tmp, 'half-written-residue');            // 前一次失敗留下的殘骸
  assert.ok(existsSync(tmp), '前置：殘骸要先真的存在，否則本題會空轉');

  const broken = join(dir, 'broken.db');                 // 垃圾位元組＝open() 在建連線/PRAGMA 就失敗
  writeFileSync(broken, Buffer.from('this is not a sqlite database, just garbage.'.repeat(64)));

  const script = "const s = await import('./lib/store.js');"
    + " try { s.snapshotTo(process.env.T_DEST); console.log('NO_THROW'); }"
    + " catch (e) { console.log('THREW:' + e.message); }";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: broken, T_DEST: dest },
  });
  assert.doesNotMatch(out, /NO_THROW/, '主庫損毀時 snapshotTo 必須拋錯（呼叫端要據實回報備份失敗）');
  assert.match(out, /store\.db\.bak/,
    '拋出來的必須是 open() 的還原指引——確認失敗真的發生在**開庫**那一步，'
    + '而不是後面的 VACUUM／改名（否則本題就退化成上一題的重複）');
  assert.ok(!existsSync(tmp),
    '開庫就失敗這條路上，前一次的 .tmp 殘骸也必須被清掉——'
    + '清理只寫在 renameSync 的 catch 裡的話，這顆殘骸會永遠躺在 backups/ 冒充備份');
  assert.ok(!existsSync(dest), '這一次根本沒做出備份，不該憑空出現 dest');
});

test('備份｜ledger 搬家動手前那顆 pre-ledger-migration.bak 要真的產出來，而且是「搬家之前」的狀態', () => {
  // ⚠️ 這一題補的是本節劃界裡③自己的缺口（#410 r7）：`migrateLedgerIfNeeded`（lib/store.js:164-172）
  //    是**第三份**獨立的 VACUUM→rename，而在這一題之前它連 happy path 都沒有任何斷言——
  //    全 repo grep `pre-ledger-migration` 的命中，除了 lib/store.js 自己、AGENTS.md、本節上方那塊
  //    劃界，以及各測試檔 after() 的 rmSync 清理迴圈（與那幾份後綴清單的說明註解），
  //    **本題之外沒有任何一條是斷言**。複驗者實測（在 r6 之前那棵樹上，把
  //    lib/store.js:161-172 那整段備份程式碼**整個刪掉**）：`npm test` **1495 pass / 0 fail**，無一題轉紅。
  // ⚠️ 為什麼這顆值得一題：搬家是**一次性且不可逆**的整批改寫（補 ledger＋舊平面收入分類改歸新樹），
  //    meta 鍵 `__ledgerMigratedAt` 一蓋下去就不會再跑第二次。判準若哪天寫歪（例如未來有人動
  //    normalizeLedger 的對應表），使用者要回到搬家前唯一的憑據就是這顆檔——而它是 best-effort、
  //    失敗只 console.warn，所以「有沒有真的產出來」正是最容易靜靜壞掉的地方。
  // ⚠️ 判準必須包含**內容**：只斷言 existsSync 的話，把備份挪到 COMMIT 之後（檔案照樣產得出來，
  //    但存的是搬家**後**的狀態＝什麼都救不回）就抓不到。所以直接開這顆 .bak 讀 kv，要求裡面那列
  //    **還沒有 ledger**。兩種突變都實測過（本題轉紅）：
  //      MUT1＝複驗者那招，整段備份刪掉 ⇒ existsSync 那行紅。
  //      MUT2＝備份原封不動搬到 COMMIT 之後 ⇒ existsSync **照樣通過**，紅的是下面的內容比對。
  // ⚠️ 隔離：`migrateLedgerIfNeeded` 未 export、只在 `open()` 裡跑、又被 meta 鍵守成一次性，
  //    本檔前面的題目早已把它跑掉 ⇒ 必須另開子行程（寫法比照本節其他另開子行程的題）。
  const dir = mkdtempSync(join(tmpdir(), 'finance-ledgerbak-'));
  TRASH.push(dir);
  const target = join(dir, 'ledger.db');
  const bak = target + '.pre-ledger-migration.bak';
  const boot = (/** @type {string} */ tail) => execFileSync(
    process.execPath, ['--input-type=module', '-e', "const s = await import('./lib/store.js');" + tail],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: target } });

  // ① 「上一版」開機一次：把庫建起來並蓋上 __ledgerMigratedAt。
  //    ⚠️ 這一次**本來就會產一顆** pre-ledger-migration.bak——`SEED`（lib/store.js:19）永遠指向 repo 的
  //    `data/seed.json`（不隨 STORE_FILE 走），而那份種子的 11 筆交易都沒有 ledger ⇒ 首開就會搬一次家。
  //    所以這裡把它刪掉：③ 斷言的那顆才能確定是③自己產的，不是首開留下來的（否則本題會空轉）。
  boot(" s.load(); console.log('BOOTED');");
  try { rmSync(bak); } catch { /* 種子哪天全帶 ledger 的話首開就不會產，沒有也無妨 */ }
  assert.ok(!existsSync(bak), '前置：舊備份要先真的清掉，否則③ 那顆分不出是哪一次留下的');

  // ② 直接改庫模擬真實升級路徑「庫裡躺著還沒搬過家的舊列」：塞一列沒有 ledger 的舊交易＋清掉一次性旗標
  {
    const d = new DatabaseSync(target);
    d.prepare('INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data')
      .run('transactions', JSON.stringify([{ id: 'old1', date: '2026-06-01', amount: 100,
        category: '飲食', subcategory: '餐廳', type: 'expense', source: 'stmt' }]));   // 無 ledger＝搬家前形狀
    d.prepare("DELETE FROM kv WHERE key='__ledgerMigratedAt'").run();
    d.close();
  }

  // ③ 「新版開機」：migrateLedgerIfNeeded 應先備份、再補 ledger
  const out = boot(" console.log(JSON.stringify(s.load().transactions.map(t => t.ledger)));");
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop() || '[]'), ['card'],
    '前置：搬家必須真的跑了（source:stmt→card）——沒跑的話後面「有沒有備份」問了也是白問');
  assert.ok(existsSync(bak),
    '不可逆的整批搬家動手前，那顆 pre-ledger-migration.bak 必須真的產出來（lib/store.js:164-172）');

  const d = new DatabaseSync(bak);
  try {
    const row = /** @type {any} */ (d.prepare("SELECT data FROM kv WHERE key='transactions'").get());
    assert.ok(row, '備份裡要有 transactions（VACUUM 出來的是完整快照，不是空殼）');
    const rows = JSON.parse(row.data);
    assert.equal(rows.length, 1, '備份要含那一列舊交易');
    assert.equal(rows[0].ledger, undefined,
      '備份必須是**搬家之前**的狀態（那列還沒有 ledger）——存到搬家後的狀態等於什麼都沒救到');
  } finally { d.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、資料庫損毀＝fail-closed（lib/store.js）
// ─────────────────────────────────────────────────────────────────────────────

test('開啟資料庫｜檔案損毀時**每一次**呼叫都要給「還原指引」（不是只擋第一次）', () => {
  // ⚠️ 註解明寫「fail closed：資料庫損毀時絕不回空資料庫」，而丟出去的訊息就是使用者
  //    唯一拿得到的還原指引（刪 -wal/-shm、把 .bak 改名回 store.db）。斷電／硬碟壞是真實情境。
  // ⚠️ 考題設計沿革（每一版都被實際繞法抓到一次「弄壞卻全綠」）：
  //    v1 是空包彈：關鍵判準**不是「有沒有丟錯」而是「有沒有還原指引」**。第一版用「SQLite 檔頭＋垃圾」，
  //       那種檔連 CREATE TABLE 都失敗 ⇒ 守衛拿掉後照樣從 open() 的 catch 丟出帶指引的訊息，突變全綠。
  //       這一版刻意造「**開得起來、schema 也在、只有中段資料頁壞掉**」的檔。實測兩邊（拿掉 lib/store.js:42-43
  //       的 `PRAGMA quick_check` 兩行當突變）：
  //         有守衛 → quick_check 在 open() 當場擋下，丟出 `quick_check: *** in database main *** / Tree 2 page 5:
  //                  btreeInitPage() returns error code 11…` 後面接還原指引。
  //         沒守衛 → **load() 根本不炸**：三行輸出全是 `NO_THROW`。更糟的是 migrateIfNeeded 看不到 settings 鍵，
  //                  把 data/seed.json 的示範資料**寫進那顆損毀的庫**（子行程印出「三層重構搬家完成：11 筆交易…」），
  //                  之後 save() 也照樣寫得進去——使用者拿到一本混了 demo 帳的損毀庫，畫面一切正常。
  //         ⇒ 本題轉紅的是**第一條 `doesNotMatch(NO_THROW)`**。
  //    ⚠️ r5 訂正（#410 Low）：原註解寫「沒守衛 → open() 順利返回，等到 load() 真的讀資料才炸，訊息是
  //       database disk image is malformed」是**沒實測、想當然爾**——malformed 只出現在啟動備份與
  //       pre-ledger 備份的 console.warn 裡（VACUUM 要掃全庫才踩到壞頁），load() 那幾條 kv 查詢沒踩到。
  //       題目照樣轉紅，但轉紅機制與註解說的不是同一回事，屬本 PR r3/r4 已修過兩次的同一種失真。
  //    v2 只呼叫**一次**入口（Codex #410 r4 抓到）：拿掉 lib/store.js catch 裡的 `db = null` 重置
  //       ⇒ 第一次照樣被擋，**第二次起** open() 看到 `db` 非空直接放行、load() 回**空資料庫**、
  //       接著 save() 還寫得進那顆損毀檔——正是 store.js 註解自己點名的「設計明文禁止的結局」，
  //       而全 1494 題無一轉紅（伺服器是長跑行程，真實情境就是同一個行程裡被呼叫很多次）。
  //    v3（現在）：同一個子行程裡**連呼兩輪 load()＋一次 save()**，三次都必須丟出帶還原指引的錯。
  const corrupt = join(tmpdir(), `finance-corrupt-${process.pid}.db`);
  TRASH.push(corrupt);
  {
    const d = new DatabaseSync(corrupt);
    d.exec('PRAGMA journal_mode = DELETE');     // 不留 -wal，免得干擾
    d.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const ins = d.prepare('INSERT INTO kv(key,data) VALUES(?,?)');
    for (let i = 0; i < 400; i++) ins.run(`k${i}`, JSON.stringify({ pad: 'x'.repeat(200) }));
    d.close();
    const buf = readFileSync(corrupt);
    buf.fill(0x5a, 4096 * 3, 4096 * 5);          // 破壞中段資料頁（第 1 頁的 schema 保持完好）
    writeFileSync(corrupt, buf);
  }
  // 三次呼叫各印一行（R1/R2＝連續兩輪 load()、SAVE＝之後再試寫一次）。逐行斷言，才抓得到
  // 「只有第一次被擋」——整包 out 一起比對的話，第一輪那句指引會替第二輪擋掉 assert.match。
  // 訊息用 JSON.stringify 包成單行：quick_check 的錯誤本身是**多行**（每個壞頁一行），
  // 直接印會讓「一次呼叫＝一行」的前提破功（實測第一版就這樣誤紅）。
  const script = "const s = await import('./lib/store.js');"
    + " for (const tag of ['R1', 'R2']) {"
    + "   try { s.load(); console.log(tag + ':NO_THROW'); }"
    + "   catch (e) { console.log(tag + ':THREW:' + JSON.stringify(e.message)); } }"
    + " try { s.save({ ...s.emptyDb() }); console.log('SAVE:NO_THROW'); }"
    + " catch (e) { console.log('SAVE:THREW:' + JSON.stringify(e.message)); }";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, STORE_FILE: corrupt },
  });
  const lines = out.split('\n');
  for (const [tag, what] of [
    ['R1', '第一次讀取'],
    ['R2', '同一個行程裡的第二次讀取（伺服器是長跑行程，這才是常態）'],
    ['SAVE', '被擋下之後的寫入'],
  ]) {
    const line = lines.find((l) => l.startsWith(tag + ':'));
    assert.ok(line, `前置：子行程必須印出 ${tag} 那一行（沒印＝腳本自己爆了，本題會空轉）`);
    assert.doesNotMatch(line, /NO_THROW/,
      `${what}也不可被放行——db 連線沒在失敗時重置的話，第二次起會拿到「空資料庫」還照樣接受寫入`);
    assert.match(line, /store\.db\.bak/,
      `${what}丟出的訊息必須點名 store.db.bak（使用者唯一拿得到的自救說明）——`
      + '只丟一句 database disk image is malformed 等於把人丟在原地');
    assert.match(line, /刪掉|改名/, `${what}要說清楚步驟（先刪 -wal/-shm、再把備份改名回去）`);
  }
});
