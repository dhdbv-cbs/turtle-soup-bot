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

      case 'card':
        // 卡片是 Discord 专有的：那边由适配器直接贴出可点击卡片，走不到这里。
        // 这里是 QQ 渠道（或 Discord 文本兜底）落到这条命令时的说明。
        return {
          text:
            platform === 'discord'
              ? '卡片没能贴出来，先用 /status 看本局进度，再试一次 /card。'
              : '交互卡片只有 Discord 有：在那边发 /card 能把卡片重新贴到频道最下面。这里用 /start 看汤面、/status 看进度。',
        };

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
        return { text: this.reveal(channelKey, userId) };

      case 'reset':
        return { text: this.reset(channelKey, userId) };

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

  /* ---------- 给 Discord 卡片用的只读入口 ----------
   *
   * 卡片是"表现层"：它只读这些状态来渲染，所有改动仍然走下面已有的
   * next/pick/start/reveal，逻辑不会出现两份。
   */

  // 题目清单（[{ id, title, puzzle }]），卡片下拉菜单用。
  // 只带汤面做预览，**绝不带汤底**：汤底只能在开局后由卡片/命令公布。
  questionList() {
    return this.qs.listAll().map((q) => ({ id: q.id, title: q.title, puzzle: q.puzzle }));
  }

  // 当前已选中的题目（含汤面/汤底），没选则为 null
  currentQuestion(channelKey) {
    return this.gm.getState(channelKey).question ?? null;
  }

  // 本局状态摘要（GameManager.status 的薄封装）
  gameStatus(channelKey) {
    return this.gm.status(channelKey);
  }

  // 换题权限（卡片用它判断"这一下能不能点"）
  canSwitch(channelKey, userId) {
    return this.gm.canSwitch(channelKey, userId);
  }

  // 普通提问的回答方式：本频道选过的值优先，没选过用后台配置的默认值
  answerMode(channelKey) {
    return this.gm.answerMode(channelKey);
  }

  // 发起人在卡片上切换回答方式（'reply' 回消息 / 'reaction' 打反应）
  setAnswerMode(channelKey, mode) {
    return this.gm.setAnswerMode(channelKey, mode);
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
  // "会把本局冲掉"的动作（换题 / 公布谜底 / 重置）在进行中只有发起人能做。
  // 并发场景下别人手里可能还攥着一张旧卡片、或直接发命令，光看卡片上的发起人拦不住，
  // 所以每个入口都在这里过一遍。
  denySwitch(channelKey, userId, what = '换题') {
    if (this.gm.canSwitch(channelKey, userId)) return null;
    const owner = this.gm.status(channelKey).ownerName;
    return `🔒 本局正在进行中，只有发起人 ${owner || '（发起人）'} 可以${what}。等本局结束后再操作，或让 TA 来做。`;
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

  // 公布谜底：拿结构化结果（Discord 卡片要用 question.answer 原地渲染）
  revealModel(channelKey, userId) {
    const denied = this.denySwitch(channelKey, userId, '公布谜底');
    if (denied) return { ok: false, msg: denied };
    const r = this.gm.reveal(channelKey);
    if (!r.ok) return { ok: false, msg: r.msg };
    return { ok: true, question: r.question };
  }

  reveal(channelKey, userId) {
    const r = this.revealModel(channelKey, userId);
    if (!r.ok) return r.msg;
    return `📖 谜底公布：\n\n【汤面】${r.question.puzzle}\n\n【汤底】${r.question.answer}\n\n用 /next 开始新的一局。`;
  }

  // 重置本频道：进行中的一局同样只有发起人能重置，别让人一句话把别人的局清了
  reset(channelKey, userId) {
    const denied = this.denySwitch(channelKey, userId, '重置本局');
    if (denied) return denied;
    this.gm.reset(channelKey);
    return '🔄 本频道的游戏状态已重置。用 /start 开新的一局。';
  }
}
