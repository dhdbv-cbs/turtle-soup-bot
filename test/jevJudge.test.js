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
  QUESTIONS,
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

test('state 用带名字的字段，整段发言原样在里面（官方推荐形状）', () => {
  const question = { puzzle: '汤面', answer: '汤底' };
  const full = '我爱海龟汤，它很好喝';
  const state = buildState(question, full);

  // 官方："Use an object for most requests so each part of the state has a descriptive name"
  assert.deepEqual(Object.keys(state), ['汤面', '谜底', '玩家发言']);
  assert.equal(state.汤面, '汤面');
  assert.equal(state.谜底, '汤底');
  // 整段都在，Jev 才能看出"它"指的是海龟汤——逐句核对靠的是这个，不是题面里的叮嘱
  assert.equal(state.玩家发言, full);
  // Jev 只吃文本：state 里不该混进数字/布尔
  assert.ok(Object.values(state).every((v) => typeof v === 'string'));
});

test('三道题的题面都合 System One 的格式：短问题 + criteria 带标准', () => {
  assert.equal(QUESTIONS.isYes.type, 'boolean');
  assert.ok(QUESTIONS.isYes.instructions.length <= 30, QUESTIONS.isYes.instructions);
  assert.match(QUESTIONS.isYes.instructions, /是否符合谜底/);
  // 官方："The ids are not sent to the model"——题面要自足，指向 state 里的字段名
  assert.match(QUESTIONS.isYes.instructions, /玩家发言/);
  assert.deepEqual(Object.keys(QUESTIONS.isYes.criteria).sort(), ['false', 'true']);

  assert.equal(QUESTIONS.similarity.type, 'score');
  assert.ok(QUESTIONS.similarity.instructions.length <= 30, QUESTIONS.similarity.instructions);
  // 等级表就是标定，必须原样交给模型
  assert.equal(QUESTIONS.similarity.criteria, SIMILARITY_LEVELS);
  assert.ok(SIMILARITY_LEVELS.length >= 2 && SIMILARITY_LEVELS.length <= 10, '官方 score 支持 2~10 级');
  assert.match(SIMILARITY_LEVELS.at(-1), /完整/);
});

test('题面里不该出现"慢慢推理"式的话术（官方点名的反例）', () => {
  const all = { ...QUESTIONS, ...buildSentenceQuestions(['我爱海龟汤', '它很好喝']) };
  const text = JSON.stringify(all);
  // 这些词一旦回到题面，就说明又把校准/推理要求塞回了 instructions
  for (const banned of ['不要', '分析', '只有当', '不能给高分', '尽量', '仔细']) {
    assert.ok(!text.includes(banned), `题面里不该有「${banned}」：${text}`);
  }
  // 校准信息留在等级描述里
  assert.ok(SIMILARITY_LEVELS.some((lv) => /核心真相/.test(lv)));
});

