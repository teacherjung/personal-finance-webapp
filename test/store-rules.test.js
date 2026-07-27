// 店名規則自助化考題（第三帖，使用者定 2026-07-19）。鎖住四件事：
//   ①使用者填的是**純文字**——任何正規表示式符號都只當字面字元（沒有程式背景也不會誤傷全庫）
//   ②使用者規則**優先於內建規則**（自助的意義＝蓋得過內建判斷）
//   ③**鑰匙的判定基礎凍結在內建規則**：分類規則不開放編輯（storeKeyOf 靠 categorize 判油錢，
//     可編輯的話改一條分類就讓鑰匙漂移、既有學習全部對不上）——這是本帖的核心不變量
//   ④預覽（dryRun）**不留副作用**：候選規則跑完一定還原，含中途拋錯
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-rules-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { setUserRules, sanitizeStoreRules, compileStoreRules, escapeRe, isProtoKey } = await import('../lib/store-rules.js');
const { cleanStore, storeKeyOf, applyDisplayLabels, categorize, normalizeStoreDisplay } = await import('../lib/statement.js');
const { previewStoreRules, saveStoreRules, getStoreRules, listOrphanLearned } = await import('../lib/services/store-rules.js');

after(() => {
  setUserRules(null);
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

beforeEach(() => setUserRules(null));   // 每題從「只有內建規則」開始

// ---------- ① 純文字，不是正規表示式 ----------

test('規則是純文字：正規表示式符號只當字面字元（.* 不會吃掉整個字串）', () => {
  setUserRules({ canon: [{ match: '.*', to: '被吃掉了', mode: 'contains' }] });
  assert.notEqual(cleanStore('八方雲集林口三井店'), '被吃掉了',
    '「.*」必須被當成兩個字面字元，不可當萬用字元把每一家店都比中');
  assert.equal(cleanStore('我家.*小吃'), '被吃掉了', '真的含「.*」這兩個字的店名才比中');
});

test('escapeRe：跳脫所有樣式符號', () => {
  assert.equal(escapeRe('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'), 'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
});

test('壞規則直接丟棄：空的 match／空的 to／超長字串進不了資料', () => {
  const bad = [];
  const r = sanitizeStoreRules({
    canon: [{ match: '', to: 'X' }, { match: 'A', to: '' }, { match: 'B', to: 'C' }],
    rename: [{ match: 'x'.repeat(200), to: 'Y' }],
    chains: ['', '好店'],
    parkExempt: [123]
  }, bad);
  assert.equal(r.canon.length, 1, '只留下 match/to 都非空的那條');
  assert.equal(r.canon[0].to, 'C');
  assert.equal(r.rename.length, 0, '超過長度上限的丟棄');
  assert.deepEqual(r.chains, ['好店']);
  assert.equal(r.parkExempt.length, 0, '非字串丟棄');
  assert.ok(bad.length >= 4, '壞條目要回報給呼叫端（前端才講得出哪條沒收）');
});

test('to 不可為空：BRAND_RENAME 是全域取代，空取代等於把店名的字刪掉', () => {
  const r = sanitizeStoreRules({ rename: [{ match: '便利商店', to: '' }] });
  assert.equal(r.rename.length, 0);
});

test('比對方式：contains／startsWith／exact 各自的邊界', () => {
  const c = compileStoreRules({ canon: [
    { match: '小北', to: 'A', mode: 'startsWith' },
    { match: '小南', to: 'B', mode: 'exact' },
    { match: '小東', to: 'C', mode: 'contains' }
  ] });
  const hit = (/** @type {string} */ s) => { const f = c.canon.find(([, re]) => re.test(s)); return f ? f[0] : ''; };
  assert.equal(hit('小北百貨林口店'), 'A');
  assert.equal(hit('林口小北百貨'), '', 'startsWith 不該比中出現在中間的');
  assert.equal(hit('小南'), 'B');
  assert.equal(hit('小南門'), '', 'exact 要完全等於');
  assert.equal(hit('林口小東店'), 'C');
});

// ---------- ② 使用者規則優先於內建 ----------

test('canon：使用者規則蓋得過內建規則（內建把星巴克統一，使用者要拆出來也行）', () => {
  assert.equal(cleanStore('星巴克MITSUI門市'), '星巴克', '內建行為');
  setUserRules({ canon: [{ match: 'MITSUI', to: '星巴克三井店', mode: 'contains' }] });
  assert.equal(cleanStore('星巴克MITSUI門市'), '星巴克三井店', '使用者規則要排在內建前面');
});

test('brand：使用者加一條就能把「銀行截斷的兩種寫法」併回同一把鑰匙（體檢 D1 的自助解）', () => {
  assert.notEqual(storeKeyOf('禾豐日式料理'), storeKeyOf('禾豐日式料'), '沒規則時是兩把鑰匙');
  setUserRules({ brand: [{ match: '禾豐日式料', to: '禾豐日式料理' }] });
  assert.equal(storeKeyOf('禾豐日式料'), '禾豐日式料理', '截斷版併回完整品牌名');
  assert.equal(storeKeyOf('禾豐日式料理'), '禾豐日式料理', '完整版不變');
  assert.equal(cleanStore('禾豐日式料理-林口店'), '禾豐日式料理（林口店）', '顯示名仍保留分店');
});

test('brand：反向填（長寫法→短品牌名）也要對，分店不可被吃掉（自審 r3）', () => {
  // 使用者一樣可能反過來填：match＝帳單上的長寫法、to＝想要的短品牌名。
  // 編譯時若沒把兩個寫法「長的排前面」，JS 的 | 會先中短的，
  // 「…印度咖哩風味-林口店」就會在短品牌處切開、把「印度咖哩風味」當成分店、真分店反而不見。
  setUserRules({ brand: [{ match: 'Zaika札伊卡印度咖哩風味', to: 'Zaika札伊卡' }] });
  assert.equal(cleanStore('Zaika札伊卡印度咖哩風味'), 'Zaika札伊卡', '長寫法收斂成短品牌名，不可生出假分店');
  assert.equal(cleanStore('Zaika札伊卡印度咖哩風味-林口店'), 'Zaika札伊卡（林口店）', '真正的分店要留住');
  assert.equal(cleanStore('Zaika札伊卡-林口店'), 'Zaika札伊卡（林口店）', '短寫法也對');
  assert.equal(storeKeyOf('Zaika札伊卡印度咖哩風味'), storeKeyOf('Zaika札伊卡-林口店'), '兩種寫法同一把鑰匙');
});

test('rename：取代字串裡的 $ 不可被當成樣式（自審 r3）', () => {
  // `to` 進的是 String.replace 的取代字串，$&／$`／$'／$$ 在那裡是有意義的樣式。
  setUserRules({ rename: [{ match: '小店', to: "X$'Y" }] });
  assert.equal(cleanStore('小店東西'), "X$'Y東西", "使用者打的 $' 就是兩個字面字元，不可複製半個店名進去");
  setUserRules({ rename: [{ match: '小店', to: 'A$&B' }] });
  assert.equal(cleanStore('小店'), 'A$&B');
});

test('原型鍵擋在門外：不只 __proto__，Object.prototype 全部的名字都不行（Codex r3#4）', () => {
  // 只擋三個名字不夠：toString／hasOwnProperty／valueOf… 一樣會讓 learnedCategories[key]=…
  // 去碰原型而不是建立鍵，那條學習就人間蒸發（Codex 實測 toString 可過驗證、學習沒存下來）。
  const r = sanitizeStoreRules({
    canon: [{ match: 'X', to: '__proto__' }, { match: 'Y', to: 'toString' },
      { match: 'W', to: 'hasOwnProperty' }, { match: 'Z', to: '正常店名' }],
    chains: ['valueOf', '好店']
  });
  assert.deepEqual(r.canon.map(e => e.to), ['正常店名'], '繼承屬性名一律拒收');
  assert.deepEqual(r.chains, ['好店']);
  // 真的用得出來才算數：拿 toString 當店名時，學習表要能正常存取
  assert.ok(isProtoKey('toString') && isProtoKey('__proto__') && !isProtoKey('星巴克'));
});

test('rename 必須冪等：整理跑第二次名字不可以繼續膨脹（Codex r3#5）', () => {
  // 整理會重複執行（規則指紋變動、開 app 自動跑），ABC→台灣ABC 跑兩次會變台灣台灣ABC。
  const r = sanitizeStoreRules({ rename: [{ match: 'ABC', to: '台灣ABC' }, { match: '早午餐', to: '早餐' }] });
  assert.equal(r.rename.length, 1, '「改成的名字裡還含有要被取代的字」的規則直接拒收');
  assert.equal(r.rename[0].to, '早餐', '正常的改寫照收');

  // 收下來的規則，連續正規化兩次結果必須相同
  setUserRules({ rename: [{ match: '早午餐', to: '早餐' }] });
  const once = cleanStore('麥味登早午餐-林口店');
  assert.equal(normalizeStoreDisplay(once), once, '再整理一次結果不變（冪等）');
});

test('儲存這條路要嚴格：形狀不對整包拒絕，不可默默把規則清空（Codex r3#6）', async () => {
  store.save({ ...store.emptyDb() });
  await saveStoreRules({ chains: ['既有規則'] });
  assert.deepEqual((await getStoreRules()).rules.chains, ['既有規則'], '前置條件：先有一條規則');

  // 型別打錯 → 舊版會當成空物件、回報成功、把全部規則清空
  await assert.rejects(() => saveStoreRules('oops'), /規則沒有儲存/);
  assert.deepEqual((await getStoreRules()).rules.chains, ['既有規則'], '被拒絕時原有規則必須原封不動');

  await assert.rejects(() => saveStoreRules({ chains: 'not-an-array' }), /清單/);
  await assert.rejects(() => saveStoreRules({ canon: [{ match: 'A', to: 'B', mode: 'containz' }] }), /比對方式/,
    '拼錯的比對方式要明講，不可默默降成最寬的 contains');
  await assert.rejects(() => saveStoreRules({ rename: [{ match: 'ABC', to: '台灣ABC' }] }), /愈來愈長/);
  assert.deepEqual((await getStoreRules()).rules.chains, ['既有規則'], '以上每一次都不可動到既有規則');
});

test('沒收的條目要報對位置、超過上限要出聲（自審 r3：使用者才知道哪條沒生效）', () => {
  const bad = [];
  sanitizeStoreRules({ chains: ['ok1', '', 'ok2', '', 'ok3'] }, bad);
  assert.deepEqual(bad, ['storeRules.chains[1]', 'storeRules.chains[3]'],
    '報的是「輸入的第幾條」，不是已收下的筆數（混著好壞時會報錯位置）');

  const bad2 = [];
  sanitizeStoreRules({ chains: Array.from({ length: 250 }, (_, i) => `店${i}`) }, bad2);
  assert.ok(bad2.some(b => b.includes('上限')), '默默吃掉 50 條規則的話，使用者只會覺得「怎麼有些沒生效」');
});

test('chains：使用者把自家常去的連鎖加進白名單 → 沒有分隔符也切得出分店', () => {
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙林口店', '不在白名單時整串當店名');
  setUserRules({ chains: ['鮮芋仙'] });
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙（林口店）');
  assert.equal(storeKeyOf('鮮芋仙林口店'), '鮮芋仙', '分店進顯示名、不進鑰匙');
});

test('parkExempt：使用者自己豁免「不該被包成停車費（…）」的店', () => {
  assert.equal(applyDisplayLabels('中租好停車', { subcategory: '停車費' }), '停車費（中租好停車）');
  setUserRules({ parkExempt: ['中租好停車'] });
  assert.equal(applyDisplayLabels('中租好停車', { subcategory: '停車費' }), '中租好停車');
});

test('rename：顯示名改寫保留分店', () => {
  setUserRules({ rename: [{ match: '統一超商', to: '7-11' }] });
  assert.equal(cleanStore('統一超商-百福'), '7-11（百福）');
});

// ---------- ③ 核心不變量：鑰匙的判定基礎凍結在內建規則 ----------

test('不變量｜分類規則不開放編輯：使用者規則動不了 categorize（改分類＝鑰匙漂移、學習全毀）', () => {
  const before = categorize('中油自助加油站');
  setUserRules({
    canon: [{ match: '中油', to: '中油', mode: 'contains' }],
    rename: [{ match: '加油站', to: '停車場' }],
    brand: [{ match: '中油', to: '中油直營' }]
  });
  assert.deepEqual(categorize('中油自助加油站'), before,
    '分類只由內建 CATEGORY_RULES 決定——storeRules 沒有任何一種能改它');
  assert.equal(before[1], '油錢');
});

test('不變量｜加油站聚合不受使用者規則影響（鑰匙的判定基礎凍結）', () => {
  assert.equal(storeKeyOf('台亞林口第二交流道南站'), '加油站', '內建行為：所有加油站合併');
  setUserRules({
    canon: [{ match: '台亞', to: '台亞好棒棒', mode: 'contains' }],
    brand: [{ match: '台亞', to: '台亞石油' }],
    rename: [{ match: '加油', to: '打氣' }]
  });
  assert.equal(storeKeyOf('台亞林口第二交流道南站'), '加油站',
    '油錢→加油站 這條是用「內建 categorize(原文)」判的，使用者怎麼改店名規則都動不到鑰匙');
});

// ---------- ④ 預覽不留副作用 ----------

test('預覽（dryRun）不留副作用：跑完還原、不寫檔', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  const r = await previewStoreRules({ chains: ['鮮芋仙'] });
  assert.ok(r.changed >= 1, '預覽要看得到會被改到的筆數');
  assert.equal(r.changes[0].after, '鮮芋仙（林口店）', '而且看得到會變成什麼樣子');
  assert.ok(r.keyChanged >= 1, '鑰匙的變動也要說（最危險、預覽只列顯示名看不到）');
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙林口店', '跑完候選規則必須失效（否則整個行程都被汙染）');
  assert.equal(store.load().transactions?.[0].note, '鮮芋仙林口店', '預覽不可寫檔');
});

test('連續預覽互不汙染：前一次的候選規則不可以滲進下一次', async () => {
  // ⚠️ 自審 r3 誠實註記：原本這裡是一題「預覽中途拋錯也要還原」，但它是**空的**——
  // 那個會拋錯的物件在 `sanitizeStoreRules` 階段就炸了，當下覆蓋層還沒設，`finally` 從沒被走過。
  // 想補一題真的「設好覆蓋層之後才拋錯」，得先讓 normalizeBranches 中途爆掉；試過髒交易
  //（數字 storeKey／壞 note／壞學習值）都被櫃檯驗證或 `String(...)` 擋掉了，用公開 API 造不出來。
  // 與其留一題假考題，改測「同一件事的可觀察後果」：覆蓋層有沒有確實在每次預覽後歸零。
  //（`try/finally` 本身仍在 `withRules`，那是拋錯情境的保險。）
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  await previewStoreRules({ chains: ['鮮芋仙'] });
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙林口店', '第一次預覽後候選規則必須失效');
  const second = await previewStoreRules({ chains: [] });
  assert.equal(second.changed, 0, '第二次預覽（空規則）不可看到上一次規則的效果');
});

test('預覽的候選規則蓋得過「規則入櫃檯」（getDb 會重設規則，覆蓋層才蓋得住）', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  // normalizeBranches 內部會 getDb() → 若候選規則只放在「櫃檯值」那一層，這裡就被洗回空規則、預覽恆為 0
  assert.ok((await previewStoreRules({ chains: ['鮮芋仙'] })).changed >= 1);
});

// ---------- 存檔：寫進 settings、立刻套用到既有資料 ----------

test('存規則＝存完就生效（不必再記得按一次「整理店名格式」）', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  const r = await saveStoreRules({ chains: ['鮮芋仙'] });
  assert.equal(r.ok, true);
  assert.ok(r.changed >= 1, '存檔時要回報動到幾筆');
  const db = store.load();
  assert.equal(db.transactions?.[0].note, '鮮芋仙（林口店）', '既有資料當場被整理');
  assert.equal(db.transactions?.[0].storeKey, '鮮芋仙', '鑰匙也跟著對齊');
  assert.deepEqual((await getStoreRules()).rules.chains, ['鮮芋仙'], '規則存進 settings');
});

