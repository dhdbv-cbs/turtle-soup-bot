// Jev 评判层单元测试：只测纯逻辑与"未配置密钥"分支，绝不发起真实请求
import test from 'node:test';
import assert from 'node:assert/strict';

// 必须在动态 import JevJudge 之前清空密钥，确保走"未配置"分支（静态 import 会被提升）
process.env.AI_GATEWAY_API_KEY = '';

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

test('未配置密钥时返回"无法判断"，不抛异常', async () => {
  const judge = new JevJudge();
  const r = await judge.judge({ puzzle: '汤面', answer: '汤底' }, '是这样吗');
  assert.equal(r.isYes, null);
  assert.equal(r.yesProb, 0);
  assert.equal(r.similarity, 0);
  assert.equal(r.usage, null);
});
