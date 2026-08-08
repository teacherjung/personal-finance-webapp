import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⚠️ 為什麼要有這一題（2026-08-08 實際事故）：
 * `new URL('..', import.meta.url).pathname` 留著 URL 編碼。本專案實際落在
 * 「07 專案/榮祥森（投資理財）」這種含**空白與中文**的路徑下，於是它算出
 * `.../07%20%E5%B0%88%E6%A1%88/...` ⇒ 掃描原始碼的考題 `readFileSync` 直接 ENOENT。
 *
 * 這個病的形狀最惡：#417 的實作樹落在 `/private/tmp/claude-impl-…`（純 ASCII）＝四題全綠，
 * 十四輪審查也全綠；**合併進 main、在使用者自己的目錄跑才紅**。
 * ⇒ 也就是說「考題在開發者機器上綠」不代表「在使用者機器上綠」，而路徑是這條分界線上最常見的那顆雷。
 *
 * ⚠️ 誠實劃界：本題**只**擋 `new URL(...).pathname` 這一種寫法（那是本次的病灶，也是最常見的誤用）。
 * 它擋不住「用別的方式湊出未解碼路徑」，也不證明任何掃描器真的掃到了東西
 * ——後者由各掃描題自己的「掃到幾個」斷言負責（本檔第二題只保證 ROOT 這一顆算得對）。
 */
test('掃原始碼的考題不可用 new URL(...).pathname 當檔案路徑（含空白／中文的目錄會 ENOENT）', () => {
  const offenders = [];
  for (const dir of ['test', 'scripts', 'lib', 'public']) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base, { recursive: true })) {
      if (typeof f !== 'string' || !f.endsWith('.js')) continue;
      const rel = join(dir, f);
      const src = readFileSync(join(ROOT, rel), 'utf8');
      // 逐行掃才報得出行號。⚠️ **註解行要跳過**：註解裡提到這個寫法（例如本檔的說明、
      // 或別處「不可以這樣寫」的警告）不是真的在用它——與 repo 既有的「掃形狀前先去註解」同一個判準。
      src.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (!/new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/.test(line)) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [],
    '這些地方用 `new URL(...).pathname` 當檔案路徑：\n  ' + offenders.join('\n  ')
    + '\n\n它留著 URL 編碼，遇到含空白或中文的專案路徑（本專案就是）會 ENOENT。'
    + '\n改用：const ROOT = join(dirname(fileURLToPath(import.meta.url)), \'..\');'
    + '\n⚠️ 這種錯在純 ASCII 的實作樹裡完全看不出來——#417 十四輪審查全綠，合併後在主目錄才紅。');
});

test('ROOT 這一顆真的指到 repo 根（否則上面那題就是在空掃）', () => {
  // ⚠️ 反面自我驗證：只斷言「沒有違規者」會在 ROOT 算錯時假綠（掃不到檔案＝清單當然空）。
  assert.ok(existsSync(join(ROOT, 'package.json')), 'ROOT 沒指到 repo 根，上面那題等於什麼都沒掃');
  assert.ok(readdirSync(join(ROOT, 'test')).length > 50, 'test/ 掃到的檔案數不對，ROOT 可能算錯');
});
