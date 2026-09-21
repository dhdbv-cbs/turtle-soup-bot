// 评判渠道测试：验证"一套代码 + 多个 Jev 入口"的接线是通的
//
// 关键点：createEvaluationModel() 只是构造模型实例，不发网络请求，
// 所以这里可以在完全离线的情况下确认每个入口都能拿到合法的 evaluation model。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-judge-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
// 清掉 .env 里的示例密钥，保证 readiness 断言确定
for (const key of ['AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY']) {
  process.env[key] = '';
}

const {
  PROVIDERS,
  PROVIDER_IDS,
  providerMeta,
  providerTargets,
  resolveTarget,
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

test('渠道登记表只保留 Jev 入口，且字段完整', () => {
  assert.deepEqual(PROVIDER_IDS, ['gateway', 'typesafe', 'custom'], '不接普通 LLM 渠道');
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '渠道 id 不能重复');
  for (const p of PROVIDERS) {
    assert.ok(p.label, `${p.id} 缺少 label`);
    assert.ok(p.note, `${p.id} 缺少说明`);
    if (!p.protocols) {
      assert.ok(p.pkg, `${p.id} 缺少依赖包名`);
      assert.ok(p.factory, `${p.id} 缺少工厂函数名`);
    }
  }
  assert.deepEqual(Object.keys(defaultProviderEntries()).sort(), [...PROVIDER_IDS].sort());
});

test('第三方转发支持两种中转协议，默认 TypeSafe 协议', () => {
  const meta = providerMeta('custom');
  assert.deepEqual(providerTargets(meta).map((t) => t.id), ['typesafe', 'gateway']);
  assert.equal(resolveTarget('custom', {}).target.id, 'typesafe');
  assert.equal(resolveTarget('custom', { protocol: 'gateway' }).target.id, 'gateway');
  // 老配置没写协议名、但填了 Base URL → 按旧行为（AI Gateway 协议）迁移
  assert.equal(providerMeta('custom').legacyProtocol, 'gateway');
  assert.throws(() => resolveTarget('custom', { protocol: 'nope' }), /不支持协议/);
});

test('readiness：缺模型 / 缺 Key / 缺 Base URL 各有明确原因', () => {
  assert.equal(judgeReadiness({ provider: 'gateway', providers: { gateway: entry() } }).ready, true);

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

test('readiness：第三方转发必须填 Base URL', () => {
  const base = { provider: 'custom', providers: { custom: entry() } };
  const missing = judgeReadiness(base);
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /Base URL/);

  const ok = judgeReadiness({
    provider: 'custom',
    providers: { custom: entry({ baseURL: 'https://jev.example.com', model: 'jev-latest' }) },
  });
  assert.equal(ok.ready, true, JSON.stringify(ok));
  assert.equal(ok.target.id, 'typesafe');
});

test('readiness：环境变量里的密钥也算数，示例占位符不算', () => {
  const config = { provider: 'gateway', providers: { gateway: entry({ apiKey: '' }) } };

  process.env.AI_GATEWAY_API_KEY = 'your-vck-key-here';
  assert.equal(judgeReadiness(config).ready, false, '示例占位符不应算配置好');

  process.env.AI_GATEWAY_API_KEY = 'vck_real_key';
  assert.equal(judgeReadiness(config).ready, true);
  process.env.AI_GATEWAY_API_KEY = '';
});

test('每个入口（含中转协议）都能造出合法的 evaluation model（不发请求）', async () => {
  const cases = [
    ['gateway', { model: 'typesafe-ai/jev' }],
    ['typesafe', { model: 'jev-latest' }],
    ['custom', { model: 'jev-latest', baseURL: 'https://jev.example.com', protocol: 'typesafe' }],
    ['custom', { model: 'typesafe-ai/jev', baseURL: 'https://jev.example.com', protocol: 'gateway' }],
  ];

  for (const [id, over] of cases) {
    const m = await createEvaluationModel(id, entry(over));
    assert.ok(m, `${id}/${over.protocol || ''} 应返回模型实例`);
    assert.equal(typeof m, 'object');
    assert.equal(m.specificationVersion, 'v4', `${id} 应返回 evaluation model`);
    assert.equal(typeof m.doEvaluate, 'function', `${id} 应实现 doEvaluate`);
  }
});

test('内置入口开箱可用，未知渠道给出可操作报错', async () => {
  assert.equal(providerMeta('gateway').builtin, true);
  await assert.rejects(() => createEvaluationModel('nope', entry()), /未知的评判渠道/);

  const installed = await installedMap();
  for (const id of PROVIDER_IDS) {
    assert.equal(typeof installed[id].installed, 'boolean', `${id} 应有安装状态`);
  }
  assert.equal(await providerInstalled('gateway'), true);
  assert.equal(installed.gateway.protocols.gateway, true, 'AI Gateway 是内置依赖');
});

test('渠道签名随配置变化，用于判断要不要重建模型', () => {
  const a = judgeSignature({ provider: 'gateway', providers: { gateway: entry() } });
  const b = judgeSignature({ provider: 'gateway', providers: { gateway: entry({ apiKey: 'other' }) } });
  const c = judgeSignature({ provider: 'typesafe', providers: { gateway: entry(), typesafe: entry() } });
  const d = judgeSignature({
    provider: 'custom',
    providers: { custom: entry({ protocol: 'typesafe' }) },
  });
  const e = judgeSignature({
    provider: 'custom',
    providers: { custom: entry({ protocol: 'gateway' }) },
  });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(d, e, '换协议要重建模型');
  assert.equal(a, judgeSignature({ provider: 'gateway', providers: { gateway: entry() } }));
});
