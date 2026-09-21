// Discord 卡片（Components V2）单元测试
//
// 卡片构建是纯函数，所以这里完全不联网、不需要 Discord 客户端：
// 只断言"生成的 JSON 长什么样"，包括分页、鉴权用的 customId、以及**汤底不能提前泄底**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../src/game/QuestionStore.js';
import { GameManager } from '../src/game/GameManager.js';
import { CommandHandler } from '../src/CommandHandler.js';
import {
  ANSWER_MODE_HINT,
  ASK_SELECT_HINT,
  ID_PREFIX,
  MAX_COMPONENTS,
  MAX_CONTAINER_CHILDREN,
  MAX_CUSTOM_ID,
  MAX_TEXT_TOTAL,
  PAGE_SIZE,
  answerModeOptionLabel,
  buildCustomId,
  buildPickerCard,
  buildRoundCard,
  cardKind,
  cardPayload,
  cardStats,
  clampPage,
  isCardUsable,
  pageCount,
  pageOfId,
  pageSlice,
  parseCustomId,
  planCardAction,
  statusLine,
  summonTarget,
} from '../src/platforms/discordCards.js';

const OWNER = '253081982000000001';

const TYPE = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_DISPLAY: 10, SEPARATOR: 14, CONTAINER: 17 };

function questions(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `题目${i + 1}`,
    puzzle: `第 ${i + 1} 题的汤面`,
    answer: `第 ${i + 1} 题的汤底`,
  }));
}

function walk(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (node.components) walk(node.components, out);
  return out;
}

function nodesOf(container) {
  return walk(container.toJSON());
}

function findByType(container, type) {
  return nodesOf(container).filter((n) => n.type === type);
}

function selectOf(container) {
  return findByType(container, TYPE.STRING_SELECT)[0] ?? null;
}

// 按下拉的 customId 动作名取（'pick' 是选汤，'mode' 是回答方式）
function selectByAction(container, action) {
  return findByType(container, TYPE.STRING_SELECT).find((s) => s.custom_id.split(':')[1] === action) ?? null;
}

function buttonsOf(container) {
  return findByType(container, TYPE.BUTTON);
}

function buttonByLabel(container, label) {
  return buttonsOf(container).find((b) => b.label.includes(label)) ?? null;
}

function allText(container) {
  return findByType(container, TYPE.TEXT_DISPLAY)
    .map((n) => n.content)
    .join('\n');
}

/* ---------------- customId ---------------- */

test('customId 编码解码可往返，且带上发起人', () => {
  const id = buildCustomId('page', OWNER, '2');
  assert.equal(id, `${ID_PREFIX}:page:2:${OWNER}`);
  assert.deepEqual(parseCustomId(id), { action: 'page', args: ['2'], ownerId: OWNER });
});

test('customId 解析：非本机器人前缀、残缺、空发起人一律拒绝', () => {
  assert.equal(parseCustomId('other:page:0:123'), null);
  assert.equal(parseCustomId('ts:page'), null);
  assert.equal(parseCustomId('ts::0:123'), null);
  assert.equal(parseCustomId('ts:page:0:'), null);
  assert.equal(parseCustomId(undefined), null);
});

test('卡片里所有 customId 都不超过 Discord 的 100 字符上限', () => {
  const card = buildPickerCard({ questions: questions(55), page: 0, ownerId: OWNER });
  const ids = nodesOf(card)
    .map((n) => n.custom_id)
    .filter((v) => typeof v === 'string');
  assert.ok(ids.length >= 5);
  for (const id of ids) {
    assert.ok(id.length <= MAX_CUSTOM_ID, `${id} 过长（${id.length}）`);
    assert.equal(parseCustomId(id).ownerId, OWNER);
  }
});

/* ---------------- 分页 ---------------- */

