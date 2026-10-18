'use strict';
function fixture() {
  const settings = {
    owner: 'Boss',
    participants: [
      { role: '裁示者（人）', id: 'Boss', account: 'boss-acct' },
      { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' },
      { role: '受指定裁示者', id: 'Delta', account: 'delegate-acct' },
    ],
    rulingAssignments: [{ id: 'engineering', decider: 'Delta', scope: '本工作線的工程與必要前置', source: 'https://x.invalid/acme/kit/pull/1#c-grant', from: '2026-10-01T00:00:00Z', until: null }],
  };
  const make = (id, minute, body, author = 'ai-acct') => ({ id, change: '7', author, body, createdAt: `2026-10-18T10:${String(minute).padStart(2, '0')}:00Z` });
  const question = make('q', 1, '## ❓ 待裁（2026-10-18）：刪除後鍵盤焦點\n只問技術實作');
  const answer = make('a', 2, '## ⚖️ Delta 裁示（2026-10-18）：回到標題\n裁示指派：engineering\n原話（對話中，Alpha 轉述）：**「回到標題」**\n原題：https://x.invalid/acme/kit/pull/7#c-q', 'delegate-acct');
  return { settings, question, answer, make, comments: [question, answer] };
}
module.exports = { fixture };
