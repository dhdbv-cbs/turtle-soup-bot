// 共享命令处理器：三个平台共用一套 /斜杠命令
//
// handle() 返回值约定：
//   { text }              —— 普通文本回复（应直接发送）
//   { text, ephemeral:true} —— 仅 Discord 有效，只给发起人看
//   { ask: result }        —— 这是 /ask 的评判结果，由适配器按各平台的 @ 规则格式化
//   null                   —— 不是命令（例如普通聊天或 @机器人 提问，交给适配器处理）
import { channelHelpText, isEphemeralCommand, parseCommand } from './commands.js';

export class CommandHandler {
  constructor(gameManager, questionStore) {
    this.gm = gameManager;
    this.qs = questionStore;
  }

  async handle(channelKey, userId, userName, rawInput, { platform = 'discord' } = {}) {
    const parsed = parseCommand(rawInput);
    if (!parsed) return null;

    const { name, args } = parsed;

    switch (name) {
      case 'help':
        // /help 在 Discord 里只有发起人能看到，避免刷屏
        return { text: channelHelpText(platform), ephemeral: isEphemeralCommand(platform, 'help') };

      case 'start':
        return { text: this.start(channelKey, userId, userName) };

      case 'ask': {
        const question = args.join(' ').trim();
        if (!question) return { text: '用法：/ask <你的结论>，也可以直接 @我 提问。' };
        return { ask: await this.handleVerify(channelKey, userId, userName, question) };
      }

      case 'list':
        return { text: this.list() };

      case 'next':
        return { text: this.next(channelKey, userId, userName) };

      case 'pick':
        return { text: this.pick(channelKey, userId, userName, args[0]) };

      case 'status':
        return { text: this.status(channelKey) };

      case 'history':
        return { text: this.history(channelKey) };

      case 'reveal':
        return { text: this.reveal(channelKey) };

      case 'reset':
        this.gm.reset(channelKey);
        return { text: '🔄 本频道的游戏状态已重置。用 /start 开新的一局。' };

      default:
        return { text: `未知命令：/${name}\n发送 /help 查看全部命令。` };
    }
  }

  // 处理提问（@机器人 或 直接提问）：回答「是 / 不是」
  async handleAsk(channelKey, userId, userName, message) {
    return this.gm.ask(channelKey, userId, userName, message);
  }

  // 处理 /ask：提交结论，逐句核对（对 ✅ 错 ❌）
  async handleVerify(channelKey, userId, userName, message) {
    return this.gm.verify(channelKey, userId, userName, message);
  }

  // 提问预检（只看不记额度）：需要提前判断"这条提问会不会被限流"时用
  peekAskBlock(channelKey, userId) {
    return this.gm.peekAskQuota(channelKey, userId);
  }

  list() {
    const list = this.qs.list();
    if (list.length === 0) return '题目库为空，请到后台界面「题库」里添加题目。';
    const lines = list.map((q) => `  #${q.id}  ${q.title}`).join('\n');
    return `📚 题目库（共 ${list.length} 题）：\n${lines}\n\n用 /pick <编号> 选择，或 /next 顺序切换。`;
  }

  // 换题权限检查：进行中的一局只有发起人能换题
  denySwitch(channelKey, userId) {
    if (this.gm.canSwitch(channelKey, userId)) return null;
    const owner = this.gm.status(channelKey).ownerName;
    return `🔒 本局正在进行中，只有发起人 ${owner || '（发起人）'} 可以换题。等本局结束后再换，或让 TA 用 /next。`;
  }

  next(channelKey, userId, userName) {
    const denied = this.denySwitch(channelKey, userId);
    if (denied) return denied;
    const q = this.qs.next();
    if (!q) return '题目库为空。';
    this.gm.setQuestion(channelKey, q, { userId, userName });
    return `➡️ 已切换到第 #${q.id} 题：${q.title}\n\n用 /start 开始本局。`;
  }

  pick(channelKey, userId, userName, id) {
    const denied = this.denySwitch(channelKey, userId);
    if (denied) return denied;
    if (!id) return '用法：/pick <编号>，例如 /pick 3。';
    const q = this.qs.goto(id);
    if (!q) return `没有找到 #${id} 题。用 /list 查看所有题目。`;
    this.gm.setQuestion(channelKey, q, { userId, userName });
    return `➡️ 已选择第 #${q.id} 题：${q.title}\n\n用 /start 开始本局。`;
  }

  start(channelKey, userId, userName) {
    const r = this.gm.start(channelKey, userId, userName);
    if (!r.ok) return r.msg;
    const q = r.question;
    return (
      `🎮 第 #${q.id} 题：${q.title}\n\n` +
      `【汤面】\n${q.puzzle}\n\n` +
      `游戏开始！提问直接 @我（Discord 也可以用 /ask），我只回答「是」或「不是」；` +
      `想一次说完整结论就用 /ask，我会拆成一句一句核对，对的 ✅、错的 ❌。` +
      `当有人说中跟谜底吻合的内容时，就是集体通关。`
    );
  }

  status(channelKey) {
    const s = this.gm.status(channelKey);
    if (!s.hasQuestion) return '当前没有题目，用 /next 或 /pick <编号> 选一道。';
    const lines = [
      `📊 当前题目：#${s.questionTitle || '（无标题）'}`,
      `游戏状态：${s.started ? '进行中' : '未开始'}`,
      `提问次数：${s.questionCount}`,
      `参与人数：${s.participantCount}`,
    ];
    if (s.ownerName) lines.push(`本局发起人：${s.ownerName}`);
    if (s.winner) {
      lines.push(`🏆 通关者：${s.winner.userName}`);
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
    return `📖 谜底公布：\n\n【汤面】${r.question.puzzle}\n\n【汤底】${r.question.answer}\n\n用 /next 开始新的一局。`;
  }
}