test('分页：0 题也算 1 页；55 题 3 页；页号会被夹到合法区间', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(1), 1);
  assert.equal(pageCount(PAGE_SIZE), 1);
  assert.equal(pageCount(PAGE_SIZE + 1), 2);
  assert.equal(pageCount(55), 3);
  assert.equal(clampPage(9, 55), 2);
  assert.equal(clampPage(-3, 55), 0);
  assert.equal(clampPage('abc', 55), 0);
});

test('分页切片：最后一页只放剩下的题', () => {
  const list = questions(55);
  assert.deepEqual(pageSlice(list, 0).items.map((q) => q.id).slice(0, 2), [1, 2]);
  assert.equal(pageSlice(list, 0).items.length, 25);
  assert.equal(pageSlice(list, 1).items.length, 25);
  const last = pageSlice(list, 2);
  assert.equal(last.items.length, 5);
  assert.deepEqual(last.items.map((q) => q.id), [51, 52, 53, 54, 55]);
});

/* ---------------- 选汤卡片 ---------------- */

test('选汤卡片：容器 + 两个下拉（选汤 25 项 / 回答方式）+ 三个按钮，翻页在边界时禁用', () => {
  const card = buildPickerCard({ questions: questions(55), page: 0, ownerId: OWNER });
  const json = card.toJSON();
  assert.equal(json.type, TYPE.CONTAINER);

  const select = selectByAction(card, 'pick');
  assert.equal(select.options.length, PAGE_SIZE);
  assert.deepEqual(select.options.map((o) => o.value).slice(0, 3), ['1', '2', '3']);

  assert.ok(selectByAction(card, 'mode'), '回答方式也要是个下拉，和选汤一样');
  assert.equal(findByType(card, TYPE.STRING_SELECT).length, 2, '不该再冒出第三个下拉');
  assert.equal(buttonsOf(card).length, 3, '上一页 / 下一页 / 开始本局（随机已删掉）');
  assert.equal(buttonByLabel(card, '随机'), null, '随机按钮不该再出现');
  assert.equal(buttonByLabel(card, '上一页').disabled, true);
  assert.equal(buttonByLabel(card, '下一页').disabled, false);
  assert.match(allText(card), /题库 55 题 · 第 1\/3 页/);
});

test('选汤卡片：浏览一行、回答方式下拉 + 说明、开始单独一行', () => {
  const card = buildPickerCard({ questions: questions(3), current: { id: 1 }, ownerId: OWNER });
  const rows = card.toJSON().components.filter((c) => c.type === TYPE.ACTION_ROW);
  assert.equal(rows.length, 4, '选汤下拉 + 浏览 + 回答方式下拉 + 开始');

  assert.equal(rows[0].components[0].type, TYPE.STRING_SELECT);
  assert.deepEqual(rows[1].components.map((b) => b.label), ['◀ 上一页', '下一页 ▶']);
  assert.equal(rows[2].components[0].type, TYPE.STRING_SELECT);
  assert.deepEqual(rows[3].components.map((b) => b.label), ['▶ 开始本局']);

  // 说明要紧跟在回答方式下拉后面（玩家不用点开就看懂两种方式）
  const order = card.toJSON().components;
  const modeRow = order.findIndex((c) => c.type === TYPE.ACTION_ROW && c.components[0].custom_id.includes(':mode:'));
  const hintAt = order.findIndex((c) => c.type === TYPE.TEXT_DISPLAY && c.content.includes(ANSWER_MODE_HINT));
  assert.ok(modeRow >= 0 && hintAt === modeRow + 1, '说明应该正好在下拉框下面一行');
});