test('逐句核对题面：一句话一个"瞬间判断"，材料跟着问题走（官方 System One 写法）', () => {
  const items = ['我爱海龟汤', '它很好喝'];
  const questions = buildSentenceQuestions(items);
  assert.deepEqual(Object.keys(questions), ['s1', 's2'], '一次请求里给每句一个问题');

  for (const id of Object.keys(questions)) {
    const q = questions[id];
    assert.equal(q.type, 'boolean');
    // AI SDK 的校验：boolean 题的 criteria 只允许 true / false 两个键
    assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true']);

    // 题面是"一个懂行的人一秒内能给出的判断"，不是"分析一下再决定"
    assert.equal(typeof q.instructions, 'object', '材料用结构化字段带，不拼进字符串模板');
    assert.deepEqual(Object.keys(q.instructions).sort(), ['focus', 'question', 'sentence']);
    assert.ok(q.instructions.question.length <= 30, `题面要短：${q.instructions.question}`);
    assert.match(q.instructions.question, /是否符合谜底/);
    assert.ok(q.instructions.focus.length <= 40, `focus 只是一句指向：${q.instructions.focus}`);
  }

  // 每句原文就在它自己的那条问题里；不能靠 id 互相引用——官方明确"id 不会发给模型"
  assert.equal(questions.s1.instructions.sentence, '我爱海龟汤');
  assert.equal(questions.s2.instructions.sentence, '它很好喝');
  assert.match(questions.s2.instructions.focus, /整段/);
  // criteria 负责说明"是/否"各代表什么
  assert.match(questions.s1.criteria.true, /支持/);
  assert.match(questions.s2.criteria.false, /不支持/);
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

// 用假模型走一遍**真实的 SDK 校验**（validateEvaluationInput / validateEvaluationAnswers）。
// 这样"题面格式合不合规"就不只是形状断言，而是 AI SDK 真的放行、并且答案能正确解析。
function fakeModel(answers, { onEvaluate } = {}) {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'fake-jev',
    supportedQuestionTypes: ['choice', 'score', 'boolean'],
    async doEvaluate(call) {
      onEvaluate?.(call);
      // warnings 不能省：SDK 的 logWarnings 会读它的 length
      return { answers, usage: { inputTokens: 12, outputTokens: 3 }, warnings: [] };
    },
  };
}

test('judge()：走通 SDK 校验，答案解析成 isYes / similarity', async () => {
  const judge = new JevJudge();
  let seen = null;
  judge.resolveModel = async () =>
    fakeModel(
      {
        isYes: { type: 'boolean', probability: 0.93 },
        // score 答案里的 probabilities 是可选的，一旦给出就必须是完整分布且均值等于 score
        similarity: { type: 'score', score: 4 },
      },
      { onEvaluate: (call) => { seen = call; } },
    );

  const r = await judge.judge({ puzzle: '汤面文字', answer: '汤底文字' }, '他喝了海龟汤就死了');
  assert.equal(r.failed, false);
  assert.equal(r.yesProb, 0.93);
  assert.equal(r.isYes, 0.93 >= config.judge.yesThreshold);
  assert.equal(r.similarity, 1, '5 级里给第 4 级 = 满分');
  assert.equal(r.usage.totalTokens, 15);

  // 发给模型的东西：state 是命名对象，玩家发言原样在里面
  assert.deepEqual(Object.keys(seen.state), ['汤面', '谜底', '玩家发言']);
  assert.equal(seen.state.玩家发言, '他喝了海龟汤就死了');
  assert.equal(seen.questions, QUESTIONS);
});

test('judgeSentences()：一次请求判完所有句子（SDK 校验放行 + 逐句解析）', async () => {
  const judge = new JevJudge();
  let seen = null;
  judge.resolveModel = async () =>
    fakeModel(
      {
        s1: { type: 'boolean', probability: 0.99 },
        s2: { type: 'boolean', probability: 0.02 },
        s3: { type: 'boolean', probability: 0.97 },
      },
      { onEvaluate: (call) => { seen = call; } },
    );

  const items = ['我爱海龟汤', '凶手是医生', '它很好喝'];
  const full = '我爱海龟汤，凶手是医生，它很好喝';
  const r = await judge.judgeSentences({ puzzle: '汤面', answer: '汤底' }, full, items);

  assert.equal(r.failed, false);
  assert.deepEqual(r.items, [
    { text: '我爱海龟汤', isYes: true },
    { text: '凶手是医生', isYes: false },
    { text: '它很好喝', isYes: true },
  ]);
  // 一次请求：整段在 state 里，三句各一条题，材料跟着各自的问题走
  assert.equal(seen.state.玩家发言, full);
  assert.deepEqual(Object.keys(seen.questions), ['s1', 's2', 's3']);
  assert.equal(seen.questions.s2.instructions.sentence, '凶手是医生');
  assert.equal(seen.questions.s2.instructions.question, '「玩家发言」里的这一句是否符合谜底？');
});

test('模型漏答一题 → SDK 直接报错，我们如实报"评判失败"，不拿错结果', async () => {
  const judge = new JevJudge();
  judge.resolveModel = async () =>
    fakeModel({
      // 只答了 s1，s2 没答：SDK 会拒绝（每个问题必须恰好一个答案）
      s1: { type: 'boolean', probability: 0.9 },
    });

  const r = await judge.judgeSentences({ puzzle: '汤面', answer: '汤底' }, '甲句。乙句。', ['甲句', '乙句']);
  assert.equal(r.failed, true);
  assert.deepEqual(r.items, []);
  assert.match(r.error, /评判调用失败|评判超时/);
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
