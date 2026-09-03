// @ts-check
// 第二輪稽核第二批 2B：lib/store.js writeAll 的 ROLLBACK（2026-09-02 稽核：拿掉那一行沒有任何一題會紅）。
//
// 為什麼要用替身讓序列化炸：save() 之前一律過 sanitizeDbForWrite（mode:'throw'），資料形狀的錯到不了交易裡；
// 交易裡唯一會炸的是「序列化」與 SQLite 本身。替身只在「序列化一個時間戳數字」時炸——在本題受測的這次 save 裡，
// 那是 writeAll 交易**最後一筆** meta（__dbUpdatedAt）的寫入，前面所有 KV 列都已經寫進交易了。
// （開庫時的搬家 meta 也會序列化時間戳，但替身是在第一次 load/save 把開庫與搬家都做完之後才裝上的。）沒有 ROLLBACK 的話：
// ① 交易掛著，同一條連線的下一次 load 會讀到未提交的新值；② 下一次 save 的 BEGIN 撞
// 「cannot start a transaction within a transaction」。兩個都有斷言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'store-rollback-'));
process.env.STORE_FILE = join(DIR, 'store.db');
const store = await import('../lib/store.js');

test('2B｜交易中途炸掉 → ROLLBACK 收乾淨：資料仍是炸之前的樣子、下一次 save 照常成功', () => {
  const db = store.load();
  db.settings.usdTwd = 31.5;
  store.save(db);

  const realStringify = JSON.stringify;
  let fired = 0;
  JSON.stringify = function (/** @type {any} */ ...args) {
    if (typeof args[0] === 'number' && args[0] > 1e12) { fired++; throw new Error('替身：交易最後一筆 meta 序列化炸掉'); }
    return realStringify.apply(JSON, args);
  };
  try {
    const poisoned = store.load();
    poisoned.settings.usdTwd = 99;
    assert.throws(() => store.save(poisoned), /替身/);
  } finally { JSON.stringify = realStringify; }
  assert.equal(fired, 1, '對照：替身真的在交易裡炸過一次（否則這題什麼都沒考）');

  assert.equal(store.load().settings.usdTwd, 31.5, '炸掉的那次不可留下半截（KV 列已寫進交易、必須被回滾）');
  const again = store.load();
  again.settings.usdTwd = 32.25;
  assert.doesNotThrow(() => store.save(again), '交易沒收乾淨：下一次 save 的 BEGIN 撞「cannot start a transaction」');
  assert.equal(store.load().settings.usdTwd, 32.25, '收乾淨之後的寫入要真的落地');
});
