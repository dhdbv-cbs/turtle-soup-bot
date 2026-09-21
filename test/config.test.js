// 配置中心单元测试：全部在临时 CONFIG_FILE 上跑，不碰真实 data/config.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-cfg-'));

// 必须在动态 import config 之前：清掉 .env 的影响，保证断言确定性
for (const key of [
  'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'JUDGE_PROVIDER', 'JEV_MODEL',
  'WIN_THRESHOLD', 'YES_THRESHOLD',
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
const { PROVIDER_IDS } = await import('../src/judge/providers.js');

test('首次运行会生成配置文件，并采用安全默认值', async () => {
  await loadConfig();
  assert.equal(CONFIG_FILE, join(dir, 'config.json'));
  assert.equal(config.admin.host, '127.0.0.1');
  assert.equal(config.admin.port, 4319);
  assert.equal(config.judge.winThreshold, 0.8);
  assert.equal(config.judge.provider, 'gateway');
  assert.equal(config.judge.providers.gateway.model, 'typesafe-ai/jev');
  assert.equal(config.discord.enabled, false);
  assert.equal(config.qq.napcat.enabled, false);
  assert.equal(config.qq.official.enabled, false);
  assert.equal(hasPassword(), false);
  // 每个渠道都要有一份独立配置，切换时不用重填
  for (const id of PROVIDER_IDS) {
    assert.ok(config.judge.providers[id], `缺少渠道 ${id} 的默认配置`);
  }
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

test('未知的评判渠道会被拒绝', async () => {
  const r = await updateConfig({ judge: { provider: 'not-a-provider' } });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('judge.provider')));
  assert.equal(config.judge.provider, 'gateway');
});

test('切换评判渠道：每个渠道的密钥各自保存', async () => {
  let r = await updateConfig({
    judge: {
      providers: {
        gateway: { apiKey: 'gateway-key', model: 'typesafe-ai/jev' },
        typesafe: { apiKey: 'typesafe-key', model: 'jev-latest' },
      },
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));

  r = await updateConfig({ judge: { provider: 'typesafe' } });
  assert.equal(r.ok, true);
  assert.equal(config.judge.provider, 'typesafe');
  assert.equal(config.judge.providers.gateway.apiKey, 'gateway-key', '切走不应清掉原渠道的密钥');
  assert.equal(config.judge.providers.typesafe.apiKey, 'typesafe-key');

  const onDisk = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(onDisk.judge.provider, 'typesafe');
  assert.equal(onDisk.judge.providers.typesafe.apiKey, 'typesafe-key');

  await updateConfig({ judge: { provider: 'gateway' } });
});

test('自定义网关必须填 Base URL', async () => {
  const bad = await updateConfig({ judge: { provider: 'custom', providers: { custom: { model: 'x' } } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('Base URL')));
  assert.equal(config.judge.provider, 'gateway', '校验失败不应改变当前渠道');

  const good = await updateConfig({
    judge: { provider: 'custom', providers: { custom: { baseURL: 'https://gw.example.com', model: 'typesafe-ai/jev' } } },
  });
  assert.equal(good.ok, true);
  assert.equal(config.judge.provider, 'custom');

  await updateConfig({ judge: { provider: 'gateway' } });
});

test('对外配置视图里所有渠道的密钥都是掩码', () => {
  const view = publicConfig();
  assert.equal(view.judge.providers.gateway.apiKey, SECRET_MASK);
  assert.equal(view.judge.providers.typesafe.apiKey, SECRET_MASK);
  assert.equal(view.judge.providers.gateway.apiKeySet, true);
  assert.equal(view.judge.providers.openai.apiKey, '');
  assert.equal(view.judge.providers.openai.apiKeySet, false);

  const json = JSON.stringify(view);
  assert.ok(!json.includes('gateway-key'), '明文不能出现在对外视图里');
  assert.ok(!json.includes('typesafe-key'), '明文不能出现在对外视图里');
  assert.ok(!json.includes('abcd1234'));
});

test('密钥字段语义：留空保持、null 清空', async () => {
  let r = await updateConfig({ judge: { providers: { gateway: { apiKey: '' } } } });
  assert.equal(r.ok, true);
  assert.equal(config.judge.providers.gateway.apiKey, 'gateway-key', '空串应保持原值');

  r = await updateConfig({ judge: { providers: { gateway: { apiKey: null } } } });
  assert.equal(r.ok, true);
  assert.equal(config.judge.providers.gateway.apiKey, '', 'null 应清空');
  assert.equal(publicConfig().judge.providers.gateway.apiKeySet, false);
});

test('密码：太短会被拒绝，设置后可以校验', async () => {
  await assert.rejects(() => setPassword('123'), /至少/);
  await setPassword('abcd1234');
  assert.equal(hasPassword(), true);
  assert.equal(verifyPassword('abcd1234'), true);
  assert.equal(verifyPassword('wrong-pass'), false);

  const view = publicConfig();
  assert.equal(view.admin.hasPassword, true);
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

test('旧配置（judge.apiKey / judge.model）会自动迁移到 gateway 渠道', () => {
  const problems = [];
  const c = coerceConfig({ judge: { apiKey: 'legacy-key', model: 'typesafe-ai/jev-latest' } }, problems);
  assert.equal(c.judge.provider, 'gateway');
  assert.equal(c.judge.providers.gateway.apiKey, 'legacy-key');
  assert.equal(c.judge.providers.gateway.model, 'typesafe-ai/jev-latest');
  assert.deepEqual(problems, []);
});

test('配置问题会被记录下来，但不会让进程崩掉', async () => {
  await loadConfig();
  assert.ok(Array.isArray(configProblems));
  assert.ok(configProblems.every((p) => typeof p === 'string'));
});
