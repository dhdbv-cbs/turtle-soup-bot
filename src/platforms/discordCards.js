// Discord 卡片（Components V2）：把「/start → 选汤 → 开局」做成可点的卡片
//
// 这个文件里只有**纯函数**：给题目列表和游戏状态，返回能直接发给 Discord 的
// payload（{ flags, components, allowedMentions }）。不碰网络、不碰状态，
// 所以能单独跑测试；QQ 两个渠道完全不受影响（那边的 /start 仍然是文本）。
//
// 鉴权思路：把发起人 id 编进 customId（ts:<动作>:<参数…>:<发起人 id>）。
// customId 是 Discord 在组件交互时原样回传的，玩家伪造不了，
// 因此不需要在内存里维护"这张卡片归谁"，机器人重启后旧卡片依然能正确鉴权。
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from 'discord.js';

// Discord 下拉菜单最多 25 个选项，所以题目多了要分页
export const PAGE_SIZE = 25;
// 自定义 id 前缀，避免和其它组件撞车
export const ID_PREFIX = 'ts';
// customId 上限 100 字符，超了就直接不发卡片（宁可不发也不能发出去报错）
export const MAX_CUSTOM_ID = 100;
// Components V2 的硬限制：整条消息组件总数 ≤ 40（嵌套也算），
// 所有 TextDisplay 正文合计 ≤ 4000 字符（不是 JSON 体积），Container 顶层子组件 ≤ 10。
export const MAX_COMPONENTS = 40;
export const MAX_TEXT_TOTAL = 4000;
export const MAX_CONTAINER_CHILDREN = 10;

/* ---------------- customId 编解码 ---------------- */

export function buildCustomId(action, ownerId, ...args) {
  return [ID_PREFIX, action, ...args, String(ownerId ?? '')].join(':');
}

export function parseCustomId(raw) {
  const parts = String(raw ?? '').split(':');
  if (parts.length < 3 || parts[0] !== ID_PREFIX) return null;
  const action = parts[1];
  const ownerId = parts[parts.length - 1];
  if (!action || !ownerId) return null;
  return { action, args: parts.slice(2, -1), ownerId };
}

/* ---------------- 分页 ---------------- */

