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
      // 每句都对却没通关：说明方向对了，但还差最关键的那一环，给一句提示免得玩家卡住
      // （走到这里一定是没通关——通关那条走的是 win 分支）
      const allYes = items.every((it) => it.isYes);
      const tail = allYes ? '\n\n💡 每句都对，但还没说中核心谜底，再往真相推一步。' : '';
      const text = `${who}：\n🧾 逐句核对（${items.length} 句）\n${lines.join('\n')}${tail}`;
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

// 普通提问该在提问者消息上打哪个反应（Discord 的 reaction 模式用）。
//
// 只有「是 / 不是 / 判断不了」能用单个表情说清，所以这里**只认 answer**：
//   isYes === true  → ✅
//   isYes === false → ❌
//   isYes === null  → 🤔（这个问题暂时判断不了）
// 其它情况（通关 🎉、各种提示、/ask 的逐句核对）一律返回 null，
// 由调用方走文本回复——这些内容塞进一个表情里会丢信息。
export function askReaction(result) {
  if (!result || result.type !== 'answer') return null;
  if (result.isYes === true) return '✅';
  if (result.isYes === false) return '❌';
  return '🤔';
}

// 反应模式的总开关（discord.askReplyMode）：
//   'reaction' → 该打反应就打反应
//   其它取值（含默认 'reply'）→ 一律返回 null，照旧回一条消息
// 未知取值按 reply 处理：配置坏了也不该突然改行为。
export function askReactionFor(mode, result) {
  return mode === 'reaction' ? askReaction(result) : null;
}

// 卡片上「回答方式」按钮点一下之后该变成什么：两个值来回切。
// 未知取值（配置损坏/旧数据）一律切成 reaction——按钮总得有点用，
// 而且玩家点完能立刻从卡片上看到结果。
export function nextAnswerMode(mode) {
  return mode === 'reaction' ? 'reply' : 'reaction';
}
