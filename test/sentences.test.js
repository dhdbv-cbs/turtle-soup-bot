// 拆句测试：把玩家提交的结论拆成「一句话一条」，供 /ask 逐句核对
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../src/game/sentences.js';
import { MAX_VERIFY_SENTENCES } from '../src/limits.js';

test('句末标点断句，标点留在原句上', () => {
  assert.deepEqual(splitSentences('他是自杀的。凶手是医生！他留了遗书？'), [
    '他是自杀的。',
    '凶手是医生！',
    '他留了遗书？',
  ]);
  assert.deepEqual(splitSentences('他是自杀的吗?他留了遗书!'), ['他是自杀的吗?', '他留了遗书!']);
});

test('逗号也算一句：结论里的每个分句通常就是一个独立判断', () => {
  assert.deepEqual(splitSentences('他是自杀的，因为欠了债，而且留了遗书'), [
    '他是自杀的',
    '因为欠了债',
    '而且留了遗书',
  ]);
});

test('换行也断句', () => {
  assert.deepEqual(splitSentences('凶手是医生\n他用了毒药'), ['凶手是医生', '他用了毒药']);
});

test('半角句点断句，但数字里的小数点不算', () => {
  assert.deepEqual(splitSentences('凶手是医生.他用了毒药'), ['凶手是医生.', '他用了毒药']);
  assert.deepEqual(splitSentences('他欠了 3.5 万块钱。他是自杀的'), [
    '他欠了 3.5 万块钱。',
    '他是自杀的',
  ]);
});

test('太短的碎片并到相邻那句上，一个字都不丢', () => {
  // 开头的语气词并到后面
  assert.deepEqual(splitSentences('嗯，他是自杀的'), ['嗯，他是自杀的']);
  // 结尾的追问并到前面
  assert.deepEqual(splitSentences('他是自杀的，对吧'), ['他是自杀的，对吧']);
  // 中间的短碎片并到后面那句
  assert.deepEqual(splitSentences('凶手是医生，护士，还有院长'), ['凶手是医生', '护士，还有院长']);
});

test('前一句已带句末标点时直接接上，不额外补逗号', () => {
  assert.deepEqual(splitSentences('他是自杀的。。他是好人'), ['他是自杀的。', '他是好人']);
});

test(`最多拆 ${MAX_VERIFY_SENTENCES} 条，多出来的并成最后一条（内容不丢）`, () => {
  const raw = '一句甲。一句乙。一句丙。一句丁。一句戊。一句己。一句庚。';
  const list = splitSentences(raw);

  assert.equal(list.length, MAX_VERIFY_SENTENCES);
  assert.equal(list.at(-1), '一句己。一句庚。');
  // 拼回去和原文完全一致：只重新分组，绝不丢字
  assert.equal(list.join(''), raw);
});

test('上限可以调小，也可以给单条', () => {
  const raw = '一句甲。一句乙。一句丙。';
  assert.deepEqual(splitSentences(raw, { max: 2 }), ['一句甲。', '一句乙。一句丙。']);
  assert.deepEqual(splitSentences(raw, { max: 1 }), ['一句甲。一句乙。一句丙。']);
});

test('空内容返回空数组，没有标点的一整句原样返回', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences('他是自杀的'), ['他是自杀的']);
});
