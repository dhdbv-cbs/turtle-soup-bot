// Discord「正在回复中」：立刻显示一次、按 8 秒续期，回复发出后 stop() 收尾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTyping, TYPING_REFRESH_MS } from '../src/platforms/typing.js';

function stubChannel(sendTyping) {
  const channel = { pings: 0 };
  channel.sendTyping = sendTyping || (() => {
    channel.pings += 1;
    return Promise.resolve();
  });
  return channel;
}

test('评判一开始就显示输入状态，并按间隔续期（一次只维持约 10 秒）', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const channel = stubChannel();

  const stop = startTyping(channel);
  assert.equal(channel.pings, 1, '立刻显示一次');
  assert.ok(TYPING_REFRESH_MS < 10000, '续期间隔必须短于状态失效时间');

  t.mock.timers.tick(TYPING_REFRESH_MS);
  assert.equal(channel.pings, 2, '到点续期');
  t.mock.timers.tick(TYPING_REFRESH_MS * 3);
  assert.equal(channel.pings, 5, '评判再久也不会中途消失');

  stop();
  t.mock.timers.tick(TYPING_REFRESH_MS * 5);
  assert.equal(channel.pings, 5, '回复发出后不再续期');
});

test('stop() 可以重复调用', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stop = startTyping(stubChannel());
  stop();
  assert.doesNotThrow(() => stop());
  assert.doesNotThrow(() => stop());
});

test('可以自定义续期间隔', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const channel = stubChannel();
  const stop = startTyping(channel, { intervalMs: 1000 });
  t.mock.timers.tick(3000);
  assert.equal(channel.pings, 4);
  stop();
});

test('sendTyping 失败不会影响正常回复（吞掉异常与拒绝）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const throwing = stubChannel(() => {
    throw new Error('缺权限');
  });
  assert.doesNotThrow(() => startTyping(throwing));

  const rejecting = stubChannel(() => Promise.reject(new Error('限流')));
  const stop = startTyping(rejecting);
  t.mock.timers.tick(TYPING_REFRESH_MS);
  stop();
  // 给被吞掉的 rejection 一个冒头的机会：没处理的话这里会变成未处理拒绝
  await new Promise((r) => setTimeout(r, 5));
});

test('频道对象不完整也不会炸', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stop = startTyping({});
  assert.doesNotThrow(() => stop());
  assert.doesNotThrow(() => startTyping(undefined)());
});
