// 各平台共用的提问结果格式化：避免同一段文案在三个适配器里各写一遍
//
// 返回 { text, users }
//   text  最终回复文本
//   users 需要被 @ 的用户 id 列表（Discord 用来设置 allowedMentions，其它平台忽略）

export function formatAskResult(result, { mention = defaultMention } = {}) {
  if (!result) return { text: '评判失败，请重试。', users: [] };

  switch (result.type) {
    case 'win': {
      const names = [...new Set((result.history || []).map((h) => h.userName))];
      const text =
        `🎉 通关！由 ${mention(result.userId, result.userName)} 揭示谜底（相似度 ${percent(result.similarity)}）\n\n` +
        `参与玩家（${result.participantCount} 人）：${names.join('、')}\n\n` +
        `【完整谜底】\n${result.question?.answer ?? ''}\n\n` +
        `用「汤 下一题」开始新的一局！`;
      return { text, users: result.userId ? [result.userId] : [] };
    }

    case 'answer': {
      const text = `${mention(result.askerId, result.asker)}：${result.answer}（与谜底相似度 ${percent(result.similarity)}）`;
      return { text, users: result.askerId ? [result.askerId] : [] };
    }

    case 'hint':
    default: {
      const text = result.text || '无法处理该提问。';
      return { text, users: result.userId ? [result.userId] : [] };
    }
  }
}

function percent(value) {
  const n = Number(value);
  return `${((Number.isFinite(n) ? n : 0) * 100).toFixed(0)}%`;
}

function defaultMention(id, fallbackName) {
  return fallbackName || '玩家';
}
