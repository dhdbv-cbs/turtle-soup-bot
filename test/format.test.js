// askReaction：反应模式下「普通提问」该打哪个表情
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askReaction, askReactionFor, formatAskResult, nextAnswerMode } from '../src/platforms/format.js';

test('是 → ✅', () => {
  assert.equal(askReaction({ type: 'answer', isYes: true, answer: '✅ 是。' }), '✅');
});

test('不是 → ❌', () => {
  assert.equal(askReaction({ type: 'answer', isYes: false, answer: '❌ 不是。' }), '❌');
});

test('判断不了（isYes 为 null）→ 🤔', () => {
  assert.equal(askReaction({ type: 'answer', isYes: null, answer: '🤔 这个问题暂时无法判断，换个问法试试。' }), '🤔');
});

test('判定用 isYes，不依赖文案：answer 文案变了也照旧', () => {
  assert.equal(askReaction({ type: 'answer', isYes: true, answer: '对' }), '✅');
});

test('通关要发完整谜底，不能只剩一个表情 → null（走文字）', () => {
  const win = { type: 'win', userId: '1', userName: '甲', question: { answer: '谜底' }, history: [] };
  assert.equal(askReaction(win), null);
  // 而且文字里必须有谜底，确认这条内容确实不能压成表情
  const { text } = formatAskResult(win);
  assert.match(text, /谜底/);
});

test('提示类（限流/没开局/排队太多）→ null（走文字）', () => {
  for (const text of [
    '⏳ 问得有点快啦，每人每分钟最多 6 次，请等 30 秒再问。',
    '还没有题目，先用 /start 开一局。',
    '本局还没开始，用 /start 启动。',
    '⏳ 这个频道排队的提问有点多，等我把前面几条答完再问～',
  ]) {
    assert.equal(askReaction({ type: 'hint', text }), null);
  }
});

test('/ask 的逐句核对 → null（多句对错塞不进一个表情）', () => {
  const verify = { type: 'verify', items: [{ text: '甲', isYes: true }, { text: '乙', isYes: false }] };
  assert.equal(askReaction(verify), null);
});

test('空值/未知类型 → null', () => {
  assert.equal(askReaction(null), null);
  assert.equal(askReaction(undefined), null);
  assert.equal(askReaction({}), null);
  assert.equal(askReaction({ type: 'answer' }), '🤔'); // isYes 缺失按「判断不了」处理
});

/* ---------------- 开关：askReplyMode ---------------- */

const YES = { type: 'answer', isYes: true, answer: '✅ 是。' };

test('reply 模式（默认）绝不打反应，照旧回消息', () => {
  assert.equal(askReactionFor('reply', YES), null);
  assert.equal(askReactionFor('reply', { type: 'answer', isYes: false }), null);
});

test('reaction 模式才打反应：是 ✅ / 不是 ❌ / 判断不了 🤔', () => {
  assert.equal(askReactionFor('reaction', YES), '✅');
  assert.equal(askReactionFor('reaction', { type: 'answer', isYes: false }), '❌');
  assert.equal(askReactionFor('reaction', { type: 'answer', isYes: null }), '🤔');
});

test('配置取值异常时按 reply 处理：不能因为配置坏了就改行为', () => {
  for (const mode of [undefined, null, '', 'REACTION', 'shout']) {
    assert.equal(askReactionFor(mode, YES), null);
  }
});

test('reaction 模式下通关/提示/逐句核对仍然发文字', () => {
  assert.equal(askReactionFor('reaction', { type: 'win', history: [] }), null);
  assert.equal(askReactionFor('reaction', { type: 'hint', text: '还没有题目，先用 /start 开一局。' }), null);
  assert.equal(askReactionFor('reaction', { type: 'verify', items: [] }), null);
});

/* ---------------- 卡片上的切换按钮 ---------------- */

test('回答方式按钮点一下：两个值来回切，未知取值也能切成 reaction', () => {
  assert.equal(nextAnswerMode('reply'), 'reaction');
  assert.equal(nextAnswerMode('reaction'), 'reply');
  assert.equal(nextAnswerMode(undefined), 'reaction');
  assert.equal(nextAnswerMode(''), 'reaction');
  // 来回两次回到原点
  assert.equal(nextAnswerMode(nextAnswerMode('reply')), 'reply');
});