export function pageCount(total, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

export function clampPage(page, total, size = PAGE_SIZE) {
  const last = pageCount(total, size) - 1;
  const n = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 0;
  return Math.min(Math.max(n, 0), last);
}

export function pageSlice(questions, page, size = PAGE_SIZE) {
  const list = Array.isArray(questions) ? questions : [];
  const p = clampPage(page, list.length, size);
  const start = p * size;
  return { page: p, start, items: list.slice(start, start + size), total: list.length };
}

/* ---------------- 文本小工具 ---------------- */

// 各块文案的上限：Discord 要求一条消息里所有文本合计 ≤4000 字，
// 这里按「汤面 1800 + 汤底 1200 + 标题/状态/提示 ≈ 400」分，留足余量。
const TITLE_LIMIT = 80;
const PUZZLE_LIMIT = 1800;
const ANSWER_LIMIT = 1200;
const OPTION_LABEL_LIMIT = 100;

function cut(value, max) {
  const s = String(value ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

// 画一条分隔线：用来把"标题区"和"内容区"分开
function divider() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

// 只留白不画线：分组用，比连画几条横线干净
function spacer(size = SeparatorSpacingSize.Large) {
  return new SeparatorBuilder().setDivider(false).setSpacing(size);
}

// 小字（Discord 的 -# 子文本）：放"题库多少题""怎么玩"这类次要信息
function subtext(content) {
  return text(`-# ${content}`);
}

// 玩法提示：只在"该用它"的地方出现一次，不两张卡片各说一遍
export const START_HINT = '选一道汤 → 点「开始本局」→ 在频道里 @我 提问';

// 两种回答方式的区别：放在下拉框正下方，不用点开也看得懂
export const ANSWER_MODE_HINT =
  '💬 直接回复 = 每次提问单独回一条「是 / 不是」 · ⚡ 用反应 = 在提问那条消息上打 ✅ / ❌';

// 对局卡片底部的提示：怎么提问 + 两种回答方式的区别
export const ASK_SELECT_HINT = `在频道里 @我 提问 · ${ANSWER_MODE_HINT}`;

// 进行中的警告：换掉上面的引导
export function activeHint(ownerName) {
  return `⚠️ 本局进行中（发起人 ${ownerName || '未知'}），只有 TA 能换题`;
}

function button(customId, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(cut(customId, MAX_CUSTOM_ID))
    .setLabel(cut(label, 80))
    .setStyle(style)
    .setDisabled(!!disabled);
}

// 该贴哪张卡片：
//   进行中的一局 → 汤面卡片；否则 → 选汤卡片。
// keepRound=true（/card 重新唤起）时，"已经开始过的这一局"也继续给汤面卡片——
// 通关或公布谜底之后，发起人常要回来重看汤底，这时候给选汤卡片就把展示页弄丢了。
export function cardKind(status = {}, { keepRound = false } = {}) {
  const active = !!status.started && !status.winner && !status.revealed;
  return (keepRound ? !!status.started : active) ? 'round' : 'picker';
}

// 重新唤起卡片时，这张新卡片归谁：
//   进行中的一局 → 归本局发起人（换题、公布这些按钮只有 TA 点得动，给别人等于给一张废卡）；
//   没有进行中的一局 → 归下命令的人（接下来是他要选汤开局）。
export function summonTarget(status = {}, userId) {
  const active = !!status.started && !status.winner && !status.revealed;
  const ownerId = active && status.ownerId ? String(status.ownerId) : String(userId);
  return {
    ownerId,
    active,
    isOwner: ownerId === String(userId),
    ownerName: active ? status.ownerName ?? null : null,
  };
}

// 状态行：进行中 / 未开始 / 已通关 / 已公布
export function statusLine(status = {}) {
  const bits = [];
  if (status.winner) bits.push('🏆 已通关');
  else if (status.revealed) bits.push('📖 谜底已公布');
  else if (status.started) bits.push('🎮 进行中');
  else bits.push('⏸ 未开始');
  bits.push(`提问 ${status.questionCount ?? 0} 次`);
  bits.push(`参与 ${status.participantCount ?? 0} 人`);
  if (status.ownerName) bits.push(`发起人 ${status.ownerName}`);
  return bits.join(' · ');
}

// 卡片能不能发：按 Discord 的真实限制检查（组件数 + 文本总量 + 容器子组件数）。
// 不通过时返回 false，调用方退回文本，绝不让 Discord 因为我们发坏包而报错。
function summarize(node, acc) {
  if (Array.isArray(node)) {
    for (const n of node) summarize(n, acc);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.type === 'number') {
    acc.count += 1;
    if (node.type === 10) acc.text += String(node.content ?? '').length;
  }
  if (node.components) summarize(node.components, acc);
  return acc;
}

// 统计组件数与 TextDisplay 文本总量（测试和调用方都能用）
export function cardStats(payload) {
  const acc = { count: 0, text: 0 };
  const list = Array.isArray(payload?.components) ? payload.components : [];
  for (const c of list) summarize(c?.toJSON ? c.toJSON() : c, acc);
  return acc;
}

export function isCardUsable(payload) {
  if (!payload || !Array.isArray(payload.components) || payload.components.length === 0) return false;
  try {
    const { count, text } = cardStats(payload);
    if (count === 0 || count > MAX_COMPONENTS) return false;
    if (text > MAX_TEXT_TOTAL) return false;
    for (const c of payload.components) {
      const json = c?.toJSON ? c.toJSON() : c;
      if (Array.isArray(json?.components) && json.components.length > MAX_CONTAINER_CHILDREN) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// 回答方式下拉框：和"选汤"一样是个下拉，当前值直接显示在框上（发起人点一下就能换）
export function answerModeOptionLabel(mode) {
  return mode === 'reaction' ? '⚡ 用反应' : '💬 直接回复';
}

function answerModeSelect(ownerId, mode, view, page = 0, { disabled = false } = {}) {
  const current = mode === 'reaction' ? 'reaction' : 'reply';
  const option = (value, label, description) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setDescription(description)
      .setDefault(value === current);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cut(buildCustomId('mode', ownerId, view, String(page)), MAX_CUSTOM_ID))
      .setPlaceholder(cut(`回答方式：${current === 'reaction' ? '用反应' : '直接回复'}`, 150))
      .setDisabled(!!disabled)
      .addOptions(
        option('reply', '💬 直接回复', '每次提问都单独回一条「是 / 不是」'),
        option('reaction', '⚡ 用反应', '在提问的那条消息上打 ✅ / ❌，不刷屏'),
      ),
  );
}

/* ---------------- 选汤卡片 ---------------- */

// questions: [{ id, title, puzzle }]
// current:   当前已选中的题目（可为 null）
// status:    GameManager.status() 的返回值（用于显示，不用于鉴权）
export function buildPickerCard({
  questions = [],
  page = 0,
  current = null,
  status = {},
  ownerId,
  ownerName = '',
  answerMode = 'reply',
}) {
  const { page: p, items, total } = pageSlice(questions, page);
  const pages = pageCount(total);
  const active = status.started && !status.winner && !status.revealed;

  // 标题区：标题 → 一句话引导（或"进行中"警告）→ 当前题目 → 小字元信息
  const head = ['## 🐢 海龟汤 · 选汤'];
  head.push(`> ${active ? activeHint(status.ownerName) : START_HINT}`);
  head.push('');
  head.push(
    current
      ? `**当前题目**　#${current.id} ${cut(current.title || '（无标题）', 60)}`
      : '**当前题目**　还没选',
  );

  const meta = [`题库 ${total} 题`];
  if (pages > 1) meta.push(`第 ${p + 1}/${pages} 页`);
  head.push(`-# ${meta.join(' · ')}`);

  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(text(head.join('\n')))
    .addSeparatorComponents(divider());

  if (items.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(cut(buildCustomId('pick', ownerId, String(p)), MAX_CUSTOM_ID))
      // 只有一页时不必提页码，免得每张卡片都挂个"第 1/1 页"
      .setPlaceholder(cut(pages > 1 ? `选一道汤 · 第 ${p + 1}/${pages} 页` : '选一道汤', 150))
      .addOptions(
        items.map((q) => {
          const preview = cut(String(q.puzzle ?? '').replace(/\s+/g, ' '), 50);
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(cut(`#${q.id} ${q.title || '（无标题）'}`, OPTION_LABEL_LIMIT))
            .setValue(cut(String(q.id), 100))
            .setDefault(!!current && Number(current.id) === Number(q.id));
          // 没有汤面可预览时**不要**调 setDescription：
          // discord.js 会因 undefined 抛 ValidationError（Expected a string primitive），
          // 一旦抛在交互处理里，Discord 那边就是"应用未响应"。
          if (preview) option.setDescription(preview);
          return option;
        }),
      );
    container.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  } else {
    container
      .addTextDisplayComponents(text('**📭 题库是空的**'))
      .addTextDisplayComponents(subtext('到后台界面「题库」里添加题目，然后重新 /start。'));
  }

  // 题库空的时候不摆一排全灰的浏览按钮，只留"回答方式"下拉（还能先设好），
  // 免得新手对着一堆点不动的按钮发呆。
  if (items.length === 0) {
    container
      .addActionRowComponents(answerModeSelect(ownerId, answerMode, 'picker', p))
      .addTextDisplayComponents(subtext(ANSWER_MODE_HINT));
    return container;
  }

  // 第一行只放"浏览"：翻页是一类事
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button(buildCustomId('page', ownerId, String(p - 1)), '◀ 上一页', ButtonStyle.Secondary, p <= 0),
      button(buildCustomId('page', ownerId, String(p + 1)), '下一页 ▶', ButtonStyle.Secondary, p >= pages - 1),
    ),
  );

  // 回答方式（和选汤一样的下拉，当前值显示在框上）+ 紧跟着一句两种方式的区别
  container
    .addActionRowComponents(answerModeSelect(ownerId, answerMode, 'picker', p))
    .addTextDisplayComponents(subtext(ANSWER_MODE_HINT));

  // 最后一行只放主操作，不跟别的按钮抢位置
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button(buildCustomId('start', ownerId), '▶ 开始本局', ButtonStyle.Success, !current || active),
    ),
  );
  return container;
}

