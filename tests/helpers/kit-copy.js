// 考題專用：在暫存目錄搭一份「只有工具＋考題自己給的設定」的套件複本，在裡面跑工具的指令入口。
//
// 為什麼（2026-09-13 搬家驗屋「考題綁死設定未填」那一類）：工具一律讀 tools/ 旁邊那份 settings.json。
// 那份在套件倉庫裡是空白的，搬進專案後會被填成真的。原本「真的跑一遍指令」的 9 題直接跑本倉庫的工具，
// 一填設定就紅，還會照真設定去問真平台、在真禁區埋假機密再收（端到端實際發生過）。
// 在複本裡跑，真的那份設定一個字都不讀。
//
// 空白設定＝同目錄的 unfilled-settings.json：套件發布時 settings.json 的逐字副本。
// 它的形狀（欄位名、型別）由 settings.test.js 盯著跟真設定一致——設定多一欄、少一欄，那題就紅。
// ⚠️ 守不到的：新寫的考題不經過這裡、又直接跑本倉庫的工具（或呼叫純函式時不給設定、吃到預設讀真設定）——
//   這一條由 tests/filled-settings.test.js 在「每一欄都填了假值」的複本裡整卷重跑來抓（照設定叫外面＝錄音機記到＝紅）；考題沒走到的分支仍靠審查。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../../tools/git-env.js');

const KIT_ROOT = path.join(__dirname, '..', '..');
const UNFILLED_FILE = path.join(__dirname, 'unfilled-settings.json');

/** 空白設定（每次讀一份新的，考題改它不會互相汙染）。 */
const unfilled = () => JSON.parse(fs.readFileSync(UNFILLED_FILE, 'utf8'));

/**
 * 搭一份複本、在裡面跑一支工具，跑完就收掉。回 spawnSync 的結果。
 * @param {string} relTool 相對套件根目錄的工具路徑，例如 'tools/gates/check-stacked.js'
 */
function runInCopy(relTool, args = [], { settings = unfilled(), input } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-copy-'));
  try {
    fs.cpSync(path.join(KIT_ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    const env = gitEnv();
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [path.join(dir, relTool), ...args], { cwd: dir, env, input, encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runInCopy, unfilled, UNFILLED_FILE };