test('後悔了可以還原：刪掉規則 → 顯示名、鑰匙、學習表 key 全部回到原樣（自助化的安全網）', async () => {
  const seed = () => store.save({ ...store.emptyDb(),
    transactions: [
      { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
        note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' },
      { id: 't2', date: '2026-07-02', type: 'expense', category: '飲食', amount: 120,
        note: '鮮芋仙新店店', storeKey: '鮮芋仙新店店', source: 'stmt', stmtRef: 'c1|2026-07-02|120|鮮芋仙新店店' }],
    learnedCategories: { '鮮芋仙林口店': { category: '飲食', subcategory: '零食' } } });
  const snap = () => { const d = store.load();
    return { notes: (d.transactions || []).map(t => t.note),
      keys: (d.transactions || []).map(t => t.storeKey),
      learned: Object.keys(d.learnedCategories || {}) }; };

  seed();
  const before = snap();
  await saveStoreRules({ chains: ['鮮芋仙'] });
  const during = snap();
  assert.deepEqual(during.keys, ['鮮芋仙', '鮮芋仙'], '規則生效：兩家分店合併成一把鑰匙');
  assert.deepEqual(during.learned, ['鮮芋仙'], '學習表 key 跟著搬到品牌層');

  await saveStoreRules({ chains: [] });   // 使用者把規則刪掉
  assert.deepEqual(snap(), before,
    '刪掉規則要能完全回到原樣——不然使用者不敢試，自助化就沒人敢用');
});

test('唯一不可逆的效果：併鑰匙會蓋掉教過的分類——而且預覽一定要先講出來（自審 r3，高）', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [
      { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
        note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' },
      { id: 't2', date: '2026-07-02', type: 'expense', category: '飲食', amount: 120,
        note: '鮮芋仙新店店', storeKey: '鮮芋仙新店店', source: 'stmt', stmtRef: 'c1|2026-07-02|120|鮮芋仙新店店' }],
    // 兩家分店被手動教成**不同**分類 → 併成一把鑰匙時只留得下一個
    learnedCategories: {
      '鮮芋仙林口店': { category: '飲食', subcategory: '零食' },
      '鮮芋仙新店店': { category: '娛樂', subcategory: '看電影' }
    } });

  const pre = await previewStoreRules({ chains: ['鮮芋仙'] });
  assert.ok(pre.learnedConflicts.length >= 1,
    '預覽（＝套用前唯一的安全帶）必須看得到這件事；以前整段計算包在 !dryRun 裡，預覽對它完全盲目');
  const c = pre.learnedConflicts.find(x => x.field === 'category');
  assert.ok(c, '要指出是哪個欄位衝突');
  assert.equal(c.key, '鮮芋仙', '要指出合併到哪一把鑰匙');
  assert.ok(c.kept && c.dropped && c.kept !== c.dropped, '要講清楚留下哪個、捨棄哪個');

  // 而且預覽真的沒有寫檔（衝突是「將會發生」，不是「已經發生」）
  assert.equal(Object.keys(store.load().learnedCategories || {}).length, 2, '預覽不可動到學習表');

  // 實際套用後確認：確實只剩一個，且刪掉規則也救不回被捨棄的那個（這就是要事先講的原因）
  await saveStoreRules({ chains: ['鮮芋仙'] });
  assert.deepEqual(Object.keys(store.load().learnedCategories || {}), ['鮮芋仙']);
  await saveStoreRules({ chains: [] });
  assert.deepEqual(Object.keys(store.load().learnedCategories || {}), ['鮮芋仙林口店'],
    '被捨棄的「鮮芋仙新店店」救不回來——所以預覽的警告是必要的，不是可有可無的提示');
});

