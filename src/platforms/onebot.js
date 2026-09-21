// QQ 适配器：OneBot v11 反向 WebSocket（配合 NapCat / Lagrange / LLOneBot）
import WebSocket from 'ws';
import { config } from '../config.js';
import { log, error, warn } from '../utils/logger.js';

export function startQQ(handler) {
  const { enabled, wsUrl: WS_URL, accessToken: ACCESS_TOKEN, prefix: PREFIX } = config.qq;

  if (!enabled) {
    log('QQ 平台已禁用（QQ_ENABLED != true）');
    return null;
  }

  let ws = null;
  let selfId = null; // 机器人 QQ 号
  let echoCounter = 0;
  const pending = new Map(); // echo -> resolve

  function connect() {
    const headers = ACCESS_TOKEN ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {};
    ws = new WebSocket(WS_URL, { headers });

    ws.on('open', () => {
      log(`QQ OneBot WebSocket 已连接：${WS_URL}`);
      // 获取机器人自身 QQ 号
      call('get_login_info', {})
        .then((info) => {
          if (info?.user_id) {
            selfId = String(info.user_id);
            log(`QQ 机器人登录号：${selfId}（前缀 ${PREFIX}汤）`);
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
      warn('QQ OneBot WebSocket 断开，5 秒后重连…');
      setTimeout(connect, 5000);
    });

    ws.on('error', (e) => {
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
    if (isGroup && !atBot && !plainText.startsWith(PREFIX)) return;

    // 1) 前缀命令：#汤 ...
    if (plainText.startsWith(PREFIX)) {
      const result = await handler.handle(channelKey, String(userId), userName, plainText);
      if (result) await sendReply(evt, result.text);
      return;
    }

    // 2) @机器人 提问
    if (atBot) {
      const askText = plainText.trim();
      if (!askText) {
        await sendReply(evt, '你 @我 了但没说内容，把问题发给我吧。');
        return;
      }
      await sendReply(evt, '🤔 思考中…');
      const result = await handler.handleAsk(channelKey, String(userId), userName, askText);
      await sendReply(evt, formatAskResult(result));
    }
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
  return { call, close: () => ws?.close() };
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

// 只 @ 提问者/通关者本人，其余人不受打扰
function atOf(id, fallbackName) {
  return id ? `[CQ:at,qq=${id}]` : fallbackName || '玩家';
}

function formatAskResult(result) {
  if (!result) return '评判失败，请重试。';

  switch (result.type) {
    case 'win': {
      const names = [...new Set((result.history || []).map((h) => h.userName))];
      return (
        `🎉 通关！由 ${atOf(result.userId, result.userName)} 揭示谜底（相似度 ${(result.similarity * 100).toFixed(0)}%）\n\n` +
        `参与玩家（${result.participantCount} 人）：${names.join('、')}\n\n` +
        `【完整谜底】\n${result.question.answer}\n\n` +
        `用「汤 下一题」开始新的一局！`
      );
    }

    case 'answer': {
      return `${atOf(result.askerId, result.asker)}：${result.answer}（与谜底相似度 ${(result.similarity * 100).toFixed(0)}%）`;
    }

    case 'hint':
    default:
      return result.text || '无法处理该提问。';
  }
}
