// 游戏管理器：多人海龟汤，按频道/群隔离状态
//
// 并发兜底（同时有几个团体在玩、或同一个群里多人同时提问时）：
//   1. 状态按 channelKey 隔离（channelKey 带平台前缀），不同群/频道互不影响；
//   2. 同一个频道里的提问串行处理（队列 + 上限），答题顺序与提问顺序一致，
//      也不会因为并发评判冒出两条"通关"；
//   3. 每条提问记录本局编号，评判期间题目被换掉/重置时这条结果直接作废，
//      既不会写进下一局，也不会让下一局莫名通关；
//   4. 状态表有上限，长期没人玩的频道会被回收，开很多群也不会无限涨内存。
import { config } from '../config.js';
import { log, warn } from '../utils/logger.js';
import {
  ASK_RATE_LIMIT,
  ASK_RATE_WINDOW_MS,
  MAX_CHANNELS,
  MAX_CONCURRENT_JUDGES,
  MAX_PENDING_PER_CHANNEL,
  PRUNE_INTERVAL_MS,
  STATE_IDLE_MS,
} from '../limits.js';

function newState(question = null) {
  return {
    question,
    started: false,
    history: [],
    participants: new Set(),
    winner: null,
    revealed: false,
    // 本局发起人：开始本局的人，进行中只有 TA 能换题
    ownerId: null,
    ownerName: null,
    createdAt: Date.now(),
    // 本局编号：换题/重开都会 +1，用来识别"评判期间题目被换掉了"
    roundId: 0,
    touchedAt: Date.now(),
  };
}

export class GameManager {
  // winThreshold 只作为测试用的覆盖值；正常运行读 config，改了立即生效
  constructor(judge, { winThreshold = null } = {}) {
    this.judge = judge;
    this.winThresholdOverride = winThreshold;
    this.states = new Map(); // channelKey -> state
    this.queues = new Map(); // channelKey -> { running, pending: [] }
    this.askQuota = new Map(); // `channelKey\0userId` -> 最近一分钟的提问时间戳
    this.lastPrune = 0;
    this.judgeSlots = { active: 0, waiters: [] }; // 全局评判并发额度
  }

