// Discord 适配器：原生斜杠命令 + @提及提问
import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from '../config.js';
import { COMMANDS, commandsFor, isEphemeralCommand } from '../commands.js';
import { askReactionFor, formatAskResult, nextAnswerMode } from './format.js';
import { syncDiscordCommands } from './discordCommands.js';
import {
  buildPickerCard,
  buildRoundCard,
  cardKind,
  cardPayload,
  isCardUsable,
  pageOfId,
  parseCustomId,
  planCardAction,
  summonTarget,
} from './discordCards.js';
import { startTyping, startTypingFor } from './typing.js';
import { proxyRestAgent } from '../proxy.js';
import { log, error, warn } from '../utils/logger.js';
import { createSerializer } from '../utils/serialize.js';

// 同一频道的卡片交互串行处理（见 utils/serialize.js 的说明）
const serializeCard = createSerializer();

// 把共享命令表转成 Discord 应用命令（type: 3 = STRING, 4 = INTEGER）
// 只取标了 discord（或没标渠道）的命令，避免把 QQ 专有命令注册到 Discord
const APP_COMMANDS = commandsFor('discord').map((c) => ({
  name: c.name,
  description: c.description,
  options: (c.options || []).map((o) => ({
    name: o.name,
    description: o.description,
    type: o.type === 'integer' ? 4 : 3,
    required: !!o.required,
  })),
}));