test('选汤卡片：标题区有引导语、当前题目和小字元信息，且不再重复回答方式那句话', () => {
  const card = buildPickerCard({
    questions: questions(55),
    page: 1,
    current: { id: 30, title: '电梯' },
    status: { ownerName: '小明' },
    ownerId: OWNER,
  });
  const body = allText(card);
  assert.match(body, /## 🐢 海龟汤 · 选汤/);
  assert.match(body, /> 选一道汤 → 点「开始本局」→ 在频道里 @我 提问/);
  assert.match(body, /\*\*当前题目\*\*　#30 电梯/);
  assert.match(body, /-# 题库 55 题 · 第 2\/3 页/);
  // 回答方式由下拉框自己说，小字里不再重复（一句话只说一遍）
  assert.doesNotMatch(body, /我会回答/);
});

test('选汤卡片：进行中时把引导语换成"只有发起人能换题"的警告', () => {
  const card = buildPickerCard({
    questions: questions(3),
    status: { started: true, ownerName: '小明' },
    ownerId: OWNER,
  });
  const body = allText(card);
  assert.match(body, /⚠️ 本局进行中（发起人 小明），只有 TA 能换题/);
  assert.doesNotMatch(body, /选一道汤 →/);
});

test('选汤卡片：回答方式下拉标出当前值，选项带说明', () => {
  const reply = selectByAction(
    buildPickerCard({ questions: questions(3), ownerId: OWNER, answerMode: 'reply' }),
    'mode',
  );
  assert.equal(reply.placeholder, '回答方式：直接回复');
  assert.deepEqual(reply.options.map((o) => o.value), ['reply', 'reaction']);
  assert.deepEqual(reply.options.map((o) => o.label), ['💬 直接回复', '⚡ 用反应']);
  assert.deepEqual(reply.options.map((o) => o.default), [true, false]);
  assert.match(reply.options[1].description, /打 ✅ \/ ❌/);

  const reaction = selectByAction(
    buildPickerCard({ questions: questions(3), ownerId: OWNER, answerMode: 'reaction' }),
    'mode',
  );
  assert.equal(reaction.placeholder, '回答方式：用反应');
  assert.deepEqual(reaction.options.map((o) => o.default), [false, true]);

  // 不传时按默认（直接回复）显示，不能出现 undefined 之类的脏值
  const fallback = selectByAction(buildPickerCard({ questions: questions(3), ownerId: OWNER }), 'mode');
  assert.equal(fallback.placeholder, '回答方式：直接回复');
  assert.deepEqual(fallback.options.map((o) => o.default), [true, false]);
});

test('选汤卡片：最后一页下一个按钮禁用、选项只剩 5 个', () => {
  const card = buildPickerCard({ questions: questions(55), page: 2, ownerId: OWNER });
  assert.equal(selectOf(card).options.length, 5);
  assert.equal(buttonByLabel(card, '上一页').disabled, false);
  assert.equal(buttonByLabel(card, '下一页').disabled, true);
});

test('选汤卡片：当前题目被标成默认项，标题区显示「当前题目」', () => {
  const list = questions(55);
  const card = buildPickerCard({ questions: list, page: 0, current: list[6], ownerId: OWNER });
  const marked = selectOf(card).options.filter((o) => o.default);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].value, '7');
  assert.match(allText(card), /\*\*当前题目\*\*　#7 题目7/);
});

test('选汤卡片：没有选中题目时「开始本局」禁用；选中且未开局时可用', () => {
  const list = questions(3);
  const none = buildPickerCard({ questions: list, ownerId: OWNER });
  assert.equal(buttonByLabel(none, '开始本局').disabled, true);

  const picked = buildPickerCard({ questions: list, current: list[0], ownerId: OWNER, status: {} });
  assert.equal(buttonByLabel(picked, '开始本局').disabled, false);

  const running = buildPickerCard({
    questions: list,
    current: list[0],
    ownerId: OWNER,
    status: { started: true, ownerName: '小明' },
  });
  assert.equal(buttonByLabel(running, '开始本局').disabled, true);
  assert.match(allText(running), /本局进行中（发起人 小明）/);
});

test('选汤卡片：题库为空时不出选汤下拉、不摆灰按钮，只留回答方式下拉', () => {
  const card = buildPickerCard({ questions: [], ownerId: OWNER });
  assert.equal(selectByAction(card, 'pick'), null);
  assert.match(allText(card), /📭 题库是空的/);
  assert.match(allText(card), /到后台界面「题库」里添加题目/);
  // 一排点不动的浏览/开始按钮只是噪音，只留能用的「回答方式」
  assert.equal(buttonByLabel(card, '开始本局'), null);
  assert.equal(buttonByLabel(card, '上一页'), null);
  assert.equal(buttonsOf(card).length, 0);
  assert.equal(selectByAction(card, 'mode').placeholder, '回答方式：直接回复');
  assert.match(allText(card), /💬 直接回复 = 每次提问单独回一条/);
});

test('选汤卡片：超长标题/汤面会被截到 Discord 上限内', () => {
  const card = buildPickerCard({
    questions: [{ id: 1, title: '标'.repeat(300), puzzle: '面'.repeat(500) }],
    ownerId: OWNER,
  });
  const opt = selectByAction(card, 'pick').options[0];
  assert.ok(opt.label.length <= 100);
  assert.ok(opt.description.length <= 100);
});

test('对局卡片：回答方式也是下拉，标出当前值；按钮排成一行', () => {
  const card = buildRoundCard({
    question: { id: 1, title: '甲', puzzle: '面', answer: '底' },
    status: { started: true },
    ownerId: OWNER,
    answerMode: 'reaction',
  });
  const select = selectByAction(card, 'mode');
  assert.ok(select, '对局卡片上也要能改回答方式');
  assert.equal(select.placeholder, '回答方式：用反应');
  assert.deepEqual(select.options.map((o) => o.default), [false, true]);

  const rows = card.toJSON().components.filter((c) => c.type === TYPE.ACTION_ROW);
  assert.equal(rows.length, 2, '按钮一行 + 回答方式下拉一行');
  assert.deepEqual(rows[0].components.map((b) => b.label), ['📊 状态', '🔄 换一题', '📖 公布谜底']);
});

test('并发：卡片主人不是本局发起人时，"动本局"的按钮全部禁用并说明原因', () => {
  const q = { id: 3, title: '电梯', puzzle: '汤面', answer: '汤底' };
  const mine = buildRoundCard({
    question: q,
    status: { started: true, ownerId: OWNER, ownerName: '小明' },
    ownerId: OWNER,
  });
  assert.equal(buttonByLabel(mine, '换一题').disabled, false);
  assert.equal(buttonByLabel(mine, '公布谜底').disabled, false);
  assert.equal(selectByAction(mine, 'mode').disabled, false);
  assert.match(allText(mine), /在频道里 @我 提问/);

  // 别人手里那张旧卡片：只能看状态，换题/公布/改回答方式都点不动
  const theirs = buildRoundCard({
    question: q,
    status: { started: true, ownerId: OWNER, ownerName: '小明' },
    ownerId: 'u2',
  });
  assert.equal(buttonByLabel(theirs, '换一题').disabled, true);
  assert.equal(buttonByLabel(theirs, '公布谜底').disabled, true);
  assert.equal(buttonByLabel(theirs, '状态').disabled, false, '看状态不影响任何人');
  assert.equal(selectByAction(theirs, 'mode').disabled, true);
  assert.match(allText(theirs), /本局由 小明 发起，换题和公布谜底只有 TA 能做/);

  // 公布之后"选新题"同样只有发起人能点
  const revealedTheirs = buildRoundCard({
    question: q,
    status: { started: true, revealed: true, ownerId: OWNER, ownerName: '小明' },
    ownerId: 'u2',
    revealed: true,
    answer: q.answer,
  });
  assert.equal(buttonByLabel(revealedTheirs, '选新题').disabled, true);
});

test('并发：没有发起人信息（老状态）时按原样放开，不会把卡片锁死', () => {
  const card = buildRoundCard({
    question: { id: 1, title: '甲', puzzle: '面', answer: '底' },
    status: { started: true },
    ownerId: OWNER,
  });
  assert.equal(buttonByLabel(card, '换一题').disabled, false);
  assert.equal(buttonByLabel(card, '公布谜底').disabled, false);
});

/* ---------------- 对局卡片 ---------------- */

test('对局卡片：未通关时只给汤面，绝不能带上汤底', () => {
  const q = { id: 3, title: '电梯', puzzle: '我走进电梯准备去上学', answer: '这是汤底-机密' };
  const card = buildRoundCard({
    question: q,
    status: { started: true, questionCount: 2, participantCount: 1, ownerName: '小明' },
    ownerId: OWNER,
  });
  const body = allText(card);
  assert.match(body, /我走进电梯准备去上学/);
  assert.doesNotMatch(body, /这是汤底-机密/);
  assert.match(body, /🎮 进行中/);
  assert.equal(buttonByLabel(card, '公布谜底').disabled, false);
  assert.equal(buttonByLabel(card, '换一题').disabled, false);
});

test('对局卡片：已通关/已公布才摊开汤底，并把「公布谜底」换成「选新题」', () => {
  const q = { id: 3, title: '电梯', puzzle: '汤面在这', answer: '汤底在这' };
  const card = buildRoundCard({
    question: q,
    status: { started: true, revealed: true, winner: { userName: '小红' }, questionCount: 5, participantCount: 3 },
    ownerId: OWNER,
    revealed: true,
    answer: q.answer,
  });
  const body = allText(card);
  assert.match(body, /\*\*🔑 汤底\*\*/);
  assert.match(body, /汤底在这/);
  assert.match(body, /🏆 已通关/);
  assert.equal(buttonByLabel(card, '公布谜底'), null);
  assert.ok(buttonByLabel(card, '选新题'));
});

test('状态行覆盖：未开始 / 进行中 / 已通关 / 已公布', () => {
  assert.match(statusLine({}), /⏸ 未开始/);
  assert.match(statusLine({ started: true }), /🎮 进行中/);
  assert.match(statusLine({ started: true, winner: { userName: 'x' } }), /🏆 已通关/);
  assert.match(statusLine({ started: true, revealed: true }), /📖 谜底已公布/);
  assert.match(statusLine({ started: true, questionCount: 4, participantCount: 2, ownerName: '甲' }), /提问 4 次 · 参与 2 人 · 发起人 甲/);
});

/* ---------------- /card 重新唤起：贴哪张、归谁 ---------------- */

test('重新贴卡片：没开局给选汤卡片，开局后给汤面卡片', () => {
  assert.equal(cardKind({}), 'picker');
  assert.equal(cardKind({ started: true }), 'round');
  assert.equal(cardKind({ started: true, winner: { userName: 'x' } }), 'picker', '/start 的规则：通关了就给选汤卡片');
});

test('重新贴卡片：公布谜底后仍要能把展示页（汤底）重新贴出来', () => {
  const finished = { started: true, revealed: true, ownerId: 'u9' };
  assert.equal(cardKind(finished, { keepRound: true }), 'round');
  assert.equal(cardKind({ ...finished, winner: { userName: '小红' } }, { keepRound: true }), 'round');
  // 只是选了题、还没开局：仍然是选汤卡片，不提前把汤面摊出来
  assert.equal(cardKind({ hasQuestion: true }, { keepRound: true }), 'picker');
});

test('重新贴卡片：没有进行中的一局时归下命令的人', () => {
  const idle = summonTarget({ ownerId: 'u9', ownerName: '旧发起人' }, 'u1');
  assert.deepEqual(idle, { ownerId: 'u1', active: false, isOwner: true, ownerName: null });
});

test('重新贴卡片：进行中的一局归本局发起人，别人只拿到一句说明', () => {
  const status = { started: true, ownerId: 'u9', ownerName: '小明' };

  const owner = summonTarget(status, 'u9');
  assert.deepEqual(owner, { ownerId: 'u9', active: true, isOwner: true, ownerName: '小明' });

  const other = summonTarget(status, 'u1');
  assert.equal(other.ownerId, 'u9', '卡片必须归发起人，否则按钮对别人点不动');
  assert.equal(other.isOwner, false, '别人不该贴出这张卡片（会把频道刷乱）');
  assert.equal(other.ownerName, '小明', '要能说出这局是谁的');
});

test('重新贴卡片：通关/公布后不再算"进行中"，谁下命令就归谁', () => {
  for (const status of [
    { started: true, winner: { userName: '小红' }, ownerId: 'u9', ownerName: '小明' },
    { started: true, revealed: true, ownerId: 'u9', ownerName: '小明' },
  ]) {
    const t = summonTarget(status, 'u1');
    assert.equal(t.active, false);
    assert.equal(t.ownerId, 'u1');
    assert.equal(t.isOwner, true);
  }
});

/* ---------------- payload ---------------- */

test('payload 带 Components V2 标记，并锁死 @ 提醒', () => {
  const payload = cardPayload(buildPickerCard({ questions: questions(2), ownerId: OWNER }));
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0].toJSON().type, TYPE.CONTAINER);
});

