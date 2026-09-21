// 评判层：判断玩家提问「是/不是」，并给出玩家发言与谜底的相似度
//
// 只用 Jev（System One 模型），入口在后台界面里切换
// （Vercel AI Gateway / TypeSafe 直连 / 第三方转发的 Jev）；
// 所有入口都走 AI SDK 同一套 evaluation model 接口，这里只负责取模型 + 组装问题。
//
// 题面/state 的写法照 TypeSafe 官方规范（docs.typesafe.ai 的 State / Primitives /
// Advanced: structure 三页）：一个问题只放一个"瞬间判断"，要带的材料用带名字的字段
// 跟着问题走，判断标准放 criteria，多个判断放在同一次请求里。
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
// 官方要求 state 用**带名字的字段**（"Use an object for most requests so each part of
// the state has a descriptive name and its relationships remain clear"），字段名就和
// 题面里说的「玩家发言」「谜底」对齐。
//
// 逐句核对时**也整段发**：只发单句的话，「我爱海龟汤，它很好喝」里的"它"就没有先行词，
// Jev 只能硬抠单句字面。整段一起给它，代词和省略的主语才有上下文可依。
export function buildState(question, userMessage) {
  return {
    汤面: question.puzzle,
    谜底: question.answer, // 完整谜底，只给评判模型看，玩家侧永远看不到
    玩家发言: userMessage,
  };
}

const YES_CRITERIA = {
  true: '谜底明确支持玩家这句话',
  false: '谜底不支持、与谜底无关，或无法判断',
};

// 三道题的题面都按官方格式写：**一个问题只放一个"瞬间判断"**，判断标准放 criteria。
// 官方点名的反例是 "Analyze this message and determine the best course of action" 这类
// 需要慢慢推理的要求——所以题面里不该出现"不要…也不要…"这种叮嘱。
export const QUESTIONS = {
  isYes: {
    type: 'boolean',
    instructions: '「玩家发言」是否符合谜底？',
    criteria: YES_CRITERIA,
  },
  similarity: {
    type: 'score',
    // 判断题面只问一句：等级表（criteria）本身就是标定，5 级里已经把
    // "完整揭示"写清楚了，不需要再补"猜中细节不能给高分"这类话术
    instructions: '「玩家发言」离完整谜底有多近？',
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
        question: '「玩家发言」里的这一句是否符合谜底？',
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