test('預覽要講出「你自己取的店名會被改掉」——即使筆數全是 0（Codex r3#2，高）', async () => {
  // 孤兒學習（交易已刪、學習刻意留給未來匯入）的自訂名被新規則改到時：
  // 顯示名 0 筆、鑰匙 0 筆、分類無衝突 → 舊版預覽會回報「不會改動任何既有記錄」，
  // 使用者放心按下去，取好的名字就沒了、而且刪掉規則也還原不回來。
  store.save({ ...store.emptyDb(),
    transactions: [],
    learnedCategories: { 'OLD SHOP': { name: 'OLD SHOP' } } });

  const pre = await previewStoreRules({ rename: [{ match: 'OLD', to: 'NEW' }] });
  assert.equal(pre.changed, 0, '前置條件：沒有任何交易會被改到');
  assert.equal(pre.keyChanged, 0, '前置條件：也沒有鑰匙變動');
  assert.equal(pre.learnedConflicts.length, 0, '前置條件：沒有分類衝突');
  assert.equal(pre.learnedNameChanges.length, 1, '但「自訂名會被改掉」這件事一定要講出來');
  assert.equal(pre.learnedNameChanges[0].before, 'OLD SHOP');
  assert.equal(pre.learnedNameChanges[0].after, 'NEW SHOP');

  // 而且確實是不可逆的（這就是非講不可的原因）
  await saveStoreRules({ rename: [{ match: 'OLD', to: 'NEW' }] });
  assert.equal(store.load().learnedCategories?.['OLD SHOP']?.name, 'NEW SHOP');
  await saveStoreRules({ rename: [] });
  assert.equal(store.load().learnedCategories?.['OLD SHOP']?.name, 'NEW SHOP',
    '刪掉規則救不回原本的名字——所以預覽非講不可');
});

