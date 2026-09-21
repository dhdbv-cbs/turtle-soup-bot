// 命令处理器单元测试（不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../src/game/QuestionStore.js';
import { GameManager } from '../src/game/GameManager.js';
import { CommandHandler } from '../src/CommandHandler.js';

async function setup(judgeResults = []) {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-cmd-'));
  const file = join(dir, 'questions.json');
  await writeFile(
    file,
    JSON.stringify([
      { id: 1, title: '甲', puzzle: '甲汤面', answer: '甲汤底' },
      { id: 2, title: '乙', puzzle: '乙汤面', answer: '乙汤底' },
    ]),
    'utf8',
  );

  const qs = new QuestionStore({ file });
  await qs.load();

  const judge = {
    async judge() {
      return judgeResults.shift() || { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };
    },
  };
  const gm = new GameManager(judge, { winThreshold: 0.8 });
  return { qs, gm, handler: new CommandHandler(gm, qs) };
}

test('非汤命令返回 null，不干扰其它消息', async () => {
  const { handler } = await setup();
  assert.equal(await handler.handle('c', 'u1', 'A', '!hello'), null);
  assert.equal(await handler.handle('c', 'u1', 'A', '随便聊聊'), null);
});

test('两个前缀都能解析命令', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 帮助')).text, /命令说明/);
  assert.match((await handler.handle('c', 'u1', 'A', '#汤 帮助')).text, /命令说明/);
});

test('首次「汤 下一题」给的是第 1 题（端到端回归）', async () => {
  const { handler } = await setup();
  const r = await handler.handle('c', 'u1', 'A', '!汤 下一题');
  assert.match(r.text, /#1 题：甲/);
});

test('列表 / 选 / 开始 正常', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 列表')).text, /共 2 题/);
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 选 2')).text, /#2 题：乙/);
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 开始')).text, /乙汤面/);
});

test('「汤 选」缺参数或编号不存在时有提示', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 选')).text, /请指定题目编号/);
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 选 99')).text, /没有找到/);
});

test('未知子命令给出帮助指引', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 飞行')).text, /未知命令/);
});

test('换题权限：进行中只有本局发起人能换题', async () => {
  const { handler } = await setup();
  await handler.handle('c', 'u1', 'A', '!汤 下一题');
  await handler.handle('c', 'u1', 'A', '!汤 开始');

  const denied = await handler.handle('c', 'u2', 'B', '!汤 下一题');
  assert.match(denied.text, /只有发起人 A/);

  const deniedGoto = await handler.handle('c', 'u2', 'B', '!汤 选 2');
  assert.match(deniedGoto.text, /只有发起人 A/);

  // 发起人自己可以换
  const ok = await handler.handle('c', 'u1', 'A', '!汤 下一题');
  assert.match(ok.text, /#2 题：乙/);
});

test('本局结束后任何人都能换题', async () => {
  const { handler } = await setup([{ isYes: true, yesProb: 1, similarity: 0.9, usage: null }]);
  await handler.handle('c', 'u1', 'A', '!汤 下一题');
  await handler.handle('c', 'u1', 'A', '!汤 开始');
  await handler.handleAsk('c', 'u1', 'A', '我完整说出谜底');

  const r = await handler.handle('c', 'u2', 'B', '!汤 下一题');
  assert.match(r.text, /#2 题：乙/);
});

test('状态：未选题与进行中两种文案', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 状态')).text, /当前没有题目/);

  await handler.handle('c', 'u1', 'A', '!汤 下一题');
  await handler.handle('c', 'u1', 'A', '!汤 开始');
  await handler.handleAsk('c', 'u1', 'A', '问题');
  const status = (await handler.handle('c', 'u1', 'A', '!汤 状态')).text;
  assert.match(status, /当前题目：#甲/);
  assert.match(status, /提问次数：1/);
  assert.match(status, /参与人数：1/);
  assert.match(status, /本局发起人：A/);
});

test('历史：空记录与条数文案', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 历史')).text, /还没有提问记录/);

  await handler.handle('c', 'u1', 'A', '!汤 下一题');
  await handler.handle('c', 'u1', 'A', '!汤 开始');
  await handler.handleAsk('c', 'u1', 'A', '问题一');
  const h = (await handler.handle('c', 'u1', 'A', '!汤 历史')).text;
  assert.match(h, /共 1 条/);
  assert.match(h, /问题一/);
});

test('公布与重置', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 公布')).text, /还没有题目/);

  await handler.handle('c', 'u1', 'A', '!汤 下一题');
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 公布')).text, /甲汤底/);

  const reset = await handler.handle('c', 'u1', 'A', '!汤 重置');
  assert.match(reset.text, /已重置/);
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 状态')).text, /当前没有题目/);
});

test('题目库为空时列表有明确提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-empty-'));
  const file = join(dir, 'questions.json');
  await writeFile(file, '[]', 'utf8');
  const qs = new QuestionStore({ file });
  await qs.load();
  const handler = new CommandHandler(new GameManager({ judge: async () => ({}) }), qs);

  assert.match((await handler.handle('c', 'u1', 'A', '!汤 列表')).text, /题目库为空/);
  assert.match((await handler.handle('c', 'u1', 'A', '!汤 下一题')).text, /题目库为空/);
});
