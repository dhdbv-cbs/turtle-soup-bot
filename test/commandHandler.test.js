// 命令处理器单元测试（不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../src/game/QuestionStore.js';
import { GameManager } from '../src/game/GameManager.js';
import { CommandHandler } from '../src/CommandHandler.js';
import { formatAskResult } from '../src/platforms/format.js';
import { COMMANDS, channelHelpText, parseCommand } from '../src/commands.js';

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
    // 逐句核对：一次调用判完所有句子（这里偶数序号的句子判 ✅，方便断言）
    async judgeSentences(question, message, items) {
      const next = judgeResults.shift();
      if (next?.failed) return { ...next, items: [] };
      return {
        isYes: null,
        yesProb: 0,
        similarity: 0,
        usage: null,
        failed: false,
        items: items.map((text, i) => ({ text, isYes: i % 2 === 0 })),
      };
    },
  };
  const gm = new GameManager(judge, { winThreshold: 0.8 });
  return { qs, gm, handler: new CommandHandler(gm, qs) };
}

test('非命令消息返回 null，不干扰其它消息', async () => {
  const { handler } = await setup();
  assert.equal(await handler.handle('c', 'u1', 'A', '你好'), null);
  assert.equal(await handler.handle('c', 'u1', 'A', '@某人 在吗'), null);
  assert.equal(await handler.handle('c', 'u1', 'A', ''), null);
});

test('命令解析：只认 / 开头的命令', async () => {
  assert.deepEqual(parseCommand('/next'), { name: 'next', args: [] });
  assert.deepEqual(parseCommand('/pick 3'), { name: 'pick', args: ['3'] });
  assert.deepEqual(parseCommand('  /Help  '), { name: 'help', args: [] });
  assert.deepEqual(parseCommand('/ask 是不是他杀的'), { name: 'ask', args: ['是不是他杀的'] });
  assert.deepEqual(parseCommand('/'), { name: 'help', args: [] });
  assert.equal(parseCommand('!汤 帮助'), null);
  assert.equal(parseCommand('#汤 帮助'), null);
  assert.equal(parseCommand('随便聊聊'), null);
});

test('命令表里的每个命令都能被执行，不会有"未知命令"', async () => {
  const { handler } = await setup();
  for (const cmd of COMMANDS) {
    const raw = cmd.name === 'pick' ? '/pick 1' : cmd.name === 'ask' ? '/ask 问题' : `/${cmd.name}`;
    const r = await handler.handle('c', 'u1', 'A', raw);
    assert.ok(r, `/${cmd.name} 应该有回复`);
    assert.ok(r.text || r.ask, `/${cmd.name} 应该有内容`);
    assert.doesNotMatch(r.text ?? '', /未知命令/, `/${cmd.name} 不应落到未知命令分支`);
  }
});

test('/help 在三个渠道给出各自的用法说明', async () => {
  const discord = channelHelpText('discord');
  const napcat = channelHelpText('napcat');
  const official = channelHelpText('official');

  assert.match(discord, /Discord/);
  assert.match(discord, /原生斜杠命令/);
  assert.match(napcat, /NapCat/);
  assert.match(napcat, /@我/);
  assert.match(official, /官方/);
  assert.match(official, /被动消息/);

  // 三个渠道的文案必须不一样
  assert.notEqual(discord, napcat);
  assert.notEqual(napcat, official);

  // 每条命令都要在帮助里出现
  for (const cmd of COMMANDS) {
    assert.match(discord, new RegExp(`/${cmd.name}\\b`), `帮助里应该有 /${cmd.name}`);
  }
});

test('/help 的自定义文案由配置覆盖', async () => {
  const { config } = await import('../src/config.js');
  const before = config.discord.helpText;
  try {
    config.discord.helpText = '本服务器专用说明：先发 /start';
    assert.equal(channelHelpText('discord'), '本服务器专用说明：先发 /start');
    // 只影响 Discord，别的渠道仍是内置文案
    assert.match(channelHelpText('napcat'), /NapCat/);
  } finally {
    config.discord.helpText = before;
  }
});

test('只有 Discord 的 /help 是仅自己可见', async () => {
  const { handler } = await setup();
  const onDiscord = await handler.handle('c', 'u1', 'A', '/help', { platform: 'discord' });
  assert.equal(onDiscord.ephemeral, true);

  const onNapcat = await handler.handle('c', 'u1', 'A', '/help', { platform: 'napcat' });
  assert.equal(onNapcat.ephemeral, false);

  const onOfficial = await handler.handle('c', 'u1', 'A', '/help', { platform: 'official' });
  assert.equal(onOfficial.ephemeral, false);
});

