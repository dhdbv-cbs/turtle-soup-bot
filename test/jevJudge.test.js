// 评判层单元测试：只测纯逻辑与"未配置"分支，绝不发起真实请求
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在动态 import 之前：清空密钥/隔离配置文件，确保走"未配置"分支
const dir = await mkdtemp(join(tmpdir(), 'turtle-judge-unit-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
for (const key of ['AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'JUDGE_PROVIDER', 'JEV_MODEL']) {
  process.env[key] = '';
}

const { config } = await import('../src/config.js');
const { JevJudge, scoreToSimilarity, SIMILARITY_LEVELS } = await import('../src/game/JevJudge.js');

test('score 分数归一化到 0~1', () => {
  assert.equal(scoreToSimilarity(0), 0);
  assert.equal(scoreToSimilarity(1), 0.25);
  assert.equal(scoreToSimilarity(2), 0.5);
  assert.equal(scoreToSimilarity(4), 1);
  assert.equal(scoreToSimilarity(2, 3), 1); // 3 个等级时满分是 2
});

test('越界或非法 score 一律夹取，不会产生 NaN/越界相似度', () => {
  assert.equal(scoreToSimilarity(99), 1);
  assert.equal(scoreToSimilarity(-5), 0);
  assert.equal(scoreToSimilarity(undefined), 0);
  assert.equal(scoreToSimilarity(NaN), 0);
  assert.equal(scoreToSimilarity('不是数字'), 0);
});

test('相似度等级表至少 2 级（score 题型要求）', () => {
  assert.ok(SIMILARITY_LEVELS.length >= 2);
});

test('没配 API Key 时：明确失败、给出原因、不联网、不抛异常', async () => {
  const judge = new JevJudge();
  const r = await judge.judge({ puzzle: '汤面', answer: '汤底' }, '是这样吗');

  assert.equal(r.failed, true, '应标记为失败，让 GameManager 不要记入历史');
  assert.match(r.error, /API Key/);
  assert.equal(r.isYes, null);
  assert.equal(r.yesProb, 0);
  assert.equal(r.similarity, 0);
  assert.equal(r.usage, null);
});

test('渠道没配好时 readiness() 直接告诉后台原因', () => {
  const judge = new JevJudge();
  const r = judge.readiness();
  assert.equal(r.ready, false);
  assert.match(r.reason, /Key|模型/);
});

test('切换渠道后报错信息会跟着变', async () => {
  const judge = new JevJudge();
  const original = { ...config.judge.providers.custom };
  config.judge.provider = 'custom';
  try {
    // 第三方转发默认带模型名，先清掉看看"缺模型"的提示
    config.judge.providers.custom.model = '';
    const noModel = await judge.judge({ puzzle: '汤面', answer: '汤底' }, '问题');
    assert.equal(noModel.failed, true);
    assert.match(noModel.error, /模型 ID/);

    config.judge.providers.custom.model = 'jev-latest';
    const noBase = await judge.judge({ puzzle: '汤面', answer: '汤底' }, '问题');
    assert.equal(noBase.failed, true);
    assert.match(noBase.error, /Base URL/);

    config.judge.providers.custom.baseURL = 'https://jev.example.com';
    config.judge.providers.custom.apiKey = '';
    const noKey = await judge.judge({ puzzle: '汤面', answer: '汤底' }, '问题');
    assert.equal(noKey.failed, true);
    assert.match(noKey.error, /API Key/);
  } finally {
    config.judge.provider = 'gateway';
    Object.assign(config.judge.providers.custom, original);
  }
});

test('模型实例按渠道签名缓存，配置变了才重建', async () => {
  const judge = new JevJudge();
  config.judge.providers.gateway.apiKey = 'test-key';
  config.judge.providers.gateway.model = 'typesafe-ai/jev';

  const first = await judge.resolveModel();
  const second = await judge.resolveModel();
  assert.equal(first, second, '配置没变应复用同一个模型实例');

  config.judge.providers.gateway.model = 'typesafe-ai/jev-latest';
  const third = await judge.resolveModel();
  assert.notEqual(first, third, '模型变化应重建');

  config.judge.providers.gateway.apiKey = '';
  config.judge.providers.gateway.model = 'typesafe-ai/jev';
});
