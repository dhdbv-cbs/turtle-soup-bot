'use strict';

const state = {
  token: localStorage.getItem('turtle.adminToken') || '',
  screen: 'loading',   // loading | setup | login | app
  tab: 'overview',
  info: null,          // /api/state
  config: null,        // publicConfig
  overview: null,
  questions: [],
  editingId: null,
  problems: [],
  providers: [],       // 评判渠道清单
  activeProvider: '',
  judgeReadiness: null,
  drawer: null,        // 当前展开的评判渠道
};
let refreshTimer = null;

const root = document.getElementById('root');
const toastEl = document.getElementById('toast');

const TABS = ['overview', 'judge', 'discord', 'napcat', 'official', 'questions', 'admin'];

/* ---------------- 锚点深链：#judge / #judge/typesafe ---------------- */

function readHash() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const [tab, sub] = raw.split('/');
  if (TABS.includes(tab)) state.tab = tab;
  if (state.tab === 'judge' && sub) state.drawer = sub;
}

function syncHash() {
  const hash = state.tab === 'judge' && state.drawer ? `#judge/${state.drawer}` : `#${state.tab}`;
  if (location.hash !== hash) location.hash = hash;
}

/* ---------------- 基础 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'toast ' + kind; }, 3600);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['X-Auth-Token'] = state.token;
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401) {
      state.token = '';
      localStorage.removeItem('turtle.adminToken');
    }
    const err = new Error(data?.error || data?.problems?.join('；') || ('HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  return m + ' 分 ' + (s % 60) + ' 秒';
}

const STATE_TEXT = {
  connected: '已连接', connecting: '连接中', error: '异常',
  disabled: '未启用', unconfigured: '待配置', stopped: '已停止',
};

/* ---------------- 登录 / 初始化 ---------------- */

function renderSetup() {
  state.screen = 'setup';
  const min = state.info?.passwordMinLength || 6;
  root.innerHTML = `
    <div class="center"><div class="auth">
      <h1>🐢 海龟汤机器人</h1>
      <p>首次使用，请先设置一个后台密码。之后所有配置都在这个界面里改，不需要编辑任何配置文件。</p>
      <div class="field">
        <label>后台密码（至少 ${min} 位）</label>
        <input id="pw1" type="password" autocomplete="new-password" autofocus>
      </div>
      <div class="field">
        <label>再输入一次</label>
        <input id="pw2" type="password" autocomplete="new-password">
      </div>
      <div class="err" id="err"></div>
      <div class="actions"><button class="primary" id="go">设置并进入</button></div>
      <div class="hint">忘记密码只能删除 data/config.json 后重新设置。</div>
    </div></div>`;

  const submit = async () => {
    const pw1 = document.getElementById('pw1').value;
    const pw2 = document.getElementById('pw2').value;
    const err = document.getElementById('err');
    if (pw1.length < min) { err.textContent = `密码至少 ${min} 位`; return; }
    if (pw1 !== pw2) { err.textContent = '两次输入不一致'; return; }
    try {
      const r = await api('/api/setup', { method: 'POST', body: JSON.stringify({ password: pw1 }) });
      state.token = r.token;
      localStorage.setItem('turtle.adminToken', r.token);
      toast('密码已设置');
      await enterApp();
    } catch (e) { err.textContent = e.message; }
  };
  document.getElementById('go').onclick = submit;
  root.querySelectorAll('input').forEach((el) => {
    el.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
  });
}

function renderLogin() {
  state.screen = 'login';
  root.innerHTML = `
    <div class="center"><div class="auth">
      <h1>🐢 海龟汤机器人</h1>
      <p>请输入后台密码。</p>
      <div class="field">
        <label>后台密码</label>
        <input id="pw" type="password" autocomplete="current-password" autofocus>
      </div>
      <div class="err" id="err"></div>
      <div class="actions"><button class="primary" id="go">登录</button></div>
    </div></div>`;

  const submit = async () => {
    const pw = document.getElementById('pw').value;
    const err = document.getElementById('err');
    try {
      const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      state.token = r.token;
      localStorage.setItem('turtle.adminToken', r.token);
      await enterApp();
    } catch (e) { err.textContent = e.message; }
  };
  document.getElementById('go').onclick = submit;
  document.getElementById('pw').onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
}

