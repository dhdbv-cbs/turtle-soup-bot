// Discord 适配器：原生斜杠命令 + @提及提问
import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { config } from '../config.js';
import { COMMANDS, isEphemeralCommand } from '../commands.js';
import { formatAskResult } from './format.js';
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
  });

  const mention = (id, name) => (id ? `<@${id}>` : name || '玩家');

  // 注册斜杠命令：全局 + 已加入的每个服务器（服务器内的命令立刻生效，全局最长要 1 小时）
  async function registerCommands() {
    try {
      await client.application.commands.set(APP_COMMANDS);
    } catch (e) {
      warn('Discord 全局斜杠命令注册失败：', e.message);
    }
    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.commands.set(APP_COMMANDS);
      } catch (e) {
        warn(`Discord 服务器 ${guild.name} 斜杠命令注册失败：`, e.message);
      }
    }
  }

  client.once('ready', () => {
    status.state = 'connected';
    status.detail = `已登录：${client.user.tag}，正在注册 ${APP_COMMANDS.length} 个斜杠命令…`;
    log(`Discord 已登录：${client.user.tag}`);
    registerCommands()
      .then(() => {
        status.detail = `已登录：${client.user.tag}，斜杠命令 ${APP_COMMANDS.length} 个已注册`;
        log(`Discord 斜杠命令已注册：${COMMANDS.map((c) => '/' + c.name).join(' ')}`);
        log('提示：全局命令最长需要 1 小时生效；已加入的服务器内是立即生效的。');
      })
      .catch((e) => error('Discord 斜杠命令注册异常：', e?.message || String(e)));
  });

  // 被拉进新服务器时，马上把命令注册过去
  client.on('guildCreate', (guild) => {
    guild.commands
      .set(APP_COMMANDS)
      .then(() => log(`Discord 已为新服务器 ${guild.name} 注册斜杠命令`))
      .catch((e) => warn(`Discord 为 ${guild.name} 注册命令失败：`, e.message));
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

    const thinking = await safeReply(message, '🤔 思考中…', { repliedUser: false });
    const result = await handler.handleAsk(channelKey, userId, userName, askText);
    const { text, users } = formatAskResult(result, { mention });

    if (thinking) {
      try {
        await thinking.edit({ content: text, allowedMentions: { parse: [], users, repliedUser: false } });
        return;
      } catch {
        // 编辑失败则退回普通回复
      }
    }
    await safeReply(message, text, { users, repliedUser: false });
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
