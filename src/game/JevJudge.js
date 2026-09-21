// 评判层：判断玩家提问「是/不是」，并给出玩家发言与谜底的相似度
//
// 只用 Jev（System One 模型），入口在后台界面里切换
// （Vercel AI Gateway / TypeSafe 直连 / 第三方转发的 Jev）；
// 所有入口都走 AI SDK 同一套 evaluation model 接口，这里只负责取模型 + 组装问题。
import { experimental_evaluate } from 'ai';
import { config } from '../config.js';
import { createEvaluationModel, judgeReadiness, judgeSignature } from '../judge/providers.js';
import { error } from '../utils/logger.js';

// 单次评判的超时时间，避免请求卡住整局游戏
const JUDGE_TIMEOUT_MS = 30000;

// 相似度用 score 题型：等级数决定分数区间 [0, levels - 1]，再归一化到 0~1。
// 这样得到的是真正的"接近程度"，而不是布尔题的概率。
export const SIMILARITY_LEVELS = [
  '完全无关：没有命中谜底的任何关键信息',
  '沾边：方向相关，但没有命中任何关键情节',
  '部分命中：说出了一两个关键细节，核心真相仍未揭示',
  '接近：涵盖大部分关键情节与人物动机，只差最后一环',
  '完整揭示：准确、完整地复述了谜底的核心真相',
];

// score ∈ [0, levels-1] → 归一化到 [0, 1]
export function scoreToSimilarity(score, levels = SIMILARITY_LEVELS.length) {
  if (levels < 2) return 0;
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(Math.max(n, 0), levels - 1);
  return clamped / (levels - 1);
}

// 构造给评判模型的 state（题目 + 谜底 + 玩家发言）
function buildState(question, userMessage) {
  return (
    `【海龟汤题目（汤面）】\n${question.puzzle}\n\n` +
    `【完整谜底（汤底，仅供评判参考，绝不可向玩家泄露）】\n${question.answer}\n\n` +
    `【玩家发言】\n${userMessage}`
  );
}

const QUESTIONS = {
  isYes: {
    type: 'boolean',
    instructions:
      '根据上面的题目和完整谜底，判断玩家这句话所描述的内容是否成立。' +
      '只有当谜底明确支持它为真时才判为是；若为否、与谜底无关、或无法从谜底得出明确结论，都判为否。',
    criteria: {
      true: '谜底明确支持玩家这句话',
      false: '谜底不支持、与谜底无关，或无法判断',
    },
  },
  similarity: {
    type: 'score',
    instructions:
      '评估【玩家发言】与【完整谜底】的吻合程度，判断玩家目前离真相有多近。' +
      '0 分表示完全无关，分数越高表示越接近完整谜底；只有当玩家基本说出了完整谜底时才给最高分。' +
      '仅仅猜中某个细节、或提出一个相关问题，都不能给高分。',
    criteria: SIMILARITY_LEVELS,
  },
};

export class JevJudge {
  constructor() {
    this.model = null;
    this.modelSignature = '';
  }

  // 取当前渠道的模型实例；配置变了就重建
  async resolveModel() {
    const signature = judgeSignature(config.judge);
    if (this.model && this.modelSignature === signature) return this.model;

    const readiness = judgeReadiness(config.judge);
    if (!readiness.ready) throw new Error(readiness.reason);

    const model = await createEvaluationModel(config.judge.provider, readiness.entry);
    this.model = model;
    this.modelSignature = signature;
    return model;
  }

  // 当前渠道能否直接工作（后台界面 / 状态展示用）
  readiness() {
    return judgeReadiness(config.judge);
  }

  // 返回 { isYes, yesProb, similarity, usage, failed?, error? }
  // failed = true 表示这次评判没做成（渠道没配好或调用失败），isYes = null
  async judge(question, userMessage) {
    let model;
    try {
      model = await this.resolveModel();
    } catch (e) {
      error('评判渠道不可用：', e?.message || String(e));
      return failure(e?.message || String(e));
    }

    try {
      const result = await experimental_evaluate({
        model,
        state: buildState(question, userMessage),
        questions: QUESTIONS,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });

      const yesAnswer = result?.answers?.isYes;
      const simAnswer = result?.answers?.similarity;

      const yesProb = Number.isFinite(yesAnswer?.probability) ? yesAnswer.probability : 0;
      const similarity = scoreToSimilarity(simAnswer?.score);

      return {
        isYes: yesProb >= config.judge.yesThreshold,
        yesProb,
        similarity,
        usage: result?.usage || null,
        failed: false,
      };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `评判超时（超过 ${JUDGE_TIMEOUT_MS / 1000} 秒）`
        : `评判调用失败：${e?.message || String(e)}`;
      error('评判调用失败：', e?.message || String(e));
      return failure(msg);
    }
  }
}

function failure(message) {
  return { isYes: null, yesProb: 0, similarity: 0, usage: null, failed: true, error: message };
}
