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
const { setUserRules, sanitizeStoreRules, compileStoreRules, escapeRe } = await import('../lib/store-rules.js');
const { cleanStore, storeKeyOf, applyDisplayLabels, categorize } = await import('../lib/statement.js');
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

test('預覽（dryRun）不留副作用：跑完還原、不寫檔', () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  const r = previewStoreRules({ chains: ['鮮芋仙'] });
  assert.ok(r.changed >= 1, '預覽要看得到會被改到的筆數');
  assert.equal(r.changes[0].after, '鮮芋仙（林口店）', '而且看得到會變成什麼樣子');
  assert.ok(r.keyChanged >= 1, '鑰匙的變動也要說（最危險、預覽只列顯示名看不到）');
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙林口店', '跑完候選規則必須失效（否則整個行程都被汙染）');
  assert.equal(store.load().transactions?.[0].note, '鮮芋仙林口店', '預覽不可寫檔');
});

test('預覽中途拋錯也要還原（finally，不是「順順跑完才還原」）', () => {
  assert.throws(() => previewStoreRules(Object.defineProperty({}, 'canon', { get() { throw new Error('boom'); } })));
  assert.equal(cleanStore('鮮芋仙林口店'), '鮮芋仙林口店', '拋錯後候選規則仍須失效');
});

test('預覽的候選規則蓋得過「規則入櫃檯」（getDb 會重設規則，覆蓋層才蓋得住）', () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  // normalizeBranches 內部會 getDb() → 若候選規則只放在「櫃檯值」那一層，這裡就被洗回空規則、預覽恆為 0
  assert.ok(previewStoreRules({ chains: ['鮮芋仙'] }).changed >= 1);
});

// ---------- 存檔：寫進 settings、立刻套用到既有資料 ----------

test('存規則＝存完就生效（不必再記得按一次「整理店名格式」）', () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt',
      stmtRef: 'c1|2026-07-01|100|鮮芋仙林口店' }] });
  const r = saveStoreRules({ chains: ['鮮芋仙'] });
  assert.equal(r.ok, true);
  assert.ok(r.changed >= 1, '存檔時要回報動到幾筆');
  const db = store.load();
  assert.equal(db.transactions?.[0].note, '鮮芋仙（林口店）', '既有資料當場被整理');
  assert.equal(db.transactions?.[0].storeKey, '鮮芋仙', '鑰匙也跟著對齊');
  assert.deepEqual(getStoreRules().rules.chains, ['鮮芋仙'], '規則存進 settings');
});

test('存規則：壞條目被丟掉，不會寫進資料庫', () => {
  store.save(store.emptyDb());
  const r = saveStoreRules({ chains: ['好店', ''], canon: [{ match: 'A', to: '' }] });
  assert.deepEqual(r.rules.chains, ['好店']);
  assert.equal(r.rules.canon.length, 0);
});

test('存規則：沒帶內容回 400（避免手滑把規則清空）', () => {
  assert.throws(() => saveStoreRules(undefined), /缺少規則內容/);
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

test('孤兒學習清單：列出「對不上任何現存交易」的學習條目（看不見的隱形規則）', () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      note: '好店', storeKey: '好店', source: 'stmt', stmtRef: 'c1|2026-07-01|100|好店-林口' }],
    learnedCategories: {
      '好店': { category: '飲食' },              // 現存交易的 storeKey → 不是孤兒
      '好店-林口': { name: '好店（林口）' },        // 現存交易的帳單原文 → 不是孤兒
      '早就刪掉的店': { category: '娛樂' }          // 對不上任何交易 → 孤兒
    } });
  const r = listOrphanLearned();
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map(i => i.key), ['早就刪掉的店']);
  assert.equal(r.items[0].category, '娛樂', '要帶出內容，使用者才判斷得了要不要刪');
});
