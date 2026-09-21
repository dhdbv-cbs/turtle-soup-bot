// 出站网络代理（HTTP / HTTPS 代理，走 CONNECT 隧道）
//
// 背景：Node 不会使用 Windows 的"系统代理"。浏览器能打开 Discord，机器人却直连失败
// （典型报错 connect ECONNREFUSED 127.0.0.1:443 —— 域名被 DNS 指回了本机）。
// 进程里有三条互相独立的出站链路，得分别接上；全部只用 Node 原生能力，不装第三方代理库：
//
//   1. fetch / undici.request（评判请求、QQ 官方机器人的 REST）
//      → setGlobalDispatcher(按目标分流的 ProxyAgent)。
//        实测 Node 内置的 fetch 也认这个：undici 把全局 dispatcher 挂在 globalThis 上
//        一个固定的 Symbol 上，npm 版 undici 与 Node 内置的那份共享它。
//   2. discord.js 的 REST
//      → @discordjs/rest 支持 agent（一个 undici dispatcher），由适配器显式传入。
//   3. WebSocket（ws 包：Discord 网关、NapCat、QQ 官方网关）
//      → ws 会自己塞 opts.createConnection = net.connect / tls.connect，既不看
//        http(s).globalAgent，也没有全局开关；但它认显式传入的 agent。
//        · 本项目自己的适配器：显式传 agent（proxyWebSocketAgent）
//        · discord.js 的网关：@discordjs/ws 连 agent 选项都不开放（只传 handshakeTimeout），
//          所以这里在它加载之前替换 ws 导出的 WebSocket 类，由子类注入 agent。
//          proxy.js 被 config.js 首先引入，早于 runtime.js → platforms/discord.js，顺序有保证。
//
// 只支持 HTTP/HTTPS 代理；SOCKS5 不在 Node 原生能力范围内（要连 SOCKS5 请改用 TUN 模式）。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { Agent, Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { warn } from './utils/logger.js';

// 默认不走代理的地址：本机（NapCat 一般就装在本机，不该绕出去）
export const DEFAULT_BYPASS = 'localhost,127.0.0.1,::1,0.0.0.0';

// 进程启动时的原始 dispatcher：关掉代理时要原样还回去
const ORIGINAL_DISPATCHER = getGlobalDispatcher();

let installed = null; // { dispatcher, proxyDispatcher, directDispatcher, wsAgent, wssAgent }
let lastStatus = { enabled: false, active: false, url: '', bypass: '', error: null };

/* ---------------- 纯函数（config.js 校验时也要用，所以不依赖 config） ---------------- */

// 允许只填 127.0.0.1:7890，自动补 http://
export function normalizeProxyUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

export function parseProxyUrl(raw) {
  const url = new URL(normalizeProxyUrl(raw));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只支持 HTTP/HTTPS 代理，不支持 ${url.protocol}//（SOCKS5 请改用 TUN 模式）`);
  }
  if (!url.hostname) throw new Error('代理地址缺少主机名');
  return url;
}

// 归一化主机名：去掉方括号与端口，注意 IPv6（::1）本身就有冒号，不能当端口切
export function normalizeHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (bracketed) return bracketed[1];
  const first = h.indexOf(':');
  if (first !== -1 && h.indexOf(':', first + 1) === -1 && /^\d+$/.test(h.slice(first + 1))) {
    return h.slice(0, first);
  }
  return h;
}

export function bypassList(raw) {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((s) => normalizeHost(s))
    .filter(Boolean);
}

// 支持精确匹配与 *.example.com 通配
export function shouldBypassHost(host, list) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const item of list) {
    if (item === h) return true;
    if (item.startsWith('*.') && (h === item.slice(2) || h.endsWith(item.slice(1)))) return true;
  }
  return false;
}

/* ---------------- CONNECT 隧道 ---------------- */