/* ---------------- 表单定义 ---------------- */

const FORMS = {
  discord: {
    title: 'Discord',
    sub: '需要开启 Message Content Intent，并把机器人邀请进服务器。命令以 Discord 原生斜杠命令注册。',
    fields: [
      { path: 'discord.enabled', label: '启用 Discord 通道', type: 'bool' },
      { path: 'discord.token', label: 'Bot Token', type: 'secret' },
      { path: 'discord.helpText', label: '/help 文案', type: 'long', rows: 16, prefill: 'discord', hint: '已经按 Discord 的用法填好了，可以直接改；改完保存才生效，清空保存则恢复这份内置文案' },
    ],
  },
  napcat: {
    title: 'QQ · NapCat（OneBot v11）',
    sub: '机器人会主动连接下面的 WebSocket 地址。在 NapCat 里请开启「WebSocket 服务端」，端口与这里保持一致。',
    fields: [
      { path: 'qq.napcat.enabled', label: '启用该通道', type: 'bool' },
      { path: 'qq.napcat.wsUrl', label: 'WebSocket 地址', type: 'text', placeholder: 'ws://127.0.0.1:3001' },
      { path: 'qq.napcat.accessToken', label: 'Access Token', type: 'secret', hint: 'NapCat 未设置令牌时留空' },
      { path: 'qq.napcat.helpText', label: '/help 文案', type: 'long', rows: 16, prefill: 'napcat', hint: '已经按 QQ（NapCat）的用法填好了（群里要先 @机器人），可以直接改；清空保存则恢复内置文案' },
    ],
  },
  official: {
    title: 'QQ · 官方机器人（QQ 开放平台）',
    sub: '在 QQ 开放平台创建机器人后，把 AppID / AppSecret 填进来，并选择沙箱或正式环境。',
    fields: [
      { path: 'qq.official.enabled', label: '启用该通道', type: 'bool' },
      { path: 'qq.official.appId', label: 'AppID', type: 'text' },
      { path: 'qq.official.appSecret', label: 'AppSecret', type: 'secret' },
      { path: 'qq.official.sandbox', label: '使用沙箱环境', type: 'bool', hint: '关闭后使用正式环境（api.sgroup.qq.com）；正式环境必须在开放平台的「开发设置 → IP 白名单」里加上服务器公网 IP，否则连不上网关' },
      { path: 'qq.official.guildMessages', label: '同时接收频道（子频道）@消息', type: 'bool', hint: '需要机器人具备公域消息权限，未开通时可能连不上网关' },
      { path: 'qq.official.helpText', label: '/help 文案', type: 'long', rows: 16, prefill: 'official', hint: '已经按官方规则填好了（被动消息的时效与条数），可以直接改；清空保存则恢复内置文案。注意：2026 年起新机器人基本加不进 QQ 群，官方通道更适合单聊' },
    ],
  },
  admin: {
    title: '后台服务',
    sub: '修改监听地址或端口后，需要重启进程才会生效。',
    fields: [
      { path: 'admin.host', label: '监听地址', type: 'text', hint: '默认 127.0.0.1 只允许本机访问' },
      { path: 'admin.port', label: '监听端口', type: 'number', min: '1', max: '65535' },
    ],
  },
};

// 评判参数（渠道本身在抽屉里配置）
const JUDGE_PARAMS = [
  { path: 'judge.winThreshold', label: '通关相似度阈值', type: 'number', step: '0.05', min: '0', max: '1', hint: '0~1，玩家发言与谜底的相似度达到该值即通关' },
  { path: 'judge.yesThreshold', label: '判「是」的概率阈值', type: 'number', step: '0.05', min: '0', max: '1', hint: '布尔题概率超过该值才回答「是」' },
];

function getValue(config, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
}

