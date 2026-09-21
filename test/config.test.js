// 配置中心单元测试：全部在临时 CONFIG_FILE 上跑，不碰真实 data/config.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-cfg-'));

// 必须在动态 import config 之前：清掉 .env 的影响，保证断言确定性
for (const key of [
  'AI_GATEWAY_API_KEY', 'JEV_MODEL', 'WIN_THRESHOLD', 'YES_THRESHOLD',
  'DISCORD_ENABLED', 'DISCORD_TOKEN', 'DISCORD_PREFIX',
  'QQ_ENABLED', 'ONEBOT_WS_URL', 'ONEBOT_ACCESS_TOKEN', 'QQ_PREFIX',
  'ADMIN_HOST', 'ADMIN_PORT', 'ADMIN_TOKEN', 'QQ_OFFICIAL_ENABLED',
]) {
  process.env[key] = '';
}
process.env.CONFIG_FILE = join(dir, 'config.json');

const {
  config,
  configProblems,
  loadConfig,
  updateConfig,
  publicConfig,
  hasPassword,
  setPassword,
  verifyPassword,
  coerceConfig,
  SECRET_MASK,
  CONFIG_FILE,
} = await import('../src/config.js');

test('首次运行会生成配置文件，并采用安全默认值', async () => {
  await loadConfig();
  assert.equal(CONFIG_FILE, join(dir, 'config.json'));
  assert.equal(config.admin.host, '127.0.0.1');
  assert.equal(config.admin.port, 4319);
  assert.equal(config.judge.winThreshold, 0.8);
  assert.equal(config.judge.model, 'typesafe-ai/jev');
  assert.equal(config.discord.enabled, false);
  assert.equal(config.qq.napcat.enabled, false);
  assert.equal(config.qq.official.enabled, false);
  assert.equal(hasPassword(), false);
});

test('非法值被拒绝，且不会污染已生效的配置', async () => {
  const before = config.judge.winThreshold;
  const r = await updateConfig({ judge: { winThreshold: 2 }, admin: { port: 99999 } });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.some((p) => p.includes('judge.winThreshold')));
  assert.ok(r.problems.some((p) => p.includes('admin.port')));
  assert.equal(config.judge.winThreshold, before);
  assert.equal(config.admin.port, 4319);
});

test('合法更新会写盘并可被重新读取', async () => {
  const r = await updateConfig({
    judge: { winThreshold: 0.9, model: 'typesafe-ai/jev' },
    discord: { enabled: true, prefix: '!', token: 'discord-token-abc' },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));

  const onDisk = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(onDisk.judge.winThreshold, 0.9);
  assert.equal(onDisk.discord.enabled, true);
  assert.equal(onDisk.discord.token, 'discord-token-abc');
});

test('对外配置视图里的密钥一律是掩码', () => {
  const view = publicConfig();
  assert.equal(view.discord.token, SECRET_MASK);
  assert.equal(view.discord.tokenSet, true);
  assert.ok(!JSON.stringify(view).includes('discord-token-abc'), '明文不能出现在对外视图里');
});

test('密钥字段语义：留空保持、null 清空', async () => {
  let r = await updateConfig({ discord: { token: '' } });
  assert.equal(r.ok, true);
  assert.equal(config.discord.token, 'discord-token-abc', '空串应保持原值');

  r = await updateConfig({ discord: { token: null } });
  assert.equal(r.ok, true);
  assert.equal(config.discord.token, '', 'null 应清空');
  assert.equal(publicConfig().discord.tokenSet, false);
});

test('密码：太短会被拒绝，设置后可以校验', async () => {
  await assert.rejects(() => setPassword('123'), /至少/);
  await setPassword('abcd1234');
  assert.equal(hasPassword(), true);
  assert.equal(verifyPassword('abcd1234'), true);
  assert.equal(verifyPassword('wrong-pass'), false);

  const view = publicConfig();
  assert.equal(view.admin.hasPassword, true);
  assert.ok(!JSON.stringify(view).includes('abcd1234'));
  assert.ok(!JSON.stringify(view).includes(config.admin.passwordHash));
});

test('coerceConfig 把脏输入归一化成完整配置', () => {
  const problems = [];
  const c = coerceConfig(
    { judge: { winThreshold: '0.5' }, qq: { napcat: { wsUrl: 'http://x', enabled: 'yes' } } },
    problems,
  );
  assert.equal(c.judge.winThreshold, 0.5);
  assert.equal(c.qq.napcat.enabled, true);
  assert.equal(c.qq.napcat.wsUrl, 'ws://127.0.0.1:3001', '非 ws 地址应回退默认值');
  assert.ok(problems.some((p) => p.includes('wsUrl')));
});
