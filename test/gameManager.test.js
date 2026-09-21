// 游戏状态机单元测试（judge 全部用桩，不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';

const Q1 = { id: 1, title: '一', puzzle: '汤面1', answer: '汤底1' };
const Q2 = { id: 2, title: '二', puzzle: '汤面2', answer: '汤底2' };

function stubJudge(sequence = []) {
  const calls = [];
  return {
    calls,
    async judge(question, message) {
      calls.push({ question, message });
      return sequence.shift() || { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };
    },
  };
}

function makeGame(sequence, winThreshold = 0.8) {
  const judge = stubJudge(sequence);
  return { judge, gm: new GameManager(judge, { winThreshold }) };
}

test('没有题目 / 未开始时提问只给提示', async () => {
  const { gm } = makeGame();
  assert.equal((await gm.ask('c', 'u1', 'A', '问题')).type, 'hint');

  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  assert.equal((await gm.ask('c', 'u1', 'A', '问题')).type, 'hint');
});

test('相似度达到阈值即通关，并返回 similarity 与参与人数', async () => {
  const { gm } = makeGame([{ isYes: false, yesProb: 0.1, similarity: 0.85, usage: null }], 0.8);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.ask('c', 'u2', 'B', '我猜是这样');
  assert.equal(r.type, 'win');
  assert.equal(r.userId, 'u2');
  assert.equal(r.similarity, 0.85);
  assert.equal(r.participantCount, 1);
  assert.equal(r.question.answer, '汤底1');

  // 通关后不再接受提问
  assert.equal((await gm.ask('c', 'u3', 'C', '再问')).type, 'hint');
  assert.equal(gm.status('c').winner.userName, 'B');
});

test('未达阈值返回是/不是，并带上相似度', async () => {
  const { gm } = makeGame([
    { isYes: true, yesProb: 0.9, similarity: 0.25, usage: null },
    { isYes: false, yesProb: 0.1, similarity: 0.5, usage: null },
  ]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const yes = await gm.ask('c', 'u1', 'A', '是这样吗');
  assert.equal(yes.type, 'answer');
  assert.equal(yes.answer, '✅ 是。');
  assert.equal(yes.similarity, 0.25);
  assert.equal(yes.askerId, 'u1');

  const no = await gm.ask('c', 'u2', 'B', '是那样吗');
  assert.equal(no.answer, '❌ 不是。');
  assert.equal(gm.status('c').participantCount, 2);
});

test('评判失败（isYes 为 null）时提示无法判断', async () => {
  const { gm } = makeGame([{ isYes: null, yesProb: 0, similarity: 0, usage: null }]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');
  const r = await gm.ask('c', 'u1', 'A', '问题');
  assert.match(r.answer, /无法判断/);
});

test('换题会清零参与人数（回归：participants 跨局累加）', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');
  await gm.ask('c', 'u1', 'A', '问题1');
  await gm.ask('c', 'u2', 'B', '问题2');
  assert.equal(gm.status('c').participantCount, 2);

  // 换题 = 新一局
  gm.setQuestion('c', Q2, { userId: 'u2', userName: 'B' });
  assert.equal(gm.status('c').participantCount, 0);
  assert.equal(gm.status('c').questionCount, 0);

  gm.start('c', 'u2', 'B');
  assert.equal(gm.status('c').participantCount, 0);
  await gm.ask('c', 'u3', 'C', '问题3');
  assert.equal(gm.status('c').participantCount, 1);
});

test('换题权限：未开局人人可换，进行中只有发起人可换，结束后放开', async () => {
  const { gm } = makeGame([{ isYes: true, yesProb: 1, similarity: 0.9, usage: null }]);

  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  assert.equal(gm.canSwitch('c', 'u2'), true, '未开始时应人人可换');

  gm.start('c', 'u1', 'A');
  assert.equal(gm.canSwitch('c', 'u1'), true);
  assert.equal(gm.canSwitch('c', 'u2'), false, '进行中非发起人不可换题');

  await gm.ask('c', 'u1', 'A', '完整答案');
  assert.equal(gm.status('c').winner.userId, 'u1');
  assert.equal(gm.canSwitch('c', 'u2'), true, '本局结束后应放开换题');
});

test('重复开始会被拒绝，通关/公布后可以重开', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  assert.equal(gm.start('c', 'u1', 'A').ok, true);
  assert.equal(gm.start('c', 'u1', 'A').ok, false);

  gm.reveal('c');
  assert.equal(gm.start('c', 'u1', 'A').ok, true);
});

test('history 只取最近 N 条，historyCount 是总数', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');
  for (let i = 0; i < 5; i++) await gm.ask('c', 'u1', 'A', `问题${i}`);

  assert.equal(gm.historyCount('c'), 5);
  assert.equal(gm.history('c', 2).length, 2);
  assert.equal(gm.history('c', 2).at(-1).message, '问题4');
});

test('reset 清空该频道状态', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');
  gm.reset('c');
  const s = gm.status('c');
  assert.equal(s.hasQuestion, false);
  assert.equal(s.started, false);
});

test('状态按频道隔离', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c1', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c1', 'u1', 'A');
  assert.equal(gm.status('c1').started, true);
  assert.equal(gm.status('c2').hasQuestion, false);
});
