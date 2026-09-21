// QQ 适配器：OneBot v11（配合 NapCat / Lagrange / LLOneBot）
//
// 注意：这里是"机器人主动连接 OneBot 的 WebSocket 服务端"（正向 WS）。
// 在 NapCat 里要开启「WebSocket 服务端」，地址填 ws://127.0.0.1:3001。
import WebSocket from 'ws';
import { config } from '../config.js';
import { formatAskResult } from './format.js';
import { log, error, warn } from '../utils/logger.js';

export function startOneBot(handler) {
  const { wsUrl: WS_URL, accessToken: ACCESS_TOKEN } = config.qq.napcat;

  const mention = (id, name) => (id ? `[CQ:at,qq=${id}]` : name || '玩家');
  const status = { state: 'connecting', detail: '正在连接…' };
  let stopped = false;
  let ws = null;
  let selfId = null; // 机器人 QQ 号
  let echoCounter = 0;
  let reconnectTimer = null;
  const pending = new Map(); // echo -> resolve

  function connect() {
    if (stopped) return;
    const headers = ACCESS_TOKEN ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {};
    ws = new WebSocket(WS_URL, { headers });

    ws.on('open', () => {
      status.state = 'connected';
      status.detail = `已连接 ${WS_URL}`;
      log(`QQ OneBot WebSocket 已连接：${WS_URL}`);
      // 获取机器人自身 QQ 号
      call('get_login_info', {})
        .then((info) => {
          if (info?.user_id) {
            selfId = String(info.user_id);
            status.detail = `已登录 QQ ${selfId}`;
            log(`QQ 机器人登录号：${selfId}（斜杠命令，如 /help）`);
          }
        })
        .catch(() => {});
    });

    ws.on('message', (raw) => {
      try {
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // API 调用响应
        if (data.echo && pending.has(data.echo)) {
          const resolve = pending.get(data.echo);
          pending.delete(data.echo);
          resolve(data.status === 'ok' ? data.data : null);
          return;
        }

        // 事件
        if (data.post_type === 'message') {
          handleMessage(data).catch((e) => error('QQ 消息处理失败：', e?.message || String(e)));
        }
      } catch (e) {
        error('QQ 消息解析异常：', e?.message || String(e));
      }
    });

    ws.on('close', () => {
      if (stopped) return;
      status.state = 'error';
      status.detail = `连接断开，5 秒后重连（${WS_URL}）`;
      warn('QQ OneBot WebSocket 断开，5 秒后重连…');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 5000);
    });

    ws.on('error', (e) => {
      status.detail = `连接错误：${e.message}`;
      warn('QQ OneBot WebSocket 错误：', e.message);
    });
  }

  // 调用 OneBot API
  function call(action, params) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve(null);
        return;
      }
      const echo = String(++echoCounter);
      pending.set(echo, resolve);
      ws.send(JSON.stringify({ action, params, echo }));
      // 超时 10 秒
      setTimeout(() => {
        if (pending.has(echo)) {
          pending.delete(echo);
          resolve(null);
        }
      }, 10000);
    });
  }

  async function handleMessage(evt) {
    const isGroup = evt.message_type === 'group';
    const isPrivate = evt.message_type === 'private';
    if (!isGroup && !isPrivate) return;

    const groupId = evt.group_id;
    const userId = evt.user_id;
    const userName = evt.sender?.card || evt.sender?.nickname || String(userId);
    const channelKey = isGroup ? `qq:${groupId}` : `qq:dm:${userId}`;

    // 从 message 数组提取纯文本，并检测是否 @机器人
    let plainText = '';
    let atBot = false;
    const segments = Array.isArray(evt.message) ? evt.message : [];
    for (const seg of segments) {
      if (seg.type === 'text') plainText += seg.data?.text || '';
      else if (seg.type === 'at') {
        const qq = String(seg.data?.qq || '');
        if (selfId && qq === selfId) atBot = true;
      }
    }
    // 兜底：用 raw_message
    if (!plainText && evt.raw_message) plainText = evt.raw_message;
    plainText = plainText.trim();

    // 群里没 @机器人 也不是命令，忽略
    const isCommand = plainText.startsWith('/');
    if (isGroup && !atBot && !isCommand) return;

    // 1) /斜杠命令
    if (isCommand) {
      const result = await handler.handle(channelKey, String(userId), userName, plainText, {
        platform: 'napcat',
      });
      if (!result) return;
      if (result.ask) {
        const { text } = formatAskResult(result.ask, { mention });
        await sendReply(evt, text);
        return;
      }
      await sendReply(evt, result.text);
      return;
    }

    // 2) 提问：群里需要 @机器人，私聊直接发就行
    const askText = plainText.trim();
    if (!askText) {
      await sendReply(evt, '你 @我 了但没说内容。用法：/help 查看命令，或 @我 + 你的问题。');
      return;
    }
    await sendReply(evt, '🤔 思考中…');
    const result = await handler.handleAsk(channelKey, String(userId), userName, askText);
    const { text } = formatAskResult(result, { mention });
    await sendReply(evt, text);
  }

  async function sendReply(evt, text) {
    if (!text) return;
    // QQ 单条消息建议不超过 2000 字符
    const chunks = splitLong(text, 1800);
    for (const chunk of chunks) {
      if (evt.message_type === 'group') {
        await call('send_group_msg', { group_id: evt.group_id, message: chunk });
      } else {
        await call('send_private_msg', { user_id: evt.user_id, message: chunk });
      }
      await sleep(300); // 避免发送过快
    }
  }

  connect();

  return {
    name: 'QQ（NapCat / OneBot v11）',
    status: () => ({ ...status }),
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
