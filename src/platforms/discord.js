// Discord 适配器：discord.js v14，前缀命令 + @提及提问
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config, isPlaceholder } from '../config.js';
import { log, error, warn } from '../utils/logger.js';

export async function startDiscord(handler) {
  const { enabled, token, prefix: PREFIX } = config.discord;

  if (!enabled) {
    log('Discord 平台已禁用（DISCORD_ENABLED != true）');
    return null;
  }
  if (isPlaceholder(token)) {
    warn('Discord token 未配置，跳过 Discord 平台');
    return null;
  }

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
    log(`Discord 已登录：${client.user.tag}（前缀 ${PREFIX}汤）`);
  });

  client.on('messageCreate', (message) => {
    // 兜底：任何意外都不该让进程挂掉
    handleMessage(message).catch((e) => error('Discord 消息处理失败：', e?.message || String(e)));
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
    const { text, users } = formatAskResult(result);

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

  client.on('error', (e) => error('Discord 错误：', e.message));

  try {
    await client.login(token);
    return client;
  } catch (e) {
    error('Discord 登录失败：', e.message);
    return null;
  }
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

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

function mentionOf(id, fallbackName) {
  return id ? `<@${id}>` : fallbackName || '玩家';
}

// 把 GameManager.ask 的返回格式化成 { text, users }
// users 只包含本次要 @ 的提问者/通关者
function formatAskResult(result) {
  if (!result) return { text: '评判失败，请重试。', users: [] };

  switch (result.type) {
    case 'win': {
      const names = [...new Set((result.history || []).map((h) => h.userName))];
      const text =
        `🎉 通关！由 ${mentionOf(result.userId, result.userName)} 揭示谜底（相似度 ${(result.similarity * 100).toFixed(0)}%）\n\n` +
        `参与玩家（${result.participantCount} 人）：${names.join('、')}\n\n` +
        `【完整谜底】\n${result.question.answer}\n\n` +
        `用「汤 下一题」开始新的一局！`;
      return { text, users: result.userId ? [result.userId] : [] };
    }

    case 'answer': {
      const text = `${mentionOf(result.askerId, result.asker)}：${result.answer} （与谜底相似度 ${(result.similarity * 100).toFixed(0)}%）`;
      return { text, users: result.askerId ? [result.askerId] : [] };
    }

    case 'hint':
    default:
      return { text: result.text || '无法处理该提问。', users: result.userId ? [result.userId] : [] };
  }
}
