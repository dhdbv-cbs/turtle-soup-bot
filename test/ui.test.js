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
async function bootUi({ state, routes, hash = '' }) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const calls = [];
  const realSetInterval = globalThis.setInterval;
  const hadWindow = 'window' in globalThis;
  const hadLocation = 'location' in globalThis;

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
  globalThis.location = { hash };
  globalThis.window = { addEventListener() {} };
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
    if (!hadWindow) delete globalThis.window;
    if (!hadLocation) delete globalThis.location;
  }
}

// 评判渠道接口的桩数据
const PROVIDERS_FIXTURE = {
  active: 'gateway',
  readiness: { ready: true, provider: 'gateway', label: 'Vercel AI Gateway', model: 'typesafe-ai/jev' },
  providers: [
    { id: 'gateway', label: 'Vercel AI Gateway', pkg: '@ai-sdk/gateway', installed: true, supportsBaseURL: true,
      defaultModel: 'typesafe-ai/jev', modelExample: 'typesafe-ai/jev', apiKeyEnv: 'AI_GATEWAY_API_KEY',
      note: '官方网关，内置依赖开箱可用', home: 'https://vercel.com/docs/ai-gateway', protocols: [] },
    { id: 'typesafe', label: 'TypeSafe 官方直连', pkg: '@ai-sdk/typesafe-ai', installed: false, supportsBaseURL: true,
      defaultModel: 'jev-latest', modelExample: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY',
      note: 'TypeSafe 自家 API', home: 'https://docs.typesafe.ai', protocols: [] },
    { id: 'custom', label: '第三方转发（Jev）', installed: true, supportsBaseURL: true, requiresBaseURL: true,
      defaultModel: 'jev-latest', modelExample: 'jev-latest', apiKeyEnv: '', defaultProtocol: 'typesafe',
      note: '第三方中转的 Jev 服务', home: 'https://docs.typesafe.ai',
      protocols: [
        { id: 'typesafe', label: 'TypeSafe 直连协议（api.typesafe.ai 风格）', pkg: '@ai-sdk/typesafe-ai', defaultModel: 'jev-latest', installed: true },
        { id: 'gateway', label: 'AI Gateway 协议（/v4/ai 风格）', pkg: '@ai-sdk/gateway', defaultModel: 'typesafe-ai/jev', installed: false },
      ] },
  ],
};

function judgeConfigFixture() {
  return {
    problems: [],
    config: {
      source: 'file',
      admin: { host: '127.0.0.1', port: 4319, hasPassword: true },
      judge: {
        provider: 'gateway',
        winThreshold: 0.8,
        yesThreshold: 0.5,
        providers: {
          gateway: { apiKey: '••••••••', apiKeySet: true, baseURL: '', model: 'typesafe-ai/jev' },
          typesafe: { apiKey: '', apiKeySet: false, baseURL: '', model: 'jev-latest' },
          custom: { apiKey: '', apiKeySet: false, baseURL: '', model: 'jev-latest', protocol: 'typesafe' },
        },
      },
      discord: { enabled: false, helpText: '', token: '', tokenSet: false },
      qq: {
        napcat: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', helpText: '', accessToken: '', accessTokenSet: false },
        official: { enabled: false, appId: '', sandbox: true, helpText: '', guildMessages: false, appSecret: '', appSecretSet: false },
      },
    },
  };
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
          judge: {
            provider: 'gateway',
            winThreshold: 0.8,
            yesThreshold: 0.5,
            providers: { gateway: { apiKey: '', apiKeySet: false, baseURL: '', model: 'typesafe-ai/jev' } },
          },
          discord: { enabled: false, helpText: '', token: '', tokenSet: false },
          qq: {
            napcat: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', helpText: '', accessToken: '', accessTokenSet: false },
            official: { enabled: true, appId: '102000001', sandbox: true, helpText: '', guildMessages: false, appSecret: '', appSecretSet: false },
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

test('评判页用抽屉列表，默认全部收起', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#judge',
    routes: {
      '/api/overview': { channels: {}, questions: 0, uptime: 0, configProblems: [], judge: { ready: true } },
      '/api/config': judgeConfigFixture(),
      '/api/judge/providers': PROVIDERS_FIXTURE,
    },
  });

  const html = ui.html();
  assert.ok(ui.calls.includes('/api/judge/providers'), '进入评判页应拉取渠道清单');
  assert.match(html, /当前评判渠道/);
  assert.match(html, /可选的评判渠道/);
  assert.match(html, /评判参数/);

  // 三个渠道都列出来了，但抽屉是收起的（没有展开体）
  assert.match(html, /Vercel AI Gateway/);
  assert.match(html, /TypeSafe 官方直连/);
  assert.match(html, /第三方转发/);
  assert.equal((html.match(/drawer-body/g) || []).length, 0, '默认不应展开任何抽屉');

  // 当前生效的渠道有标记，没装依赖的渠道被标注出来
  assert.match(html, /使用中/);
  assert.match(html, /依赖未安装/);
  // 表头显示的是该渠道当前的模型
  assert.match(html, /typesafe-ai\/jev/);

  // 旧的"前缀"配置项应该彻底消失，也不再出现 LLM 渠道
  assert.doesNotMatch(html, /命令前缀/);
  assert.doesNotMatch(html, /OpenAI|Anthropic|Claude|Gemini/);
  assert.match(html, /当前没有正在评判的提问/);
});