test('空字串子分類是合法值，不是「沒有值」：與非空值衝突時要警告（Codex r3#3）', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [
      { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
        note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' },
      { id: 't2', date: '2026-07-02', type: 'expense', category: '飲食', amount: 120,
        note: '鮮芋仙新店店', storeKey: '鮮芋仙新店店', source: 'stmt', stmtRef: 'c1|2026-07-02|120|鮮芋仙新店店' }],
    learnedCategories: {
      '鮮芋仙林口店': { category: '飲食', subcategory: '' },       // 刻意不分子類（合法）
      '鮮芋仙新店店': { category: '飲食', subcategory: '餐廳' }
    } });
  const pre = await previewStoreRules({ chains: ['鮮芋仙'] });
  const c = pre.learnedConflicts.find(x => x.field === 'subcategory');
  assert.ok(c, '一邊空字串、一邊「餐廳」，合併後只留得下一個——用 truthy 判斷會把空字串當成「沒有值」而漏報');
  assert.equal(c.dropped, '餐廳', '被捨棄的是有資訊的那個，更該講出來');
});

test('存規則：壞條目改成「整包拒絕」而非默默丟掉（Codex r3#6 之後的新口徑）', async () => {
  store.save(store.emptyDb());
  // 舊口徑是「壞的丟掉、好的照存」——問題是使用者看不出哪條沒收，而且同一套寬鬆邏輯
  // 讓 saveStoreRules('oops') 變成「清空全部規則還回報成功」。儲存這條路改成嚴格：
  // 有問題就整包退回並說明是第幾條、為什麼，使用者改好再存。
  await assert.rejects(() => saveStoreRules({ chains: ['好店', ''], canon: [{ match: 'A', to: '' }] }),
    /規則沒有儲存/, '有空欄位就整包退回');
  assert.deepEqual((await getStoreRules()).rules.chains, [], '被拒絕時什麼都不該寫進去');

  // 全部合法才存得進去
  const r = await saveStoreRules({ chains: ['好店'], canon: [{ match: 'A', to: 'B' }] });
  assert.deepEqual(r.rules.chains, ['好店']);
  assert.equal(r.rules.canon.length, 1);
});

