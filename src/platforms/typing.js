// Discord 的「正在回复中」：调用 channel.sendTyping()，频道里就会显示
// 「机器人 正在输入…」，其它成员能看到"它在处理"。
//
// 两个官方限制决定了这里要这么写：
//   1. 一次输入状态大约只维持 10 秒，评判慢的时候必须续期，否则会中途消失；
//   2. 没有"取消输入"的接口——机器人一发消息，状态就自动结束了，
//      所以 stop() 只负责停掉续期定时器，回复发出去那一刻状态自然消失。
export const TYPING_REFRESH_MS = 8000;

/**
 * 开始显示「正在输入…」并自动续期。
 *
 * @param {object} channel 需要有 sendTyping()（Discord 的 TextBasedChannel）
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] 续期间隔，默认 8 秒（低于 10 秒的失效时间）
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @returns {Function} stop()，停掉续期；可重复调用
 */
export function startTyping(channel, {
  intervalMs = TYPING_REFRESH_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const ping = () => {
    try {
      // 发不出去（没权限、频道被删、限流）就算了，不能因此影响正常回复
      Promise.resolve(channel?.sendTyping?.()).catch(() => {});
    } catch {
      /* 同上 */
    }
  };

  ping();
  const timer = setIntervalFn(ping, intervalMs);
  // 别让这个定时器拖住进程退出（测试里是假定时器，没有 unref）
  timer?.unref?.();

  let stopped = false;
  return function stopTyping() {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  };
}
