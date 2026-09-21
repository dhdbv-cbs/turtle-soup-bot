// 出站代理测试：完全离线 —— 本机起一个假 HTTP 代理和目标服务，验证「评判用的 fetch、
// ws 连接、discord.js 网关用的 ws.WebSocket」真的都走了代理，且 bypass 列表里的地址直连。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在动态 import config 之前：清掉 .env 的影响，保证断言确定性
for (const key of ['PROXY_ENABLED', 'PROXY_URL', 'PROXY_USERNAME', 'PROXY_PASSWORD', 'PROXY_BYPASS']) {
  process.env[key] = '';
}
process.env.CONFIG_FILE = join(mkdtempSync(join(tmpdir(), 'turtle-proxy-')), 'config.json');

const { coerceConfig, publicConfig, loadConfig, updateConfig, SECRET_MASK, CONFIG_FILE } =
  await import('../src/config.js');
const {
  DEFAULT_BYPASS,
  normalizeProxyUrl,
  parseProxyUrl,
  bypassList,
  shouldBypassHost,
  applyProxy,
  proxySummary,
  proxyWebSocketAgent,
  proxyRestAgent,
  resetProxyForTests,
} = await import('../src/proxy.js');

const req = createRequire(import.meta.url);

/* ---------------- 假代理 + 目标服务 ---------------- */

let hits = []; // 每次经过代理都记一笔：'CONNECT host:port' / 'FORWARD host'

function startFakeProxy() {
  const server = http.createServer((clientReq, clientRes) => {
    // http 目标走绝对形式（GET http://host/path HTTP/1.1），不建隧道
    let target;
    try {
      target = new URL(clientReq.url);
    } catch {
      clientRes.writeHead(400);
      clientRes.end();
      return;
    }
    hits.push(`FORWARD ${target.host}`);
    const up = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: target.host },
      },
      (upRes) => {
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(clientRes);
      },
    );
    up.on('error', () => {
      clientRes.writeHead(502);
      clientRes.end();
    });
    clientReq.pipe(up);
  });

  server.on('connect', (connectReq, socket, head) => {
    hits.push(`CONNECT ${connectReq.url}`);
    const [host, port] = String(connectReq.url).split(':');
    const up = net.connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  return server;
}

const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));

function startApiServer() {
  return http.createServer((r, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: r.url }));
  });
}

function startWsEcho(server) {
  const { WebSocketServer } = req('ws');
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)));
  return wss;
}