test('存規則：沒帶內容回 400（避免手滑把規則清空）', async () => {
  await assert.rejects(() => saveStoreRules(undefined), /缺少規則內容/);
});

test('規則進得了櫃檯、也活得過備份還原（手做的規則不可因還原而消失）', async () => {
  const { sanitizeSettings } = await import('../lib/schema.js');
  const kept = sanitizeSettings({ storeRules: { chains: ['好店'], canon: [{ match: 'A', to: 'B', mode: 'exact' }] } });
  assert.deepEqual(kept.storeRules.chains, ['好店'], '匯入白名單要保留 storeRules');
  assert.equal(kept.storeRules.canon[0].mode, 'exact');
  // 櫃檯（save）＝throw 模式：壞規則走到這裡代表「寫入端漏了驗證」（服務層已先 sanitize），
  // 當場炸出來讓考試抓到——與自訂分類三欄同口徑，不默默剝掉。
  const db = { ...store.emptyDb() };
  db.settings = { ...db.settings, storeRules: { chains: ['好店', 123], canon: 'oops' } };
  assert.throws(() => store.save(db), /storeRules/);
  // 乾淨的規則則順利往返
  const ok = { ...store.emptyDb() };
  ok.settings = { ...ok.settings, storeRules: { chains: ['好店'], canon: [], brand: [], rename: [], parkExempt: [] } };
  store.save(ok);
  assert.deepEqual(store.load().settings.storeRules?.chains, ['好店']);
});

