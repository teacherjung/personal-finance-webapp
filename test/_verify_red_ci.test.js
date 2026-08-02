// ⚠️ 暫時性測試檔：故意失敗，用來驗證「紅 CI 合不了」的分支保護。驗證完立刻刪、PR 關掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('故意失敗（驗證分支保護會擋住紅 CI 合併）', () => {
  assert.equal(1, 2, '這題本來就該紅——它在測 GitHub 的 required status check 有沒有真的擋合併');
});
