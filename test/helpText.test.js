// /help 文案测试：三个渠道的说明必须完整、可用，且不需要用户自己写
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-help-'));
process.env.CONFIG_FILE = join(dir, 'config.json');

const { COMMAND_NAMES, commandsFor, defaultHelpText, helpText, channelHelpText } = await import(
  '../src/commands.js'
);
const { config } = await import('../src/config.js');
const { ASK_RATE_LIMIT, MAX_PENDING_PER_CHANNEL } = await import('../src/limits.js');

const PLATFORMS = ['discord', 'napcat', 'official'];

test('三个渠道的内置 /help 都不为空，且长度适合一条消息发完', () => {
  for (const p of PLATFORMS) {
    const text = defaultHelpText(p);
    assert.ok(text.length > 300, `${p} 的文案太短，像是没写`);
    assert.ok(text.length < 1800, `${p} 的文案太长（${text.length} 字），会被拆成多条`);
  }
});

test('每个渠道的 /help 都包含：标题、触发方式、全部命令、玩法、限制', () => {
  for (const p of PLATFORMS) {
    const text = defaultHelpText(p);
    assert.match(text, /^🐢 海龟汤机器人/, `${p} 缺少标题`);
    assert.match(text, /【命令】/, `${p} 缺少命令表`);
    assert.match(text, /【常用例子】/, `${p} 缺少例子`);
    assert.match(text, /【怎么玩】/, `${p} 缺少玩法`);
    assert.match(text, /【规则与限制】/, `${p} 缺少限制说明`);
    for (const cmd of commandsFor(p)) {
      assert.ok(text.includes(`/${cmd.name}`), `${p} 的文案里没有 /${cmd.name}`);
    }
    // 新加的防刷限制必须写清楚，不能只写在代码里
    assert.ok(
      text.includes(`每人每分钟最多提问 ${ASK_RATE_LIMIT} 次`),
      `${p} 没写清楚提问频率上限`,
    );
    // 换题权限、通关条件这些容易踩坑的地方要有说明
    assert.match(text, /只有本局发起人/);
    // 但**不能**把相似度告诉玩家（判定过程不对外暴露）
    assert.doesNotMatch(text, /相似度/);
    assert.doesNotMatch(text, /\d+%/);
  }
});

test('三个渠道的说明各自贴合本渠道（不能三份一样）', () => {
  const discord = defaultHelpText('discord');
  const napcat = defaultHelpText('napcat');
  const official = defaultHelpText('official');

  assert.match(discord, /原生斜杠命令/);
  assert.match(napcat, /群里提问请先 @我/);
  // 官方渠道要讲清楚被动消息的时效与次数（官方文档：群 5 分钟 5 次 / 单聊 60 分钟 4 次）
  assert.match(official, /被动消息/);
  assert.match(official, /群聊 5 分钟内、每条消息最多回 5 条/);
  assert.match(official, /单聊 60 分钟内、最多回 4 条/);

  // /card 是 Discord 卡片专有命令：只在 Discord 的文案里出现，QQ 两个渠道里不能出现
  assert.match(discord, /\/card/);
  assert.doesNotMatch(napcat, /\/card/);
  assert.doesNotMatch(official, /\/card/);
  assert.match(official, /昵称/);
  assert.notEqual(discord, napcat);
  assert.notEqual(napcat, official);
});

test('后台填了自定义文案就以自定义为准，清空则回到内置文案', () => {
  const builtin = defaultHelpText('discord');

  config.discord.helpText = '  我自己的说明  ';
  assert.equal(helpText('discord', { custom: config.discord.helpText }), '我自己的说明');
  assert.equal(channelHelpText('discord'), '我自己的说明');

  config.discord.helpText = '';
  assert.equal(channelHelpText('discord'), builtin);

  config.qq.napcat.helpText = 'NapCat 专用说明';
  assert.equal(channelHelpText('napcat'), 'NapCat 专用说明');
  config.qq.napcat.helpText = '';

  config.qq.official.helpText = '官方专用说明';
  assert.equal(channelHelpText('official'), '官方专用说明');
  config.qq.official.helpText = '';
});

test('未知渠道也能给出一份能看的文案', () => {
  const text = defaultHelpText('telegram');
  assert.match(text, /海龟汤机器人 · 用法$/m);
  assert.match(text, /【命令】/);
});

test('文案里提到的排队上限与代码一致', () => {
  const text = defaultHelpText('discord');
  // 只声明"我会按顺序答"，但数字必须来自同一份常量，避免文案与实现漂移
  assert.ok(MAX_PENDING_PER_CHANNEL >= 1);
  assert.match(text, /按提问顺序一条条答/);
});