export async function startDiscord(handler) {
  const { token } = config.discord;
  const status = { state: 'connecting', detail: '正在登录…' };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
    // REST 不认全局 dispatcher（@discordjs/rest 用的是自己那份 undici），得显式给
    rest: { agent: proxyRestAgent() },
  });

  // 真正的 @：Discord 会把它显示成对方的用户名
  const mention = (id, name) => (id ? `<@${id}>` : name || '玩家');

  // 斜杠命令只注册**全局**这一份：
  // 既在服务器里能用，也在私聊里能用；再给每个服务器单独注册一份的话，
  // 客户端里同一个命令会出现两条（discord.js 也无法合并），所以服务器级的要清掉。
  async function registerCommands() {
    return syncDiscordCommands({
      application: client.application,
      guilds: client.guilds.cache.values(),
      commands: APP_COMMANDS,
      log,
      warn,
    });
  }

  client.once('ready', () => {
    status.state = 'connected';
    status.detail = `已登录：${client.user.tag}，正在同步 ${APP_COMMANDS.length} 个斜杠命令…`;
    log(`Discord 已登录：${client.user.tag}`);
    registerCommands()
      .then((r) => {
        status.detail = r.failed
          ? `已登录：${client.user.tag}，斜杠命令注册失败（详见日志）`
          : `已登录：${client.user.tag}，斜杠命令 ${APP_COMMANDS.length} 个已就绪`;
      })
      .catch((e) => error('Discord 斜杠命令同步异常：', e?.stack || String(e)));
  });

  // 被拉进新服务器时不用再注册：全局命令对任何服务器都生效
  client.on('guildCreate', (guild) => {
    log(`Discord 已加入新服务器：${guild.name}（斜杠命令是全局注册的，无需单独注册）`);
  });

  client.on('error', (e) => {
    status.detail = e.message;
    error('Discord 错误：', e.message);
  });

  client.on('interactionCreate', (interaction) => {
    if (interaction.isChatInputCommand()) {
      handleInteraction(interaction).catch((e) =>
        error('Discord 斜杠命令处理失败：', e?.stack || String(e)),
      );
      return;
    }
    // 卡片上的按钮/下拉：同一个频道内串行处理，
    // 免得两个人（或手快）同时点时，先点的渲染后到、把后点的样子又盖回去
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const key = interaction.guildId
        ? `discord:${interaction.guildId}:${interaction.channelId}`
        : `discord:dm:${interaction.user.id}`;
      serializeCard(key, () => handleComponent(interaction)).catch((e) =>
        error('Discord 卡片交互处理失败：', e?.stack || String(e)),
      );
    }
  });

  client.on('messageCreate', (message) => {
    handleMessage(message).catch((e) => error('Discord 消息处理失败：', e?.message || String(e)));
  });

  // ---------- 斜杠命令 ----------

  async function handleInteraction(interaction) {
    const channelKey = interaction.guildId
      ? `discord:${interaction.guildId}:${interaction.channelId}`
      : `discord:dm:${interaction.user.id}`;
    const userName =
      interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

    const args = interaction.options.data
      .map((opt) => opt.value)
      .filter((v) => v !== undefined && v !== null)
      .map(String);
    const raw = `/${interaction.commandName}${args.length ? ` ${args.join(' ')}` : ''}`;

    // /start 是卡片入口：渲染是即时的，不必 defer（defer 出来的是空占位，没法做成 V2）
    if (interaction.commandName === 'start') {
      await replyStartCard(interaction, channelKey);
      return;
    }

    // /card 也是卡片入口：把卡片重新贴到最下面，同样即时、不 defer
    if (interaction.commandName === 'card') {
      await replySummonedCard(interaction, channelKey);
      return;
    }

    // 评判可能要好几秒，而 Discord 只给 3 秒，所以先 defer 再干活
    const ephemeral = isEphemeralCommand('discord', interaction.commandName);
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});

    const result = await handler.handle(channelKey, interaction.user.id, userName, raw, {
      platform: 'discord',
    });

    if (!result) {
      await interaction.editReply(`未知命令：${raw}\n发送 /help 查看全部命令。`);
      return;
    }

    if (result.ask) {
      const { text, users } = formatAskResult(result.ask, { mention });
      await editReply(interaction, text, users);
      return;
    }

    await editReply(interaction, result.text, []);
  }

  // ---------- 卡片（Components V2）：/start → 选汤 → 开局 ----------
  //
  // 这里只做「渲染 + 转发」：所有状态改动都调 CommandHandler 里已有的
  // next/pick/start/reveal，卡片不会另起一套逻辑。
  // 鉴权靠 customId 里带的发起人 id（组件交互时 Discord 原样回传，玩家伪造不了），
  // 所以不需要在内存里存"这张卡片归谁"，机器人重启后旧卡片依然能正确鉴权。

  function pickerPayload(channelKey, ownerId, page) {
    const status = handler.gameStatus(channelKey);
    return cardPayload(
      buildPickerCard({
        questions: handler.questionList(),
        page,
        current: handler.currentQuestion(channelKey),
        status,
        ownerId,
        // 卡片上的「回答方式」按钮显示当前值（发起人可自己切）
        answerMode: status.answerMode,
      }),
    );
  }

  function roundPayload(channelKey, ownerId) {
    const question = handler.currentQuestion(channelKey);
    const status = handler.gameStatus(channelKey);
    // 通关或已公布才把汤底摊开
    const showAnswer = !!status.revealed || !!status.winner;
    return cardPayload(
      buildRoundCard({
        question,
        status,
        ownerId,
        revealed: showAnswer,
        answer: question?.answer ?? null,
        answerMode: status.answerMode,
      }),
    );
  }

  // 当前题目落在第几页（一页 25 题）
  function pageOfCurrent(channelKey) {
    return pageOfId(handler.questionList(), handler.currentQuestion(channelKey));
  }

  // 该贴哪张卡片（规则见 discordCards.cardKind）。
  // 构建失败或超出 Discord 上限时返回 null，由调用方退回文本。
  function currentCardPayload(channelKey, ownerId, { keepRound = false } = {}) {
    try {
      const kind = cardKind(handler.gameStatus(channelKey), { keepRound });
      const payload =
        kind === 'round'
          ? roundPayload(channelKey, ownerId)
          : pickerPayload(channelKey, ownerId, pageOfCurrent(channelKey));
      return isCardUsable(payload) ? payload : null;
    } catch (e) {
      // 卡片构建抛错绝不能变成 Discord 的「应用未响应」
      error('卡片构建失败，退回文本：', e?.stack || String(e));
      return null;
    }
  }

  // 卡片贴不出来时的文本兜底（和上面的卡片类型保持一致）
  function cardFallbackText(channelKey, { keepRound = false } = {}) {
    const kind = cardKind(handler.gameStatus(channelKey), { keepRound });
    return kind === 'round' ? handler.status(channelKey) : handler.list();
  }

  // /start：进行中的一局给汤面卡片，否则给选汤卡片。
  // 卡片**归本局发起人**（和 /card 同一套判断）：并发时别人 /start 也只会拿到
  // 一张自己点不动的卡片（点"公布谜底"还会被挡回来），不如直接说清楚。
  async function replyStartCard(interaction, channelKey) {
    const target = summonTarget(handler.gameStatus(channelKey), interaction.user.id);
    if (!target.isOwner) {
      await interaction.reply({
        content: `本局是 ${target.ownerName || '别人'} 发起的，还没结束。要卡片就让 TA 发一句 /card，或等本局结束再开新的。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const payload = currentCardPayload(channelKey, target.ownerId);
    if (!payload) {
      await interaction.reply({
        content: cardFallbackText(channelKey),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply(payload);
  }

  // /card：把当前卡片**重新贴一张**到频道最下面（楼层多了翻不上去时用）。
  // 与 /start 的区别：完全不改状态，只是"再贴一张"。
  async function replySummonedCard(interaction, channelKey) {
    const target = summonTarget(handler.gameStatus(channelKey), interaction.user.id);
    if (!target.isOwner) {
      // 别人贴出来也点不动，只会把频道刷乱：回一句只有他自己看得到的说明
      await interaction.reply({
        content: `本局是 ${target.ownerName || '别人'} 发起的，只有 TA 能把卡片重新贴出来 —— 让 TA 发一句 /card 就行。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const payload = currentCardPayload(channelKey, target.ownerId, { keepRound: true });
    if (!payload) {
      await interaction.reply({
        content: cardFallbackText(channelKey, { keepRound: true }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply(payload);
  }

  // 卡片上的按钮 / 下拉
  async function handleComponent(interaction) {
    const custom = parseCustomId(interaction.customId);
    if (!custom) return;

    const channelKey = interaction.guildId
      ? `discord:${interaction.guildId}:${interaction.channelId}`
      : `discord:dm:${interaction.user.id}`;
    const userId = interaction.user.id;
    const userName =
      interaction.member?.nickname || interaction.user.globalName || interaction.user.username;
    const { action, args, ownerId } = custom;

    // 只给发起人看的小提示（点击后不改卡片本身）
    const hint = async (text) => {
      const payload = {
        content: text,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    };

    // 该干什么由纯函数决定（见 discordCards.js），这里只执行 + 渲染
    const plan = planCardAction({
      action,
      args,
      ownerId,
      userId,
      isSelect: interaction.isStringSelectMenu(),
      values: interaction.values ?? [],
      questions: handler.questionList(),
      current: handler.currentQuestion(channelKey),
      canSwitch: (uid) => handler.canSwitch(channelKey, uid),
    });

    const render = async (view) =>
      interaction.update(
        view.view === 'round'
          ? roundPayload(channelKey, ownerId)
          : pickerPayload(channelKey, ownerId, view.page),
      );

    // 任何渲染异常都要变成一句能看懂的话，而不是 Discord 的「应用未响应」
    try {
      await runPlan(plan, { channelKey, userId, userName, ownerId, hint, render });
    } catch (e) {
      error('卡片交互失败：', e?.stack || String(e));
      await hint('⚠️ 这张卡片操作失败了，用 /start 或斜杠命令再试一次（原因已写进日志）。');
    }
  }

  async function runPlan(plan, { channelKey, userId, userName, ownerId, hint, render }) {
    switch (plan.type) {
      case 'deny':
        await hint(`🔒 这张卡片是 <@${ownerId}> 发起的。想自己开一局就用 /start。`);
        return;

      case 'switch-denied':
        await hint(handler.denySwitch(channelKey, userId));
        return;

      case 'hint':
        await hint(plan.text);
        return;

      // 回答方式下拉：选哪个就是哪个
      case 'set-mode': {
        const r = handler.setAnswerMode(channelKey, plan.mode);
        if (!r.ok) return hint(r.msg);
        await render(plan.view);
        return;
      }

      // 老卡片上残留的切换按钮：仍然支持，点一下翻转
      case 'toggle-mode': {
        const r = handler.setAnswerMode(channelKey, nextAnswerMode(handler.answerMode(channelKey)));
        if (!r.ok) return hint(r.msg);
        await render(plan.view);
        return;
      }

      case 'view':
        await render(plan);
        return;

      case 'command': {
        if (plan.command === 'pick') {
          handler.pick(channelKey, userId, userName, plan.id);
        } else if (plan.command === 'start') {
          const msg = handler.start(channelKey, userId, userName);
          if (!handler.gameStatus(channelKey).started) return hint(msg);
        } else if (plan.command === 'reveal') {
          const r = handler.revealModel(channelKey, userId);
          if (!r.ok) return hint(r.msg);
        }
        await render(plan.view);
        return;
      }

      default:
        return;
    }
  }

  async function editReply(interaction, text, users) {
    // 是否"仅自己可见"在 deferReply 时已经定了，后续 edit/followUp 会沿用
    const chunks = splitLong(text, 1900);
    await interaction.editReply({
      content: chunks.shift(),
      allowedMentions: { parse: [], users },
    });
    for (const chunk of chunks) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [], users },
      });
    }
  }

  // ---------- 普通消息：/命令 或 @机器人 提问 ----------

  async function handleMessage(message) {
    if (message.author.bot) return;
    const channelKey = message.guild
      ? `discord:${message.guild.id}:${message.channel.id}`
      : `discord:dm:${message.author.id}`;
    const userId = message.author.id;
    const userName = message.member?.nickname || message.author.globalName || message.author.username;
    const content = message.content.trim();

    // 文本形式的 /命令（正常情况 Discord 客户端会拦截 "/"，这里只作兜底）
    if (content.startsWith('/')) {
      // /card 也是卡片入口：直接把卡片作为一条新消息贴到最下面
      if (/^\/card(\s|$)/i.test(content)) {
        const target = summonTarget(handler.gameStatus(channelKey), userId);
        if (!target.isOwner) {
          await safeReply(
            message,
            `本局是 ${target.ownerName || '别人'} 发起的，只有 TA 能把卡片重新贴出来。`,
            { repliedUser: false },
          );
          return;
        }
        const payload = currentCardPayload(channelKey, target.ownerId, { keepRound: true });
        if (!payload) {
          await safeReply(message, cardFallbackText(channelKey, { keepRound: true }), {
            repliedUser: false,
          });
          return;
        }
        // V2 卡片直接作为回复发出去（cardPayload 已带好 flags 和 allowedMentions）
        await message.reply(payload).catch((e) => warn('Discord 卡片发送失败：', e.message));
        return;
      }

      // 只有 /ask 会真的等评判，其余命令是即时的，不必闪一下输入状态
      const stopTyping = /^\/ask(\s|$)/i.test(content) ? startTyping(message.channel) : () => {};
      try {
        const result = await handler.handle(channelKey, userId, userName, content, {
          platform: 'discord',
        });
        if (!result) return;
        if (result.ask) {
          const { text, users } = formatAskResult(result.ask, { mention });
          await safeReply(message, text, { users, repliedUser: false });
          return;
        }
        await safeReply(message, result.text, { repliedUser: true });
      } finally {
        stopTyping();
      }
      return;
    }

    // @机器人 提问
    const mentioned = message.mentions.users.has(client.user.id);
    if (!mentioned) return;

    const askText = content
      .replace(/<@!?\d+>/g, '')
      .replace(/@\S+/g, '')
      .trim();
    if (!askText) {
      await safeReply(message, '你 @我 了但没说内容。用法：/help 查看命令，或 @我 + 你的问题。', {
        repliedUser: false,
      });
      return;
    }

    // 评判要好几秒，先在频道里显示「正在输入…」（会自己续期）；
    // 回复一发出去 Discord 就结束这个状态，这里只负责收掉续期定时器。
    // 斜杠命令不需要它：Discord 自己会用 deferReply 显示「正在思考…」。
    // 反应模式也不显示：它不发消息，输入状态收不掉，会在 ✅ / ❌ 打上去之后继续挂 10 秒。
    const answerMode = handler.gameStatus(channelKey).answerMode;
    const stopTyping = startTypingFor(message.channel, answerMode);
    try {
      const result = await handler.handleAsk(channelKey, userId, userName, askText);

      // 反应模式（卡片里可切换）：普通提问直接在提问者那条消息上打 ✅ / ❌ / 🤔，不再回一条消息。
      // 通关、限流、题目状态提示这类必须解释清楚的内容 askReaction() 会返回 null，仍然走文本。
      // 回答方式按**本频道当前的选择**走（发起人在卡片上可切换；没人切过就用后台配置的默认值）
      const reaction = askReactionFor(answerMode, result);
      if (reaction) {
        try {
          await message.react(reaction);
          return;
        } catch (e) {
          // 没有「添加反应」权限、消息被删、反应数满了……都退回到文字回复，别让玩家什么都收不到
          warn('Discord 加反应失败，改用文字回复：', e.message);
        }
      }

      const { text, users } = formatAskResult(result, { mention });
      await safeReply(message, text, { users, repliedUser: false });
    } finally {
      stopTyping();
    }
  }

  // users：允许被 @ 的用户 id 列表（其余一律不解析，防止题库文本里的 @everyone 触发全员提醒）
  async function safeReply(message, text, { users = [], repliedUser = true } = {}) {
    try {
      const chunks = splitLong(text, 1900);
      let last = null;
      for (const chunk of chunks) {
        last = await message.reply({
          content: chunk,
          allowedMentions: { parse: [], users, repliedUser },
        });
      }
      return last;
    } catch (e) {
      warn('Discord 回复失败：', e.message);
      return null;
    }
  }

  try {
    await client.login(token);
    status.state = 'connected';
    status.detail = `已登录：${client.user?.tag ?? ''}`;
  } catch (e) {
    status.state = 'error';
    status.detail = `登录失败：${e.message}`;
    error('Discord 登录失败：', e.message);
  }

  return {
    name: 'Discord',
    status: () => ({ ...status }),
    stop() {
      try {
        client.destroy();
      } catch {}
      status.state = 'stopped';
      status.detail = '已停止';
    },
  };
}

function splitLong(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return [value];
  const parts = [];
  for (let i = 0; i < value.length; i += max) parts.push(value.slice(i, i + max));
  return parts;
}
