// Discord 斜杠命令注册：只保留「全局」一份，并清掉旧版本留在各服务器里的重复命令。
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSignature, syncDiscordCommands } from '../src/platforms/discordCommands.js';

const COMMANDS = [
  { name: 'help', description: '查看帮助' },
  {
    name: 'ask',
    description: '提问',
    options: [{ name: 'question', description: '你的问题', type: 3, required: true }],
  },
];

function stubApplication({ existing = [] } = {}) {
  const calls = [];
  return {
    calls,
    commands: {
      async fetch() {
        return new Map(existing.map((c, i) => [String(i), c]));
      },
      async set(list) {
        calls.push(list);
      },
    },
  };
}

function stubGuild(name, own = []) {
  const cleared = [];
  return {
    name,
    cleared,
    commands: {
      async fetch() {
        return new Map(own.map((c, i) => [String(i), c]));
      },
      async set(list) {
        cleared.push(list);
      },
    },
  };
}

test('命令签名忽略 Discord 返回的额外字段，只比较命令本身', () => {
  const fromApi = [
    { id: '1', application_id: 'x', version: '9', name: 'help', description: '查看帮助' },
    {
      id: '2',
      application_id: 'x',
      name: 'ask',
      description: '提问',
      options: [{ id: '3', name: 'question', description: '你的问题', type: 3, required: true }],
    },
  ];
  assert.equal(commandSignature(fromApi), commandSignature(COMMANDS));
  // 顺序不同也算相同
  assert.equal(commandSignature([...fromApi].reverse()), commandSignature(COMMANDS));
  // 描述改了就应该重注册
  assert.notEqual(commandSignature([{ name: 'help', description: '别的' }]), commandSignature([{ name: 'help', description: '查看帮助' }]));
});

test('命令没变化时不重复注册，也不去动服务器', async () => {
  const app = stubApplication({ existing: COMMANDS });
  const guild = stubGuild('甲服', []);
  const logs = [];
  const r = await syncDiscordCommands({
    application: app,
    guilds: [guild],
    commands: COMMANDS,
    log: (...a) => logs.push(a.join(' ')),
  });

  assert.deepEqual(app.calls, [], '内容一样就不该再 PUT 一次');
  assert.equal(r.unchanged, true);
  assert.equal(r.registered, false);
  assert.equal(r.cleaned, 0);
  assert.deepEqual(guild.cleared, [], '服务器本来就没有命令，不该乱清');
  assert.ok(logs.some((l) => l.includes('无变化')));
});

test('命令有变化时注册到全局，并清掉服务器里重复的那一份', async () => {
  const app = stubApplication({ existing: [{ name: 'help', description: '旧描述' }] });
  const guildA = stubGuild('甲服', [{ name: 'help', description: '查看帮助' }]);
  const guildB = stubGuild('乙服', [{ name: 'help', description: '查看帮助' }]);
  const guildC = stubGuild('丙服', []);
  const logs = [];
  const r = await syncDiscordCommands({
    application: app,
    guilds: [guildA, guildB, guildC],
    commands: COMMANDS,
    log: (...a) => logs.push(a.join(' ')),
  });

  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.calls[0], COMMANDS);
  assert.equal(r.registered, true);
  assert.equal(r.cleaned, 2);
  assert.deepEqual(guildA.cleared, [[]], '服务器级的命令要清空');
  assert.deepEqual(guildB.cleared, [[]]);
  assert.deepEqual(guildC.cleared, [], '没有重复的就不用调接口');
  assert.ok(logs.some((l) => l.includes('/help')));
  assert.ok(logs.some((l) => l.includes('已清理 2 个服务器')));
});

test('注册或清理失败只记警告，不往上抛', async () => {
  const warnings = [];
  const app = {
    commands: {
      async fetch() {
        throw new Error('网络不通');
      },
      async set() {
        throw new Error('不该被调用');
      },
    },
  };
  const guild = {
    name: '甲服',
    id: '1',
    commands: {
      async fetch() {
        throw new Error('权限不足');
      },
      async set() {},
    },
  };
  const r = await syncDiscordCommands({
    application: app,
    guilds: [guild],
    commands: COMMANDS,
    warn: (...a) => warnings.push(a.join(' ')),
  });

  assert.equal(r.failed, true);
  assert.equal(r.registered, false);
  assert.equal(r.cleaned, 0);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0].includes('注册失败'));
  assert.ok(warnings[1].includes('甲服'));
});

test('没有服务器时也能正常注册（新装的机器人还没被拉进服务器）', async () => {
  const app = stubApplication({ existing: [] });
  const r = await syncDiscordCommands({ application: app, guilds: [], commands: COMMANDS });
  assert.equal(r.registered, true);
  assert.equal(r.cleaned, 0);
  assert.deepEqual(app.calls, [COMMANDS]);
});