// 自签证书（openssl 不在就跳过 TLS 用例）
function makeCert(dir) {
  const candidates = [
    process.env.OPENSSL_BIN,
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(
        bin,
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
          '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
          '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
        ],
        { stdio: 'ignore' },
      );
      return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

const proxyServer = startFakeProxy();
const proxyPort = await listen(proxyServer);
const apiServer = startApiServer();
const apiPort = await listen(apiServer);
const wsHttp = http.createServer();
const wsPort = await listen(wsHttp);
startWsEcho(wsHttp);
const certDir = mkdtempSync(join(tmpdir(), 'turtle-cert-'));
const tlsPair = makeCert(certDir);
let wssPort = 0;
let wssServer = null;
if (tlsPair) {
  wssServer = https.createServer({ key: tlsPair.key, cert: tlsPair.cert });
  wssPort = await listen(wssServer);
  startWsEcho(wssServer);
}

test.after(() => {
  resetProxyForTests();
  for (const s of [proxyServer, apiServer, wsHttp, wssServer]) s?.close();
});

const PROXY_URL = `http://127.0.0.1:${proxyPort}`;
// 本机地址故意不放进 bypass（默认 bypass 会把本机直连），这样本机目标也会走代理
const bypassOn = { enabled: true, url: PROXY_URL, bypass: 'example.com' };

/* ---------------- 纯函数 ---------------- */

test('代理地址解析：缺协议自动补 http://，非 HTTP 协议直接报错', () => {
  assert.equal(normalizeProxyUrl(' 127.0.0.1:7890 '), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl(''), '');
  assert.equal(parseProxyUrl('127.0.0.1:7890').hostname, '127.0.0.1');
  assert.equal(parseProxyUrl('https://proxy.local:8443').port, '8443');
  assert.throws(() => parseProxyUrl('socks5://127.0.0.1:7890'), /SOCKS5/);
  assert.throws(() => parseProxyUrl(''), /Invalid URL/);
});

test('bypass 列表：逗号/空格分隔，支持 *. 通配', () => {
  assert.deepEqual(bypassList(' localhost, 127.0.0.1 ,, ::1 '), ['localhost', '127.0.0.1', '::1']);
  assert.deepEqual(bypassList(undefined), []);
  const list = bypassList('localhost,*.internal,10.0.0.1');
  assert.equal(shouldBypassHost('localhost', list), true);
  assert.equal(shouldBypassHost('LOCALHOST', list), true);
  assert.equal(shouldBypassHost('db.internal', list), true);
  assert.equal(shouldBypassHost('notinternal', list), false);
  assert.equal(shouldBypassHost('10.0.0.1', list), true);
  assert.equal(shouldBypassHost('discord.com', list), false);
  assert.equal(shouldBypassHost('[::1]', bypassList('::1')), true);
  assert.equal(shouldBypassHost('example.com:443', bypassList('example.com')), true);
  assert.equal(shouldBypassHost('', list), false);
});

/* ---------------- 配置层 ---------------- */

test('配置里自带 proxy 段，默认关闭且默认绕过本机', () => {
  const problems = [];
  const cfg = coerceConfig({}, problems);
  assert.deepEqual(problems, []);
  assert.equal(cfg.proxy.enabled, false);
  assert.equal(cfg.proxy.url, 'http://127.0.0.1:7890');
  assert.equal(cfg.proxy.bypass, DEFAULT_BYPASS);
  assert.equal(cfg.proxy.password, '');
});

test('代理地址填错会被配置校验拦下', () => {
  const problems = [];
  const cfg = coerceConfig({ proxy: { enabled: true, url: 'socks5://127.0.0.1:7890' } }, problems);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /proxy\.url/);
  assert.match(problems[0], /SOCKS5/);
  assert.equal(cfg.proxy.enabled, true);
  assert.equal(cfg.proxy.url, 'socks5://127.0.0.1:7890');

  const p2 = [];
  coerceConfig({ proxy: { enabled: true, url: '   ' } }, p2);
  assert.equal(p2.length, 1);
  assert.match(p2[0], /proxy\.url/);
  const p3 = [];
  const cfg3 = coerceConfig({ proxy: { enabled: true, url: '127.0.0.1:7890' } }, p3);
  assert.deepEqual(p3, []);
  assert.equal(cfg3.proxy.url, 'http://127.0.0.1:7890');
});

test('后台看到的代理密码是掩码，PUT 保存时空密码不覆盖、null 才清空', async () => {
  await loadConfig();
  const r1 = await updateConfig({
    proxy: { enabled: true, url: 'http://127.0.0.1:7890', username: 'u', password: 'p@ss' },
  });
  assert.equal(r1.ok, true);
  assert.equal(publicConfig().proxy.password, SECRET_MASK);
  assert.equal(publicConfig().proxy.passwordSet, true);
  assert.equal(publicConfig().proxy.url, 'http://127.0.0.1:7890');
  assert.match(readFileSync(CONFIG_FILE, 'utf8'), /p@ss/);

  // 界面把掩码原样回传（或留空）时不能把密码冲掉
  const r2 = await updateConfig({ proxy: { enabled: true, url: 'http://127.0.0.1:7890', password: '' } });
  assert.equal(r2.ok, true);
  assert.equal(publicConfig().proxy.passwordSet, true);

  const r3 = await updateConfig({ proxy: { password: null } });
  assert.equal(r3.ok, true);
  assert.equal(publicConfig().proxy.passwordSet, false);
  assert.equal(publicConfig().proxy.password, '');
});

/* ---------------- 运行时：三条出站链路 ---------------- */

test('启用代理：fetch 走代理，关闭后自动还原', async () => {
  hits = [];
  const status = applyProxy(bypassOn);
  assert.equal(status.active, true);
  assert.equal(status.url, PROXY_URL);
  assert.equal(proxySummary().active, true);

  const res = await fetch(`http://127.0.0.1:${apiPort}/judge`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, path: '/judge' });
  // undici 的 ProxyAgent 即使是 http 目标也走 CONNECT
  assert.equal(hits.length, 1, `应该只经过代理一次，实际：${JSON.stringify(hits)}`);
  assert.match(hits[0], new RegExp(`CONNECT 127\\.0\\.0\\.1:${apiPort}`));

  applyProxy({ enabled: false, url: PROXY_URL, bypass: 'example.com' });
  assert.equal(proxySummary().active, false);
  hits = [];
  const direct = await fetch(`http://127.0.0.1:${apiPort}/direct`);
  assert.equal(direct.status, 200);
  assert.deepEqual(hits, [], '关掉代理后不该再经过代理');
});

