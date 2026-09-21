// QQ 官方机器人开放平台适配器
//
// 协议要点（据官方文档 https://bot.q.qq.com/wiki/develop/api-v2/ ）：
//   1. POST https://bots.qq.com/app/getAppAccessToken  { appId, clientSecret } → { access_token, expires_in }
//      —— 失败时 HTTP 仍可能是 200，必须检查响应体里有没有 access_token
//   2. GET  {apiBase}/gateway  (Authorization: QQBot {access_token}) → { url }
//   3. WebSocket：op10 Hello → op2 Identify(token 格式 "QQBot {access_token}")
//      → 按 heartbeat_interval 发 op1 心跳，d 为最近一次收到的 s
//   4. 群/单聊消息必须"被动回复"：带 msg_id（事件里的 d.id）与递增的 msg_seq
//      群消息 5 分钟内最多回 5 条，单聊 60 分钟内最多回 4 条
import WebSocket from 'ws';
import { config } from '../config.js';
import { formatAskResult } from './format.js';
import { log, error, warn } from '../utils/logger.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = {
  sandbox: 'https://sandbox.api.sgroup.qq.com',
  production: 'https://api.sgroup.qq.com',
};

const INTENT_GUILDS = 1 << 0;
const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;

const CHUNK_SIZE = 900; // 官方对单条消息长度有限制，保守切分
const REPLY_BUDGET = { group: 4, c2c: 3, guild: 4 }; // 被动回复条数上限（留出余量）