// ---------- 孤兒學習清單 ----------

test('孤兒學習清單：列出「對不上任何現存交易」的學習條目（看不見的隱形規則）', async () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '好店', storeKey: '好店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|好店-林口' }],
    learnedCategories: {
      '好店': { category: '飲食' },              // 現存交易的 storeKey → 不是孤兒
      '好店-林口': { name: '好店（林口）' },        // 現存交易的帳單原文 → 不是孤兒
      '早就刪掉的店': { category: '娛樂' }          // 對不上任何交易 → 孤兒
    } });
  const r = await listOrphanLearned();
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map(i => i.key), ['早就刪掉的店']);
  assert.equal(r.items[0].category, '娛樂', '要帶出內容，使用者才判斷得了要不要刪');
});

// ---------- Codex 第四輪的三條（規則驗證收尾）----------

test('r4#6｜非法 mode 整條剝除，不默默降成最寬的 contains', () => {
  const bad = [];
  const r = sanitizeStoreRules({ canon: [
    { match: 'A', to: 'X', mode: 'containz' },   // 拼錯 → 整條丟掉（原本會變 contains，命中一大票）
    { match: 'B', to: 'Y' },                     // mode 缺席 → 用預設 contains（合法）
    { match: 'C', to: 'Z', mode: 'exact' }
  ] }, bad);
  assert.deepEqual(r.canon.map(e => e.match), ['B', 'C'], '拼錯 mode 的那條要被丟掉');
  assert.equal(r.canon[0].mode, 'contains', 'mode 缺席才用預設');
  assert.ok(bad.some(b => b.includes('canon')), '要回報哪條被丟');
});