test('首次 /next 给的是第 1 题（指针回归）', async () => {
  const { handler } = await setup();
  const r = await handler.handle('c', 'u1', 'A', '/next');
  assert.match(r.text, /#1 题：甲/);
});

test('列表 / 选 / 开始 正常', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '/list')).text, /共 2 题/);
  assert.match((await handler.handle('c', 'u1', 'A', '/pick 2')).text, /#2 题：乙/);
  assert.match((await handler.handle('c', 'u1', 'A', '/start')).text, /乙汤面/);
});

test('/pick 缺参数或编号不存在时有提示', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '/pick')).text, /用法：\/pick/);
  assert.match((await handler.handle('c', 'u1', 'A', '/pick 99')).text, /没有找到/);
});

test('未知命令给出帮助指引', async () => {
  const { handler } = await setup();
  const r = await handler.handle('c', 'u1', 'A', '/fly');
  assert.match(r.text, /未知命令/);
  assert.match(r.text, /\/help/);
});

test('/ask 是"提交结论"：逐句核对后打勾打叉，空内容给用法提示', async () => {
  const { handler } = await setup([
    // 整段（判是否通关）
    { isYes: false, yesProb: 0.1, similarity: 0.2, usage: null },
    // 逐句
    { isYes: true, yesProb: 0.9, similarity: 0.2, usage: null },
    { isYes: false, yesProb: 0.1, similarity: 0.1, usage: null },
  ]);
  await handler.handle('c', 'u1', 'A', '/pick 1');
  await handler.handle('c', 'u1', 'A', '/start');

  const empty = await handler.handle('c', 'u1', 'A', '/ask');
  assert.match(empty.text, /用法：\/ask/);

  const r = await handler.handle('c', 'u1', 'A', '/ask 他是自杀的，凶手是医生');
  assert.ok(r.ask, '应返回 ask 结果交给适配器格式化');
  assert.equal(r.ask.type, 'verify');
  assert.equal(r.ask.asker, 'A');
  assert.deepEqual(r.ask.items, [
    { text: '他是自杀的', isYes: true },
    { text: '凶手是医生', isYes: false },
  ]);

  // 适配器格式化后：逐句打勾打叉，且不泄露任何分数
  const { text, users } = formatAskResult(r.ask, { mention: (id) => `[CQ:at,qq=${id}]` });
  assert.deepEqual(users, ['u1']);
  assert.equal(text, '[CQ:at,qq=u1]：\n🧾 逐句核对（2 句）\n✅ 他是自杀的\n❌ 凶手是医生');
  assert.doesNotMatch(text, /%|相似度|\d\.\d/);
});

test('@我 提问仍然是「是 / 不是」，没有被 /ask 改掉', async () => {
  const { handler } = await setup([{ isYes: false, yesProb: 0.1, similarity: 0.2, usage: null }]);
  await handler.handle('c', 'u1', 'A', '/pick 1');
  await handler.handle('c', 'u1', 'A', '/start');

  const r = await handler.handleAsk('c', 'u1', 'A', '他是被谋杀的吗');
  assert.equal(r.type, 'answer');
  assert.equal(r.answer, '❌ 不是。');

  const { text } = formatAskResult(r, { mention: (id) => `[CQ:at,qq=${id}]` });
  assert.equal(text, '[CQ:at,qq=u1]：❌ 不是。');
});

test('逐句核对：每句都对但没通关时，多一句"还没说中核心谜底"', () => {
  const mention = (id) => `[CQ:at,qq=${id}]`;
  const allYes = {
    type: 'verify',
    asker: '小明',
    askerId: 'u1',
    items: [
      { text: '他是自杀的', isYes: true },
      { text: '他留了遗书', isYes: true },
    ],
  };

  const hit = formatAskResult(allYes, { mention });
  assert.equal(
    hit.text,
    '[CQ:at,qq=u1]：\n🧾 逐句核对（2 句）\n✅ 他是自杀的\n✅ 他留了遗书' +
      '\n\n💡 每句都对，但还没说中核心谜底，再往真相推一步。',
  );
  assert.deepEqual(hit.users, ['u1']);
  // 依然不泄露任何分数
  assert.doesNotMatch(hit.text, /%|相似度|\d\.\d/);

  // 有 ❌ 就不加这句（还没到"方向全对"的程度）
  const mixed = { ...allYes, items: [{ text: '他是自杀的', isYes: true }, { text: '凶手是医生', isYes: false }] };
  assert.doesNotMatch(formatAskResult(mixed, { mention }).text, /核心谜底/);

  // 只有一句、判 ❌ 时也不加
  const no = { ...allYes, items: [{ text: '他是被谋杀的', isYes: false }] };
  assert.doesNotMatch(formatAskResult(no, { mention }).text, /核心谜底/);
});