function fieldHtml(f, config) {
  const stored = getValue(config, f.path);
  // /help 这类"留空就用内置文案"的字段：直接把内置文案填进输入框，
  // 打开页面就是一份完整可用的文案，不用自己写
  const fallback = f.prefill ? state.helpDefaults?.[f.prefill] || '' : '';
  const value = stored === '' || stored == null ? fallback : stored;
  const id = 'f_' + f.path.replace(/\./g, '_');

  if (f.type === 'bool') {
    return `<div class="field"><label class="check">
      <input type="checkbox" data-field="${f.path}" id="${id}" ${value ? 'checked' : ''}>
      <span>${esc(f.label)}</span></label>
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  if (f.type === 'secret') {
    const set = value === '••••••••';
    return `<div class="field">
      <label>${esc(f.label)}</label>
      <div class="secret-row">
        <input type="password" data-field="${f.path}" id="${id}" autocomplete="new-password"
          placeholder="${set ? '已设置（留空表示不修改）' : '未设置'}">
        ${set ? `<button type="button" class="ghost" data-clear="${f.path}">清除</button>` : ''}
      </div>
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  if (f.type === 'select') {
    const options = (f.options || [])
      .map((o) => `<option value="${esc(o.value)}" ${String(value) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    return `<div class="field">
      <label>${esc(f.label)}</label>
      <select data-field="${f.path}" id="${id}" data-select="${f.path}">${options}</select>
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  if (f.type === 'long') {
    return `<div class="field">
      <label>${esc(f.label)}</label>
      <textarea data-field="${f.path}" id="${id}" rows="${f.rows || 6}" placeholder="${esc(f.placeholder || '')}">${esc(value ?? '')}</textarea>
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  const type = f.type === 'number' ? 'number' : 'text';
  const attrs = [
    f.step ? `step="${f.step}"` : '',
    f.min !== undefined ? `min="${f.min}"` : '',
    f.max !== undefined ? `max="${f.max}"` : '',
    f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '',
  ].join(' ');
  return `<div class="field">
    <label>${esc(f.label)}</label>
    <input type="${type}" data-field="${f.path}" id="${id}" value="${esc(value ?? '')}" ${attrs}>
    ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}

function formCard(name) {
  const spec = FORMS[name];
  const config = state.config || {};
  const body = spec.fields.map((f) => fieldHtml(f, config)).join('');
  return `<div class="card" data-form="${name}">
    <h2>${esc(spec.title)}</h2>
    <div class="sub">${esc(spec.sub)}</div>
    ${body}
    <div class="actions"><button class="primary" data-save="${name}">保存${esc(spec.title.split('（')[0])}</button></div>
  </div>`;
}

function collectFields(card, fields) {
  const patch = {};
  for (const f of fields) {
    const el = card.querySelector(`[data-field="${f.path}"]`);
    if (!el) continue;
    if (f.type === 'bool') { setPath(patch, f.path, el.checked); continue; }
    if (f.type === 'secret') {
      if (el.dataset.cleared === '1') { setPath(patch, f.path, null); continue; }
      const v = el.value.trim();
      if (v !== '') setPath(patch, f.path, v);
      continue;
    }
    if (f.type === 'number') {
      if (el.value.trim() === '') continue;
      setPath(patch, f.path, Number(el.value));
      continue;
    }
    // 没改过的内置文案不必存进配置：这样以后内置文案升级了，你这边也能跟着更新
    if (f.prefill && el.value === (state.helpDefaults?.[f.prefill] || '')) {
      setPath(patch, f.path, '');
      continue;
    }
    setPath(patch, f.path, el.value);
  }
  return patch;
}

function collectForm(name) {
  const spec = FORMS[name];
  const card = root.querySelector(`[data-form="${name}"]`);
  return collectFields(card, spec.fields);
}

/* ---------------- 评判渠道：抽屉式 ---------------- */

function providerFields(meta) {
  const fields = [];

  if (meta.protocols?.length) {
    fields.push({
      path: `judge.providers.${meta.id}.protocol`,
      label: '协议',
      type: 'select',
      options: meta.protocols.map((p) => ({
        value: p.id,
        label: p.installed ? p.label : `${p.label}（依赖未安装）`,
      })),
      hint: '按中转站兼容的协议选；换协议后模型 ID 一般也要跟着改',
    });
  }

  fields.push({
    path: `judge.providers.${meta.id}.apiKey`,
    label: 'API Key',
    type: 'secret',
    hint: meta.apiKeyEnv
      ? `也可以用环境变量 ${meta.apiKeyEnv}（留空即用环境变量）`
      : '第三方中转的密钥，填中转站给你的那个',
  });

  if (meta.supportsBaseURL) {
    fields.push({
      path: `judge.providers.${meta.id}.baseURL`,
      label: 'Base URL',
      type: 'text',
      placeholder: meta.requiresBaseURL ? '必填，例如 https://jev.example.com' : '留空使用官方地址',
    });
  }

  fields.push({
    path: `judge.providers.${meta.id}.model`,
    label: '模型 ID',
    type: 'text',
    placeholder: meta.modelExample || 'model-id',
  });
  return fields;
}

// 选了协议就顺手把该协议的默认模型填进模型框（用户自己改过则不动）
function protocolDefaults(meta) {
  const map = {};
  for (const p of meta.protocols || []) map[p.id] = p.defaultModel || '';
  return map;
}

function providerEntry(id) {
  return getValue(state.config || {}, `judge.providers.${id}`) || {};
}

function providerDot(meta, entry) {
  if (!meta.installed) return 'disabled';
  if (entry.apiKey || entry.apiKeySet) return 'connected';
  return 'unconfigured';
}

function drawerHtml(meta) {
  const entry = providerEntry(meta.id);
  const active = state.activeProvider === meta.id;
  const open = state.drawer === meta.id;
  const configured = !!(entry.apiKeySet || entry.apiKey) || !!entry.model;
  const tags = [
    active ? '<span class="tag on">使用中</span>' : '',
    !meta.installed ? '<span class="tag warn">依赖未安装</span>' : '',
    configured && !active ? '<span class="tag">已配置</span>' : '',
  ].join('');

  // 依赖缺失提示：带协议的渠道按协议分别提示，普通渠道提示它自己那个包
  const missing = meta.protocols?.length
    ? meta.protocols.filter((p) => !p.installed).map((p) => ({ label: p.label, pkg: p.pkg }))
    : meta.installed
      ? []
      : [{ label: meta.label, pkg: meta.pkg }];
  const currentProto = meta.protocols?.length
    ? meta.protocols.find((p) => p.id === (entry.protocol || meta.defaultProtocol))
    : null;
  // 整个渠道一个包都没有 → 不让保存；带协议的渠道只要有一种协议可用就允许保存
  const blocked = !meta.protocols?.length && !meta.installed;

  const body = open
    ? `<div class="drawer-body">
        ${missing.length
          ? `<div class="problems">${missing
              .map((m) => `「${esc(m.label)}」需要先安装依赖：<code>npm i ${esc(m.pkg)}</code>`)
              .join('<br>')}</div>`
          : ''}
        ${currentProto && !currentProto.installed
          ? `<div class="problems">当前选的协议依赖还没装：<code>npm i ${esc(currentProto.pkg)}</code>，先切到上面那个已装好的协议，或者装上再保存。</div>`
          : ''}
        <div class="sub">${esc(meta.note)}${meta.home ? ` · <a href="${esc(meta.home)}" target="_blank" rel="noreferrer">官方文档</a>` : ''}</div>
        ${providerFields(meta).map((f) => fieldHtml(f, state.config || {})).join('')}
        <div class="actions">
          <button class="primary" data-use-provider="${meta.id}" ${blocked ? 'disabled' : ''}>
            ${active ? '保存' : '保存并切换到该渠道'}
          </button>
          ${active ? '' : `<button data-save-provider="${meta.id}" ${blocked ? 'disabled' : ''}>仅保存</button>`}
        </div>
        <div class="hint">切换后立即生效，正在进行的游戏不受影响。</div>
      </div>`
    : '';

  return `<div class="drawer ${open ? 'open' : ''}" data-form="provider:${meta.id}">
    <button class="drawer-head" data-toggle="${meta.id}">
      <span class="chev">${open ? '▾' : '▸'}</span>
      <span class="dot ${providerDot(meta, entry)}"></span>
      <span class="drawer-title">${esc(meta.label)}${tags}</span>
      <span class="drawer-meta">${esc(entry.model || meta.defaultModel || '未设置模型')}</span>
    </button>
    ${body}
  </div>`;
}

function judgeHtml() {
  const r = state.judgeReadiness;
  const activeMeta = state.providers.find((p) => p.id === state.activeProvider);
  const statusLine = r?.ready
    ? `<span class="dot connected"></span>可用：${esc(r.meta?.label || state.activeProvider)}`
    : `<span class="dot unconfigured"></span>还不可用：${esc(r?.reason || '未配置')}`;
  const load = state.overview?.judge;

  return `${problemsHtml()}
    <div class="card">
      <h2>当前评判渠道</h2>
      <div class="sub">判断「是/不是」并计算与谜底的相似度。三个入口都走 AI SDK 同一套评判接口，切换时不需要重装任何东西。</div>
      <div class="chan">
        ${statusLine}
        <div class="detail">${esc(activeMeta?.note || '')}</div>
      </div>
      <div class="hint">${
        load?.active || load?.queued
          ? `正在评判 ${load.active} 条，排队 ${load.queued} 条（同时最多 8 条，各频道内串行）`
          : '当前没有正在评判的提问。同一频道内的提问会排队依次评判，规则和判定不受并发影响。'
      }</div>
      <div class="hint">下面点开任意一个渠道就能填它的密钥和模型；同一时间只用其中一个。</div>
    </div>

    <div class="card">
      <h2>可选的评判渠道</h2>
      <div class="sub">评判只用 Jev（System One 模型），不接普通 LLM。可用的入口：Vercel AI Gateway、TypeSafe 官方直连、以及第三方转发的 Jev。</div>
      ${state.providers.length ? state.providers.map(drawerHtml).join('') : '<div class="muted">加载中…</div>'}
    </div>

    <div class="card" data-form="judge-params">
      <h2>评判参数</h2>
      <div class="sub">对所有渠道都生效。</div>
      ${JUDGE_PARAMS.map((f) => fieldHtml(f, state.config || {})).join('')}
      <div class="actions"><button class="primary" data-save-params="1">保存参数</button></div>
    </div>`;
}

async function saveProvider(id, { activate = false } = {}) {
  const meta = state.providers.find((p) => p.id === id);
  if (!meta) return;
  const card = root.querySelector(`[data-form="provider:${id}"]`);
  if (!card) return;

  const patch = collectFields(card, providerFields(meta));
  const entry = patch.judge?.providers?.[id] || {};
  const current = providerEntry(id);
  const hasKey = entry.apiKey !== undefined && entry.apiKey !== null ? true : !!current.apiKeySet;

  if (!entry.model) return toast('请先填写模型 ID', 'bad');
  if (meta.requiresBaseURL && !entry.baseURL) return toast('这个渠道必须填写 Base URL', 'bad');
  if (activate) patch.judge.provider = id;

  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    state.config = r.config;
    state.problems = r.problems || [];
    state.activeProvider = r.config.judge.provider;
    state.drawer = id;
    await loadProviders();
    renderApp();
    toast(!hasKey && !current.apiKeySet ? '已保存，但还没有填 API Key' : r.note || '已保存');
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function saveJudgeParams() {
  const card = root.querySelector('[data-form="judge-params"]');
  const patch = collectFields(card, JUDGE_PARAMS);
  patch.judge = { ...patch.judge, provider: state.activeProvider };
  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    state.config = r.config;
    state.problems = r.problems || [];
    renderApp();
    toast('已保存');
  } catch (e) {
    toast(e.message, 'bad');
  }
}

/* ---------------- 主界面 ---------------- */

function tabBtn(id, label) {
  return `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${esc(label)}</button>`;
}

function header() {
  const v = state.info?.version ? `<span class="ver">v${esc(state.info.version)}</span>` : '';
  return `<header><div class="inner">
    <span class="logo">🐢 海龟汤机器人</span>${v}
    <span class="spacer"></span>
    <button class="ghost" id="logout">退出登录</button>
  </div>
  <nav>
    ${tabBtn('overview', '概览')}
    ${tabBtn('judge', '评判渠道')}
    ${tabBtn('discord', 'Discord')}
    ${tabBtn('napcat', 'QQ · NapCat')}
    ${tabBtn('official', 'QQ · 官方机器人')}
    ${tabBtn('questions', '题库')}
    ${tabBtn('admin', '后台服务')}
  </nav></header>`;
}

function problemsHtml() {
  if (!state.problems?.length) return '';
  return `<div class="problems">配置存在问题：<br>${state.problems.map(esc).join('<br>')}</div>`;
}

function overviewHtml() {
  const ov = state.overview;
  if (!ov) return '<div class="card">加载中…</div>';
  const names = { discord: 'Discord', napcat: 'QQ · NapCat（OneBot v11）', official: 'QQ · 官方机器人' };
  const chans = Object.entries(ov.channels || {}).map(([key, s]) => `
    <div class="chan">
      <span class="dot ${esc(s.state)}"></span>
      <div>
        <div class="name">${esc(names[key] || key)} <span class="tag">${esc(STATE_TEXT[s.state] || s.state)}</span></div>
        <div class="detail">${esc(s.detail || '')}</div>
      </div>
    </div>`).join('');

  return `${problemsHtml()}
    <div class="card">
      <h2>通道状态</h2>
      <div class="sub">配置保存后会自动按新配置重启对应通道。</div>
      ${chans}
      <div class="actions"><button id="reapply">重启所有通道</button>
        <span class="hint">最近一次应用：${ov.appliedAt ? esc(new Date(ov.appliedAt).toLocaleString('zh-CN')) : '—'}</span></div>
    </div>
    <div class="card">
      <h2>运行信息</h2>
      <div class="grid3">
        <div class="stat"><div class="k">题目数量</div><div class="v">${ov.questions}</div></div>
        <div class="stat"><div class="k">已运行</div><div class="v">${esc(fmtUptime(ov.uptime))}</div></div>
        <div class="stat"><div class="k">配置文件</div><div class="v" style="font-size:12px;word-break:break-all">${esc(ov.configFile || '')}</div></div>
      </div>
      <div class="hint" style="margin-top:12px">所有配置都存在这个 JSON 文件里，但正常使用不需要手动编辑它。</div>
    </div>`;
}

function questionsHtml() {
  const rows = state.questions.map((q) => {
    if (state.editingId === q.id) {
      return `<tr>
        <td>#${q.id}</td>
        <td colspan="2">
          <div class="field"><label>标题</label><input id="e_title" value="${esc(q.title)}"></div>
          <div class="field"><label>汤面</label><textarea id="e_puzzle">${esc(q.puzzle)}</textarea></div>
          <div class="field"><label>汤底</label><textarea id="e_answer">${esc(q.answer)}</textarea></div>
          <div class="actions">
            <button class="primary" data-qsave="${q.id}">保存</button>
            <button class="ghost" data-qcancel="1">取消</button>
          </div>
        </td></tr>`;
    }
    const puzzle = q.puzzle.length > 60 ? q.puzzle.slice(0, 60) + '…' : q.puzzle;
    return `<tr>
      <td>#${q.id}</td>
      <td><div>${esc(q.title)}</div><div class="muted">${esc(puzzle)}</div></td>
      <td style="white-space:nowrap">
        <button class="ghost" data-qedit="${q.id}">编辑</button>
        <button class="ghost danger" data-qdel="${q.id}">删除</button>
      </td></tr>`;
  }).join('');

  return `<div class="card">
      <h2>新增题目</h2>
      <div class="sub">标题可以留空，会自动编号。</div>
      <div class="field"><label>标题</label><input id="n_title" placeholder="例如：海龟汤"></div>
      <div class="field"><label>汤面</label><textarea id="n_puzzle" placeholder="给玩家看的题目描述"></textarea></div>
      <div class="field"><label>汤底</label><textarea id="n_answer" placeholder="完整谜底，用于评判相似度"></textarea></div>
      <div class="actions"><button class="primary" id="addq">添加题目</button></div>
    </div>

    <div class="card">
      <h2>题目列表 <span class="tag">共 ${state.questions.length} 题</span></h2>
      <div class="sub">出题按列表顺序循环；换题时玩家看到的是「汤面」。</div>
      <table><thead><tr><th style="width:60px">编号</th><th>题目</th><th style="width:130px">操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="muted">还没有题目</td></tr>'}</tbody></table>
      <div class="actions" style="margin-top:14px">
        <button id="exportq">导出 JSON</button>
      </div>
    </div>

    <div class="card">
      <h2>批量导入</h2>
      <div class="sub">粘贴 JSON 数组，或 { "questions": [ ... ] }，每条需要 puzzle 与 answer。</div>
      <textarea id="importq" placeholder='[{"title":"题目","puzzle":"汤面","answer":"汤底"}]'></textarea>
      <div class="actions"><button class="primary" id="doimport">导入</button></div>
    </div>`;
}

function renderApp() {
  state.screen = 'app';
  let body = '';
  if (state.tab === 'overview') body = overviewHtml();
  else if (state.tab === 'judge') body = judgeHtml();
  else if (state.tab === 'questions') body = questionsHtml();
  else body = problemsHtml() + formCard(state.tab);

  root.innerHTML = header() + `<div class="wrap">${body}</div>`;
  bindApp();
}

function bindApp() {
  document.getElementById('logout')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    state.token = '';
    localStorage.removeItem('turtle.adminToken');
    state.screen = 'login';
    renderLogin();
  });

  root.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      state.tab = el.dataset.tab;
      state.editingId = null;
      state.drawer = null;
      syncHash();
      renderApp();
      loadTabData();
    });
  });

  // 抽屉：同一时间只展开一个
  root.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.toggle;
      state.drawer = state.drawer === id ? null : id;
      syncHash();
      renderApp();
    });
  });

  root.querySelectorAll('[data-use-provider]').forEach((el) => {
    el.addEventListener('click', () => saveProvider(el.dataset.useProvider, { activate: true }));
  });
  root.querySelectorAll('[data-save-provider]').forEach((el) => {
    el.addEventListener('click', () => saveProvider(el.dataset.saveProvider, { activate: false }));
  });
  root.querySelectorAll('[data-save-params]').forEach((el) => {
    el.addEventListener('click', saveJudgeParams);
  });

  // 换协议时，把该协议的默认模型填进模型框（用户已经改过就不动）
  root.querySelectorAll('[data-select]').forEach((el) => {
    el.addEventListener('change', () => {
      const meta = state.providers.find((p) => `judge.providers.${p.id}.protocol` === el.dataset.select);
      if (!meta) return;
      const input = root.querySelector(`[data-field="judge.providers.${meta.id}.model"]`);
      const defaults = protocolDefaults(meta);
      if (!input) return;
      const current = input.value.trim();
      const known = Object.values(defaults).includes(current);
      if (current === '' || known) {
        input.value = defaults[el.value] || '';
        input.placeholder = defaults[el.value] || 'model-id';
      }
    });
  });

  root.querySelectorAll('[data-clear]').forEach((el) => {
    el.addEventListener('click', () => {
      const input = root.querySelector(`[data-field="${el.dataset.clear}"]`);
      if (!input) return;
      input.dataset.cleared = '1';
      input.value = '';
      input.placeholder = '保存后将清空';
      el.remove();
    });
  });

  root.querySelectorAll('[data-save]').forEach((el) => {
    el.addEventListener('click', async () => {
      const name = el.dataset.save;
      el.disabled = true;
      try {
        const patch = collectForm(name);
        const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
        state.config = r.config;
        state.problems = r.problems || [];
        toast(r.note || '已保存');
        renderApp();
      } catch (e) {
        toast(e.message, 'bad');
        el.disabled = false;
      }
    });
  });

  document.getElementById('reapply')?.addEventListener('click', async () => {
    try {
      await api('/api/runtime/apply', { method: 'POST' });
      toast('正在重启通道');
      setTimeout(loadOverview, 1200);
    } catch (e) { toast(e.message, 'bad'); }
  });

  document.getElementById('addq')?.addEventListener('click', async () => {
    const title = document.getElementById('n_title').value.trim();
    const puzzle = document.getElementById('n_puzzle').value.trim();
    const answer = document.getElementById('n_answer').value.trim();
    if (!puzzle || !answer) return toast('汤面和汤底都要填', 'bad');
    try {
      await api('/api/questions', { method: 'POST', body: JSON.stringify({ questions: [{ title, puzzle, answer }] }) });
      toast('已添加');
      await loadQuestions();
      renderApp();
    } catch (e) { toast(e.message, 'bad'); }
  });

  document.getElementById('doimport')?.addEventListener('click', async () => {
    const raw = document.getElementById('importq').value.trim();
    if (!raw) return toast('请先粘贴 JSON', 'bad');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return toast('JSON 解析失败：' + e.message, 'bad'); }
    try {
      const r = await api('/api/questions', { method: 'POST', body: JSON.stringify(parsed) });
      toast(`已导入 ${r.added} 题，当前共 ${r.total} 题`);
      await loadQuestions();
      renderApp();
    } catch (e) { toast(e.message, 'bad'); }
  });

  document.getElementById('exportq')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/questions/export', { headers: { 'X-Auth-Token': state.token } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'questions.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message, 'bad'); }
  });

  root.querySelectorAll('[data-qedit]').forEach((el) => {
    el.addEventListener('click', () => { state.editingId = Number(el.dataset.qedit); renderApp(); });
  });
  root.querySelectorAll('[data-qcancel]').forEach((el) => {
    el.addEventListener('click', () => { state.editingId = null; renderApp(); });
  });
  root.querySelectorAll('[data-qsave]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.qsave;
      const body = {
        title: document.getElementById('e_title').value,
        puzzle: document.getElementById('e_puzzle').value,
        answer: document.getElementById('e_answer').value,
      };
      try {
        await api('/api/questions/' + id, { method: 'PUT', body: JSON.stringify(body) });
        toast('已保存');
        state.editingId = null;
        await loadQuestions();
        renderApp();
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
  root.querySelectorAll('[data-qdel]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.qdel;
      if (!confirm(`确定删除 #${id} 这道题？`)) return;
      try {
        await api('/api/questions/' + id, { method: 'DELETE' });
        toast('已删除');
        await loadQuestions();
        renderApp();
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
}

/* ---------------- 数据加载 ---------------- */

async function loadOverview() {
  try {
    state.overview = await api('/api/overview');
    state.problems = state.overview.configProblems || [];
    if (state.tab === 'overview' && state.screen === 'app') renderApp();
  } catch (e) {
    if (e.status === 401) { state.screen = 'login'; renderLogin(); }
  }
}

async function loadQuestions() {
  const r = await api('/api/questions');
  state.questions = r.questions || [];
  state.overview = state.overview ? { ...state.overview, questions: r.count } : state.overview;
}

async function loadConfig() {
  const r = await api('/api/config');
  state.config = r.config;
  state.helpDefaults = r.helpDefaults || {};
  state.problems = r.problems || [];
}

async function loadProviders() {
  const r = await api('/api/judge/providers');
  state.providers = r.providers || [];
  state.activeProvider = r.active;
  state.judgeReadiness = r.readiness || null;
}

async function loadTabData() {
  try {
    if (state.tab === 'overview') await loadOverview();
    else if (state.tab === 'questions') await loadQuestions();
    else if (state.tab === 'judge') await Promise.all([loadConfig(), loadProviders()]);
    else await loadConfig();
    if (state.screen === 'app') renderApp();
  } catch (e) {
    if (e.status === 401) { renderLogin(); return; }
    toast(e.message, 'bad');
  }
}

async function enterApp() {
  readHash();
  await loadOverview();
  await loadConfig();
  if (state.tab === 'judge') await loadProviders();
  renderApp();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.screen === 'app' && state.tab === 'overview') loadOverview();
  }, 5000);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', onHashChange);
  }
}

function onHashChange() {
  if (state.screen !== 'app') return;
  const before = `${state.tab}/${state.drawer}`;
  readHash();
  if (`${state.tab}/${state.drawer}` === before) return;
  renderApp();
  loadTabData();
}

async function boot() {
  try {
    state.info = await api('/api/state');
  } catch (e) {
    root.innerHTML = `<div class="center"><div class="auth"><h1>无法连接后台服务</h1><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  if (state.info.needsSetup) return renderSetup();
  if (state.info.authenticated) return enterApp();
  renderLogin();
}

boot();