/* ---------------- 对局卡片（开局之后原地刷新成这张） ---------------- */

export function buildRoundCard({
  question,
  status = {},
  ownerId,
  revealed = false,
  answer = null,
  answerMode = 'reply',
}) {
  // 并发时别人手里可能还攥着一张旧卡片：卡片主人不是本局发起人时，
  // 换题 / 公布谜底 / 回答方式这些"动这一局"的操作一律禁用，并写清原因
  // （就算不禁用，点了也会被 CommandHandler 挡回来，不如直接别让人点）。
  const isRoundOwner = !status.ownerId || String(status.ownerId) === String(ownerId);
  const ownerNote = `本局由 ${status.ownerName || '发起人'} 发起，换题和公布谜底只有 TA 能做；你照样可以 @我 提问。`;

  // 标题区：题号 + 标题 → 状态引用行
  const title = question
    ? `## 🎮 第 ${question.id} 题 · ${cut(question.title || '（无标题）', TITLE_LIMIT)}`
    : '## 🎮 本局';
  const head = [title, `> ${statusLine(status)}`];

  const puzzle = question?.puzzle ? cut(question.puzzle, PUZZLE_LIMIT) : '（还没有题目，先用 /start 选一道）';
  const puzzleTruncated = !!question?.puzzle && question.puzzle.length > PUZZLE_LIMIT;
  // 截断提示并进同一块文本：Container 顶层子组件只有 10 个位置，省一个是一个
  const puzzleBlock = puzzleTruncated
    ? `**📜 汤面**\n${puzzle}\n-# 汤面过长已截断，完整内容用 /status 查看。`
    : `**📜 汤面**\n${puzzle}`;

  const container = new ContainerBuilder()
    .setAccentColor(revealed ? 0xe67e22 : 0x3498db)
    .addTextDisplayComponents(text(head.join('\n')))
    .addSeparatorComponents(divider())
    // 标签和正文放在同一个文本块里：小标题跟着内容走，不会被间距拆开
    .addTextDisplayComponents(text(puzzleBlock));

  // 汤底只在通关/公布后出现，并且用留白和汤面隔开
  if (revealed && answer) {
    container
      .addSeparatorComponents(spacer())
      .addTextDisplayComponents(text(`**🔑 汤底**\n${cut(answer, ANSWER_LIMIT)}`));
  }

  container.addSeparatorComponents(divider());

  // 一行放完三个按钮（查看 / 换题 / 公布）；不是本局发起人就只剩"查看"
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button(buildCustomId('status', ownerId), '📊 状态'),
      button(buildCustomId('switch', ownerId), '🔄 换一题', ButtonStyle.Secondary, !isRoundOwner),
      revealed
        ? button(buildCustomId('page', ownerId, '0'), '📚 选新题', ButtonStyle.Primary, !isRoundOwner)
        : button(buildCustomId('reveal', ownerId), '📖 公布谜底', ButtonStyle.Danger, !isRoundOwner),
    ),
  );

  // 最下面：回答方式下拉 + 一条说明（怎么问、两种方式什么区别；不是发起人就说清权限）
  container
    .addActionRowComponents(answerModeSelect(ownerId, answerMode, 'round', 0, { disabled: !isRoundOwner }))
    .addTextDisplayComponents(subtext(isRoundOwner ? ASK_SELECT_HINT : ownerNote));
  return container;
}

