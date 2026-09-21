// 运行时通道管理测试：用注入的假适配器，不产生任何真实连接
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-rt-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
for (const key of [
  'AI_GATEWAY_API_KEY', 'DISCORD_ENABLED', 'DISCORD_TOKEN', 'QQ_ENABLED', 'ONEBOT_WS_URL',
]) {
  process.env[key] = '';
}

const { config, defaultConfig } = await import('../src/config.js');
const { BotRuntime } = await import('../src/runtime.js');

function resetConfig() {
  Object.assign(config, defaultConfig());
}

function makeRuntime() {
  const log = [];
  const mk = (name) => () => {
    log.push(`start:${name}`);
    return {
      name,
      status: () => ({ state: 'connected', detail: `${name} ok` }),
      stop: () => log.push(`stop:${name}`),
    };
  };
  const runtime = new BotRuntime({}, {
    factories: { discord: mk('discord'), napcat: mk('napcat'), official: mk('official') },
  });
  return { runtime, log };
}

test('未启用时不会启动任何适配器，状态为 disabled', async () => {
  resetConfig();
  const { runtime, log } = makeRuntime();
  await runtime.apply();

  assert.deepEqual(log, []);
  const s = runtime.status();
  assert.equal(s.discord.state, 'disabled');
  assert.equal(s.napcat.state, 'disabled');
  assert.equal(s.official.state, 'disabled');
});

test('启用 Discord 后启动；配置未变化时不会重复启动', async () => {
  resetConfig();
  config.discord.enabled = true;
  config.discord.token = 'token-1';
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  assert.deepEqual(log, ['start:discord']);
  assert.equal(runtime.status().discord.state, 'connected');

  await runtime.apply();
  assert.deepEqual(log, ['start:discord'], '配置没变不应重启');
});

test('配置变化会重启对应通道', async () => {
  resetConfig();
  config.discord.enabled = true;
  config.discord.token = 'token-1';
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  config.discord.token = 'token-2'; // 换了 Token 应该重连
  await runtime.apply();

  assert.deepEqual(log, ['start:discord', 'stop:discord', 'start:discord']);
});

test('只改 /help 文案不需要重连通道（调用时才读取）', async () => {
  resetConfig();
  config.discord.enabled = true;
  config.discord.token = 'token-1';
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  config.discord.helpText = '本服专用说明';
  await runtime.apply();
  config.qq.napcat.helpText = 'NapCat 说明';
  await runtime.apply();

  assert.deepEqual(log, ['start:discord'], 'help 文案不影响连接，不应重启');
});

test('启用但缺 Token 时标记为待配置且不启动', async () => {
  resetConfig();
  config.discord.enabled = true;
  config.discord.token = '';
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  assert.deepEqual(log, []);
  const s = runtime.status().discord;
  assert.equal(s.state, 'unconfigured');
  assert.match(s.detail, /Token/);
});

test('关闭开关会停掉已启动的通道', async () => {
  resetConfig();
  config.qq.napcat.enabled = true;
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  assert.deepEqual(log, ['start:napcat']);

  config.qq.napcat.enabled = false;
  await runtime.apply();
  assert.deepEqual(log, ['start:napcat', 'stop:napcat']);
  assert.equal(runtime.status().napcat.state, 'disabled');
});

test('QQ 官方机器人缺 AppSecret 时给出明确原因', async () => {
  resetConfig();
  config.qq.official.enabled = true;
  config.qq.official.appId = '102000000';
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  assert.deepEqual(log, []);
  const s = runtime.status().official;
  assert.equal(s.state, 'unconfigured');
  assert.match(s.detail, /AppSecret/);
});

test('stopAll 会停掉全部通道', async () => {
  resetConfig();
  config.discord.enabled = true;
  config.discord.token = 'token-1';
  config.qq.napcat.enabled = true;
  const { runtime, log } = makeRuntime();

  await runtime.apply();
  await runtime.stopAll();
  assert.deepEqual(log, ['start:discord', 'start:napcat', 'stop:discord', 'stop:napcat']);
  assert.equal(runtime.adapters.discord, null);
  assert.equal(runtime.adapters.napcat, null);
});
