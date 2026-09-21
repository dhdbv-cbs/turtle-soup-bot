// Discord 适配器：原生斜杠命令 + @提及提问
import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from '../config.js';
import { COMMANDS, isEphemeralCommand } from '../commands.js';
import { formatAskResult } from './format.js';
import { syncDiscordCommands } from './discordCommands.js';
import { startTyping } from './typing.js';
import { proxyRestAgent } from '../proxy.js';
import { log, error, warn } from '../utils/logger.js';

// 把共享命令表转成 Discord 应用命令（type: 3 = STRING, 4 = INTEGER）
const APP_COMMANDS = COMMANDS.map((c) => ({
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
    if (!interaction.isChatInputCommand()) return;
    handleInteraction(interaction).catch((e) =>
      error('Discord 斜杠命令处理失败：', e?.stack || String(e)),
    );
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
    const stopTyping = startTyping(message.channel);
    try {
      const result = await handler.handleAsk(channelKey, userId, userName, askText);
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