test('评判页显示并发负载：正在评判 / 排队多少条', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#judge',
    routes: {
      '/api/overview': {
        channels: {},
        questions: 0,
        uptime: 0,
        configProblems: [],
        judge: { ready: true, active: 3, queued: 2, channels: 7 },
      },
      '/api/config': judgeConfigFixture(),
      '/api/judge/providers': PROVIDERS_FIXTURE,
    },
  });

  const html = ui.html();
  assert.match(html, /正在评判 3 条，排队 2 条/);
});

test('渠道页的 /help 文案输入框已按本渠道预先填好，不用自己写', async () => {
  const cfg = judgeConfigFixture();
  cfg.helpDefaults = {
    discord: '🐢 内置 Discord 文案\n【命令】\n  /help\n每人每分钟最多提问 6 次',
    napcat: '🐢 内置 NapCat 文案',
    official: '🐢 内置官方文案',
  };
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#discord',
    routes: { '/api/overview': { channels: {}, questions: 0, configProblems: [] }, '/api/config': cfg },
  });

  const html = ui.html();
  // 配置里 helpText 是空的，但输入框应该已经带着内置文案
  assert.match(html, /内置 Discord 文案/);
  assert.match(html, /data-field="discord\.helpText"/);
  assert.match(html, /清空保存则恢复这份内置文案/);
});

test('抽屉可以通过锚点直接展开，并显示该渠道的字段', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#judge/typesafe',
    routes: {
      '/api/overview': { channels: {}, questions: 0, uptime: 0, configProblems: [], judge: { ready: true } },
      '/api/config': judgeConfigFixture(),
      '/api/judge/providers': PROVIDERS_FIXTURE,
    },
  });

  const html = ui.html();
  assert.equal((html.match(/drawer-body/g) || []).length, 1, '只应展开一个抽屉');
  assert.match(html, /保存并切换到该渠道/);
  assert.match(html, /API Key/);
  assert.match(html, /模型 ID/);
  assert.match(html, /TYPESAFE_API_KEY/, '应提示可以用环境变量');
});

test('第三方转发：可以选协议，没装依赖的协议会提示安装命令', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#judge/custom',
    routes: {
      '/api/overview': { channels: {}, questions: 0, uptime: 0, configProblems: [], judge: { ready: true } },
      '/api/config': judgeConfigFixture(),
      '/api/judge/providers': PROVIDERS_FIXTURE,
    },
  });

  const html = ui.html();
  assert.match(html, /<select[^>]*data-select="judge\.providers\.custom\.protocol"/, '应渲染协议下拉框');
  assert.match(html, /TypeSafe 直连协议/);
  assert.match(html, /AI Gateway 协议（\/v4\/ai 风格）（依赖未安装）/);
  assert.match(html, /Base URL/, '第三方转发需要 Base URL 字段');
  assert.match(html, /第三方中转的密钥/);
  assert.doesNotMatch(html, /npm i @ai-sdk\/typesafe-ai/, '默认协议依赖已装，不该提示安装');
});

test('整个渠道都没装依赖时：按钮禁用并给出安装命令', async () => {
  const ui = await bootUi({
    state: { needsSetup: false, authenticated: true, version: '1.0.0' },
    hash: '#judge/typesafe',
    routes: {
      '/api/overview': { channels: {}, questions: 0, uptime: 0, configProblems: [], judge: { ready: true } },
      '/api/config': judgeConfigFixture(),
      '/api/judge/providers': PROVIDERS_FIXTURE,
    },
  });

  const html = ui.html();
  assert.match(html, /npm i @ai-sdk\/typesafe-ai/);
  assert.match(html, /data-use-provider="typesafe" disabled/);
});
