// @ts-check
// 雲端防線的「牆要蓋在路上」考題（夜班稽核第四批A，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢在雲端這一片的共同結論：**牆蓋得對，但沒有考題證明它蓋在路上**。
// 四道牆各自都有「純函式層」的正確性，卻沒有一條考題釘住它真正的承重點：
//   - 身分牆之前唯一准許解析的 body 上限（32KB）→ 改成 50mb 全綠：未登入者可反覆丟大檔撐爆記憶體。
//   - CSRF Origin 白名單 → 改成「開頭符合就算」全綠：`noteasy.com.tw.evil.com` 會被當合法來源。
//   - 空白名單的語意 → 改成「沒設就一律放行」全綠：忘記設 SITE_ORIGIN 等於整道牆消失。
//   - 雲端資料層的未知鍵過濾 → 拿掉全綠：使用者能往 db 物件塞特殊名稱的鍵。
//   - 帳號末四碼的取法 → 改成整串數字尾 4 全綠：遮罩帳號會回一個「假末碼」。
//
// 本檔刻意只用**純函式與模組層級**的驗證（不起 HOSTED 伺服器）：跑得快、不需要假 Supabase，
// 而且每一題都釘在「承重的那個值／那個判準」上。
// ⚠️ 誠實劃界：另外三道需要**完整 HOSTED harness**（環境變數要在檔頭就設、假 Supabase＋租戶 context，
//    見既有 `test/hosted-store-pg.test.js`），排在第四批的後續一支、不在本檔：
//    ①`server.js` 的 `trust proxy`（關掉＝「每個 IP 各有額度」退化成全站共用一個額度）
//    ②`lib/store-pg.js` 的未知鍵過濾與 `?? emptyFor(k)`（使用者能往 db 塞特殊名稱的鍵）
//    ③`lib/repo.js` 的 CAS 只重試一次、以及「找不到的資料不可白推進版本」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { originAllowed } = await import('../lib/hosted.js');
const { AUTH_JSON_LIMIT, STANDARD_JSON_LIMIT, BACKUP_JSON_LIMIT } = await import('../lib/http-body.js');
const { projectAccount } = await import('../lib/secret-fields.js');
const { extractLastFour } = await import('../lib/statement.js');

// ─────────────────────────────────────────────────────────────────────────────
// 一、身分牆之前的 body 上限（lib/http-body.js）
// ─────────────────────────────────────────────────────────────────────────────