test('超长汤面会被截断，卡片仍然可发（截断比发不出去更重要）', () => {
  const card = buildRoundCard({
    question: { id: 1, title: 'x', puzzle: '汤'.repeat(4000), answer: '底'.repeat(4000) },
    status: { started: true, revealed: true },
    ownerId: OWNER,
    revealed: true,
    answer: '底'.repeat(4000),
  });
  const payload = cardPayload(card);
  const body = allText(card);
  assert.ok(body.length < 4000, `正文 ${body.length} 字，不能超 4000`);
  assert.ok(body.includes('汤'.repeat(100)));
  assert.equal(isCardUsable(payload), true);
  assert.ok(cardStats(payload).text <= MAX_TEXT_TOTAL);
});

test('卡片体积兜底：组件数或文本总量超限时判定不可用（调用方退回文本）', () => {
  const ok = cardPayload(buildPickerCard({ questions: questions(30), ownerId: OWNER }));
  assert.equal(isCardUsable(ok), true);
  assert.ok(cardStats(ok).count <= 40);
  assert.equal(isCardUsable(null), false);
  assert.equal(isCardUsable({}), false);

  // 组件数超 40
  const many = new Array(45).fill(null).reduce(
    (c) => c.addTextDisplayComponents(new TextDisplayBuilder().setContent('x')),
    new ContainerBuilder(),
  );
  assert.equal(isCardUsable({ components: [many] }), false);

  // 文本总量超 4000（单块 4000 字是允许的，两块就爆了）
  const fat = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('字'.repeat(3000)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('字'.repeat(2000)));
  assert.equal(isCardUsable({ components: [fat] }), false);
});