export function startQqOfficial(handler) {
  const cfg = config.qq.official;
  const apiBase = cfg.sandbox ? API_BASE.sandbox : API_BASE.production;

  const status = { state: 'connecting', detail: '准备连接' };
  // 官方接口不支持 @ 语法，只能用昵称或占位名
  const mention = (_id, name) => name || '玩家';
  let stopped = false;
  let ws = null;
  let accessToken = '';
  let tokenExpireAt = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let lastSeq = null;
  let retry = 0;
  const replySeq = new Map(); // msg_id -> { seq, ts }

  // ---------- HTTP ----------

  async function getAccessToken(force = false) {
    if (!force && accessToken && Date.now() < tokenExpireAt - 60_000) return accessToken;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret }),
    });
    const data = await res.json().catch(() => ({}));

    // 失败时依然可能返回 200，所以以字段为准
    if (!data?.access_token) {
      const detail = data?.message || data?.code || `HTTP ${res.status}`;
      throw new Error(`获取 access_token 失败：${detail}`);
    }
    accessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 7200;
    tokenExpireAt = Date.now() + expiresIn * 1000;
    return accessToken;
  }

  async function apiFetch(path, init = {}) {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = data?.message || data?.code || text || `HTTP ${res.status}`;
      const err = new Error(`${path} 调用失败：${detail}`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  }

  async function getGatewayUrl() {
    const data = await apiFetch('/gateway');
    if (!data?.url) throw new Error('网关地址获取失败（响应里没有 url）');
    return data.url;
  }

  // ---------- 发送消息 ----------

  function nextSeq(msgId) {
    const now = Date.now();
    if (replySeq.size > 200) {
      for (const [key, value] of replySeq) {
        if (now - value.ts > 10 * 60_000) replySeq.delete(key);
      }
    }
    const entry = replySeq.get(msgId) || { seq: 0, ts: now };
    entry.seq += 1;
    entry.ts = now;
    replySeq.set(msgId, entry);
    return entry.seq;
  }

  async function send(target, content, msgId) {
    const path =
      target.kind === 'group'
        ? `/v2/groups/${target.id}/messages`
        : target.kind === 'c2c'
          ? `/v2/users/${target.id}/messages`
          : `/channels/${target.id}/messages`;

    const body = { content, msg_type: 0 };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = nextSeq(msgId);
    }

    try {
      await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
      return true;
    } catch (e) {
      // 40034128：被动回复时间/次数超限，属于可预期情况
      if (e.code === 40034128) {
        warn('QQ 官方机器人被动回复次数/时间超限，本条消息未发出');
      } else {
        error('QQ 官方机器人发送失败：', e.message);
      }
      return false;
    }
  }

  async function sendReply(target, text, msgId) {
    if (!text) return;
    const budget = REPLY_BUDGET[target.kind] ?? 4;
    const chunks = splitLong(text, CHUNK_SIZE).slice(0, budget);
    for (const chunk of chunks) {
      const ok = await send(target, chunk, msgId);
      if (!ok) break;
    }
  }

  // ---------- 网关 ----------

  function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function startHeartbeat(interval) {
    stopHeartbeat();
    const period = Math.max(5000, Number(interval) || 45000);
    heartbeatTimer = setInterval(() => wsSend({ op: 1, d: lastSeq }), period);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
    retry += 1;
    status.state = 'error';
    status.detail = `${status.detail}（${Math.round(delay / 1000)} 秒后重连）`;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function reconnectNow() {
    if (stopped) return;
    try {
      ws?.terminate();
    } catch {}
  }

  function identify() {
    const intents =
      INTENT_GROUP_AND_C2C |
      (cfg.guildMessages ? INTENT_PUBLIC_GUILD_MESSAGES | INTENT_GUILDS : 0);
    wsSend({
      op: 2,
      d: {
        token: `QQBot ${accessToken}`,
        intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'turtle-soup-bot', $device: 'turtle-soup-bot' },
      },
    });
    status.detail = '已发送鉴权，等待 Ready';
  }

  function onMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof payload?.s === 'number') lastSeq = payload.s;

    switch (payload?.op) {
      case 10: // Hello
        startHeartbeat(payload.d?.heartbeat_interval);
        identify();
        break;
      case 11: // 心跳 ACK
        break;
      case 1: // 服务端要求立刻心跳
        wsSend({ op: 1, d: lastSeq });
        break;
      case 7: // 要求重连
        reconnectNow();
        break;
      case 9: // 会话无效
        lastSeq = null;
        setTimeout(reconnectNow, 2000);
        break;
      case 0: // Dispatch
        handleDispatch(payload).catch((e) => error('QQ 官方机器人事件处理失败：', e?.message || String(e)));
        break;
      default:
        break;
    }
  }

  async function handleDispatch(payload) {
    const type = payload?.t;
    const d = payload?.d || {};

    switch (type) {
      case 'READY':
        retry = 0;
        status.state = 'connected';
        status.detail = `已登录：${d.user?.username || 'QQ 机器人'}`;
        log(`QQ 官方机器人已连接（${cfg.sandbox ? '沙箱' : '正式'}环境）`);
        return;

      case 'RESUMED':
        status.state = 'connected';
        return;

      case 'C2C_MESSAGE_CREATE':
        await handleMessage({
          target: { kind: 'c2c', id: d.author?.user_openid },
          userId: d.author?.user_openid,
          userName: displayName('私聊用户', d.author?.user_openid),
          content: d.content,
          msgId: d.id,
        });
        return;

      case 'GROUP_AT_MESSAGE_CREATE':
        await handleMessage({
          target: { kind: 'group', id: d.group_openid },
          userId: d.author?.member_openid,
          userName: displayName('群友', d.author?.member_openid),
          content: d.content,
          msgId: d.id,
        });
        return;

      case 'AT_MESSAGE_CREATE':
        await handleMessage({
          target: { kind: 'guild', id: d.channel_id },
          userId: d.author?.id,
          userName: d.author?.username || displayName('用户', d.author?.id),
          content: d.content,
          msgId: d.id,
        });
        return;

      default:
        return;
    }
  }

  // 官方接口不返回昵称，只能用 openid 尾部做个可区分的显示名
  function displayName(prefix, id) {
    const tail = String(id || '')
      .replace(/[^0-9a-zA-Z]/g, '')
      .slice(-4);
    return tail ? `${prefix}${tail}` : prefix;
  }

  async function handleMessage({ target, userId, userName, content, msgId }) {
    if (!target.id || !userId) return;

    const channelKey = `qq-official:${target.kind}:${target.id}`;
    const text = normalizeContent(content);
    if (!text) return;

    // 1) /斜杠命令
    if (text.startsWith('/')) {
      const result = await handler.handle(channelKey, userId, userName, text, {
        platform: 'official',
      });
      if (!result) return;
      if (result.ask) {
        const { text: reply } = formatAskResult(result.ask, { mention });
        await sendReply(target, reply, msgId);
        return;
      }
      await sendReply(target, result.text, msgId);
      return;
    }

    // 2) 提问（群里只有 @机器人 才会收到事件，单聊则直接就是提问）
    await sendReply(target, '🤔 思考中…', msgId);
    const result = await handler.handleAsk(channelKey, userId, userName, text);
    const { text: reply } = formatAskResult(result, { mention });
    await sendReply(target, reply, msgId);
  }

  // 有些客户端会带上 <@!xxx> 之类的标记
  function normalizeContent(content) {
    return String(content ?? '')
      .replace(/<@!?[^>]*>/g, '')
      .trim();
  }

  // ---------- 生命周期 ----------

  async function connect() {
    if (stopped) return;
    status.state = 'connecting';
    status.detail = '正在获取 access_token / 网关地址';
    try {
      const url = await getGatewayUrl();
      if (stopped) return;
      ws = new WebSocket(url);
      ws.on('open', () => {
        status.detail = '已连接网关，等待 Hello';
      });
      ws.on('message', onMessage);
      ws.on('error', (e) => {
        warn('QQ 官方机器人 WebSocket 错误：', e?.message || String(e));
      });
      ws.on('close', (code) => {
        stopHeartbeat();
        if (stopped) return;
        status.detail = `连接断开（code ${code}）`;
        scheduleReconnect();
      });
    } catch (e) {
      error('QQ 官方机器人连接失败：', e.message);
      status.detail = e.message;
      scheduleReconnect();
    }
  }

  connect();

  return {
    name: 'QQ 官方机器人',
    status: () => ({ ...status }),
    stop() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        ws?.close();
      } catch {}
      ws = null;
      status.state = 'stopped';
      status.detail = '已停止';
    },
  };
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}
