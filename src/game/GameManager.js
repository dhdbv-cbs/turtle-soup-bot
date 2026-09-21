// 游戏管理器：多人海龟汤，按频道/群隔离状态
import { config } from '../config.js';
import { log } from '../utils/logger.js';

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
  };
}

export class GameManager {
  constructor(judge, { winThreshold = config.judge.winThreshold } = {}) {
    this.judge = judge;
    this.winThreshold = winThreshold;
    this.states = new Map(); // channelKey -> state
  }

  getState(channelKey) {
    if (!this.states.has(channelKey)) {
      this.states.set(channelKey, newState());
    }
    return this.states.get(channelKey);
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
    return question;
  }

  // 开始当前题目
  start(channelKey, userId = null, userName = null) {
    const s = this.getState(channelKey);
    if (!s.question) return { ok: false, msg: '还没有题目，先用「汤 下一题」或「汤 列表」选择题目。' };
    if (this.isRoundActive(s)) {
      return { ok: false, msg: '本局已经开始了，直接 @我 提问即可。' };
    }
    s.started = true;
    s.history = [];
    s.participants = new Set();
    s.winner = null;
    s.revealed = false;
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

  // 处理玩家提问（多人：任何人都可以问）
  async ask(channelKey, userId, userName, message) {
    const s = this.getState(channelKey);
    if (!s.question) return { type: 'hint', text: '还没有题目，先用「汤 开始」开一局。' };
    if (!s.started) return { type: 'hint', text: '本局还没开始，用「汤 开始」启动。' };
    if (s.winner) return { type: 'hint', text: '本局已经通关啦！用「汤 下一题」换一道。' };
    if (s.revealed) return { type: 'hint', text: '谜底已公布，用「汤 下一题」开始新的一局。' };

    s.participants.add(String(userId));
    const trimmed = String(message ?? '').trim();
    if (!trimmed) return { type: 'hint', text: '提问内容不能为空。' };

    // 调用 Jev 评判
    const judge = await this.judge.judge(s.question, trimmed);

    const record = {
      userId: String(userId),
      userName,
      message: trimmed,
      isYes: judge.isYes,
      yesProb: judge.yesProb,
      similarity: judge.similarity,
      ts: Date.now(),
    };
    s.history.push(record);

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
        history: s.history,
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

  // 公布谜底（手动）
  reveal(channelKey) {
    const s = this.getState(channelKey);
    if (!s.question) return { ok: false, msg: '还没有题目。' };
    s.revealed = true;
    return { ok: true, question: s.question, history: s.history };
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

  // 重置当前频道
  reset(channelKey) {
    this.states.delete(channelKey);
  }
}
