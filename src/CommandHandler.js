// 共享命令处理器：两个平台共用一套命令和回复格式
export class CommandHandler {
  constructor(gameManager, questionStore) {
    this.gm = gameManager;
    this.qs = questionStore;
  }

  // 解析并执行命令，返回 { text }
  async handle(channelKey, userId, userName, rawInput) {
    const text = (rawInput || '').trim();
    if (!text) return { text: '输入为空。' };

    // 命令格式：前缀 + "汤" + 子命令
    // 例如：!汤 开始 / !汤下一题 / #汤 列表
    // 去掉前缀和"汤"字，取剩余部分作为子命令
    const m = text.match(/^[#!\/]?\s*汤\s*(.*)$/);
    if (!m) return null; // 不是汤命令

    const sub = (m[1] || '').trim();
    const [cmd, ...args] = sub.split(/\s+/);

    switch (cmd) {
      case '':
      case '帮助':
      case 'help':
        return { text: this.help() };

      case '列表':
      case 'list':
        return { text: this.list() };

      case '下一题':
      case 'next':
        return { text: this.next(channelKey, userId, userName) };

      case '选':
      case 'goto':
        return { text: this.goto(channelKey, userId, userName, args[0]) };

      case '开始':
      case 'start':
        return { text: this.start(channelKey, userId, userName) };

      case '状态':
      case 'status':
        return { text: this.status(channelKey) };

      case '历史':
      case 'history':
        return { text: this.history(channelKey) };

      case '公布':
      case 'reveal':
        return { text: this.reveal(channelKey) };

      case '重置':
      case 'reset':
        this.gm.reset(channelKey);
        return { text: '🔄 本频道游戏状态已重置。' };

      default:
        return { text: `未知命令：${cmd}。发送「汤 帮助」查看用法。` };
    }
  }

  // 处理 @机器人 提问
  async handleAsk(channelKey, userId, userName, message) {
    return this.gm.ask(channelKey, userId, userName, message);
  }

  help() {
    return (
      '🐢 海龟汤机器人 · 命令说明\n\n' +
      '「汤 列表」查看所有题目\n' +
      '「汤 下一题」按顺序切换到下一题\n' +
      '「汤 选 <编号>」跳到指定题目\n' +
      '「汤 开始」开始当前题目（公布汤面）\n' +
      '「汤 状态」查看本局状态\n' +
      '「汤 历史」查看最近提问记录\n' +
      '「汤 公布」手动公布谜底\n' +
      '「汤 重置」重置本频道状态\n\n' +
      '📌 玩法：开始后，任何人都可以 @我 提问，我会回答「是」或「不是」。' +
      '当有人的话与谜底相似度超过 80%，即判胜利并公布完整谜底。这是多人游戏，大家一起问！\n' +
      '🔒 一局进行中时，只有本局发起人（用「汤 开始」的那个人）能换题。'
    );
  }

  list() {
    const list = this.qs.list();
    if (list.length === 0) return '题目库为空，请先通过后台 API 导入题目。';
    const lines = list.map((q) => `  #${q.id}  ${q.title}`).join('\n');
    return `📚 题目库（共 ${list.length} 题）：\n${lines}\n\n用「汤 选 <编号>」选择，或「汤 下一题」顺序切换。`;
  }

  // 换题权限检查：进行中的一局只有发起人能换题
  denySwitch(channelKey, userId) {
    if (this.gm.canSwitch(channelKey, userId)) return null;
    const owner = this.gm.status(channelKey).ownerName;
    return `🔒 本局正在进行中，只有发起人 ${owner || '（发起人）'} 可以换题。等本局结束后再换，或让 TA 用「汤 下一题」。`;
  }

  next(channelKey, userId, userName) {
    const denied = this.denySwitch(channelKey, userId);
    if (denied) return denied;
    const q = this.qs.next();
    if (!q) return '题目库为空。';
    this.gm.setQuestion(channelKey, q, { userId, userName });
    return `➡️ 已切换到第 #${q.id} 题：${q.title}\n\n用「汤 开始」开始本局。`;
  }

  goto(channelKey, userId, userName, id) {
    const denied = this.denySwitch(channelKey, userId);
    if (denied) return denied;
    if (!id) return '请指定题目编号，例如「汤 选 3」。';
    const q = this.qs.goto(id);
    if (!q) return `没有找到 #${id} 题。用「汤 列表」查看所有题目。`;
    this.gm.setQuestion(channelKey, q, { userId, userName });
    return `➡️ 已选择第 #${q.id} 题：${q.title}\n\n用「汤 开始」开始本局。`;
  }

  start(channelKey, userId, userName) {
    const r = this.gm.start(channelKey, userId, userName);
    if (!r.ok) return r.msg;
    const q = r.question;
    return (
      `🎮 第 #${q.id} 题：${q.title}\n\n` +
      `【汤面】\n${q.puzzle}\n\n` +
      `游戏开始！大家可以 @我 提问，我只回答「是」或「不是」。` +
      `当有人的话与谜底相似度 ≥ 80% 即通关。`
    );
  }

  status(channelKey) {
    const s = this.gm.status(channelKey);
    if (!s.hasQuestion) return '当前没有题目，用「汤 下一题」选一道。';
    const lines = [
      `📊 当前题目：#${s.questionTitle || '（无标题）'}`,
      `游戏状态：${s.started ? '进行中' : '未开始'}`,
      `提问次数：${s.questionCount}`,
      `参与人数：${s.participantCount}`,
    ];
    if (s.ownerName) lines.push(`本局发起人：${s.ownerName}`);
    if (s.winner) {
      lines.push(`🏆 通关者：${s.winner.userName}（相似度 ${(s.winner.similarity * 100).toFixed(0)}%）`);
    }
    if (s.revealed) lines.push('谜底已公布。');
    return lines.join('\n');
  }

  history(channelKey) {
    const h = this.gm.history(channelKey, 15);
    if (h.length === 0) return '还没有提问记录。';
    const total = this.gm.historyCount(channelKey);
    const lines = h
      .map((r) => {
        const ans = r.isYes === null ? '🤔' : r.isYes ? '✅是' : '❌不是';
        const msg = r.message.length > 40 ? `${r.message.slice(0, 40)}…` : r.message;
        return `  ${ans}  ${r.userName}：${msg}`;
      })
      .join('\n');
    const title = h.length < total ? `最近 ${h.length} 条（共 ${total} 条）` : `共 ${total} 条`;
    return `📜 提问记录（${title}）：\n${lines}`;
  }

  reveal(channelKey) {
    const r = this.gm.reveal(channelKey);
    if (!r.ok) return r.msg;
    return `📖 谜底公布：\n\n【汤面】${r.question.puzzle}\n\n【汤底】${r.question.answer}\n\n用「汤 下一题」开始新的一局。`;
  }
}