/* ---------------- 交互路由（纯函数） ---------------- */

// 指定题目落在第几页
export function pageOfId(questions, target) {
  if (!target) return 0;
  const idx = (Array.isArray(questions) ? questions : []).findIndex(
    (q) => String(q.id) === String(target.id),
  );
  return idx < 0 ? 0 : Math.floor(idx / PAGE_SIZE);
}

/*
 * 点一下卡片该干什么——把判断全放这里，适配器只负责执行和渲染。
 *
 * 返回：
 *   { type: 'deny' }                        —— 不是发起人，回去发提示
 *   { type: 'switch-denied' }               —— 是发起人，但本局进行中且没权限换题
 *   { type: 'hint', text }                  —— 只回一句悄悄话，卡片不动
 *   { type: 'view', view, page }            —— 只刷新卡片
 *   { type: 'command', command, id, view }  —— 先执行命令（pick/start/reveal）再刷新卡片
 *   { type: 'none' }                        —— 不认识的按钮，忽略
 *
 * canSwitch 是注入的，测试里可以给确定值。
 */
export function planCardAction({
  action,
  args = [],
  ownerId,
  userId,
  isSelect = false,
  values = [],
  questions = [],
  current = null,
  canSwitch = () => true,
} = {}) {
  if (!action || String(userId) !== String(ownerId)) return { type: 'deny' };

  const list = Array.isArray(questions) ? questions : [];

  switch (action) {
    case 'page':
      return { type: 'view', view: 'picker', page: clampPage(Number(args[0]), list.length) };

    case 'pick': {
      const id = isSelect ? values[0] : args[0];
      const target = list.find((q) => String(q.id) === String(id));
      if (!target) return { type: 'hint', text: `没有找到 #${id} 题，用翻页或 /list 看看全部题目。` };
      if (!canSwitch(userId)) return { type: 'switch-denied' };
      return {
        type: 'command',
        command: 'pick',
        id: target.id,
        view: { view: 'picker', page: pageOfId(list, target) },
      };
    }

    case 'start':
      return { type: 'command', command: 'start', view: { view: 'round' } };

    case 'status':
      return { type: 'view', view: 'round' };

    case 'reveal':
      return { type: 'command', command: 'reveal', view: { view: 'round' } };

    case 'switch':
      return { type: 'view', view: 'picker', page: pageOfId(list, current) };

    // 回答方式：现在是个下拉框（选哪个就是哪个）；
    // 老卡片上残留的按钮式入口（同 action、非 select）仍然按"切一下"处理，重启后旧卡片不会失灵。
    case 'mode': {
      const view = {
        view: args[0] === 'round' ? 'round' : 'picker',
        page: clampPage(Number(args[1]), list.length),
      };
      if (!isSelect) return { type: 'toggle-mode', view };
      const picked = String(values[0] ?? '');
      if (picked !== 'reply' && picked !== 'reaction') {
        return { type: 'hint', text: '回答方式只有「回消息」和「用反应」两种。' };
      }
      return { type: 'set-mode', mode: picked, view };
    }

    default:
      return { type: 'none' };
  }
}

/* ---------------- 统一出口 ---------------- */

// allowedMentions 一定要锁死：题库文本是后台填的，万一里面写了 @everyone 不能真提醒全员
export function cardPayload(container) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}
