// 各平台共用的提问结果格式化：避免同一段文案在三个适配器里各写一遍
//
// 返回 { text, users }
//   text   最终回复文本
//   users  需要被 @ 的用户 id 列表（Discord 用来设置 allowedMentions，其它平台忽略）
//
// 两种问法对应两种回复：
//   @我 提问（answer）—— 一句「✅ 是。/ ❌ 不是。」
//   /ask 提交结论（verify）—— 逐句核对清单，对的一句一个 ✅、错的一句一个 ❌
//
// 回复里**不出现相似度**：玩家只看得到「是 / 不是」、逐句的对错和这是谁问的。
// 谁问的用各平台真正的 @（Discord `<@id>`、QQ `[CQ:at,qq=id]`），
// 客户端会把它显示成对方的昵称；实在拿不到 id 时（如 QQ 官方接口）才退回显示用户名。

export function formatAskResult(result, { mention = defaultMention } = {}) {
  if (!result) return { text: '评判失败，请重试。', users: [] };

  switch (result.type) {
    case 'win': {
      const names = [...new Set((result.history || []).map((h) => h.userName).filter(Boolean))];
      const text =
        `🎉 通关！由 ${mention(result.userId, result.userName)} 揭示谜底\n\n` +
        `参与玩家（${result.participantCount} 人）：${names.join('、')}\n\n` +
        `【完整谜底】\n${result.question?.answer ?? ''}\n\n` +
        `用 /next 开始新的一局！`;
      return { text, users: result.userId ? [result.userId] : [] };
    }

    case 'answer': {
      const text = `${mention(result.askerId, result.asker)}：${result.answer}`;
      return { text, users: result.askerId ? [result.askerId] : [] };
    }

    // /ask 提交结论：逐句核对，对的 ✅ 错的 ❌（逐句结论，但不给任何分数）
    case 'verify': {
      const items = result.items || [];
      const who = mention(result.askerId, result.asker);
      const users = result.askerId ? [result.askerId] : [];
      if (items.length === 0) {
        return { text: `${who}：这句话我没拆出可以核对的内容，换个说法再提交一次？`, users };
      }
      const lines = items.map((it) => `${it.isYes ? '✅' : '❌'} ${it.text}`);
      const text = `${who}：\n🧾 逐句核对（${items.length} 句）\n${lines.join('\n')}`;
      return { text, users };
    }

    case 'hint':
    default: {
      const text = result.text || '无法处理该提问。';
      return { text, users: result.userId ? [result.userId] : [] };
    }
  }
}

function defaultMention(id, fallbackName) {
  return fallbackName || '玩家';
}
