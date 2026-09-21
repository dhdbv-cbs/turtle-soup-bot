// 游戏相关的数量上限集中在这里
//
// 放在一个文件里是为了"帮助文案 / README / 代码"引用同一个数字，避免各写一份然后对不上。
// 大部分是并发兜底：同时有几个团体在玩的时候，防止某个人或某个群把资源吃光。

// 每人每分钟最多提问几次（按「频道 + 人」计算，换频道不叠加）
export const ASK_RATE_LIMIT = 6;
export const ASK_RATE_WINDOW_MS = 60 * 1000;

// 同一个频道里最多排队的提问数（不含正在评判的那一条）
export const MAX_PENDING_PER_CHANNEL = 3;

// /ask 提交结论时最多拆成几句逐句核对（多出来的部分并到最后一句，不丢内容）。
// 每一句都是一次评判调用，所以要有上限；拆句规则见 game/sentences.js
export const MAX_VERIFY_SENTENCES = 6;

// 全服同时进行的评判上限（跨频道），超出的留在各自频道队列里等
export const MAX_CONCURRENT_JUDGES = 8;

// 频道状态多久没人动就可以回收（进行中的一局永不回收）
export const STATE_IDLE_MS = 12 * 60 * 60 * 1000;
// 状态表硬上限，超出后从最久没动过的开始回收
export const MAX_CHANNELS = 500;
// 清理动作最多多久做一次
export const PRUNE_INTERVAL_MS = 60 * 1000;