test('身分牆前的 body 上限｜登入入口必須遠小於一般 API，而且是 KB 級', () => {
  // ⚠️ 這個常數是「HOSTED 身分牆之前唯一准許解析的 body」——牆前的每一個位元組都是未驗證流量。
  //    改成 50mb 之後，未登入的人可以反覆丟大檔把伺服器記憶體撐爆（實測 10 個未登入請求 ×45MB → OOM）。
  //    考題不寫死「32kb」這個數字（數字可以合理調整），而是釘住**它的性質**：
  //    ①單位是 kb ②數值 ≤ 64 ③嚴格小於一般 API 入口 ④嚴格小於備份入口。
  const m = /^(\d+)(kb|mb)$/i.exec(AUTH_JSON_LIMIT);
  assert.ok(m, `AUTH_JSON_LIMIT 應該是「數字＋kb/mb」的字串，實際是 ${AUTH_JSON_LIMIT}`);
  assert.equal(m[2].toLowerCase(), 'kb',
    `登入入口必須是 KB 級（實際 ${AUTH_JSON_LIMIT}）——身分牆前的流量全部未驗證，MB 級等於開門讓人塞`);
  assert.ok(Number(m[1]) <= 64,
    `登入入口不該超過 64KB（實際 ${AUTH_JSON_LIMIT}）：body 裡只有信箱與密碼`);
  const toBytes = (/** @type {string} */ s) => {
    const mm = /^(\d+)(kb|mb)$/i.exec(s);
    return Number(mm?.[1] ?? 0) * (mm?.[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
  };
  assert.ok(toBytes(AUTH_JSON_LIMIT) < toBytes(STANDARD_JSON_LIMIT),
    '登入入口必須嚴格小於一般 API 入口');
  assert.ok(toBytes(AUTH_JSON_LIMIT) < toBytes(BACKUP_JSON_LIMIT),
    '登入入口必須嚴格小於備份入口（那個是刻意大的）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、CSRF Origin 白名單（lib/hosted.js）
// ─────────────────────────────────────────────────────────────────────────────

test('Origin 白名單｜必須是「完全相等」——開頭像但不是的網址一律拒絕', () => {
  // ⚠️ 改成 `some(a => origin.startsWith(a))` 之後，`https://noteasy.com.tw.evil.com`
  //    會被當成合法來源 ⇒ 第二道 CSRF 防線失效。這是典型的「前綴比對」漏洞。
  const prev = process.env.SITE_ORIGIN;
  process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
  try {
    assert.equal(originAllowed('https://noteasy.com.tw'), true, '白名單本身要放行');
    for (const bad of [
      'https://noteasy.com.tw.evil.com',      // 後綴接別的網域（前綴比對會放行）
      'https://noteasy.com.tw:8443',          // 加 port＝不同來源
      'https://noteasy.com.tw/',              // 末尾斜線＝不同字串
      'http://noteasy.com.tw',                // 換 scheme
      'https://NOTEASY.com.tw',               // 大小寫變化（Origin 比對是逐字的）
      'https://evil.com',
    ]) {
      assert.equal(originAllowed(bad), false,
        `「${bad}」不在白名單裡，必須拒絕——前綴／大小寫寬鬆比對都會讓 CSRF 防線失效`);
    }
  } finally {
    if (prev === undefined) delete process.env.SITE_ORIGIN; else process.env.SITE_ORIGIN = prev;
  }
});

test('Origin 白名單｜白名單是空的時候一律拒絕（忘記設 SITE_ORIGIN 不可等於整道牆消失）', () => {
  // ⚠️ 改成 `allow.length === 0 || allow.includes(origin)` 之後，忘記設環境變數
  //    ＝任何 Origin 都放行，而那正是最容易發生的部署失誤。
  const prev = process.env.SITE_ORIGIN;
  for (const empty of ['', '   ', ',,']) {
    process.env.SITE_ORIGIN = empty;
    try {
      assert.equal(originAllowed('https://evil.com'), false,
        `SITE_ORIGIN=${JSON.stringify(empty)}（等於沒設）時，有帶 Origin 的請求必須拒絕`
        + '——「沒設就放行」會讓部署失誤直接變成安全洞');
      assert.equal(originAllowed(undefined), true,
        '沒有帶 Origin 的請求照舊放行（curl／同源 GET；SameSite=Lax 已擋跨站帶 cookie）');
    } finally {
      if (prev === undefined) delete process.env.SITE_ORIGIN; else process.env.SITE_ORIGIN = prev;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、機密投影：末四碼不可猜錯（lib/secret-fields.js／lib/statement.js）
// ─────────────────────────────────────────────────────────────────────────────

test('帳號投影｜遮罩帳號要取「星號後的可見末碼」，不可拿整串數字的尾四碼', () => {
  // ⚠️ 註解寫明：「取星號後的可見末碼，不是整串數字尾 4（那會變 5162 之類的假末碼）」。
  //    猜錯末碼的後果＝銀行對帳單匯入時比對到錯的帳戶，或把帳單掛到別張卡。
  assert.equal(projectAccount({ id: 'a1', accountNo: '900100****3301' }).accountNoLast4, '3301',
    '遮罩帳號要取星號後那一段（不可把前綴的數字也算進來）');
  assert.equal(projectAccount({ id: 'a2', accountNo: '1234****56' }).accountNoLast4, '56',
    '星號後只有兩碼時就只回兩碼——回 3456 是把前綴的數字拿來湊，那是一個不存在的末碼');
  assert.equal(projectAccount({ id: 'a3', accountNo: '12345678901234' }).accountNoLast4, '1234',
    '完整帳號（無星號）才取純數字尾四碼');
  const p = projectAccount({ id: 'a4', accountNo: '900100****3301' });
  assert.equal(/** @type {any} */ (p).accountNo, undefined, '完整帳號絕不可送到瀏覽器');
  assert.equal(p.accountNoSet, true, '要用布林告訴前端「有設過」');
});

test('帳單末四碼｜遮罩後接超過四碼時不可回「前」四碼（那是一個猜出來的假末碼）', () => {
  // ⚠️ 遮罩樣式結尾的 `\b` 是承重的。實測（先跑再寫，不憑猜測）：
  //      有 `\b`：'****12345' → '2345'（退到第三條規則「該行最後一組四碼」）
  //      無 `\b`：'****12345' → '1234'  ← 把遮罩後的**前**四碼當末碼＝猜出來的假末碼
  //    假末碼的後果＝帳單被掛到別張卡（末四碼是自動歸卡的判準）。
  //    ⚠️ 我第一版照夜班報告的建議寫成「應該回 null」，實測發現不是——契約是「回最後四碼」。
  //       報告的建議只是假設，考題要照**真實行為**寫（不然會把一個不存在的契約釘進去）。
  assert.equal(extractLastFour('卡號 ****12345'), '2345',
    '遮罩後接五碼時要回最後四碼 2345；回 1234（前四碼）＝憑空猜一個不存在的末碼');
  assert.equal(extractLastFour('卡號 **** 567890'), '7890',
    '遮罩後接六碼同理：回最後四碼，不可回 5678');
  assert.equal(extractLastFour('XXXX-1234567'), null,
    '沒有「卡號」字樣、遮罩後又接超過四碼＝抓不到，回 null 讓上層請使用者選卡（不可猜 1234）');
  // 反面：正常的四碼要抓得到（避免整條正則被關掉也綠）。
  assert.equal(extractLastFour('卡號 ****3301'), '3301', '正常的四碼要照抓');
  assert.equal(extractLastFour('末四碼 **** 5678'), '5678', '「末四碼」明寫的優先規則也要照走');
});