test('真实的 55 题一页卡片离限制还差得远', () => {
  const long = Array.from({ length: 55 }, (_, i) => ({
    id: i + 1,
    title: `第${i + 1}题`.repeat(20),
    puzzle: `汤面${i + 1}`.repeat(80),
  }));
  const payload = cardPayload(buildPickerCard({ questions: long, page: 0, ownerId: OWNER }));
  const stats = cardStats(payload);
  // 容器 + 标题文本 + 分隔线 + 选汤下拉行(1+1) + 浏览行(1+3) + 回答方式行(1+1) + 开始行(1+1) = 13（限额 40）
  assert.equal(stats.count, 13);
  assert.ok(stats.text < 2000, `正文 ${stats.text} 字`);
  assert.equal(isCardUsable(payload), true);
});

test('对局卡片：连"公布汤底"状态也离各项上限很远', () => {
  const long = { id: 1, title: '标'.repeat(200), puzzle: '面'.repeat(3000), answer: '底'.repeat(2000) };
  const payload = cardPayload(
    buildRoundCard({
      question: long,
      status: { started: true, revealed: true, ownerName: '甲', questionCount: 9, participantCount: 5 },
      ownerId: OWNER,
      revealed: true,
      answer: long.answer,
    }),
  );
  const container = payload.components[0].toJSON();
  // Container 顶层子组件 ≤10（超了 Discord 直接拒收，整张卡片只能退回文本）
  assert.ok(container.components.length <= MAX_CONTAINER_CHILDREN, `子组件 ${container.components.length} 个`);
  const stats = cardStats(payload);
  assert.ok(stats.count <= MAX_COMPONENTS, `组件 ${stats.count} 个`);
  assert.ok(stats.text <= MAX_TEXT_TOTAL, `正文 ${stats.text} 字`);
  assert.equal(isCardUsable(payload), true);
});

