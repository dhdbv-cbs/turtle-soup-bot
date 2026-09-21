// 命令表与各渠道的 /help 文案
//
// 所有渠道统一用 /斜杠命令（Discord 用原生斜杠命令注册，QQ 两个渠道是 /文本命令）。
// 每个渠道的 /help 正文不一样：因为"怎么触发机器人"在三个渠道里完全不同。
import { config } from './config.js';
import { ASK_RATE_LIMIT } from './limits.js';

// 命令表：后台/Discord 注册/帮助文案都从这里取，避免多处各写一份
export const COMMANDS = [
  { name: 'help', description: '查看这个渠道的用法说明' },
  { name: 'start', description: '开始当前题目，公布汤面' },
  {
    name: 'ask',
    description: '提交你的结论：我会逐句核对（对 ✅ 错 ❌）',
    options: [
      {
        name: 'conclusion',
        description: '你要核对的结论，可以写多句',
        type: 'string',
        required: true,
      },
    ],
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
    '也可以直接 @我 + 问题 来提问，效果和 /ask 一样；私聊我同样能用。',
    '/help 只有你自己看得到，不会刷屏。',
  ],
  napcat: [
    '命令直接在群里或私聊里发送即可，例如 /help、/start（普通聊天我不会理）。',
    '群里提问请先 @我 再发问题，例如「@机器人 他是被谋杀的」；私聊可以直接发。',
    '私聊我发 /help 也能看到这份说明。',
  ],
  official: [
    '群里请先 @我，再发命令或问题，例如「@机器人 /start」。单聊直接发送即可。',
    '官方接口只允许「被动消息」：我得先收到你的消息才能回——群聊 5 分钟内、每条消息最多回 5 条，单聊 60 分钟内、最多回 4 条，所以我会尽量一条说完。',
    '主动推送要平台另外开权限、你也能在机器人资料卡里关掉，所以这个机器人只回复，不主动来找你。',
    '官方接口发消息时不能 @ 别人（发送接口没有这个字段），回复里我直接写你的昵称。',
  ],
};

function commandTable() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 8;
  return COMMANDS.map((c) => {
    const usage = c.name === 'ask' ? '/ask <问题>' : c.name === 'pick' ? '/pick <编号>' : `/${c.name}`;
    return `  ${usage.padEnd(width)}${c.description}`;
  }).join('\n');
}

// 各渠道的提问方式举例（/help 里最有用的一节）
const CHANNEL_EXAMPLES = {
  discord: [
    '  /next                    换到下一题',
    '  /start                   开始这一题，公布汤面',
    '  /ask 他是自杀的，他留了遗书   提交结论：逐句核对，对 ✅ 错 ❌',
    '  @我 他是自杀的吗          提问：我回答「是 / 不是」',
    '  /status                  看看本局问到哪了',
  ],
  napcat: [
    '  /next                    换到下一题',
    '  /start                   开始这一题，公布汤面',
    '  /ask 他是自杀的，他留了遗书   提交结论：逐句核对，对 ✅ 错 ❌',
    '  @机器人 他是自杀的吗      提问：我回答「是 / 不是」',
    '  /status                  看看本局问到哪了',
  ],
  official: [
    '  @机器人 /next             换到下一题',
    '  @机器人 /start            开始这一题，公布汤面',
    '  @机器人 /ask 他是自杀的     提交结论：逐句核对，对 ✅ 错 ❌',
    '  @机器人 他是自杀的吗      提问：我回答「是 / 不是」',
    '  @机器人 /status           看看本局问到哪了',
  ],
};

// 所有渠道共用的玩法说明
const COMMON_TAIL = [
  '【怎么玩】',
  '1. 先选一道题：/next 按顺序换题，/pick <编号> 跳到指定题目，/list 看全部题目。',
  '2. /start 开始这一局，我会公布汤面（只给线索，不给谜底）。',
  '3. 想一次说完整结论就用 /ask：我会把你这段话拆成一句一句核对，对的 ✅、错的 ❌。',
  '4. 其它提问直接 @我：这种我只回答「是」或「不是」，两种方式都不会报分数。',
  '5. 有人说中跟谜底吻合的内容时，就是集体通关，我会公布完整谜底和参与名单。',
  '',
  '【规则与限制】',
  `· 每人每分钟最多提问 ${ASK_RATE_LIMIT} 次，超过了我会让你歇一下再问。`,
  '· /ask 一条最多拆 6 句逐句核对，多出来的部分会并成最后一句，内容不会丢。',
  '· 一局进行中，只有本局发起人（用 /start 的那个人）能换题（/next、/pick）；本局结束后谁都能换。',
  '· 换题即开新一局，参与人数和提问记录会清零；/reset 可以把本频道彻底重置。',
  '· 同时有几个人在问时，我会按提问顺序一条条答，不会乱序。',
];

// 取某个渠道的 /help 正文
export function helpText(platform, { custom } = {}) {
  const text = typeof custom === 'string' ? custom.trim() : '';
  if (text) return text; // 后台里填了自定义文案就以它为准

  const title = CHANNEL_TITLE[platform] ?? '🐢 海龟汤机器人 · 用法';
  const intro = CHANNEL_INTRO[platform] ?? CHANNEL_INTRO.discord;
  const examples = CHANNEL_EXAMPLES[platform] ?? CHANNEL_EXAMPLES.discord;
  return [
    title,
    '',
    ...intro,
    '',
    '【命令】',
    commandTable(),
    '',
    '【常用例子】',
    ...examples,
    '',
    ...COMMON_TAIL,
  ].join('\n');
}

// 该渠道的内置文案（不含自定义覆盖）；后台界面用它把输入框预先填好，
// 这样你打开页面看到的就是完整文案，不用自己写。
export function defaultHelpText(platform) {
  return helpText(platform, {});
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