test('换题权限：进行中只有本局发起人能换题', async () => {
  const { handler } = await setup();
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');

  const denied = await handler.handle('c', 'u2', 'B', '/next');
  assert.match(denied.text, /只有发起人 A/);

  const deniedPick = await handler.handle('c', 'u2', 'B', '/pick 2');
  assert.match(deniedPick.text, /只有发起人 A/);

  // 发起人自己可以换
  const ok = await handler.handle('c', 'u1', 'A', '/next');
  assert.match(ok.text, /#2 题：乙/);
});

test('本局结束后任何人都能换题', async () => {
  const { handler } = await setup([{ isYes: true, yesProb: 1, similarity: 0.9, usage: null }]);
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');
  await handler.handleAsk('c', 'u1', 'A', '我完整说出谜底');

  const r = await handler.handle('c', 'u2', 'B', '/next');
  assert.match(r.text, /#2 题：乙/);
});

/* ---------------- 并发：别人冲不掉正在进行的一局 ---------------- */

test('并发：别人不能公布谜底，这一局不会被提前结束', async () => {
  const { handler, gm } = await setup();
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');

  const denied = await handler.handle('c', 'u2', 'B', '/reveal');
  assert.match(denied.text, /只有发起人 A 可以公布谜底/);

  const status = gm.status('c');
  assert.equal(status.revealed, false, '谜底不能因为别人点一下就摊开');
  assert.equal(status.started, true, '本局还得继续');

  // 发起人自己可以公布
  const ok = await handler.handle('c', 'u1', 'A', '/reveal');
  assert.match(ok.text, /谜底公布/);
  assert.equal(gm.status('c').revealed, true);
});

test('并发：别人不能用 /reset 把正在进行的一局清掉', async () => {
  const { handler, gm } = await setup();
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');

  const denied = await handler.handle('c', 'u2', 'B', '/reset');
  assert.match(denied.text, /只有发起人 A 可以重置本局/);
  assert.equal(gm.status('c').started, true, '状态必须还在');
  assert.equal(gm.status('c').questionTitle, '甲', '题目也得还在');

  // 发起人自己可以重置
  const ok = await handler.handle('c', 'u1', 'A', '/reset');
  assert.match(ok.text, /已重置/);
  assert.equal(gm.status('c').hasQuestion, false);
});

test('并发：本局结束后，别人就可以公布/重置了', async () => {
  const { handler, gm } = await setup([{ isYes: true, yesProb: 1, similarity: 0.9, usage: null }]);
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');
  await handler.handleAsk('c', 'u1', 'A', '我完整说出谜底'); // 通关 → 本局结束

  const reveal = await handler.handle('c', 'u2', 'B', '/reveal');
  assert.match(reveal.text, /谜底公布/);

  const reset = await handler.handle('c', 'u2', 'B', '/reset');
  assert.match(reset.text, /已重置/);
  assert.equal(gm.status('c').hasQuestion, false);
});

test('并发：局中别人点旧卡片上的"公布谜底"，走的是同一道校验', async () => {
  const { handler, gm } = await setup();
  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');

  // 卡片按钮最终调用的是 revealModel（适配器里带 userId），校验必须在这里也生效
  const denied = handler.revealModel('c', 'u2');
  assert.equal(denied.ok, false);
  assert.match(denied.msg, /只有发起人 A 可以公布谜底/);
  assert.equal(gm.status('c').revealed, false);

  const ok = handler.revealModel('c', 'u1');
  assert.equal(ok.ok, true);
  assert.equal(ok.question.id, 1);
});

test('并发：A 的提问还在评判时，B 连点公布/重置/换题都冲不掉这一局', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-race-'));
  const file = join(dir, 'questions.json');
  await writeFile(file, JSON.stringify([{ id: 1, title: '甲', puzzle: '甲汤面', answer: '甲汤底' }]), 'utf8');
  const qs = new QuestionStore({ file });
  await qs.load();

  // 把评判卡住，模拟"正在评判"的那几秒
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const gm = new GameManager({
    async judge() {
      await gate;
      return { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };
    },
    async judgeSentences() {
      return { isYes: null, yesProb: 0, similarity: 0, failed: false, items: [] };
    },
  });
  const handler = new CommandHandler(gm, qs);

  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');

  const pending = handler.handleAsk('c', 'u1', 'A', '是谋杀吗');

  // B 在这几秒里连点：三个"冲掉本局"的动作一个都不该成功
  assert.match((await handler.handle('c', 'u2', 'B', '/reveal')).text, /只有发起人 A 可以公布谜底/);
  assert.match((await handler.handle('c', 'u2', 'B', '/reset')).text, /只有发起人 A 可以重置本局/);
  assert.match((await handler.handle('c', 'u2', 'B', '/next')).text, /只有发起人 A 可以换题/);

  const mid = gm.status('c');
  assert.equal(mid.started, true, '本局还得在进行中');
  assert.equal(mid.revealed, false, '谜底不能被别人摊开');
  assert.equal(mid.questionTitle, '甲', '题目不能被别人换掉');

  release();
  const answer = await pending;
  assert.equal(answer.type, 'answer', 'A 的提问照常拿到回答');
  assert.equal(gm.status('c').questionTitle, '甲', '答的还是原来那道题');
  assert.equal(gm.status('c').questionCount, 1);
});

test('状态：未选题与进行中两种文案', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '/status')).text, /当前没有题目/);

  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');
  await handler.handleAsk('c', 'u1', 'A', '问题');
  const status = (await handler.handle('c', 'u1', 'A', '/status')).text;
  assert.match(status, /当前题目：#甲/);
  assert.match(status, /提问次数：1/);
  assert.match(status, /参与人数：1/);
  assert.match(status, /本局发起人：A/);
});

