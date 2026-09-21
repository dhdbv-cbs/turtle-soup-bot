// 进程重启：模块逻辑 + 后台接口（全部用桩，绝不真的动进程）
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-restart-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
process.env.ADMIN_HOST = '';
process.env.ADMIN_PORT = '';

const { setPassword } = await import('../src/config.js');
const { createRestarter, detectSupervisor } = await import('../src/restart.js');
const { createAdminApp } = await import('../src/web/server.js');

const runtime = { appliedAt: null, status: () => ({ discord: { state: 'disabled', detail: '未启用' } }), apply: async () => {} };
const questionStore = { count: 0, listAll: () => [] };

// 假的新进程：能手动触发 'spawn' / 'error'
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

function makeRestarter(overrides = {}) {
  const events = [];
  const child = overrides.child || fakeChild();
  const restarter = createRestarter({
    stop: async () => { events.push('stop'); },
    onFail: overrides.onFail ? async () => { events.push('onFail'); await overrides.onFail(); } : async () => { events.push('onFail'); },
    env: {},
    argv: ['node', 'src/index.js'],
    execPath: 'node',
    cwd: '/tmp/bot',
    spawnFn: (...args) => { events.push(['spawn', ...args]); if (overrides.spawnThrows) throw new Error('boom'); return child; },
    exitFn: (code) => { events.push(['exit', code]); },
    logFn: () => {},
    errorFn: (msg) => { events.push(['error', msg]); },
    ...overrides.options,
  });
  return { restarter, events, child };
}

test('没有守护进程时：自己拉一模一样的命令，等子进程起来再退出', async () => {
  const { restarter, events, child } = makeRestarter();
  const accepted = restarter.accept();
  assert.equal(accepted.ok, true);
  assert.equal(accepted.mode, 'exec');

  const running = restarter.run();
  await new Promise((r) => setTimeout(r, 0));
  child.emit('spawn'); // 子进程起来了
  const result = await running;

  assert.equal(result.ok, true);
  assert.equal(result.pid, 4242);
  assert.deepEqual(events[0], 'stop', '先停通道、放开端口，再拉新进程');
  const spawnCall = events.find((e) => Array.isArray(e) && e[0] === 'spawn');
  assert.equal(spawnCall[1], 'node');
  assert.deepEqual(spawnCall[2], ['src/index.js']);
  assert.equal(spawnCall[3].detached, true, '要独立一组，父进程退出后它还能活');
  assert.equal(spawnCall[3].stdio, 'inherit');
  assert.equal(spawnCall[3].cwd, '/tmp/bot');
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(events.at(-1), ['exit', 0]);
});

test('有守护进程（pm2 / systemd）时：只退出自己，不再拉新进程', async () => {
  for (const env of [{ pm_id: '0' }, { NODE_APP_INSTANCE: '0' }, { INVOCATION_ID: 'abc' }]) {
    const { restarter, events } = makeRestarter({ options: { env } });
    assert.equal(restarter.accept().mode, 'exit');
    const result = await restarter.run();
    assert.equal(result.mode, 'exit');
    assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'spawn'), false, '不能再拉一个，否则两个进程抢同一条消息');
    assert.deepEqual(events.at(-1), ['exit', 0]);
  }
});

test('子进程没起来：留在原地恢复，不退出也不丢机器人', async () => {
  const { restarter, events, child } = makeRestarter();
  restarter.accept();
  const running = restarter.run();
  await new Promise((r) => setTimeout(r, 0));
  child.emit('error', new Error('ENOENT'));

  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'failed');
  assert.equal(events.some((e) => Array.isArray(e) && e[0] === 'exit'), false, '没起来就别退出');
  assert.equal(events.includes('onFail'), true, '要把停掉的东西恢复回来');
  assert.equal(restarter.busy, false, '恢复后还能再点一次');
});

test('重复点按钮：第二次被挡成 busy，不会排两次重启', async () => {
  const { restarter } = makeRestarter();
  assert.equal(restarter.accept().ok, true);
  const second = restarter.accept();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.equal(restarter.busy, true);
});

test('detectSupervisor 认得出常见守护进程，普通启动返回 null', () => {
  assert.equal(detectSupervisor({}), null);
  assert.equal(detectSupervisor({ PATH: '/usr/bin' }), null);
  assert.equal(detectSupervisor({ pm_id: '3' }), 'pm2');
  assert.equal(detectSupervisor({ pm2_home: '/root/.pm2' }), 'pm2');
  assert.equal(detectSupervisor({ INVOCATION_ID: 'x' }), 'systemd');
  assert.equal(detectSupervisor({ SUPERVISOR_ENABLED: '1' }), 'supervisord');
});

/* ---------------- 接口 ---------------- */

let token = '';
const apps = [];

async function startApp(options) {
  const app = createAdminApp({ runtime, questionStore, games: null, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  apps.push(server);
  return base;
}

async function call(base, path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Auth-Token'] = token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, raw: text };
}

await setPassword('soup-1234');

test('没提供重启能力时，接口明确回 501，不装作成功', async () => {
  const base = await startApp({});
  const login = await call(base, '/api/login', { method: 'POST', body: { password: 'soup-1234' } });
  token = login.data.token;

  const ov = await call(base, '/api/overview');
  assert.equal(ov.data.canRestart, false, '界面据此不显示按钮');

  const r = await call(base, '/api/restart', { method: 'POST' });
  assert.equal(r.status, 501);
  assert.match(r.data.error, /手动重启/);
});

test('重启接口：先回 ok，再在响应之后执行重启；重复点回 409', async () => {
  const events = [];
  let accepted = 0;
  const fakeRestarter = {
    get busy() { return false; },
    accept() {
      accepted += 1;
      if (accepted > 1) return { ok: false, reason: 'busy' };
      return { ok: true, mode: 'exec' };
    },
    async run() { events.push('run'); },
  };

  const base = await startApp({ restart: fakeRestarter });
  const login = await call(base, '/api/login', { method: 'POST', body: { password: 'soup-1234' } });
  token = login.data.token;

  const ov = await call(base, '/api/overview');
  assert.equal(ov.data.canRestart, true);

  const r = await call(base, '/api/restart', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.mode, 'exec');
  assert.match(r.data.note, /重新登录/);
  assert.deepEqual(events, [], '响应发出去之前不能动进程');

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(events, ['run'], '响应之后才真的重启');

  const again = await call(base, '/api/restart', { method: 'POST' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /已经在进行中/);
});

// 收尾钩子必须注册在最后：放在顶层 await 之前的话，Node 的 test runner 会早早执行它
after(async () => {
  // fetch 用的是 keep-alive 连接池：只 close() 会留下活跃 socket，测试进程不会退出
  for (const s of apps) {
    s.closeAllConnections?.();
    s.close();
  }
});
