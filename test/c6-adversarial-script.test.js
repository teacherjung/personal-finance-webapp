// @ts-check
// 「**驗收工具自己會不會說謊**」的考題（2026-07-28）。
//
// 為什麼需要這個檔：`scripts/c6-adversarial.js` 只能對**真正部署好的 Supabase** 跑，
// 所以它從來沒有任何自動考題盯著。結果就是 PR #334 修掉四個假綠之後，
// Codex 收官審查又在同一支腳本裡找到**第五、第六個**（#3 主鍵撞車、#4 沒種機密）——
// 因為「修好了」這件事本身沒有任何東西守著。
//
// 誠實劃界（很重要，別把這份考題讀成比它更強的東西）：
//   ✅ 這裡是**原始碼形狀考題**——守的是「那幾個已知會生出假綠的寫法不准回來」。
//   ❌ 這裡**證明不了**腳本跑起來是對的。那要真的打到部署好的服務，屬於 C6 人工那一關。
//      腳本自己新增的「正向對照組」才是那一關的保險：它會在攻擊之前先證明
//      「同樣形狀的寫入，寫給自己是成功的」，所以後面那個失敗不可能是「請求根本沒送出去」。
//
// 這份考題的價值不在於發現新 bug，在於**讓已經付出過代價的教訓不會被下一個人抹掉**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts/c6-adversarial.js'), 'utf8');
const { KV_KEYS } = await import('../lib/store.js');

/** 抽出某一段 `await check('…', async () => { … });` 的內容。 @param {string} titleFragment */
function checkBlock(titleFragment) {
  const i = SRC.indexOf(titleFragment);
  assert.ok(i > 0, `找不到考題「${titleFragment}」——腳本被改過，請同步更新本考題`);
  const start = SRC.lastIndexOf('await check(', i);
  const end = SRC.indexOf('\n});', i);
  assert.ok(start >= 0 && end > start, `抓不到「${titleFragment}」的區塊`);
  return SRC.slice(start, end);
}

/**
 * 去掉 `//` 註解——**掃「程式碼寫成什麼樣」的考題一定要先做這一步**。
 * 不做的話，光是在註解裡解釋「舊版錯在 `key: 'transactions'`」就會讓考題自己紅
 *（我第一版就踩到）。而那些說明正是我們最想留著的東西，不能為了讓考題過而刪掉。
 * @param {string} src
 */
const codeOnly = (src) => src.split('\n')
  .map(l => (l.trimStart().startsWith('//') ? '' : l.replace(/\s+\/\/.*$/, '')))
  .join('\n');

// ============================================================================
// 一、RLS 寫入探針（Codex 收官審查 #3）
// ============================================================================

test('RLS 寫入探針不准插「已經存在的 kv 鍵」——主鍵撞車會讓任何政策都變綠', () => {
  const block = codeOnly(checkBlock('RLS 寫入：A 直連想插一列'));
  // 病根：`(user_id, key)` 是主鍵，而 B 的種子早就把 20 個 KV_KEYS 都建過一遍。
  // PostgreSQL 先跑 RLS 的 WITH CHECK、再跑唯一索引，所以
  //   牆在 → 42501 → 403；牆倒 → 23505 → 409
  // 兩者都 `>= 400`。舊版固定插 `key: 'transactions'`＝這一題在任何政策下都是綠的。
  // ⚠️ 判準是「整段裡不准出現任何 kv 鍵的字串常值」，**不是**只看 `key: 'transactions'` 那個形狀。
  //    第一版寫成後者，結果把 `const victimKey = 'transactions'` 放進去照樣全綠——
  //    我自己補的考題自己就是假考題（突變測試當場抓到）。**只認得一種寫法的考題等於沒有考題**。
  for (const k of KV_KEYS) {
    assert.ok(!new RegExp(`['"\`]${k}['"\`]`).test(block),
      `寫入探針的區塊裡出現了既有的 kv 鍵 '${k}'——一旦拿它當攻擊用的 key 就會撞主鍵，` +
      '讓「RLS 擋下（42501）」與「主鍵重複（23505）」都變成 4xx、分不出來');
  }
  // 而且攻擊用的 key 必須是**每次都不一樣的**（含時間戳），不可以是任何寫死的字串
  const victimAssign = block.match(/const victimKey\s*=\s*(.+?);/);
  assert.ok(victimAssign, '找不到 victimKey 的指派');
  assert.match(/** @type {any} */ (victimAssign)[1], /STAMP/,
    'victimKey 必須帶時間戳（每次都是新鍵），寫死的字串遲早會跟既有列撞在一起');
});