/* ---------------- 交互路由 ---------------- */

const LIST = questions(55);
const base = { ownerId: OWNER, userId: OWNER, questions: LIST };

test('交互路由：不是发起人就拒掉（卡片公开，但只能自己点自己的）', () => {
  for (const action of ['start', 'page', 'pick', 'reveal', 'switch', 'status', 'mode']) {
    assert.deepEqual(planCardAction({ ...base, action, userId: '别人' }), { type: 'deny' });
  }
  assert.deepEqual(planCardAction({ ...base, action: '' }), { type: 'deny' });
});

test('交互路由：切换回答方式 → 下拉选哪个就是哪个；老卡片的切换按钮仍然可用', () => {
  // 下拉框（现在的主入口）：选中哪个就用哪个
  const picked = planCardAction({
    ...base,
    action: 'mode',
    args: ['picker', '1'],
    isSelect: true,
    values: ['reaction'],
  });
  assert.deepEqual(picked, {
    type: 'set-mode',
    mode: 'reaction',
    view: { view: 'picker', page: 1 },
  });

  // 下拉选了不认的值：只给悄悄话，不改状态
  const bogus = planCardAction({ ...base, action: 'mode', isSelect: true, values: ['shout'] });
  assert.equal(bogus.type, 'hint');
  assert.match(bogus.text, /回消息/);

  // 老卡片（机器人重启前发出去的按钮）仍然按"翻转一下"处理，不会变成死卡片
  const legacy = planCardAction({ ...base, action: 'mode', args: ['round', '0'] });
  assert.deepEqual(legacy, { type: 'toggle-mode', view: { view: 'round', page: 0 } });

  // 页码越界同样夹回来
  const over = planCardAction({ ...base, action: 'mode', args: ['picker', '99'], isSelect: true, values: ['reply'] });
  assert.equal(over.view.page, 2);
});

