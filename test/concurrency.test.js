// 并发兜底测试：同时有几个团体在玩、或同一个群多人同时提问时会发生什么
//
// 这些都是"真并发"的场景：评判是异步的（可能要几秒到几十秒），
// 期间玩家完全可能再发一条、换题、甚至重置。这里用可控的 judge 桩来复现竞争。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-conc-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
for (const key of ['AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'JUDGE_PROVIDER', 'JEV_MODEL']) {
  process.env[key] = '';
}

const { GameManager } = await import('../src/game/GameManager.js');
const { QuestionStore } = await import('../src/game/QuestionStore.js');
const { config, updateConfig, CONFIG_FILE } = await import('../src/config.js');

const Q1 = { id: 1, title: '一', puzzle: '汤面1', answer: '汤底1' };
const Q2 = { id: 2, title: '二', puzzle: '汤面2', answer: '汤底2' };
const OK = { isYes: true, yesProb: 0.9, similarity: 0.1, usage: null };

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

function beginRound(gm, key = 'c', question = Q1, owner = { userId: 'u1', userName: 'A' }) {
  gm.setQuestion(key, question, owner);
  gm.start(key, owner.userId, owner.userName);
}

/* ---------------- 同一个频道：提问串行 ---------------- */

test('同一频道同时来两条提问：串行评判，回答顺序与提问顺序一致', async () => {
  const gates = [deferred(), deferred()];
  const started = [];
  let active = 0;
  let maxActive = 0;

  const gm = new GameManager({
    async judge(_q, message) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(message);
      const gate = gates[started.length - 1];
      try {
        return await gate.promise;
      } finally {
        active--;
      }
    },
  });
  beginRound(gm);

  const p1 = gm.ask('c', 'u1', 'A', '问题1');
  const p2 = gm.ask('c', 'u2', 'B', '问题2');
  await tick();

  assert.deepEqual(started, ['问题1'], '第二条必须等第一条评判完再开始');
  assert.equal(gm.pendingCount('c'), 1);

  // 故意让第二条的结果"先准备好"，也不应该插队
  gates[1].resolve({ ...OK, similarity: 0.2 });
  await tick();
  assert.deepEqual(started, ['问题1'], '第一条没结束前，第二条不能开始');

  gates[0].resolve({ ...OK, similarity: 0.1 });
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(maxActive, 1, '同一个频道不允许并发评判');
  assert.equal(r1.similarity, 0.1);
  assert.equal(r2.similarity, 0.2);
  assert.deepEqual(
    gm.history('c').map((h) => h.message),
    ['问题1', '问题2'],
    '历史顺序应等于提问顺序',
  );
});

test('两人几乎同时猜中：只通关一次，不会刷两条公告', async () => {
  const gm = new GameManager({
    async judge() {
      return { isYes: true, yesProb: 0.99, similarity: 0.95, usage: null };
    },
  });
  beginRound(gm);

  const [r1, r2] = await Promise.all([
    gm.ask('c', 'u1', 'A', '我猜是这样'),
    gm.ask('c', 'u2', 'B', '我也猜是这样'),
  ]);

  const wins = [r1, r2].filter((r) => r.type === 'win');
  const hints = [r1, r2].filter((r) => r.type === 'hint');
  assert.equal(wins.length, 1, '只能有一条通关');
  assert.equal(wins[0].userName, 'A', '先提问的人拿到通关');
  assert.equal(hints.length, 1);
  assert.match(hints[0].text, /已经通关/);
  assert.equal(gm.history('c').length, 1, '通关后的提问不再记入历史');
});

test('评判期间换题：旧结果作废，不会污染新一局、更不会让新一局莫名通关', async () => {
  const gate = deferred();
  const gm = new GameManager({ judge: () => gate.promise });
  beginRound(gm);

  const pending = gm.ask('c', 'u2', 'B', '我猜是这样');
  await tick();

  // 评判还在飞的时候，换到第二题并开始
  gm.setQuestion('c', Q2, { userId: 'u2', userName: 'B' });
  gm.start('c', 'u2', 'B');

  // 针对第一题的高相似度结果这时才回来
  gate.resolve({ isYes: false, yesProb: 0, similarity: 0.99, usage: null });
  const r = await pending;

  assert.equal(r.type, 'hint');
  assert.match(r.text, /题目已经换/);
  const s = gm.status('c');
  assert.equal(s.questionTitle, '二', '新一局仍是第二题');
  assert.equal(s.winner, null, '新一局不能被旧答案判通关');
  assert.equal(s.questionCount, 0, '旧答案不能写进新一局历史');
  assert.equal(s.participantCount, 0);
});

test('评判期间 /reset：结果作废，不会把状态又"复活"回来', async () => {
  const gate = deferred();
  const gm = new GameManager({ judge: () => gate.promise });
  beginRound(gm);

  const pending = gm.ask('c', 'u1', 'A', '问题');
  await tick();
  gm.reset('c');

  gate.resolve({ ...OK, similarity: 0.99 });
  const r = await pending;

  assert.equal(r.type, 'hint');
  assert.match(r.text, /题目已经换/);
  const s = gm.status('c');
  assert.equal(s.hasQuestion, false);
  assert.equal(s.winner, null);
  assert.equal(s.started, false);
});

