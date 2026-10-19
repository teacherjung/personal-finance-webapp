// 每題獨立子程序、合成帳本與正式 DOM／LOCAL HTTP，避免上一題留下的空值替本題作證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitEnv } from '../lib/git-env.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const normal = { category: '工具', card: '台新', email: 'Gmail' };
const blank = { category: '', card: '', email: '' };
const cases = [
  { name: '缺欄不套新增預設且儲存後仍缺席', fields: {}, display: blank },
  { name: 'null 初選空項且儲存後保留 null', fields: { category: null, card: null, email: null }, display: blank },
  { name: '空字串初選空項且只改名稱不改值', fields: blank, display: blank },
  { name: '正常值只改名稱不回送未操作欄位', fields: normal, display: normal },
  { name: '清單外值與 HTML 字元保留且不插入元素', fields: { category: '<img src=x>', card: '<失效卡>', email: '<script>舊信箱</script>' }, display: { category: '<img src=x>', card: '<失效卡>', email: '<script>舊信箱</script>' }, expiredCard: '<失效卡>' },
  { name: '空白字串依原值保留而不自行 trim', fields: { category: ' ', card: ' ', email: ' ' }, display: { category: ' ', card: ' ', email: ' ' }, expiredCard: ' ' },
  ...[['synthetic+case@gmail.example', 'Gmail'], ['synthetic+case@yahoo.example', 'Yahoo'], ['synthetic+case@me.com', 'iCloud']].map(([raw, label]) => ({ name: label + ' 顯示投影未操作時保留合成原信箱', fields: { ...normal, email: raw }, display: { ...normal, email: label } })),
  { name: '明確選新值送出並回讀', mode: 'change', fields: blank, display: blank, changes: normal, sent: normal },
  { name: '明確改空送空字串而不省略', mode: 'change', fields: normal, display: normal, changes: blank, sent: blank },
  { name: '切走再回原投影視為沒有最終變更', mode: 'restored', fields: { ...normal, email: 'synthetic@gmail.example' }, display: normal, changes: { category: '生活', card: '富邦', email: 'Yahoo' } },
  { name: '取消不送出且原列不變', mode: 'cancel', fields: {}, display: blank },
  { name: '失敗後沿開窗基準重試並保留第二次選擇', mode: 'retry', fields: { category: '工具', card: '台新', email: 'synthetic@gmail.example' }, display: normal,
    changes: { category: '生活', card: '富邦', email: 'Yahoo' }, retryChanges: { category: '生活', card: '', email: 'Gmail' }, sent: { category: '生活', card: '' } },
  { name: '終身訂閱只改名稱保存週期與日期', fields: { ...blank, cycle: 'lifetime', nextCharge: '' }, omit: ['chargeAnchorDay'], display: blank },
  { name: '即將停用訂閱只改名稱保存狀態與日期錨點', fields: { ...blank, status: 'ending', nextCharge: '2099-12-31', endsOn: '2099-12-31' }, display: blank },
  ...[false, true].map(noCards => ({ name: (noCards ? '無卡片' : '有卡片') + '新增保留娛樂與 Gmail 並明確未指定卡片', mode: 'new', noCards,
    display: { category: '娛樂', card: '', email: 'Gmail' }, sent: { category: '娛樂', card: '', email: 'Gmail' } }))
];
for (const entry of cases) test('訂閱表單｜' + entry.name, t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-sub-form-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { mode: 'preserve', sent: {}, ...entry };
  const reportPath = join(root, 'report.json'), nonce = randomUUID();
  assert.equal(fs.existsSync(reportPath), false);
  const env = { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root, TMP: root, TEMP: root,
    SUBSCRIPTION_FORM_SOURCE: ROOT, SUBSCRIPTION_FORM_CASE: JSON.stringify(spec), SUBSCRIPTION_FORM_REPORT: reportPath, SUBSCRIPTION_FORM_NONCE: nonce };
  const result = spawnSync(process.execPath, [join(ROOT, 'test/helpers/subscriptions-form-case.js')], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6 });
  assert.equal(result.status, 0, '檢查 public/modules/subscriptions.js 的 openSubForm 與 test/helpers/subscriptions-form-case.js；重跑 node --test test/subscriptions-form-preservation.test.js。\n' + (result.error?.message || '') + result.stdout + result.stderr);
  try {
    const info = fs.lstatSync(reportPath);
    assert(info.isFile()); assert.equal(info.isSymbolicLink(), false); assert(info.size > 0 && info.size <= 2e6);
    assert.equal(fs.realpathSync(reportPath), reportPath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.version, 1); assert.equal(report.nonce, nonce);
    assert.equal(report.passed, true); assert.equal(report.name, spec.name); assert.equal(report.rawRoundTrip, true);
  } catch (error) {
    error.message += '\n檢查 test/helpers/subscriptions-form-case.js 的本題收據；重跑 node --test test/subscriptions-form-preservation.test.js。\n' + result.stdout + result.stderr;
    throw error;
  }
});
