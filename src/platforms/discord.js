// Discord 适配器：discord.js v14，前缀命令 + @提及提问
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { formatAskResult } from './format.js';
import { log, error, warn } from '../utils/logger.js';

export async function startDiscord(handler) {
  const { token, prefix: PREFIX } = config.discord;
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

  client.once('ready', () => {
    status.state = 'connected';
    status.detail = `已登录：${client.user.tag}`;
    log(`Discord 已登录：${client.user.tag}（前缀 ${PREFIX}汤）`);
  });

  client.on('messageCreate', (message) => {
    // 兜底：任何意外都不该让进程挂掉
    handleMessage(message).catch((e) => error('Discord 消息处理失败：', e?.message || String(e)));
  });

  client.on('error', (e) => {
    status.detail = e.message;
    error('Discord 错误：', e.message);
  });

  async function handleMessage(message) {
    if (message.author.bot) return;
    const channelKey = message.guild
      ? `discord:${message.guild.id}:${message.channel.id}`
      : `discord:dm:${message.author.id}`;
    const userId = message.author.id;
    const userName = message.member?.nickname || message.author.globalName || message.author.username;
    const content = message.content.trim();

    // 1) 前缀命令：!汤 ...
    if (content.startsWith(PREFIX)) {
      const result = await handler.handle(channelKey, userId, userName, content);
      if (result) {
        // 命令回复只允许回复对象被 @，不解析正文里的 @everyone / @角色
        await safeReply(message, result.text, { repliedUser: true });
      }
      return;
    }

    // 2) @机器人 提问
    const mentioned = message.mentions.users.has(client.user.id);
    if (!mentioned) return;

    // 去掉 @提及，保留纯文本
    const askText = content
      .replace(/<@!?\d+>/g, '')
      .replace(/@\S+/g, '')
      .trim();
    if (!askText) {
      await safeReply(message, '你 @我 了但没说内容，把问题发给我吧。', { repliedUser: false });
      return;
    }

    // 显示"思考中"（先不 @ 任何人，避免重复提醒）
    const thinking = await safeReply(message, '🤔 思考中…', { repliedUser: false });
    const result = await handler.handleAsk(channelKey, userId, userName, askText);
    const { text, users } = formatAskResult(result, {
      mention: (id, name) => (id ? `<@${id}>` : name || '玩家'),
    });

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
      // Discord 单条消息上限 2000 字符
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
  if (text.length <= max) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}
