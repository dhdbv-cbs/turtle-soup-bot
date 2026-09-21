// 集中配置层
// 关键点：本模块自己先 import 'dotenv/config'，因此任何 import 它的模块都能拿到
// 正确的环境变量，不再依赖 index.js 里 import 的书写顺序。
import 'dotenv/config';

// 启动期的配置问题（非法数值等）。由 index.js 统一打印并拒绝启动。
export const configProblems = [];

function problem(message) {
  configProblems.push(message);
}

function readString(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === '' ? fallback : value;
}

function readNumber(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    problem(`${name} 必须是数字，当前值：${JSON.stringify(raw)}（已回退为 ${fallback}）`);
    return fallback;
  }
  if (min !== undefined && value < min) {
    problem(`${name} 不能小于 ${min}，当前值：${value}（已回退为 ${fallback}）`);
    return fallback;
  }
  if (max !== undefined && value > max) {
    problem(`${name} 不能大于 ${max}，当前值：${value}（已回退为 ${fallback}）`);
    return fallback;
  }
  return value;
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  problem(`${name} 必须是布尔值（true/false），当前值：${JSON.stringify(raw)}（已回退为 ${fallback}）`);
  return fallback;
}

// .env 里的示例占位符（your-xxx）视为"未配置"
export function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  return v.startsWith('your-') || v.startsWith('your_');
}

export const config = {
  judge: {
    apiKey: readString('AI_GATEWAY_API_KEY'),
    model: readString('JEV_MODEL', 'typesafe-ai/jev'),
    // 与谜底相似度 >= 此值判定通关
    winThreshold: readNumber('WIN_THRESHOLD', 0.8, { min: 0, max: 1 }),
    // Jev 判定"是"的概率阈值
    yesThreshold: readNumber('YES_THRESHOLD', 0.5, { min: 0, max: 1 }),
  },
  discord: {
    enabled: readBoolean('DISCORD_ENABLED', true),
    token: readString('DISCORD_TOKEN'),
    prefix: readString('DISCORD_PREFIX', '!'),
  },
  qq: {
    enabled: readBoolean('QQ_ENABLED', true),
    wsUrl: readString('ONEBOT_WS_URL', 'ws://127.0.0.1:3001'),
    accessToken: readString('ONEBOT_ACCESS_TOKEN'),
    prefix: readString('QQ_PREFIX', '#'),
  },
  admin: {
    // 默认只监听回环地址：避免同局域网内任何人都能无鉴权灌题
    host: readString('ADMIN_HOST', '127.0.0.1'),
    port: readNumber('ADMIN_PORT', 4319, { min: 1, max: 65535 }),
    token: readString('ADMIN_TOKEN'),
  },
};
