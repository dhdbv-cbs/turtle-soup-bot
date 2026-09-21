// 把玩家提交的一段结论拆成「一句话一条」，供逐句核对使用
//
// 玩家写结论时经常一段话里塞好几个判断：
//   「他是自杀的，因为欠了债，而且留了遗书」
// 这时只回一个「❌ 不是」等于没说——逐句打勾打叉才有用。
//
// 拆句规则（纯代码，不花评判调用）：
//   1. 句末标点（。！？!?；; 换行）直接断句，标点留在原句上，读起来还是原话；
//   2. 逗号也断：结论里的每个分句通常就是一个独立判断（「凶手是医生，他用毒药」）；
//   3. 半角句点也算断句，但 "3.5" 这种数字里的小数点不算；
//   4. 太短的碎片（< 3 字，比如「嗯」「对吧」）并到相邻那句上，免得判出一堆没意义的 ✅；
//   5. 超过上限时把剩下的并成最后一条：宁可判得粗一点，也绝不丢内容。
import { MAX_VERIFY_SENTENCES } from '../limits.js';

// 断句标点：遇到就切开
const BREAKS = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '\n', '\r']);
// 其中这几个是"句子结束"，保留在句尾；逗号/分号/换行只是分隔符，丢掉
const KEEP = new Set(['。', '！', '？', '!', '?']);
// 短于这个长度的句子（按字符数）会并到相邻句上
const MIN_SENTENCE_CHARS = 3;

function pushSentence(list, text) {
  const value = text.trim();
  if (value) list.push(value);
}

// 按标点切成若干片段（片段自带句末标点）
function cut(text) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (BREAKS.has(ch)) {
      // 标点跟着前面那句话走；前面没东西（连打两个句号）就把多余的标点丢掉
      if (KEEP.has(ch) && buf) buf += ch;
      pushSentence(out, buf);
      buf = '';
      continue;
    }
    // 半角句点：数字小数点（3.5）不算断句
    if (ch === '.' && !(isDigit(text[i - 1]) && isDigit(text[i + 1]))) {
      buf += ch;
      pushSentence(out, buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  pushSentence(out, buf);
  return out;
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

// 合并两条时的连接符：前一条已经有句末标点就直接接上，否则补个逗号
function joinItems(list) {
  return list.reduce((acc, item) => {
    if (!acc) return item;
    return acc + (KEEP.has(acc[acc.length - 1]) || acc.endsWith('.') ? '' : '，') + item;
  }, '');
}

// 把过短的碎片并到相邻句上（保留原话，不丢字）
function mergeShort(list) {
  const out = [];
  let pending = '';
  for (const item of list) {
    if ([...item].length < MIN_SENTENCE_CHARS) {
      pending = joinItems([pending, item]);
      continue;
    }
    out.push(joinItems([pending, item]));
    pending = '';
  }
  if (pending) {
    if (out.length) out[out.length - 1] = joinItems([out[out.length - 1], pending]);
    else out.push(pending);
  }
  return out;
}

/**
 * 拆句。
 * @param {string} text 玩家提交的内容
 * @param {object} [opts]
 * @param {number} [opts.max] 最多几条，超出部分并进最后一条
 * @returns {string[]} 至少一条（原文非空时）
 */
export function splitSentences(text, { max = MAX_VERIFY_SENTENCES } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  let list = mergeShort(cut(raw));
  if (list.length === 0) list = [raw];

  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_VERIFY_SENTENCES;
  if (list.length > limit) {
    const head = list.slice(0, limit - 1);
    head.push(joinItems(list.slice(limit - 1)));
    list = head;
  }
  return list;
}
