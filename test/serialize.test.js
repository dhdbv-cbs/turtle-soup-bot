// 同一频道的卡片操作要按"进来的顺序"处理，别让先点的那次渲染后到、把后点的样子盖回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerializer } from '../src/utils/serialize.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('同一个 key 的任务按顺序跑完，不会交叉', async () => {
  const serialize = createSerializer();
  const log = [];

  const first = serialize('c', async () => {
    log.push('a-开始');
    await tick(20);
    log.push('a-结束');
  });
  const second = serialize('c', async () => {
    log.push('b-开始');
    await tick(1);
    log.push('b-结束');
  });

  await Promise.all([first, second]);
  assert.deepEqual(log, ['a-开始', 'a-结束', 'b-开始', 'b-结束'], '慢的先来也得先跑完');
});

test('不同频道互不阻塞', async () => {
  const serialize = createSerializer();
  let released;
  const gate = new Promise((r) => {
    released = r;
  });

  const slow = serialize('c1', () => gate);
  let c2Done = false;
  await serialize('c2', async () => {
    c2Done = true;
  });
  assert.equal(c2Done, true, '另一个频道的操作不该被卡住');

  released();
  await slow;
});

test('前一个任务抛错，后面的照常执行（一次报错不会卡死队列）', async () => {
  const serialize = createSerializer();
  const seen = [];

  const bad = serialize('c', async () => {
    throw new Error('炸了');
  });
  await assert.rejects(bad, /炸了/);

  await serialize('c', async () => {
    seen.push('还是跑到了');
  });
  assert.deepEqual(seen, ['还是跑到了']);
});

test('队列跑空后不残留 key（频道多了也不会一直涨）', async () => {
  const serialize = createSerializer();
  await serialize('c', async () => {});
  await tick(); // 让清理的 then 跑完
  await serialize('c', async () => {});
  // 内部状态不暴露，这里只用"反复用同一个 key 不出问题 + 顺序仍然正确"来验证
  const order = [];
  await Promise.all([
    serialize('c', async () => {
      order.push(1);
      await tick(5);
      order.push(2);
    }),
    serialize('c', async () => order.push(3)),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('返回值照原样透传', async () => {
  const serialize = createSerializer();
  const value = await serialize('c', async () => '卡片');
  assert.equal(value, '卡片');
});