test('交互路由：翻页只刷新视图，页号越界会被夹回来', () => {
  assert.deepEqual(planCardAction({ ...base, action: 'page', args: ['1'] }), {
    type: 'view',
    view: 'picker',
    page: 1,
  });
  const over = planCardAction({ ...base, action: 'page', args: ['99'] });
  assert.equal(over.page, 2);
  const under = planCardAction({ ...base, action: 'page', args: ['-5'] });
  assert.equal(under.page, 0);
});

test('交互路由：下拉选题目 → 执行 pick 并跳到该题所在页', () => {
  const plan = planCardAction({
    ...base,
    action: 'pick',
    args: ['0'],
    isSelect: true,
    values: ['30'],
  });
  assert.equal(plan.type, 'command');
  assert.equal(plan.command, 'pick');
  assert.equal(plan.id, 30);
  assert.equal(plan.view.page, 1); // 第 30 题在第二页
});

test('交互路由：选到不存在的编号只给悄悄话，不动卡片', () => {
  const plan = planCardAction({ ...base, action: 'pick', isSelect: true, values: ['999'] });
  assert.equal(plan.type, 'hint');
  assert.match(plan.text, /没有找到 #999/);
});

test('交互路由：本局进行中且没换题权限 → 走 switch-denied（文案由 CommandHandler 给）', () => {
  const plan = planCardAction({
    ...base,
    action: 'pick',
    isSelect: true,
    values: ['3'],
    canSwitch: () => false,
  });
  assert.deepEqual(plan, { type: 'switch-denied' });
});

test('交互路由：随机这个动作已经删掉，点了也只当不认识', () => {
  // 随机按钮没了；万一还有旧卡片发来 rand，也必须是"忽略"，不能猜一个题目出来
  assert.deepEqual(planCardAction({ ...base, action: 'rand', current: LIST[0] }), { type: 'none' });
});

test('交互路由：开局/公布谜底/状态/换一题各自的去向', () => {
  assert.deepEqual(planCardAction({ ...base, action: 'start' }), {
    type: 'command',
    command: 'start',
    view: { view: 'round' },
  });
  assert.deepEqual(planCardAction({ ...base, action: 'reveal' }), {
    type: 'command',
    command: 'reveal',
    view: { view: 'round' },
  });
  assert.deepEqual(planCardAction({ ...base, action: 'status' }), { type: 'view', view: 'round' });
  assert.deepEqual(planCardAction({ ...base, action: 'switch' }), {
    type: 'view',
    view: 'picker',
    page: 0,
  });
  // 「换一题」要落在当前题目所在页，而不是永远第一页
  assert.equal(planCardAction({ ...base, action: 'switch', current: LIST[30] }).page, 1);
  assert.deepEqual(planCardAction({ ...base, action: '未知按钮' }), { type: 'none' });
});

test('pageOfId：找不到就是第 0 页', () => {
  assert.equal(pageOfId(LIST, LIST[0]), 0);
  assert.equal(pageOfId(LIST, LIST[54]), 2);
  assert.equal(pageOfId(LIST, { id: '不存在' }), 0);
  assert.equal(pageOfId(LIST, null), 0);
});

/* ---------------- 回归：真实数据路径 ---------------- */

test('回归：题目只有 id+title（没有汤面）时照样能建卡片', () => {
  // 曾经这里会调 setDescription(undefined)，discord.js 抛 ValidationError，
  // 结果 /start 崩在交互处理里，Discord 显示「应用未响应」。
  const card = buildPickerCard({ questions: [{ id: 1, title: '海龟汤' }], ownerId: OWNER });
  const opt = selectOf(card).options[0];
  assert.equal(opt.label, '#1 海龟汤');
  assert.equal(opt.description, undefined);
});

test('回归：走真实 CommandHandler.questionList()（QuestionStore 支撑）也能建卡片，且卡片里没有汤底', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turtle-cards-'));
  const file = join(dir, 'questions.json');
  await writeFile(
    file,
    JSON.stringify([
      { id: 1, title: '甲', puzzle: '甲汤面（可预览）', answer: '甲汤底（机密）' },
      { id: 2, title: '乙', puzzle: '乙汤面', answer: '乙汤底（机密）' },
    ]),
    'utf8',
  );

  const qs = new QuestionStore({ file });
  await qs.load();
  const judge = { judge: async () => ({}), judgeSentences: async () => ({}) };
  const handler = new CommandHandler(new GameManager(judge), qs);

  const questions = handler.questionList();
  assert.deepEqual(questions.map((q) => q.id), [1, 2]);
  assert.equal(questions[0].answer, undefined); // 清单里不能有汤底

  const payload = cardPayload(buildPickerCard({ questions, ownerId: OWNER }));
  assert.equal(isCardUsable(payload), true);
  const json = JSON.stringify(payload.components.map((c) => c.toJSON()));
  assert.match(json, /甲汤面/); // 汤面可以做预览
  assert.doesNotMatch(json, /机密/); // 汤底一个字都不能出现
});