function proxyAuthHeader({ username, password } = {}) {
  const user = String(username ?? '').trim();
  const pass = String(password ?? '');
  if (!user && !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

// 给「连代理本身」用的普通 agent，避免递归走我们自己的隧道 agent
const PLAIN_HTTP_AGENT = new http.Agent({ keepAlive: false });
const PLAIN_HTTPS_AGENT = new https.Agent({ keepAlive: false });

function connectThroughProxy(proxyUrl, host, port, authHeader, cb) {
  const secureProxy = proxyUrl.protocol === 'https:';
  const mod = secureProxy ? https : http;
  const req = mod.request({
    host: proxyUrl.hostname,
    port: proxyUrl.port || (secureProxy ? 443 : 80),
    method: 'CONNECT',
    path: `${host}:${port}`,
    headers: {
      host: `${host}:${port}`,
      ...(authHeader ? { 'proxy-authorization': authHeader } : {}),
    },
    agent: secureProxy ? PLAIN_HTTPS_AGENT : PLAIN_HTTP_AGENT,
    setHost: false,
    timeout: 20000,
  });

  const fail = (e) => cb(e instanceof Error ? e : new Error(String(e)));
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      fail(new Error(`代理拒绝 CONNECT ${host}:${port}（HTTP ${res.statusCode}）`));
      return;
    }
    cb(null, socket);
  });
  req.once('error', fail);
  req.once('timeout', () => req.destroy(new Error(`连接代理 ${proxyUrl.host} 超时`)));
  req.end();
}

function isIpLiteral(host) {
  return net.isIP(String(host ?? '').replace(/^\[|\]$/g, '')) !== 0;
}

// 只有这些 TLS 选项会透传给 tls.connect（避免把 path / agent 之类带进去）
const TLS_KEYS = [
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'rejectUnauthorized',
  'checkServerIdentity',
  'ALPNProtocols',
  'minVersion',
  'maxVersion',
  'ciphers',
  'secureProtocol',
  'session',
  'secureContext',
];

function tlsOptionsFrom(options, servername) {
  const out = {};
  for (const k of TLS_KEYS) if (options[k] !== undefined) out[k] = options[k];
  // SNI 不能用 IP 字面量
  if (servername && !isIpLiteral(servername)) out.servername = servername;
  return out;
}

// 明文目标（ws:// 等）
class TunnelHttpAgent extends http.Agent {
  #cfg;

  constructor(cfg = {}) {
    super({ keepAlive: true, maxSockets: cfg.maxSockets ?? 64 });
    this.#cfg = cfg;
  }

  createConnection(options, cb) {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 80;
    if (!this.#cfg.proxyUrl || shouldBypassHost(host, this.#cfg.bypass ?? [])) {
      return net.connect({ host, port, family: options.family, localAddress: options.localAddress });
    }
    connectThroughProxy(this.#cfg.proxyUrl, host, port, this.#cfg.auth, (err, socket) => {
      if (err) return cb(err);
      cb(null, socket);
    });
    return undefined;
  }
}

// TLS 目标（wss:// 等）
class TunnelHttpsAgent extends https.Agent {
  #cfg;

  constructor(cfg = {}) {
    super({ keepAlive: true, maxSockets: cfg.maxSockets ?? 64 });
    this.#cfg = cfg;
  }

  createConnection(options, cb) {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    const tlsOpts = tlsOptionsFrom(options, options.servername || host);

    if (!this.#cfg.proxyUrl || shouldBypassHost(host, this.#cfg.bypass ?? [])) {
      return tls.connect({ ...tlsOpts, host, port });
    }
    connectThroughProxy(this.#cfg.proxyUrl, host, port, this.#cfg.auth, (err, socket) => {
      if (err) return cb(err);
      cb(null, tls.connect({ ...tlsOpts, socket }));
    });
    return undefined;
  }
}

/* ---------------- undici：按目标决定走代理还是直连 ---------------- */

class RoutingDispatcher extends Dispatcher {
  #proxy;
  #direct;
  #bypass;

  constructor({ proxyDispatcher, directDispatcher, bypass }) {
    super();
    this.#proxy = proxyDispatcher;
    this.#direct = directDispatcher;
    this.#bypass = bypass;
  }