test('排队有上限：刷屏的人拿到提示，而不是把评判请求堆成雪球', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let n = 0;
  const gm = new GameManager({
    judge() {
      return gates[n++].promise;
    },
  });
  beginRound(gm);

  const promises = [];
  for (let i = 1; i <= 5; i++) promises.push(gm.ask('c', `u${i}`, `玩家${i}`, `问题${i}`));
  await tick();

  const fifth = await promises[4];
  assert.equal(fifth.type, 'hint');
  assert.match(fifth.text, /排队的提问有点多/);
  assert.equal(gm.pendingCount('c'), 3, '上限是 3 条排队');
  assert.equal(n, 1, '同一时刻只有一条在评判');
  assert.equal(gm.status('c').pending, 3, '状态摘要里能看到排队数');

  // 把队列放空，确认没有卡死
  for (let i = 0; i < 4; i++) {
    gates[i].resolve({ ...OK, similarity: 0.1 });
    await tick();
  }
  const results = await Promise.all(promises.slice(0, 4));
  assert.ok(results.every((r) => r.type === 'answer'));
  assert.equal(n, 4, '第 5 条压根没有发起评判');
  assert.equal(gm.pendingCount('c'), 0);
});

test('还在排队的提问碰上换题：直接作废，不会拿去评判新题目', async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const judged = [];
  const gm = new GameManager({
    async judge(_q, message) {
      judged.push(message);
      return gates[n++].promise;
    },
  });
  beginRound(gm);

  const first = gm.ask('c', 'u1', 'A', '针对第一题');
  const second = gm.ask('c', 'u2', 'B', '也是针对第一题');
  await tick();
  assert.deepEqual(judged, ['针对第一题'], '第二条还在排队');

  // 排队期间换到第二题并开始
  gm.setQuestion('c', Q2, { userId: 'u1', userName: 'A' });
  gm.start('c', 'u1', 'A');

  gates[0].resolve({ ...OK, similarity: 0.1 });
  const [r1, r2] = await Promise.all([first, second]);

  assert.equal(r1.type, 'hint');
  assert.match(r1.text, /题目已经换/);
  assert.equal(r2.type, 'hint');
  assert.match(r2.text, /题目已经换/);
  assert.deepEqual(judged, ['针对第一题'], '第二条提问绝不能被拿去评判第二题');
  assert.equal(gm.status('c').questionCount, 0, '新一局历史里不该有旧提问');
  assert.equal(gm.status('c').participantCount, 0);
});

test('评判抛异常不会卡死频道：后面的提问照常处理', async () => {
  let first = true;
  const gm = new GameManager({
    async judge() {
      if (first) {
        first = false;
        throw new Error('渠道炸了');
      }
      return { isYes: false, yesProb: 0.1, similarity: 0.2, usage: null };
    },
  });
  beginRound(gm);

  const bad = await gm.ask('c', 'u1', 'A', '问题1');
  assert.equal(bad.type, 'hint');
  assert.match(bad.text, /处理失败/);

  const good = await gm.ask('c', 'u2', 'B', '问题2');
  assert.equal(good.type, 'answer');
  assert.equal(gm.pendingCount('c'), 0);
});

/* ---------------- 不同频道 / 不同团体 ---------------- */

test('不同频道互不阻塞：几个团体可以同时评判', async () => {
  const gate = deferred();
  let active = 0;
  let maxActive = 0;
  const gm = new GameManager({
    async judge() {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await gate.promise;
      } finally {
        active--;
      }
    },
  });

  beginRound(gm, 'discord:1:100', Q1, { userId: 'u1', userName: 'A' });
  beginRound(gm, 'qq:200', Q2, { userId: 'u2', userName: 'B' });

  const p1 = gm.ask('discord:1:100', 'u1', 'A', '问题1');
  const p2 = gm.ask('qq:200', 'u2', 'B', '问题2');
  await tick();

  assert.equal(maxActive, 2, '不同频道应能并发评判');
  gate.resolve({ ...OK, similarity: 0.3 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.type, 'answer');
  assert.equal(r2.type, 'answer');
  // 各自的局互不影响
  assert.equal(gm.status('discord:1:100').questionTitle, '一');
  assert.equal(gm.status('qq:200').questionTitle, '二');
});

test('状态表不会无限增长：空闲频道被回收，进行中的局保留', async () => {
  const gm = new GameManager({ judge: async () => OK });
  beginRound(gm, 'active', Q1); // 进行中
  gm.setQuestion('idle', Q1, { userId: 'u1', userName: 'A' }); // 只选了题，没开始

  const later = Date.now() + 13 * 60 * 60 * 1000;
  const removed = gm.prune(later);

  assert.equal(removed, 1);
  assert.equal(gm.status('active').hasQuestion, true, '进行中的局不能被回收');
  assert.equal(gm.status('idle').hasQuestion, false);
});

