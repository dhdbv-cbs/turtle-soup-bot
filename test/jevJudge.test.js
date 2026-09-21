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
const {
  JevJudge,
  scoreToSimilarity,
  SIMILARITY_LEVELS,
  buildState,
  buildSentenceQuestions,
} = await import('../src/game/JevJudge.js');

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

test('逐句核对：整段一起发给 Jev，代词才有先行词（回归：硬抠单句）', () => {
  const question = { puzzle: '汤面', answer: '汤底' };
  const full = '我爱海龟汤，它很好喝';
  const state = buildState(question, full);

  // 整段在 state 里，Jev 能看到"它"指的是海龟汤
  assert.match(state, /【玩家发言】\n我爱海龟汤，它很好喝/);
  assert.match(state, /【完整谜底/);

  const questions = buildSentenceQuestions(['我爱海龟汤', '它很好喝']);
  const ids = Object.keys(questions);
  assert.deepEqual(ids, ['s1', 's2'], '每句一个问题，都在同一次调用里');

  for (const id of ids) {
    assert.equal(questions[id].type, 'boolean');
    // AI SDK 的校验：boolean 题的 criteria 只允许 true / false 两个键
    assert.deepEqual(Object.keys(questions[id].criteria).sort(), ['false', 'true']);
  }

  // 题面必须写明"结合整段理解代词/省略"，并把这句原文带上
  assert.match(questions.s2.instructions, /它很好喝/);
  assert.match(questions.s2.instructions, /整段/);
  assert.match(questions.s2.instructions, /代词/);
  assert.match(questions.s2.instructions, /省略的主语/);
  // 也要求别因为整段接近谜底就给单句判是
  assert.match(questions.s2.instructions, /不要因为整段整体接近谜底/);
  assert.match(questions.s1.instructions, /第 1 句/);
  assert.match(questions.s2.instructions, /第 2 句/);
});

test('judgeSentences 走同一条"没配 Key 就失败"的路，不联网', async () => {
  const judge = new JevJudge();
  const r = await judge.judgeSentences({ puzzle: '汤面', answer: '汤底' }, '我爱海龟汤，它很好喝', [
    '我爱海龟汤',
    '它很好喝',
  ]);
  assert.equal(r.failed, true);
  assert.match(r.error, /API Key/);
  assert.deepEqual(r.items, []);
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
