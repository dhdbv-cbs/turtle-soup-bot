// 评判渠道测试：验证"一套代码 + 多个平台"的接线是通的
//
// 关键点：createEvaluationModel() 只是构造模型实例，不发网络请求，
// 所以这里可以在完全离线的情况下确认每个渠道都能拿到合法的 evaluation model。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-judge-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
// 清掉 .env 里的示例密钥，保证 readiness 断言确定
for (const key of [
  'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
]) {
  process.env[key] = '';
}

const {
  PROVIDERS,
  PROVIDER_IDS,
  providerMeta,
  defaultProviderEntries,
  createEvaluationModel,
  judgeReadiness,
  judgeSignature,
  installedMap,
  providerInstalled,
} = await import('../src/judge/providers.js');

function entry(over = {}) {
  return { apiKey: 'test-key', baseURL: '', model: 'test-model', ...over };
}

test('渠道登记表本身是完整的', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '渠道 id 不能重复');
  for (const p of PROVIDERS) {
    assert.ok(p.label, `${p.id} 缺少 label`);
    assert.ok(p.pkg, `${p.id} 缺少依赖包名`);
    assert.ok(p.factory, `${p.id} 缺少工厂函数名`);
    assert.ok(p.note, `${p.id} 缺少说明`);
  }
  assert.deepEqual(Object.keys(defaultProviderEntries()).sort(), [...PROVIDER_IDS].sort());
});

test('readiness：缺模型 / 缺 Key / 缺 Base URL 各有明确原因', () => {
  const judge = (over) => ({
    provider: 'gateway',
    providers: { gateway: entry(over) },
  });

  assert.equal(judgeReadiness(judge({})).ready, true);

  const noModel = judgeReadiness({ provider: 'gateway', providers: { gateway: entry({ model: '' }) } });
  assert.equal(noModel.ready, false);
  assert.match(noModel.reason, /模型 ID/);

  const noKey = judgeReadiness({ provider: 'gateway', providers: { gateway: entry({ apiKey: '' }) } });
  assert.equal(noKey.ready, false);
  assert.match(noKey.reason, /API Key/);

  const unknown = judgeReadiness({ provider: 'nope', providers: {} });
  assert.equal(unknown.ready, false);
  assert.match(unknown.reason, /未知的评判渠道/);
});

test('readiness：自建网关必须填 Base URL，可以不填 Key', () => {
  const base = { provider: 'custom', providers: { custom: entry({ apiKey: '' }) } };
  const missing = judgeReadiness(base);
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /Base URL/);

  const ok = judgeReadiness({
    provider: 'custom',
    providers: { custom: entry({ apiKey: '', baseURL: 'https://gw.example.com' }) },
  });
  assert.equal(ok.ready, true, JSON.stringify(ok));
});

test('readiness：环境变量里的密钥也算数，示例占位符不算', () => {
  const config = { provider: 'gateway', providers: { gateway: entry({ apiKey: '' }) } };

  process.env.AI_GATEWAY_API_KEY = 'your-vck-key-here';
  assert.equal(judgeReadiness(config).ready, false, '示例占位符不应算配置好');

  process.env.AI_GATEWAY_API_KEY = 'vck_real_key';
  assert.equal(judgeReadiness(config).ready, true);
  process.env.AI_GATEWAY_API_KEY = '';
});

test('每个已安装渠道都能造出合法的 evaluation model（不发请求）', async () => {
  const installed = await installedMap();
  const cases = [
    ['gateway', 'typesafe-ai/jev', ''],
    ['custom', 'typesafe-ai/jev', 'https://gw.example.com'],
    ['typesafe', 'jev-latest', ''],
    ['openai', 'gpt-5.6-luna', ''],
    ['anthropic', 'claude-haiku-4-5-20251001', ''],
    ['google', 'gemini-3.5-flash-lite', ''],
  ];

  for (const [id, model, baseURL] of cases) {
    if (!installed[id]) continue; // 可选依赖没装就跳过
    const m = await createEvaluationModel(id, entry({ model, baseURL }));
    assert.ok(m, `${id} 应返回模型实例`);
    assert.equal(typeof m, 'object');
    assert.equal(m.specificationVersion, 'v4', `${id} 应返回 evaluation model`);
    assert.equal(typeof m.doEvaluate, 'function', `${id} 应实现 doEvaluate`);
  }
});

test('内置渠道开箱可用，未知渠道给出可操作报错', async () => {
  assert.equal(providerMeta('gateway').builtin, true);
  await assert.rejects(() => createEvaluationModel('nope', entry()), /未知的评判渠道/);

  const installed = await installedMap();
  for (const id of PROVIDER_IDS) {
    assert.equal(typeof installed[id], 'boolean', `${id} 应有安装状态`);
  }
  assert.equal(await providerInstalled('gateway'), true);
});

test('渠道签名随配置变化，用于判断要不要重建模型', () => {
  const a = judgeSignature({ provider: 'gateway', providers: { gateway: entry() } });
  const b = judgeSignature({ provider: 'gateway', providers: { gateway: entry({ apiKey: 'other' }) } });
  const c = judgeSignature({ provider: 'typesafe', providers: { gateway: entry(), typesafe: entry() } });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, judgeSignature({ provider: 'gateway', providers: { gateway: entry() } }));
});
