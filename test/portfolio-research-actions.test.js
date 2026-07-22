import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioResearchActions } from '../public/modules/portfolio-research-actions.js';

function setup(overrides = {}) {
  const calls = [];
  const notices = [];
  const elements = new Map();
  let form = null;
  let renders = 0;
  const actions = createPortfolioResearchActions({
    api: async (path, options) => { calls.push({ path, options }); },
    getElement: id => elements.get(id) || null,
    getAll: () => [],
    openForm: config => { form = config; },
    toast: (message, error = false) => { notices.push({ message, error }); },
    rerender: () => { renders += 1; },
    today: () => '2026-07-22',
    ...overrides
  });
  return { actions, calls, notices, elements, getForm: () => form, getRenders: () => renders };
}

test('投資研究互動｜空白檢查點只提示，不寫入也不重畫', async () => {
  const state = setup();
  state.elements.set('cp_AAPL', { value: '   ' });

  await state.actions.addCheckpoint('AAPL', []);

  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.notices, [{ message: '先輸入筆記內容', error: true }]);
  assert.equal(state.getRenders(), 0);
});

test('投資研究互動｜既有研究追加檢查點；新代號建立完整空研究卡', async () => {
  const state = setup();
  state.elements.set('cp_aapl', { value: '  追蹤服務營收  ' });
  await state.actions.addCheckpoint('aapl', [{ id: 'r1', symbol: 'AAPL', checkpoints: [{ date: '2026-06-01', note: '舊筆記' }] }]);
  state.elements.set('cp_GOOGL', { value: '檢查 AI 收入' });
  await state.actions.addCheckpoint('GOOGL', []);

  assert.deepEqual(state.calls, [
    {
      path: '/research/r1',
      options: { method: 'PUT', body: { checkpoints: [
        { date: '2026-06-01', note: '舊筆記' },
        { date: '2026-07-22', note: '追蹤服務營收' }
      ] } }
    },
    {
      path: '/research',
      options: { method: 'POST', body: {
        symbol: 'GOOGL', thesis: '', metrics: '', risks: '',
        checkpoints: [{ date: '2026-07-22', note: '檢查 AI 收入' }]
      } }
    }
  ]);
  assert.deepEqual(state.notices, [
    { message: '已記錄檢查點', error: false },
    { message: '已記錄檢查點', error: false }
  ]);
  assert.equal(state.getRenders(), 2);
});

test('投資研究互動｜檢查點寫入失敗只報錯，不重畫', async () => {
  const state = setup({ api: async () => { throw new Error('儲存失敗'); } });
  state.elements.set('cp_AAPL', { value: '筆記' });

  await state.actions.addCheckpoint('AAPL', []);

  assert.deepEqual(state.notices, [{ message: '儲存失敗', error: true }]);
  assert.equal(state.getRenders(), 0);
});

test('投資研究互動｜表單依既有資料選 PUT，新代號選 POST', async () => {
  const state = setup();
  state.actions.openResearchForm('aapl', [{ id: 'r1', symbol: 'AAPL', thesis: '既有' }]);
  assert.equal(state.getForm().title, 'aapl 研究卡');
  await state.getForm().onSubmit({ thesis: '更新' });
  state.actions.openResearchForm('GOOGL', []);
  await state.getForm().onSubmit({ thesis: '新論點', metrics: '', risks: '' });

  assert.deepEqual(state.calls, [
    { path: '/research/r1', options: { method: 'PUT', body: { thesis: '更新' } } },
    { path: '/research', options: { method: 'POST', body: {
      symbol: 'GOOGL', thesis: '新論點', metrics: '', risks: '', checkpoints: []
    } } }
  ]);
  assert.equal(state.getRenders(), 2);
});

test('投資研究互動｜畫面按鈕綁到對應研究表單與檢查點', async () => {
  const edit = { dataset: { editR: 'AAPL' }, onclick: null };
  const add = { dataset: { addCp: 'AAPL' }, onclick: null };
  const state = setup({
    getAll: selector => selector === '[data-edit-r]' ? [edit] : [add]
  });
  state.elements.set('cp_AAPL', { value: '新筆記' });
  state.actions.bind([]);

  edit.onclick();
  assert.equal(state.getForm().title, 'AAPL 研究卡');
  await add.onclick();
  assert.equal(state.calls[0].path, '/research');
});
