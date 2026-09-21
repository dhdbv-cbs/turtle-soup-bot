// 命令表与各渠道的 /help 文案
//
// 所有渠道统一用 /斜杠命令（Discord 用原生斜杠命令注册，QQ 两个渠道是 /文本命令）。
// 每个渠道的 /help 正文不一样：因为"怎么触发机器人"在三个渠道里完全不同。
import { config } from './config.js';

// 命令表：后台/Discord 注册/帮助文案都从这里取，避免多处各写一份
export const COMMANDS = [
  { name: 'help', description: '查看这个渠道的用法说明' },
  { name: 'start', description: '开始当前题目，公布汤面' },
  {
    name: 'ask',
    description: '直接向谜底提问（等同于 @机器人）',
    options: [{ name: 'question', description: '你要问的问题', type: 'string', required: true }],
  },
  { name: 'list', description: '查看所有题目' },
  {
    name: 'pick',
    description: '跳到指定编号的题目',
    options: [{ name: 'id', description: '题目编号', type: 'integer', required: true }],
  },
  { name: 'next', description: '按顺序切换到下一题' },
  { name: 'status', description: '查看本局状态' },
  { name: 'history', description: '查看最近的提问记录' },
  { name: 'reveal', description: '公布谜底' },
  { name: 'reset', description: '重置本频道的游戏状态' },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

// 渠道标识：discord | napcat | official
const CHANNEL_TITLE = {
  discord: '🐢 海龟汤机器人 · Discord 用法',
  napcat: '🐢 海龟汤机器人 · QQ（NapCat）用法',
  official: '🐢 海龟汤机器人 · QQ 官方机器人用法',
};

// "怎么触发我"在三个渠道里完全不同，这一段是 /help 的核心
const CHANNEL_INTRO = {
  discord: [
    '在输入框里打 / 就能看到下面这些命令（Discord 原生斜杠命令，带参数提示）。',
    '也可以直接 @我 + 问题 来提问，效果和 /ask 一样。',
  ],
  napcat: [
    '命令直接在群里或私聊里发送即可，例如 /help、/start。',
    '群里提问请先 @我 再发问题；私聊可以直接发。',
  ],
  official: [
    '群里请先 @我，再发命令或问题，例如「@机器人 /start」。单聊直接发送即可。',
    '官方接口只能"被动回复"，且群消息 5 分钟内最多回 5 条、单聊 60 分钟最多 4 条，所以我会尽量一条说完。',
    '官方接口拿不到昵称，提问记录里显示的是「群友xxxx」（账号尾号）。',
  ],
};

function commandTable() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 8;
  return COMMANDS.map((c) => {
    const usage = c.name === 'ask' ? '/ask <问题>' : c.name === 'pick' ? '/pick <编号>' : `/${c.name}`;
    return `  ${usage.padEnd(width)}${c.description}`;
  }).join('\n');
}

const COMMON_TAIL = [
  '【玩法】',
  '用 /start 开始后，任何人都可以提问，我只回答「是」或「不是」，并给出与谜底的相似度。',
  '当有人说到与谜底足够接近（默认 80%）时，判定通关并公布完整谜底——这是多人游戏，大家一起问。',
  '',
  '【权限】',
  '一局进行中时，只有本局发起人（用 /start 的那个人）能换题（/next、/pick）；本局结束后任何人都可以换。',
];

// 取某个渠道的 /help 正文
export function helpText(platform, { custom } = {}) {
  const text = typeof custom === 'string' ? custom.trim() : '';
  if (text) return text; // 后台里填了自定义文案就以它为准

  const title = CHANNEL_TITLE[platform] ?? '🐢 海龟汤机器人 · 用法';
  const intro = CHANNEL_INTRO[platform] ?? CHANNEL_INTRO.discord;
  return [title, '', ...intro, '', '【命令】', commandTable(), '', ...COMMON_TAIL].join('\n');
}

// 各渠道的自定义文案（配置里读，方便后台改完立刻生效）
export function channelHelpText(platform) {
  if (platform === 'discord') return helpText('discord', { custom: config.discord.helpText });
  if (platform === 'napcat') return helpText('napcat', { custom: config.qq.napcat.helpText });
  if (platform === 'official') return helpText('official', { custom: config.qq.official.helpText });
  return helpText(platform, {});
}

// 哪些命令只有发起人自己看得到（Discord 支持 ephemeral，其它平台忽略）
export function isEphemeralCommand(platform, name) {
  return platform === 'discord' && name === 'help';
}

// 解析 /命令 输入，返回 { name, args }；不是命令则返回 null
export function parseCommand(raw) {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('/')) return null;

  const body = text.slice(1).trim();
  if (!body) return { name: 'help', args: [] };

  const [name, ...args] = body.split(/\s+/);
  return { name: name.toLowerCase(), args };
}