  // 取一个全局评判额度（满了就在这里等，等的人按先后顺序放行）
  #acquireJudgeSlot() {
    if (this.judgeSlots.active < MAX_CONCURRENT_JUDGES) {
      this.judgeSlots.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.judgeSlots.waiters.push(resolve));
  }

  #releaseJudgeSlot() {
    const next = this.judgeSlots.waiters.shift();
    if (next) {
      next(); // 名额直接转交给下一个等待者，active 不变
      return;
    }
    this.judgeSlots.active = Math.max(0, this.judgeSlots.active - 1);
  }

  // 后台状态展示用
  get activeJudges() {
    return this.judgeSlots.active;
  }

  // 阈值热生效：后台界面改完参数，正在进行的游戏也按新值判定
  get winThreshold() {
    return Number.isFinite(this.winThresholdOverride)
      ? this.winThresholdOverride
      : config.judge.winThreshold;
  }

  getState(channelKey) {
    let s = this.states.get(channelKey);
    if (!s) {
      s = newState();
      this.states.set(channelKey, s);
      this.#maybePrune();
    }
    s.touchedAt = Date.now();
    return s;
  }

  // 一局是否正在进行中（已开始且尚未通关/公布）
  isRoundActive(state) {
    return !!(state.question && state.started && !state.winner && !state.revealed);
  }

  // 选择/切换题目（不自动开始）。换题即新一局，参与人数与历史全部清零。
  setQuestion(channelKey, question, { userId = null, userName = null } = {}) {
    const s = this.getState(channelKey);
    s.question = question;
    s.started = false;
    s.history = [];
    s.participants = new Set();
    s.winner = null;
    s.revealed = false;
    s.ownerId = userId === null ? null : String(userId);
    s.ownerName = userName || null;
    s.createdAt = Date.now();
    s.roundId += 1;
    return question;
  }

  // 开始当前题目
  start(channelKey, userId = null, userName = null) {
    const s = this.getState(channelKey);
    if (!s.question) return { ok: false, msg: '还没有题目，先用 /next 或 /pick <编号> 选择题目。' };
    if (this.isRoundActive(s)) {
      return { ok: false, msg: '本局已经开始了，直接 @我 提问即可。' };
    }
    s.started = true;
    s.history = [];
    s.participants = new Set();
    s.winner = null;
    s.revealed = false;
    s.roundId += 1;
    if (userId !== null) {
      s.ownerId = String(userId);
      s.ownerName = userName || s.ownerName;
    }
    log(`[${channelKey}] 游戏开始：${s.question.title}（发起人 ${s.ownerName || s.ownerId || '未知'}）`);
    return { ok: true, question: s.question };
  }

  // 是否有权换题：进行中的一局只有发起人能换；没有进行中的一局则谁都可以
  canSwitch(channelKey, userId) {
    const s = this.getState(channelKey);
    if (!this.isRoundActive(s)) return true;
    if (!s.ownerId) return true;
    return String(userId) === s.ownerId;
  }

  /* ---------------- 提问：按频道串行 ---------------- */

  // 明显不能提问的情况先快速返回，不必进队列
  #blocked(state) {
    if (!state.question) return { type: 'hint', text: '还没有题目，先用 /start 开一局。' };
    if (!state.started) return { type: 'hint', text: '本局还没开始，用 /start 启动。' };
    if (state.winner) return { type: 'hint', text: '本局已经通关啦！用 /next 换一道。' };
    if (state.revealed) return { type: 'hint', text: '谜底已公布，用 /next 开始新的一局。' };
    return null;
  }

  // 处理玩家提问（多人：任何人都可以问）
  async ask(channelKey, userId, userName, message) {
    const s = this.getState(channelKey);
    const blocked = this.#blocked(s);
    if (blocked) return blocked;
    // 防刷：每人每分钟最多 6 次。放在入队之前，免得刷屏把队列也占满
    const limited = this.consumeAskQuota(channelKey, userId);
    if (limited) return limited;
    // 记住排队时是哪一局：排队期间换了题，这条提问就不该拿去评判新题目
    const queuedRound = s.roundId;
    return this.#enqueue(channelKey, () => this.#askNow(channelKey, userId, userName, message, queuedRound));
  }

  // 只看不记：返回该用户当前是否已被限流（供需要提前判断的调用方使用）
  peekAskQuota(channelKey, userId, now = Date.now()) {
    const key = `${channelKey}\u0000${userId}`;
    const recent = (this.askQuota.get(key) || []).filter((t) => now - t < ASK_RATE_WINDOW_MS);
    if (recent.length < ASK_RATE_LIMIT) return null;
    const wait = Math.max(1, Math.ceil((ASK_RATE_WINDOW_MS - (now - recent[0])) / 1000));
    return {
      type: 'hint',
      userId: String(userId),
      text: `⏳ 问得有点快啦，每人每分钟最多 ${ASK_RATE_LIMIT} 次，请等 ${wait} 秒再问。`,
    };
  }

  // 频率限制：返回 null 表示放行（并记一次），否则返回该回的提示。
  // now 可注入，方便测试窗口滑动，不用真的等一分钟。
  consumeAskQuota(channelKey, userId, now = Date.now()) {
    const peeked = this.peekAskQuota(channelKey, userId, now);
    if (peeked) return peeked;
    const key = `${channelKey}\u0000${userId}`;
    const recent = (this.askQuota.get(key) || []).filter((t) => now - t < ASK_RATE_WINDOW_MS);
    recent.push(now);
    this.askQuota.set(key, recent);
    return null;
  }

  #staleHint(userId) {
    return {
      type: 'hint',
      userId: userId === null || userId === undefined ? null : String(userId),
      text: '🔄 题目已经换了，这条提问就不算数啦，按新题目重新问吧。',
    };
  }

  #enqueue(channelKey, task) {
    let q = this.queues.get(channelKey);
    if (!q) {
      q = { running: false, pending: [] };
      this.queues.set(channelKey, q);
    }
    if (q.running && q.pending.length >= MAX_PENDING_PER_CHANNEL) {
      // 兜底：一个人狂刷或全群一起问时，别把评判请求堆成雪球
      return { type: 'hint', text: '⏳ 这个频道排队的提问有点多，等我把前面几条答完再问～' };
    }
    return new Promise((resolve) => {
      q.pending.push({ task, resolve });
      this.#drain(channelKey);
    });
  }

  async #drain(channelKey) {
    const q = this.queues.get(channelKey);
    if (!q || q.running) return;
    const next = q.pending.shift();
    if (!next) {
      this.queues.delete(channelKey);
      return;
    }
    q.running = true;
    let result;
    try {
      result = await next.task();
    } catch (e) {
      // 单条提问出问题不能卡住整个频道
      warn(`[${channelKey}] 处理提问时出错：`, e?.message || String(e));
      result = { type: 'hint', text: '⚠️ 这条提问处理失败了，请再问一次。' };
    } finally {
      q.running = false;
    }
    next.resolve(result);
    this.#drain(channelKey);
  }

  async #askNow(channelKey, userId, userName, message, queuedRound) {
    // 排队期间状态可能已经变了（通关/换题/reset），执行时重新取一次
    const s = this.getState(channelKey);
    if (s.roundId !== queuedRound) return this.#staleHint(userId);
    const blocked = this.#blocked(s);
    if (blocked) return blocked;

    const trimmed = String(message ?? '').trim();
    if (!trimmed) return { type: 'hint', text: '提问内容不能为空。' };

    const roundId = s.roundId;
    const question = s.question;
    s.participants.add(String(userId));

    // 调用评判模型（可能几秒到几十秒）：全局最多 8 条同时跑，多的在频道队列里等
    await this.#acquireJudgeSlot();
    let judge;
    try {
      judge = await this.judge.judge(question, trimmed);
    } finally {
      this.#releaseJudgeSlot();
    }

    // 评判渠道没配好或调用失败：不记入历史，直接把原因告诉玩家
    if (judge.failed) {
      return {
        type: 'hint',
        userId: String(userId),
        text: `⚠️ 评判失败：${judge.error}\n（管理员可到后台界面「评判模型」里检查配置）`,
      };
    }

    // 评判期间题目被换掉/重置了：这条结果已经对不上任何题目，直接丢弃
    const current = this.states.get(channelKey);
    if (current !== s || current.roundId !== roundId) {
      log(`[${channelKey}] 评判期间题目已更换，丢弃这条提问结果`);
      return this.#staleHint(userId);
    }

    s.history.push({
      userId: String(userId),
      userName,
      message: trimmed,
      isYes: judge.isYes,
      yesProb: judge.yesProb,
      similarity: judge.similarity,
      ts: Date.now(),
    });

    // 胜利判定：与谜底的相似度达到阈值
    if (judge.similarity >= this.winThreshold) {
      s.winner = {
        userId: String(userId),
        userName,
        message: trimmed,
        similarity: judge.similarity,
      };
      s.revealed = true;
      log(
        `[${channelKey}] 通关！由 ${userName} 揭示谜底（相似度 ${(judge.similarity * 100).toFixed(0)}%）`,
      );
      return {
        type: 'win',
        userId: String(userId),
        userName,
        similarity: judge.similarity,
        question: s.question,
        history: [...s.history],
        participantCount: s.participants.size,
      };
    }

    // 普通是/不是回复
    let answer;
    if (judge.isYes === null) {
      answer = '🤔 这个问题暂时无法判断，换个问法试试。';
    } else if (judge.isYes) {
      answer = '✅ 是。';
    } else {
      answer = '❌ 不是。';
    }
    return {
      type: 'answer',
      answer,
      isYes: judge.isYes,
      yesProb: judge.yesProb,
      similarity: judge.similarity,
      asker: userName,
      askerId: String(userId),
    };
  }

  /* ---------------- 状态清理 ---------------- */

  #maybePrune() {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_INTERVAL_MS && this.states.size <= MAX_CHANNELS) return;
    this.lastPrune = now;
    this.prune(now);
  }

  // 回收空闲频道状态；正在进行的局不会被回收。返回回收数量（测试用）
  prune(now = Date.now()) {
    let removed = 0;
    for (const [key, s] of this.states) {
      if (this.isRoundActive(s)) continue;
      if (now - s.touchedAt > STATE_IDLE_MS) {
        this.states.delete(key);
        removed++;
      }
    }
    if (this.states.size > MAX_CHANNELS) {
      const idle = [...this.states.entries()]
        .filter(([, s]) => !this.isRoundActive(s))
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      for (const [key] of idle) {
        if (this.states.size <= MAX_CHANNELS) break;
        this.states.delete(key);
        removed++;
      }
    }
    // 顺带清掉早就过期的提问频率记录，不然刷过屏的人会一直留在表里
    for (const [key, stamps] of this.askQuota) {
      if (!stamps.some((t) => now - t < ASK_RATE_WINDOW_MS)) this.askQuota.delete(key);
    }
    if (removed) log(`清理空闲频道状态 ${removed} 个，现有 ${this.states.size} 个`);
    return removed;
  }

  // 公布谜底（手动）
  reveal(channelKey) {
    const s = this.getState(channelKey);
    if (!s.question) return { ok: false, msg: '还没有题目。' };
    s.revealed = true;
    return { ok: true, question: s.question, history: [...s.history] };
  }

  // 状态摘要
  status(channelKey) {
    const s = this.getState(channelKey);
    return {
      hasQuestion: !!s.question,
      questionTitle: s.question?.title,
      started: s.started,
      questionCount: s.history.length,
      participantCount: s.participants.size,
      winner: s.winner,
      revealed: s.revealed,
      ownerId: s.ownerId,
      ownerName: s.ownerName,
      pending: this.queues.get(channelKey)?.pending.length ?? 0,
    };
  }

  // 提问历史（最近 N 条）
  history(channelKey, limit = 20) {
    const s = this.getState(channelKey);
    if (!Number.isFinite(limit) || limit <= 0) return [...s.history];
    return s.history.slice(-limit);
  }

  // 历史总条数
  historyCount(channelKey) {
    return this.getState(channelKey).history.length;
  }

  // 还有多少条提问在排队（后台状态展示用）
  pendingCount(channelKey) {
    return this.queues.get(channelKey)?.pending.length ?? 0;
  }

  // 所有频道加起来还有多少条在排队
  pendingTotal() {
    let n = 0;
    for (const q of this.queues.values()) n += q.pending.length;
    return n;
  }

  // 重置当前频道
  reset(channelKey) {
    this.states.delete(channelKey);
  }
}
