// 游戏状态机单元测试（judge 全部用桩，不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';

const Q1 = { id: 1, title: '一', puzzle: '汤面1', answer: '汤底1' };
const Q2 = { id: 2, title: '二', puzzle: '汤面2', answer: '汤底2' };

const OK = { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };

function stubJudge(sequence = []) {
  const calls = []; // 整段 / 「是-不是」评判
  const sentenceCalls = []; // 逐句核对（一次调用判完所有句子）
  return {
    calls,
    sentenceCalls,
    async judge(question, message) {
      calls.push({ question, message });
      return sequence.shift() || OK;
    },
    async judgeSentences(question, message, items) {
      sentenceCalls.push({ question, message, items });
      const next = sequence.shift();
      if (next?.failed) return { ...next, items: [] };
      return {
        isYes: null,
        yesProb: 0,
        similarity: 0,
        usage: null,
        failed: false,
        // 桩里默认每句都判 ✅，测试想指定结果就传 { items: [...] }
        items: items.map((text) => ({ text, isYes: true })),
        ...next,
      };
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

/* ---------------- /ask：提交结论，逐句核对 ---------------- */

test('/ask 多句结论：整段一次 + 逐句一次（不是一句一次），对的 ✅ 错的 ❌', async () => {
  const { judge, gm } = makeGame([
    // 第 1 次调用：整段（用来判是否通关）
    { isYes: false, yesProb: 0.1, similarity: 0.3, usage: null },
    // 第 2 次调用：整段 + 三句，一次判完
    {
      items: [
        { text: '他是自杀的', isYes: true },
        { text: '凶手是医生', isYes: false },
        { text: '他留了遗书', isYes: true },
      ],
    },
  ]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const conclusion = '他是自杀的，凶手是医生，他留了遗书';
  const r = await gm.verify('c', 'u2', 'B', conclusion);
  assert.equal(r.type, 'verify');
  assert.equal(r.asker, 'B');
  assert.equal(r.askerId, 'u2');
  assert.deepEqual(r.items, [
    { text: '他是自杀的', isYes: true },
    { text: '凶手是医生', isYes: false },
    { text: '他留了遗书', isYes: true },
  ]);

  // 整段一次 + 逐句一次 = 一共 2 次调用，不随句数增长
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].message, conclusion);
  assert.equal(judge.sentenceCalls.length, 1);
  assert.equal(judge.sentenceCalls[0].message, conclusion, '整段要一起发过去，代词才有先行词');
  assert.deepEqual(judge.sentenceCalls[0].items, ['他是自杀的', '凶手是医生', '他留了遗书']);

  // 历史里记的是「是不是每句都对」，且记下拆了几句
  const last = gm.history('c').at(-1);
  assert.equal(last.isYes, false);
  assert.equal(last.sentences, 3);
  assert.equal(last.message, conclusion);
  // 玩家看不到任何分数
  assert.equal(r.similarity, undefined);
  assert.equal(r.yesProb, undefined);
});

test('/ask 拆满 6 句也只发起一次逐句调用', async () => {
  const { judge, gm } = makeGame([
    { isYes: false, yesProb: 0.1, similarity: 0.2, usage: null },
  ]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.verify('c', 'u1', 'A', '一句甲。一句乙。一句丙。一句丁。一句戊。一句己。一句庚。');
  assert.equal(r.items.length, 6);
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.sentenceCalls.length, 1, '6 句也只调用一次');
  assert.equal(judge.sentenceCalls[0].items.length, 6);
});

test('/ask 每句都对但没到通关线：仍然是核对清单，不判通关', async () => {
  const { gm } = makeGame([
    { isYes: true, yesProb: 0.9, similarity: 0.6, usage: null }, // 整段：离通关阈值还差一点
  ]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.verify('c', 'u1', 'A', '他是自杀的，他留了遗书');
  assert.equal(r.type, 'verify', '没到阈值就不能通关');
  assert.ok(r.items.length > 1 && r.items.every((it) => it.isYes), '桩默认每句都判 ✅');
  assert.equal(gm.status('c').winner, null);
});

test('/ask 单句只评判一次，不会重复调用模型', async () => {
  const { judge, gm } = makeGame([{ isYes: true, yesProb: 0.9, similarity: 0.3, usage: null }]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.verify('c', 'u1', 'A', '他是自杀的');
  assert.deepEqual(r.items, [{ text: '他是自杀的', isYes: true }]);
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.sentenceCalls.length, 0, '单句不用再单独核对一次');
});

test('/ask 说中谜底就直接通关，不做逐句核对', async () => {
  const { judge, gm } = makeGame([{ isYes: true, yesProb: 0.9, similarity: 0.9, usage: null }]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.verify('c', 'u2', 'B', '他是自杀的。他留了遗书。');
  assert.equal(r.type, 'win');
  assert.equal(r.question.answer, '汤底1');
  assert.equal(judge.calls.length, 1, '通关只需整段那一次');
  assert.equal(judge.sentenceCalls.length, 0, '谜底都公布了就不用逐句报一遍');
  assert.equal(gm.status('c').winner.userName, 'B');
});

test('/ask 逐句核对失败：提示失败，不写历史', async () => {
  const { gm } = makeGame([
    { isYes: false, yesProb: 0.1, similarity: 0.2, usage: null },
    { failed: true, error: '评判超时' },
  ]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  const r = await gm.verify('c', 'u1', 'A', '他是自杀的，凶手是医生');
  assert.equal(r.type, 'hint');
  assert.match(r.text, /评判失败/);
  assert.match(r.text, /评判超时/);
  assert.equal(gm.historyCount('c'), 0);
});

test('/ask 和 @我 共用同一份频率限制（一条只记 1 次额度）', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  for (let i = 0; i < 5; i++) await gm.verify('c', 'u1', 'A', `结论${i}甲。结论${i}乙。`);
  // 第 6 次仍然放行，第 7 条才被限流
  assert.equal((await gm.verify('c', 'u1', 'A', '再来一句。再来第二句。')).type, 'verify');
  const limited = await gm.ask('c', 'u1', 'A', '再问一句');
  assert.equal(limited.type, 'hint');
  assert.match(limited.text, /每分钟最多/);
});

test('/ask 也会被"本局没开始/已通关"拦住', async () => {
  const { gm } = makeGame([{ isYes: true, yesProb: 1, similarity: 0.9, usage: null }]);
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  assert.equal((await gm.verify('c', 'u1', 'A', '他是自杀的')).type, 'hint');

  gm.start('c', 'u1', 'A');
  await gm.ask('c', 'u1', 'A', '完整谜底');
  assert.equal((await gm.verify('c', 'u1', 'A', '他是自杀的')).type, 'hint');
});

test('/ask 空内容给提示', async () => {
  const { gm } = makeGame();
  gm.setQuestion('c', Q1, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');
  assert.match((await gm.verify('c', 'u1', 'A', '   ')).text, /不能为空/);
});