  dispatch(opts, handler) {
    let host = '';
    try {
      host = new URL(opts.origin).hostname;
    } catch {
      host = '';
    }
    const target = shouldBypassHost(host, this.#bypass) ? this.#direct : this.#proxy;
    return target.dispatch(opts, handler);
  }

  close() {
    return Promise.allSettled([this.#proxy.close(), this.#direct.close()]).then(() => {});
  }

  destroy(err) {
    return Promise.allSettled([this.#proxy.destroy(err), this.#direct.destroy(err)]).then(() => {});
  }
}

/* ---------------- ws 的 WebSocket 类注入（给 discord.js 的网关用） ---------------- */

let wsPatch = 'pending';

function patchWsWebSocket() {
  const req = createRequire(import.meta.url);
  let ws;
  try {
    ws = req('ws');
  } catch {
    wsPatch = 'missing';
    return;
  }
  const Original = ws?.WebSocket;
  if (typeof Original !== 'function') {
    wsPatch = 'missing';
    return;
  }
  // @discordjs/ws 若已经加载，它手里握着的还是旧类，补丁就晚了
  const tooLate = Object.keys(req.cache ?? {}).some((p) => /@discordjs[\\/]ws/.test(p));

  class ProxyAwareWebSocket extends Original {
    constructor(address, protocols, options) {
      // 复刻 ws 构造函数的参数归一化，再决定要不要注入 agent
      if (protocols === undefined) {
        protocols = [];
        options = {};
      } else if (typeof protocols === 'object' && protocols !== null) {
        options = protocols;
        protocols = [];
      }
      const opts = { ...(options ?? {}) };
      if (opts.agent === undefined || opts.agent === null) {
        const agent = proxyWebSocketAgent(address);
        if (agent) opts.agent = agent;
      }
      super(address, protocols, opts);
    }
  }
  ws.WebSocket = ProxyAwareWebSocket;
  wsPatch = tooLate ? 'late' : 'ok';
}

patchWsWebSocket();

/* ---------------- 对外接口 ---------------- */

function teardown() {
  setGlobalDispatcher(ORIGINAL_DISPATCHER);
  const old = installed;
  installed = null;
  if (!old) return;
  try {
    old.wsAgent.destroy();
    old.wssAgent.destroy();
  } catch {}
  Promise.resolve(old.dispatcher.close()).catch(() => {});
}

// 按配置安装/卸载代理；可重复调用（每次保存配置后都会调用）
export function applyProxy(proxyConfig = {}) {
  const enabled = !!proxyConfig?.enabled;
  const rawUrl = String(proxyConfig?.url ?? '').trim();
  // 留空 = 所有地址都走代理（默认值由配置层填，界面里清空才有这个效果）
  const bypass = bypassList(proxyConfig?.bypass ?? DEFAULT_BYPASS);

  if (!enabled || !rawUrl) {
    teardown();
    lastStatus = { enabled, active: false, url: rawUrl, bypass: bypass.join(', '), error: null };
    return lastStatus;
  }

  let proxyUrl;
  try {
    proxyUrl = parseProxyUrl(rawUrl);
  } catch (e) {
    teardown();
    lastStatus = { enabled: true, active: false, url: rawUrl, bypass: bypass.join(', '), error: e.message };
    warn(`代理未生效：${e.message}`);
    return lastStatus;
  }

  teardown();

  const auth = proxyAuthHeader(proxyConfig);
  const proxyDispatcher = new ProxyAgent({ uri: proxyUrl.href, ...(auth ? { token: auth } : {}) });
  const directDispatcher = new Agent();
  const dispatcher = new RoutingDispatcher({ proxyDispatcher, directDispatcher, bypass });
  const agentCfg = { proxyUrl, auth, bypass };

  // 1) fetch（含 Node 内置 fetch）与 undici.request
  setGlobalDispatcher(dispatcher);

  // 2) 给 ws 用的隧道 agent
  installed = {
    dispatcher,
    proxyDispatcher,
    directDispatcher,
    wsAgent: new TunnelHttpAgent(agentCfg),
    wssAgent: new TunnelHttpsAgent(agentCfg),
  };

  if (wsPatch === 'late') {
    warn('Discord 网关的代理注入晚了（@discordjs/ws 已加载），网关可能仍然直连');
  }

  lastStatus = {
    enabled: true,
    active: true,
    url: proxyUrl.href.replace(/\/$/, ''),
    bypass: bypass.join(', '),
    error: null,
  };
  return lastStatus;
}

// 给 ws 用的 agent：地址是 wss:// 就用 TLS 版本，ws:// 用明文版本
// （代理没启用时返回 undefined，ws 就按原来的方式直连）
export function proxyWebSocketAgent(address) {
  if (!installed) return undefined;
  let protocol = '';
  try {
    protocol = new URL(String(address)).protocol;
  } catch {
    return undefined;
  }
  if (protocol === 'wss:' || protocol === 'https:') return installed.wssAgent;
  if (protocol === 'ws:' || protocol === 'http:') return installed.wsAgent;
  return undefined;
}

// 给 @discordjs/rest 用的 dispatcher（discord.js 的 REST 不看全局 dispatcher）
export function proxyRestAgent() {
  return installed?.dispatcher;
}

// 供后台概览页显示（最后一次 applyProxy 的结果）
export function proxySummary() {
  return { ...lastStatus };
}

// 只给测试用：还原回进程初始状态
export function resetProxyForTests() {
  teardown();
  lastStatus = { enabled: false, active: false, url: '', bypass: '', error: null };
}
