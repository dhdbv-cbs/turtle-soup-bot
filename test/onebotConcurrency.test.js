// OneBot 适配器的并发集成测试：真起一个 WebSocket 服务端冒充 NapCat，
// 一次性灌多条群消息，看整个链路（适配器 → 频道队列 → 评判 → 回复）会怎样。
//
// 这里用可控的 judge 桩（不联网），重点验证：
//   * 同一个群的多条提问串行评判、回复顺序与提问顺序一致
//   * 两个群同时玩互不阻塞、各自都能拿到全部回复
//   * 刷屏超过排队上限时给出提示，而不是无限堆积
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const dir = await mkdtemp(join(tmpdir(), 'turtle-onebot-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
for (const key of ['AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'JUDGE_PROVIDER', 'JEV_MODEL']) {
  process.env[key] = '';
}

const { config } = await import('../src/config.js');
const { GameManager } = await import('../src/game/GameManager.js');
const { QuestionStore } = await import('../src/game/QuestionStore.js');
const { CommandHandler } = await import('../src/CommandHandler.js');
const { startOneBot } = await import('../src/platforms/onebot.js');

const BOT_QQ = 10000;
const Q1 = { id: 1, title: '一', puzzle: '汤面1', answer: '汤底1' };

/* ---------------- 假的 NapCat 服务端 ---------------- */

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => wss.once('listening', resolve));
const wsPort = wss.address().port;

let socket = null;
const sent = []; // 机器人发出去的消息
let messageId = 0;

wss.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.action === 'get_login_info') {
      ws.send(
        JSON.stringify({
          status: 'ok',
          echo: msg.echo,
          data: { user_id: BOT_QQ, nickname: '海龟汤机器人' },
        }),
      );
      return;
    }
    if (String(msg.action || '').startsWith('send_')) {
      sent.push(msg);
      // 真实的 OneBot 一定会回 echo；不回的话适配器的 call() 会一直等到 10 秒超时
      ws.send(JSON.stringify({ status: 'ok', echo: msg.echo, data: { message_id: ++messageId } }));
    }
  });
});