test('历史：空记录与条数文案', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '/history')).text, /还没有提问记录/);

  await handler.handle('c', 'u1', 'A', '/next');
  await handler.handle('c', 'u1', 'A', '/start');
  await handler.handleAsk('c', 'u1', 'A', '问题一');
  const h = (await handler.handle('c', 'u1', 'A', '/history')).text;
  assert.match(h, /共 1 条/);
  assert.match(h, /问题一/);
});

test('公布与重置', async () => {
  const { handler } = await setup();
  assert.match((await handler.handle('c', 'u1', 'A', '/reveal')).text, /还没有题目/);

  await handler.handle('c', 'u1', 'A', '/next');
  assert.match((await handler.handle('c', 'u1', 'A', '/reveal')).text, /甲汤底/);

  const reset = await handler.handle('c', 'u1', 'A', '/reset');
  assert.match(reset.text, /已重置/);
  assert.match((await handler.handle('c', 'u1', 'A', '/status')).text, /当前没有题目/);
});

test('题目库为空时列表有明确提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-empty-'));
  const file = join(dir, 'questions.json');
  await writeFile(file, '[]', 'utf8');
  const qs = new QuestionStore({ file });
  await qs.load();
  const handler = new CommandHandler(new GameManager({ judge: async () => ({}) }), qs);

  assert.match((await handler.handle('c', 'u1', 'A', '/list')).text, /题目库为空/);
  assert.match((await handler.handle('c', 'u1', 'A', '/next')).text, /题目库为空/);
});

test('评判失败时不记录历史，并把原因告诉玩家', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-soup-fail-'));
  const file = join(dir, 'questions.json');
  await writeFile(file, JSON.stringify([{ id: 1, title: '甲', puzzle: '甲汤面', answer: '甲汤底' }]), 'utf8');
  const qs = new QuestionStore({ file });
  await qs.load();

  const judge = {
    async judge() {
      return { isYes: null, yesProb: 0, similarity: 0, usage: null, failed: true, error: 'Vercel AI Gateway 还没有填写 API Key' };
    },
  };
  const handler = new CommandHandler(new GameManager(judge, { winThreshold: 0.8 }), qs);

  await handler.handle('c', 'u1', 'A', '/pick 1');
  await handler.handle('c', 'u1', 'A', '/start');
  const r = await handler.handleAsk('c', 'u1', 'A', '问题');
  assert.equal(r.type, 'hint');
  assert.match(r.text, /评判失败/);
  assert.match(r.text, /API Key/);

  assert.match((await handler.handle('c', 'u1', 'A', '/history')).text, /还没有提问记录/);
});