test('bypass 列表里的地址直连，其余走代理', async () => {
  hits = [];
  applyProxy({ enabled: true, url: PROXY_URL, bypass: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${apiPort}/bypassed`);
  assert.equal(res.status, 200);
  assert.deepEqual(hits, [], 'bypass 命中的地址不该经过代理');
});

test('ws 连接：显式传 agent 才走代理（ws 自己不看 http(s).globalAgent）', async () => {
  const WebSocket = (await import('ws')).default;
  const url = `ws://127.0.0.1:${wsPort}`;

  // 先确认「不传 agent 就不走代理」，说明这个 agent 是必须的
  hits = [];
  applyProxy(bypassOn);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.close());
    ws.on('close', resolve);
    ws.on('error', reject);
  });
  assert.deepEqual(hits, [], 'ws 不会自动用 http.globalAgent');

  hits = [];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { agent: proxyWebSocketAgent(url) });
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => {
      assert.equal(m.toString(), 'echo:ping');
      ws.close();
    });
    ws.on('close', resolve);
    ws.on('error', reject);
  });
  assert.deepEqual(hits, [`CONNECT 127.0.0.1:${wsPort}`]);

  // 关掉代理后不再提供 agent
  applyProxy({ enabled: false, url: PROXY_URL });
  assert.equal(proxyWebSocketAgent(url), undefined);
});

test('discord.js 网关：被替换过的 ws.WebSocket 会自动注入 agent', async (t) => {
  if (!tlsPair) return t.skip('本机没有 openssl，跳过 wss 用例');
  const { WebSocket: PatchedWebSocket } = req('ws');
  assert.equal(typeof PatchedWebSocket, 'function');
  assert.notEqual(PatchedWebSocket, req('ws'), 'ws.WebSocket 应该已被代理补丁替换');

  hits = [];
  applyProxy(bypassOn);
  const url = `wss://localhost:${wssPort}`;
  const received = await new Promise((resolve, reject) => {
    const ws = new PatchedWebSocket(url, { ca: tlsPair.cert });
    ws.on('open', () => ws.send('gateway'));
    ws.on('message', (m) => {
      resolve(m.toString());
      ws.close();
    });
    ws.on('error', reject);
  });
  assert.equal(received, 'echo:gateway');
  assert.deepEqual(hits, [`CONNECT localhost:${wssPort}`]);

  // 关掉代理后，同一个类应该恢复成直连
  applyProxy({ enabled: false, url: PROXY_URL });
  hits = [];
  const direct = await new Promise((resolve, reject) => {
    const ws = new PatchedWebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.on('open', () => ws.send('again'));
    ws.on('message', (m) => {
      resolve(m.toString());
      ws.close();
    });
    ws.on('error', reject);
  });
  assert.equal(direct, 'echo:again');
  assert.deepEqual(hits, []);
});

test('discord.js 的 REST 拿得到 dispatcher，代理关掉时为 undefined', () => {
  applyProxy(bypassOn);
  assert.equal(typeof proxyRestAgent()?.dispatch, 'function');
  applyProxy({ enabled: false, url: PROXY_URL });
  assert.equal(proxyRestAgent(), undefined);
});

test('代理地址非法时不生效，但会给出提示且不影响直连', async () => {
  hits = [];
  const status = applyProxy({ enabled: true, url: 'socks5://127.0.0.1:7890' });
  assert.equal(status.enabled, true);
  assert.equal(status.active, false);
  assert.match(status.error, /SOCKS5/);
  assert.equal(proxyWebSocketAgent(`ws://127.0.0.1:${wsPort}`), undefined);
  const res = await fetch(`http://127.0.0.1:${apiPort}/still-works`);
  assert.equal(res.status, 200);
  assert.deepEqual(hits, []);
});

test('代理连不上时报错但不卡死', async () => {
  applyProxy({ enabled: true, url: 'http://127.0.0.1:1', bypass: '' });
  const t0 = Date.now();
  await assert.rejects(() => fetch(`http://127.0.0.1:${apiPort}/nope`));
  assert.ok(Date.now() - t0 < 5000, '应该很快失败，而不是等到超时');
  resetProxyForTests();
});

// 确保这个测试文件不会把代理状态留给别的用例
test('收尾：还原全局 dispatcher', () => {
  resetProxyForTests();
  assert.equal(proxySummary().active, false);
  assert.equal(proxySummary().enabled, false);
});
