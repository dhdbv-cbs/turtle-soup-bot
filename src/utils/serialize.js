// 把同一个频道的卡片操作串起来处理。
//
// 为什么需要：Discord 的组件交互（按钮/下拉）是**并发投递**的——玩家点得快，
// 或者两个人同时点同一张卡片，两个 interaction 会同时进到我们这里。
// 两边各自 interaction.update() 一次，先发的请求可能后到，
// 于是卡片最后显示的是"先点那一下"的样子，后点的状态像是被冲掉了。
//
// 这里只保证"进来顺序 = 处理顺序"，不做别的：卡片内容仍然每次都按最新状态重新渲染。
// 单个任务很快（本地构建 + 一次 API 调用），不会把 3 秒的应答窗口拖爆。
export function createSerializer() {
  const chains = new Map();

  return function serialize(key, task) {
    const prev = chains.get(key) ?? Promise.resolve();
    // 前一个失败也要继续跑下一个，否则一次报错会把这条链卡死
    const next = prev.then(task, task);
    const settled = next.then(
      () => {},
      () => {},
    );
    chains.set(key, settled);
    // 队列空了就把 key 清掉，别让映射随着频道数一直长
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };
}