function groupMessage(groupId, userId, text) {
  socket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      group_id: groupId,
      user_id: userId,
      sender: { nickname: `玩家${userId}` },
      message: [
        { type: 'at', data: { qq: String(BOT_QQ) } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    }),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 3000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

// 每个群收到的消息（按顺序）
function messagesOf(groupId) {
  return sent
    .filter((m) => m.action === 'send_group_msg' && m.params.group_id === groupId)
    .map((m) => m.params.message);
}

// 真正的回复：现在适配器不再发任何"思考中"之类的占位消息，这里就是全部消息
function answersOf(groupId) {
  return messagesOf(groupId);
}

/* ---------------- 被测对象 ---------------- */

const judgeCalls = [];
let judgeDelay = 30; // 毫秒，模拟评判耗时
let activeJudges = 0;
let maxActiveJudges = 0;

const judge = {
  async judge(_question, message) {
    judgeCalls.push(message);
    activeJudges++;
    maxActiveJudges = Math.max(maxActiveJudges, activeJudges);
    try {
      await sleep(judgeDelay);
      return { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };
    } finally {
      activeJudges--;
    }
  },
};

const questions = new QuestionStore({ file: join(dir, 'questions.json') });
await writeFile(join(dir, 'questions.json'), JSON.stringify([Q1]), 'utf8');
await questions.load();

const games = new GameManager(judge);
const handler = new CommandHandler(games, questions);

config.qq.napcat.enabled = true;
config.qq.napcat.wsUrl = `ws://127.0.0.1:${wsPort}`;
config.qq.napcat.accessToken = '';

const adapter = startOneBot(handler);

// 先选好题目再开局，让这个群进入“可以提问”的状态
async function openRound(groupId, userId = 8001) {
  groupMessage(groupId, userId, '/next');
  await waitFor(() => games.status(`qq:${groupId}`).hasQuestion);
  groupMessage(groupId, userId, '/start');
  const ok = await waitFor(() => games.status(`qq:${groupId}`).started);
  assert.ok(ok, `群 ${groupId} 应该能开局`);
  await sleep(50);
  sent.length = 0;
}

after(async () => {
  try {
    adapter.stop();
  } catch {}
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
});

test('适配器连上后能拿到机器人 QQ 号', async () => {
  const ok = await waitFor(() => !!socket && adapter.status().state === 'connected');
  assert.ok(ok, '应连接到假的 OneBot 服务端');
  await waitFor(() => /已登录/.test(adapter.status().detail));
  assert.match(adapter.status().detail, new RegExp(String(BOT_QQ)));
});

test('同一个群刷 6 条提问：串行评判，回复顺序与提问顺序一致', async () => {
  const group = 2001;
  await openRound(group, 9001);
  judgeCalls.length = 0;

  // 稍微错开一点发（真实群里大家不会在同一毫秒打字），
  // 这样都排在队列里依次评判，不会撞上"排队上限"
  judgeDelay = 15;
  for (let i = 1; i <= 6; i++) {
    groupMessage(group, 9000 + i, `问题${i}`);
    await sleep(25);
  }

  const done = await waitFor(() => answersOf(group).length >= 6, { timeout: 5000 });
  assert.ok(done, `6 条提问应拿到 6 条回复，实际 ${answersOf(group).length}`);

  const replies = answersOf(group);
  assert.equal(replies.length, 6);
  assert.equal(judgeCalls.length, 6, '每条提问都应经过评判');
  assert.deepEqual(judgeCalls, ['问题1', '问题2', '问题3', '问题4', '问题5', '问题6']);
  assert.ok(!replies.some((t) => t.includes('思考中')), '不该再有占位消息');
  assert.ok(!replies.some((t) => /相似度|%/.test(t)), '回复里不能出现相似度');

  // 回复里 @ 的是提问者，顺序应与提问顺序一致
  const order = replies.map((t) => (t.match(/\[CQ:at,qq=(\d+)\]/) || [])[1]);
  assert.deepEqual(order, ['9001', '9002', '9003', '9004', '9005', '9006']);

  assert.equal(games.status(`qq:${group}`).questionCount, 6, '6 条都应记入历史');
  assert.equal(games.pendingCount(`qq:${group}`), 0);
});

test('同一瞬间灌 6 条：超出排队上限的拿到提示，其余的照常作答', async () => {
  const group = 2501;
  await openRound(group, 9001);
  judgeCalls.length = 0;

  judgeDelay = 60; // 拖慢，制造真实堆积
  for (let i = 1; i <= 6; i++) groupMessage(group, 9000 + i, `同时问${i}`);

  const done = await waitFor(() => answersOf(group).length >= 6, { timeout: 5000 });
  assert.ok(done, `每条提问都应该有回复，实际 ${answersOf(group).length}`);

  const replies = answersOf(group);
  assert.equal(replies.length, 6);
  assert.equal(replies.filter((t) => t.includes('排队的提问有点多')).length, 2, '6 条里应有 2 条被排队上限挡下');
  assert.equal(judgeCalls.length, 4, '最多 1 条在跑 + 3 条排队');
  assert.equal(games.status(`qq:${group}`).questionCount, 4);

  judgeDelay = 15;
  const idle = await waitFor(
    () => games.pendingCount(`qq:${group}`) === 0 && games.activeJudges === 0,
    { timeout: 5000 },
  );
  assert.ok(idle, '队列最终要清空');
});

test('一个人狂刷：只有前 6 条进入评判，其余收到限流提示', async () => {
  const group = 5001;
  const user = 3333;
  await openRound(group, user);
  judgeCalls.length = 0;
  sent.length = 0;

  judgeDelay = 10;
  for (let i = 1; i <= 8; i++) {
    groupMessage(group, user, `刷第${i}条`);
    await sleep(25);
  }

  const done = await waitFor(() => answersOf(group).length >= 8, { timeout: 5000 });
  assert.ok(done, `8 条都该有回复，实际 ${answersOf(group).length}`);

  const answers = answersOf(group);
  assert.equal(judgeCalls.length, 6, '一分钟内只有前 6 条会真的去评判');
  assert.ok(!answers.slice(0, 6).some((t) => t.includes('问得有点快')), '前 6 条应正常作答');
  for (const t of answers.slice(6)) assert.match(t, /问得有点快|每分钟最多 6 次/);
  assert.equal(games.status(`qq:${group}`).questionCount, 6, '被拦下的不该进历史');
});

test('额度已经用完时，只回一条提示（不再有任何占位消息）', async () => {
  const group = 6001;
  const user = 4444;
  await openRound(group, user);
  sent.length = 0;

  // 先把这个人的额度用满，再让他提问
  for (let i = 0; i < 6; i++) games.consumeAskQuota(`qq:${group}`, String(user));
  judgeCalls.length = 0;

  groupMessage(group, user, '还想再问一条');
  const got = await waitFor(() => messagesOf(group).length >= 1, { timeout: 3000 });
  assert.ok(got, '应该收到限流提示');
  await sleep(120); // 再等等，确认没有第二条消息

  const msgs = messagesOf(group);
  assert.equal(msgs.length, 1, `被限流时只该有一条提示，实际 ${JSON.stringify(msgs)}`);
  assert.match(msgs[0], /问得有点快/);
  assert.ok(!msgs[0].includes('思考中'));
  assert.equal(judgeCalls.length, 0, '被限流的提问不该去评判');
});

test('两个群同时玩：互不阻塞，各自都拿到全部回复', async () => {
  await openRound(3001, 8001);
  await openRound(3002, 8002);
  maxActiveJudges = 0;
  judgeCalls.length = 0;

  judgeDelay = 20;
  for (let i = 1; i <= 3; i++) groupMessage(3001, 7000 + i, `甲问题${i}`);
  for (let i = 1; i <= 3; i++) groupMessage(3002, 6000 + i, `乙问题${i}`);

  const done = await waitFor(
    () => answersOf(3001).length >= 3 && answersOf(3002).length >= 3,
    { timeout: 5000 },
  );
  assert.ok(done, '两个群都应收齐回复');

  assert.equal(answersOf(3001).length, 3);
  assert.equal(answersOf(3002).length, 3);
  assert.equal(judgeCalls.length, 6);
  assert.ok(maxActiveJudges >= 2, `两个群应能并发评判，实际峰值 ${maxActiveJudges}`);
  assert.equal(games.status('qq:3001').questionCount, 3);
  assert.equal(games.status('qq:3002').questionCount, 3);
});

test('刷屏超过排队上限：多余的提问收到提示，不会无限堆积', async () => {
  const group = 4001;
  await openRound(group, 5001);

  judgeDelay = 200; // 拖慢，制造堆积
  for (let i = 1; i <= 10; i++) groupMessage(group, 4000 + i, `刷屏${i}`);

  const busy = await waitFor(() => answersOf(group).some((t) => t.includes('排队的提问有点多')), {
    timeout: 3000,
  });
  assert.ok(busy, `刷屏时应给出排队提示，实际回复：${JSON.stringify(answersOf(group))}`);
  assert.ok(games.pendingCount(`qq:${group}`) <= 3, '排队数不能超过上限');

  judgeDelay = 20;
  const drained = await waitFor(
    () => games.pendingCount(`qq:${group}`) === 0 && games.activeJudges === 0,
    { timeout: 5000 },
  );
  assert.ok(drained, '队列最终要清空');
  assert.equal(activeJudges, 0, '评判额度要还回去');
});
