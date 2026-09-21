// 后台界面冒烟测试：在极简 DOM 桩里真正执行 public/app.js，
// 验证三种初始状态（首次设置密码 / 登录 / 已登录）都能正确渲染，且不抛异常。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(__dirname, '..', 'public', 'app.js');

function makeElement(id = '') {
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    className: '',
    placeholder: '',
    disabled: false,
    dataset: {},
    style: {},
    onclick: null,
    onkeydown: null,
    href: '',
    download: '',
    addEventListener() {},
    remove() {},
    click() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

// 用桩替换浏览器环境，再加载 app.js（带查询串绕过模块缓存，每个用例独立一份状态）
async function bootUi({ state, routes }) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const calls = [];
  const realSetInterval = globalThis.setInterval;

  globalThis.document = {
    getElementById: getEl,
    createElement: () => makeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, String(v)); },
    removeItem(k) { this.store.delete(k); },
  };
  globalThis.fetch = async (path) => {
    const url = String(path);
    calls.push(url);
    const body = url.includes('/api/state') ? state : routes[url.split('?')[0]];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no route: ' + url }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  // 界面里有个 5 秒轮询，测试里不真的排期，避免进程挂住
  globalThis.setInterval = () => 0;

  try {
    const url = `${pathToFileURL(APP_PATH).href}?case=${Math.random().toString(36).slice(2)}`;
    await import(url);
    await new Promise((r) => setTimeout(r, 30)); // 等 boot() 的异步流程跑完
    return { html: () => getEl('root').innerHTML, calls };
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}

test('未设置密码时渲染初始化页面', async () => {
  const ui = await bootUi({
    state: { needsSetup: true, authenticated: false, passwordMinLength: 6, version: '1.0.0' },
    routes: {},
  });
  const html = ui.html();
  assert.match(html, /首次使用/);
  assert.match(html, /设置并进入/);
  assert.match(html, /至少 6 位/);
  assert.deepEqual(ui.calls, ['/api/state']);
});

test('已设置密码但未登录时渲染登录页面', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: false, passwordMinLength: 6, version: '1.0.0' },
    routes: {},
  });
  const html = ui.html();
  assert.match(html, /请输入后台密码/);
  assert.match(html, /登录/);
});

test('已登录时渲染主界面与通道状态', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, passwordMinLength: 6, version: '9.9.9' },
    routes: {
      '/api/overview': {
        version: '9.9.9',
        uptime: 3725,
        configFile: '/tmp/config.json',
        configProblems: [],
        appliedAt: null,
        questions: 3,
        channels: {
          discord: { state: 'disabled', detail: '未启用' },
          napcat: { state: 'connected', detail: '已连接 ws://127.0.0.1:3001' },
          official: { state: 'error', detail: '获取 access_token 失败：appid invalid' },
        },
      },
      '/api/config': {
        problems: [],
        config: {
          admin: { host: '127.0.0.1', port: 4319, hasPassword: true },
          judge: { model: 'typesafe-ai/jev', winThreshold: 0.8, yesThreshold: 0.5, apiKey: '', apiKeySet: false },
          discord: { enabled: false, prefix: '!', token: '', tokenSet: false },
          qq: {
            napcat: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', prefix: '#', accessToken: '', accessTokenSet: false },
            official: { enabled: true, appId: '102000001', sandbox: true, prefix: '#', guildMessages: false, appSecret: '', appSecretSet: false },
          },
        },
      },
    },
  });

  const html = ui.html();
  assert.match(html, /v9\.9\.9/);
  assert.match(html, /通道状态/);
  assert.match(html, /QQ · NapCat/);
  assert.match(html, /已连接/);
  assert.match(html, /异常/);
  assert.match(html, /题目数量/);
  assert.match(html, /1 小时 2 分/, '运行时长应被格式化');
  assert.ok(ui.calls.includes('/api/overview'));
  assert.ok(ui.calls.includes('/api/config'));
});

test('界面脚本不引用未定义的全局变量（在桩环境里能跑完）', async () => {
  // 这里主要确保 esc() 之类的工具在缺字段时也不会抛错；
  // /api/overview 与 /api/config 的 problems 来自同一个来源，桩数据保持一致
  const problems = ['judge.winThreshold 不能大于 1'];
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    routes: {
      '/api/overview': { channels: {}, questions: 0, uptime: 0, configProblems: problems },
      '/api/config': { problems, config: {} },
    },
  });
  const html = ui.html();
  assert.match(html, /配置存在问题/);
  assert.match(html, /winThreshold/);
});
