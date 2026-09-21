// 后台 API 测试：真实起一个 HTTP 服务（随机端口），只在本机回环上跑
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'turtle-web-'));
process.env.CONFIG_FILE = join(dir, 'config.json');
process.env.ADMIN_HOST = '';
process.env.ADMIN_PORT = '';

const { config, updateConfig } = await import('../src/config.js');
const { QuestionStore } = await import('../src/game/QuestionStore.js');
const { createAdminApp } = await import('../src/web/server.js');

const questionsFile = join(dir, 'questions.json');
await writeFile(
  questionsFile,
  JSON.stringify([{ id: 1, title: '甲', puzzle: '甲汤面', answer: '甲汤底' }]),
  'utf8',
);
const questionStore = new QuestionStore({ file: questionsFile });
await questionStore.load();

const runtime = {
  appliedAt: null,
  status: () => ({
    discord: { state: 'disabled', detail: '未启用' },
    napcat: { state: 'connected', detail: '已连接 ws://127.0.0.1:3001' },
    official: { state: 'disabled', detail: '未启用' },
  }),
  apply: async () => {},
};

const app = createAdminApp({ runtime, questionStore });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

let token = '';

async function call(path, { method = 'GET', body, auth = true, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && token) headers['X-Auth-Token'] = token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, raw: text };
}

test('未设置密码时 /api/state 提示需要初始化', async () => {
  const r = await call('/api/state', { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.needsSetup, true);
  assert.equal(r.data.authenticated, false);
});

test('未登录访问受保护接口返回 401', async () => {
  const r = await call('/api/config', { auth: false });
  assert.equal(r.status, 401);
});

test('密码太短会被拒绝', async () => {
  const r = await call('/api/setup', { method: 'POST', body: { password: '123' }, auth: false });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /至少/);
});

test('初始化密码后拿到会话令牌', async () => {
  const r = await call('/api/setup', { method: 'POST', body: { password: 'soup-1234' }, auth: false });
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
  token = r.data.token;
});

test('重复初始化会被拒绝，错误密码登录失败', async () => {
  const setup = await call('/api/setup', { method: 'POST', body: { password: 'another-1' }, auth: false });
  assert.equal(setup.status, 409);

  const login = await call('/api/login', { method: 'POST', body: { password: 'nope' }, auth: false });
  assert.equal(login.status, 401);
});

test('概览返回三条通道状态与评判渠道可用性', async () => {
  await updateConfig({ judge: { providers: { gateway: { apiKey: 'vck_overview_leak_check' } } } });
  const r = await call('/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.data.channels.napcat.state, 'connected');
  assert.equal(r.data.questions, 1);
  assert.equal(r.data.judge.ready, true);
  assert.equal(r.data.judge.label, 'Vercel AI Gateway');
  assert.ok(!r.raw.includes('vck_overview_leak_check'), '概览里不能出现密钥明文');
  assert.ok(!r.raw.includes('apiKey'), '概览里不应带原始渠道配置');
});

test('评判渠道清单带依赖安装状态', async () => {
  const r = await call('/api/judge/providers');
  assert.equal(r.status, 200);
  const ids = r.data.providers.map((p) => p.id);
  assert.ok(ids.includes('gateway'));
  assert.ok(ids.includes('typesafe'));
  const gateway = r.data.providers.find((p) => p.id === 'gateway');
  assert.equal(gateway.installed, true, '内置渠道应显示已安装');
  assert.ok(gateway.label);
  assert.ok(gateway.note);
  // readiness 只暴露"能不能用"，不带原始配置
  assert.equal(r.data.readiness.ready, true);
  assert.equal(r.data.readiness.model, 'typesafe-ai/jev');
  assert.equal(r.data.readiness.entry, undefined);
  assert.ok(!r.raw.includes('vck_overview_leak_check'));
});

test('配置接口返回掩码后的密钥', async () => {
  await updateConfig({ judge: { providers: { gateway: { apiKey: 'vck_should_not_leak' } } } });
  const r = await call('/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.config.judge.providers.gateway.apiKeySet, true);
  assert.equal(r.data.config.judge.provider, 'gateway');
  assert.ok(!r.raw.includes('vck_should_not_leak'), '响应里不能出现密钥明文');
});

test('切换评判渠道：一个请求里改渠道 + 填凭据', async () => {
  const r = await call('/api/config', {
    method: 'PUT',
    body: {
      judge: {
        provider: 'typesafe',
        providers: { typesafe: { apiKey: 'ts-key', model: 'jev-latest' } },
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.config.judge.provider, 'typesafe');
  assert.equal(r.data.config.judge.providers.typesafe.apiKeySet, true);
  assert.equal(config.judge.providers.typesafe.model, 'jev-latest');
  assert.equal(config.judge.providers.gateway.apiKey, 'vck_should_not_leak', '切换不应影响别的渠道');

  const back = await call('/api/config', { method: 'PUT', body: { judge: { provider: 'gateway' } } });
  assert.equal(back.data.config.judge.provider, 'gateway');
});

test('保存非法配置返回 400 与具体原因', async () => {
  const r = await call('/api/config', { method: 'PUT', body: { judge: { winThreshold: 5 } } });
  assert.equal(r.status, 400);
  assert.equal(r.data.ok, false);
  assert.ok(r.data.problems.some((p) => p.includes('winThreshold')));
});

test('保存合法配置生效并落盘', async () => {
  const r = await call('/api/config', {
    method: 'PUT',
    body: {
      discord: { enabled: true, helpText: '本服说明' },
      qq: { napcat: { enabled: true } },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);

  const after = await call('/api/config');
  assert.equal(after.data.config.discord.enabled, true);
  assert.equal(after.data.config.discord.helpText, '本服说明');
  assert.equal(config.discord.helpText, '本服说明');
});

test('题库：列表 / 新增 / 修改 / 删除', async () => {
  let r = await call('/api/questions');
  assert.equal(r.data.count, 1);

  r = await call('/api/questions', {
    method: 'POST',
    body: { questions: [{ title: '乙', puzzle: '乙汤面', answer: '乙汤底' }] },
  });
  assert.equal(r.data.added, 1);
  assert.equal(r.data.total, 2);

  const added = questionStore.listAll().find((q) => q.title === '乙');
  r = await call(`/api/questions/${added.id}`, { method: 'PUT', body: { title: '乙（改）' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.question.title, '乙（改）');

  r = await call(`/api/questions/${added.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 1);

  r = await call('/api/questions/9999', { method: 'DELETE' });
  assert.equal(r.status, 404);
});

test('题库：缺字段的更新会被拒绝', async () => {
  const r = await call('/api/questions/1', { method: 'PUT', body: { answer: '   ' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /汤底/);
});

test('题库：导出为 JSON 文件', async () => {
  const r = await call('/api/questions/export');
  assert.equal(r.status, 200);
  const parsed = JSON.parse(r.raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].answer, '甲汤底');
});

test('未登录访问管理接口一律 401，登出后令牌失效', async () => {
  const noAuth = await call('/api/questions', { auth: false });
  assert.equal(noAuth.status, 401);

  const logout = await call('/api/logout', { method: 'POST' });
  assert.equal(logout.status, 200);

  const after = await call('/api/questions');
  assert.equal(after.status, 401);
});

test('未命中的 API 返回 JSON 404 而不是 HTML', async () => {
  const r = await call('/api/nope', { auth: false });
  assert.equal(r.status, 404);
  assert.match(r.raw, /接口不存在/);
});

test('根路径返回后台界面', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /海龟汤机器人/);
});