test('r4#5｜預覽回傳「真實總數」，不是被截到 50 的陣列長度', async () => {
  const { previewStoreRules } = await import('../lib/services/store-rules.js');
  // 52 個原文各學過不同分類、storeKey 也各異，一條 chains 規則把它們併成同一把 → 產生大量衝突
  /** @type {any[]} */
  const txs = [];
  /** @type {Record<string, any>} */
  const learned = {};
  for (let i = 0; i < 52; i++) {
    const branch = String.fromCharCode(0x4e00 + i) + '店';   // 純中文分店（chains 才切得動）
    const orig = `合作社${branch}`;
    txs.push({ id: 't' + i, date: '2026-07-01', type: 'expense', category: '飲食', amount: 1,
      note: orig, storeKey: `合作社${branch}`, source: 'stmt', stmtRef: `c1|2026-07-01|1|${orig}` });
    learned[`合作社${branch}`] = { category: i % 2 ? '飲食' : '娛樂', subcategory: i % 2 ? '零食' : '電影' };
  }
  store.save({ ...store.emptyDb(), transactions: txs, learnedCategories: learned });
  const r = await previewStoreRules({ chains: ['合作社'] });
  assert.ok(r.learnedConflicts.length <= 50, '明細有截斷（控制回應大小）');
  assert.ok(r.learnedConflictTotal > r.learnedConflicts.length, '但總數要回報真實值，不是被截的長度');
});