test('频道数超过硬上限时，从最久没动过的开始回收', async () => {
  const gm = new GameManager({ judge: async () => OK });
  const now = Date.now();
  // 600 个"刚动过"的频道，c0 最久、c599 最新（都还没到空闲回收的时限）
  for (let i = 0; i < 600; i++) {
    gm.states.set(`c${i}`, {
      question: null,
      started: false,
      history: [],
      participants: new Set(),
      winner: null,
      revealed: false,
      ownerId: null,
      ownerName: null,
      createdAt: now - (600 - i) * 1000,
      roundId: 0,
      touchedAt: now - (600 - i) * 1000,
    });
  }

  gm.prune(now);
  assert.ok(gm.states.size <= 500, `应回收到上限内，实际 ${gm.states.size}`);
  assert.equal(gm.states.has('c599'), true, '最近动过的保留');
  assert.equal(gm.states.has('c0'), false, '最久没动过的先被回收');
});

test('全局评判并发有上限：团体再多也不会一起打向网关', async () => {
  const gate = deferred();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const gm = new GameManager({
    async judge() {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await gate.promise;
      } finally {
        active--;
      }
    },
  });

  // 12 个团体一起开局、同时提问
  const keys = [];
  for (let i = 0; i < 12; i++) {
    const key = `qq:${1000 + i}`;
    keys.push(key);
    beginRound(gm, key, Q1, { userId: `u${i}`, userName: `玩家${i}` });
  }
  const asks = keys.map((key, i) => gm.ask(key, `u${i}`, `玩家${i}`, '问题'));
  await tick();

  assert.equal(calls, 8, '同时最多只发起 8 条评判');
  assert.equal(gm.activeJudges, 8);

  gate.resolve({ ...OK, similarity: 0.1 });
  const results = await Promise.all(asks);

  assert.ok(results.every((r) => r.type === 'answer'), '排队等待的最终都要答上');
  assert.equal(calls, 12);
  assert.ok(maxActive <= 8, `并发上限被突破：${maxActive}`);
  assert.equal(gm.activeJudges, 0, '额度要还回去，不能泄漏');
});

/* ---------------- 配置热生效 ---------------- */

test('阈值改动立即生效：不用重启也在用新阈值判定', async () => {
  const gm = new GameManager({
    async judge() {
      return { isYes: true, yesProb: 0.9, similarity: 0.6, usage: null };
    },
  });
  beginRound(gm);

  const before = config.judge.winThreshold;
  try {
    config.judge.winThreshold = 0.9;
    assert.equal((await gm.ask('c', 'u1', 'A', '问题')).type, 'answer');

    config.judge.winThreshold = 0.5;
    gm.setQuestion('c', Q2, { userId: 'u1', userName: 'A' });
    gm.start('c', 'u1', 'A');
    assert.equal((await gm.ask('c', 'u1', 'A', '问题')).type, 'win');
  } finally {
    config.judge.winThreshold = before;
  }
});

/* ---------------- 写文件：并发保存 ---------------- */

test('两个标签页同时改题：并发保存不会互相顶掉，也不残留临时文件', async () => {
  const qdir = await mkdtemp(join(tmpdir(), 'turtle-conc-q-'));
  const store = new QuestionStore({ file: join(qdir, 'questions.json') });
  await store.load();

  await Promise.all([
    store.import([{ puzzle: 'A', answer: 'a' }]),
    store.import([{ puzzle: 'B', answer: 'b' }]),
    store.update(1, { title: '改一下' }).catch(() => null),
    store.import([{ puzzle: 'C', answer: 'c' }]),
  ]);

  const names = await readdir(qdir);
  assert.deepEqual(names, ['questions.json'], '不应残留 .tmp 文件');
  const parsed = JSON.parse(await readFile(join(qdir, 'questions.json'), 'utf8'));
  assert.equal(parsed.length, store.count);
  assert.deepEqual(parsed.map((q) => q.puzzle), ['A', 'B', 'C']);
});

test('并发保存配置：不会 ENOENT 失败，也不会残留临时文件', async () => {
  const results = await Promise.all([
    updateConfig({ judge: { winThreshold: 0.7 } }),
    updateConfig({ discord: { helpText: '并发一' } }),
    updateConfig({ judge: { yesThreshold: 0.4 } }),
    updateConfig({ qq: { napcat: { helpText: '并发二' } } }),
  ]);

  assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.problems)));

  const cdir = join(CONFIG_FILE, '..');
  const leftovers = (await readdir(cdir)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不应残留 .tmp 文件');

  const onDisk = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(onDisk.judge.winThreshold, 0.7);
  assert.equal(onDisk.discord.helpText, '并发一');
  assert.equal(onDisk.judge.yesThreshold, 0.4);
  assert.equal(onDisk.qq.napcat.helpText, '并发二');
});
