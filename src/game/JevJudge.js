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
//
// 逐句核对时**也整段发**：只发单句的话，「我爱海龟汤，它很好喝」里的"它"就没有先行词，
// Jev 只能硬抠单句字面。整段一起给它，代词和省略的主语才有上下文可依。
export function buildState(question, userMessage) {
  return (
    `【海龟汤题目（汤面）】\n${question.puzzle}\n\n` +
    `【完整谜底（汤底，仅供评判参考，绝不可向玩家泄露）】\n${question.answer}\n\n` +
    `【玩家发言】\n${userMessage}`
  );
}

const YES_CRITERIA = {
  true: '谜底明确支持玩家这句话',
  false: '谜底不支持、与谜底无关，或无法判断',
};

const QUESTIONS = {
  isYes: {
    type: 'boolean',
    instructions:
      '根据上面的题目和完整谜底，判断玩家这句话所描述的内容是否成立。' +
      '只有当谜底明确支持它为真时才判为是；若为否、与谜底无关、或无法从谜底得出明确结论，都判为否。',
    criteria: YES_CRITERIA,
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

/**
 * 逐句核对的题面：一次请求里给每一句各出一个布尔题（s1、s2…）。
 *
 * 按 TypeSafe 官方的写法来（docs.typesafe.ai/primitives）：
 *
 * 1. **一个问题只要一个"瞬间判断"**。官方明确把"分析一下再决定"列为反例，所以要写
 *    「这一句是否符合谜底？」这种懂行的人一眼能答的问题，而不是一串推理要求
 *    （别写成"不要孤立抠字面、也不要因为整段接近就判是"那种提示词腔）。
 * 2. **要带的材料用结构化字段跟着问题走**。官方原话是 "pass in the relevant subfields
 *    instead of serializing them into a string template"，所以这句原文放进
 *    instructions.sentence，而不是拼进问题字符串里。
 * 3. **问题的 id 不会发给模型**（"The ids are not sent to the model"），所以题面必须自足：
 *    不能写"判断 s2 那一句"——模型看不到 s2 这个名字。
 *
 * 代词怎么解析不靠题面里的叮嘱：整段发言在 state 里，问题只指向"这一句"，
 * 模型是拿着整段去理解它的；focus 只是把这个指向讲明白。
 *
 * @param {string[]} items 拆好的句子
 * @returns {Record<string, object>} 交给 experimental_evaluate 的 questions
 */
export function buildSentenceQuestions(items) {
  const questions = {};
  items.forEach((sentence, index) => {
    questions[`s${index + 1}`] = {
      type: 'boolean',
      instructions: {
        question: '玩家这一句是否符合谜底？',
        sentence,
        focus: '这一句里的代词和省略的主语，按「玩家发言」整段的语境理解',
      },
      criteria: {
        true: '谜底明确支持这一句',
        false: '谜底不支持、与谜底无关，或无法从谜底得出结论',
      },
    };
  });
  return questions;
}


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
    const r = await this.#evaluate(buildState(question, userMessage), QUESTIONS);
    if (r.failed) return failure(r.error);
    const yesProb = yesProbOf(r.answers, 'isYes');
    return {
      isYes: yesProb >= config.judge.yesThreshold,
      yesProb,
      similarity: scoreToSimilarity(r.answers?.similarity?.score),
      usage: r.usage,
      failed: false,
    };
  }

  // 逐句核对：**一次调用**判完整段里的所有句子（不是一句一次）。
  // 整段作为 state 一起发，所以「它 / 他 / 这个」这些代词有上下文；
  // 返回值里 items 与传入的 items 一一对应。
  async judgeSentences(question, userMessage, items) {
    const list = Array.isArray(items) ? items : [];
    const r = await this.#evaluate(
      buildState(question, userMessage),
      buildSentenceQuestions(list),
    );
    if (r.failed) return { ...failure(r.error), items: [] };

    return {
      isYes: null, // 逐句核对不回答"整段是不是成立"，用不到
      yesProb: 0,
      similarity: 0,
      usage: r.usage,
      failed: false,
      items: list.map((text, index) => ({
        text,
        isYes: yesProbOf(r.answers, `s${index + 1}`) >= config.judge.yesThreshold,
      })),
    };
  }

  // 取模型 → 一次 evaluate → 统一把失败变成 { failed, error }，调用方不用各自 try
  async #evaluate(state, questions) {
    let model;
    try {
      model = await this.resolveModel();
    } catch (e) {
      error('评判渠道不可用：', e?.message || String(e));
      return { failed: true, error: e?.message || String(e) };
    }

    try {
      const result = await experimental_evaluate({
        model,
        state,
        questions,
        abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      return { failed: false, answers: result?.answers || {}, usage: result?.usage || null };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `评判超时（超过 ${JUDGE_TIMEOUT_MS / 1000} 秒）`
        : `评判调用失败：${e?.message || String(e)}`;
      error('评判调用失败：', e?.message || String(e));
      return { failed: true, error: msg };
    }
  }
}

// 某个布尔题判"是"的概率（缺字段/非法值都当 0，不会产生 NaN）
function yesProbOf(answers, id) {
  const value = answers?.[id]?.probability;
  return Number.isFinite(value) ? value : 0;
}

function failure(message) {
  return { isYes: null, yesProb: 0, similarity: 0, usage: null, failed: true, error: message };
}