test('RLS 寫入探針要有正向對照組——不然「請求根本沒送成功」也會被當成隔離成功', () => {
  const block = checkBlock('RLS 寫入：A 直連想插一列');   // 這一題要看得到註解
  assert.match(block, /正向對照/, '缺正向對照組的說明');
  assert.match(block, /good\s*=\s*await insert\(\s*\{\s*user_id:\s*A\.user\.id/,
    '要先用同樣的形狀寫一列給**自己**，並斷言它成功');
  assert.match(block, /good\.status === 201/,
    '正向對照要斷言成功（201），否則探針自己壞掉時整題仍是綠的');
});

test('RLS 寫入探針要核對「被誰擋下來」，不能只看 4xx', () => {
  const block = codeOnly(checkBlock('RLS 寫入：A 直連想插一列'));
  assert.match(block, /42501|row-level security/,
    '只看 status >= 400 的話，任何「碰巧失敗」都會被當成隔離成功——要核對 RLS 的錯誤碼');
});

test('兩支 RLS 探針共用同一份 token 解析——弱的那一支會穩定假綠', () => {
  // 舊版：讀探針有 `?.[0]` 陣列型退路＋長度斷言；寫探針只有 `?.access_token`，
  // 解不出來時 access=null → Supabase 回 401 → `status >= 400` 被當成「攻擊被擋住」。
  assert.match(SRC, /function accessTokenOf\(/, '應該抽出共用的 accessTokenOf()');
  const uses = codeOnly(SRC).match(/accessTokenOf\(/g) || [];
  assert.ok(uses.length >= 3, `accessTokenOf 應該被兩支探針都用到（定義 1 ＋ 呼叫 2），實際 ${uses.length}`);
  // 而且不准有人又在別處手抄一份解析
  const handRolled = codeOnly(SRC).match(/auth-token\[\^=\]\*=/g) || [];
  assert.equal(handRolled.length, 1,
    'cookie 解析只准有一份（在 accessTokenOf 裡）——手抄第二份就是下一個假綠的種子');
});

// ============================================================================
// 二、機密投影探針（Codex 收官審查 #4）
// ============================================================================

test('機密投影探針必須先「種下真的機密」並確認伺服器收到了', () => {
  // 病根：舊版種子卡片只有 {name, type}，也從沒設過 flexToken／台新密碼，
  // 而四條斷言全是否定式（「回應裡找不到機密」）——於是
  // 「投影把機密剝掉了」與「這個帳號根本沒有機密可剝」長得一模一樣。
  // 把正式投影整層刪掉，這一題照樣全綠。
  const seed = codeOnly(checkBlock('前置：透過正式 API 種下三個機密'));
  assert.match(seed, /flexToken/, '要種 IB token');
  assert.match(seed, /taishinSecPdfPassword/, '要種台新證券密碼');
  assert.match(seed, /pdfPassword/, '要種卡片 PDF 密碼');
  // 關鍵：用 …Set 布林確認伺服器手上真的有這三個機密
  for (const flag of ['flexTokenSet', 'taishinSecPdfPasswordSet', 'pdfPasswordSet']) {
    assert.ok(new RegExp(`${flag}\\s*===\\s*true`).test(seed),
      `缺 ${flag} === true 的斷言——沒有它，下面那題就退化成「什麼都沒有，所以什麼都沒洩漏」`);
  }
});

test('機密投影探針要找「我們剛剛親手種下去的那幾串值」，不能只做形狀比對', () => {
  const block = codeOnly(checkBlock('機密不送瀏覽器（含寫入端回應）'));
  // 形狀比對（"pdfPassword": "…"）會被「欄位改名」繞過；值比對不會。
  assert.match(block, /SEC_FLEX/, '要直接找種下去的 IB token 值');
  assert.match(block, /SEC_TAISHIN/, '要直接找種下去的台新密碼值');
  assert.match(block, /SEC_CARDPW/, '要直接找種下去的卡片密碼值');
  assert.match(block, /text\.includes\(secret\)/, '值比對要真的做（掃回應全文）');
});

// ============================================================================
// 三、通則：這支腳本的「假綠」教訓不准被抹掉
// ============================================================================

test('腳本裡每一段「為什麼這樣寫」的假綠說明都還在（有人簡化時會先看到它們）', () => {
  const lessons = [
    ['打空氣', /打空氣/],                                   // 舊版拿 transactions 的 id 打十個集合
    ['劫持欄位要在白名單內', /pickWritable/],                // 舊版送 {name,note} 被剝光
    ['主鍵撞車', /23505/],                                   // Codex #3
    ['沒種機密就驗不到投影', /什麼都沒有|沒有機密可剝|可剝/],  // Codex #4
    ['正向對照組', /正向對照/],
  ];
  for (const [name, re] of lessons) {
    assert.ok(/** @type {RegExp} */ (re).test(SRC),
      `「${name}」那段說明不見了——這些是付出過代價才學到的，刪掉下一個人就會重蹈覆轍`);
  }
});

test('腳本仍然 fail-closed：缺環境變數或沒明確確認是合成資料就不准跑', () => {
  assert.match(SRC, /C6_CONFIRM_SYNTHETIC !== '1'/,
    '必須要求明確確認「目標只有合成資料」——這支會寫入資料，誤打真實部署會弄髒資料');
  assert.match(SRC, /process\.exit\(2\)/, '不合格就要直接結束，不可以繼續跑');
});