test('r4#4｜跨規則串接（甲→乙、丙→甲）不冪等 → 儲存時擋下', async () => {
  const { saveStoreRules, checkRulesIdempotent } = await import('../lib/services/store-rules.js');
  store.save(store.emptyDb());
  // 兩條互不包含、各自都過自我冪等，但串起來會讓「丙」每整理一次再變一次（丙→甲→乙）
  assert.ok((await checkRulesIdempotent(sanitizeStoreRules({ rename: [{ match: '甲', to: '乙' }, { match: '丙', to: '甲' }] }))).length,
    '冪等檢查要抓到串接');
  await assert.rejects(() => saveStoreRules({ rename: [{ match: '甲', to: '乙' }, { match: '丙', to: '甲' }] }), /愈整理愈亂/);
  // 一步到位的正常規則不誤擋
  assert.equal((await checkRulesIdempotent(sanitizeStoreRules({ chains: ['鮮芋仙'], rename: [{ match: '全家便利商店', to: '全家' }] }))).length, 0);
});

test('r5#6｜rename 產物撞內建標準名（STORE_CANON）→ 擋下：完整管線會把它清成另一個品牌', async () => {
  const { checkRulesIdempotent, saveStoreRules } = await import('../lib/services/store-rules.js');
  store.save(store.emptyDb());
  // 「STARBUCKS SHOP」過得了 normalizeStoreDisplay（就地整理的固定點），
  // 但 cleanStore 開頭的 STORE_CANON 會把 STARBUCKS 開頭清成「星巴克」——
  // 未來哪張帳單直接印這串字＝同一家店兩種顯示名、兩把鑰匙（Codex r5#6 實測抓到）
  const errs = await checkRulesIdempotent(sanitizeStoreRules({ rename: [{ match: '怪店X', to: 'STARBUCKS SHOP' }] }));
  assert.ok(errs.length, '要抓到品牌口徑漂移');
  assert.ok(errs[0].includes('星巴克'), '訊息要講出它會變成哪個品牌');
  await assert.rejects(() => saveStoreRules({ rename: [{ match: '怪店X', to: 'STARBUCKS SHOP' }] }), /愈整理愈亂/);
  // 帶分店的合法目標不可誤殺：cleanStore 摘尾端「（分店）」是裝飾差、不是品牌漂移
  assert.equal((await checkRulesIdempotent(sanitizeStoreRules({ rename: [{ match: '統一超-百福', to: '統一超商（百福）' }] }))).length, 0,
    '分店裝飾差異放行');
});
