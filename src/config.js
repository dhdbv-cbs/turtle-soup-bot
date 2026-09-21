// 配置中心
//
// 目标：用户不需要手工编辑配置文件，所有配置都在后台界面里改。
// - 运行时配置持久化在 data/config.json（首次运行若存在 .env 则用它做种子，兼容老用户）
// - 密钥字段对外只输出掩码，明文只在服务端内存与磁盘上
// - 保存前统一校验，非法值直接拒绝并给出原因
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_IDS, defaultProviderEntries, providerMeta } from './judge/providers.js';
import { isPlaceholder, stripBom } from './utils/strings.js';
import { error, log, warn } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG_FILE = process.env.CONFIG_FILE
  ? process.env.CONFIG_FILE
  : join(__dirname, '..', 'data', 'config.json');

// 密钥字段对外返回这个占位符
export const SECRET_MASK = '••••••••';

export function defaultConfig() {
  return {
    admin: {
      host: '127.0.0.1',
      port: 4319,
      passwordHash: null,
      passwordSalt: null,
    },
    judge: {
      // 当前使用的评判渠道 + 每个渠道各自一份凭据，切换时不用重新填
      provider: 'gateway',
      providers: defaultProviderEntries(),
      winThreshold: 0.8,
      yesThreshold: 0.5,
    },
    discord: {
      enabled: false,
      token: '',
      // 留空则用内置的渠道说明；填了就替换掉 /help 的正文
      helpText: '',
    },
    qq: {
      napcat: {
        enabled: false,
        wsUrl: 'ws://127.0.0.1:3001',
        accessToken: '',
        helpText: '',
      },
      official: {
        enabled: false,
        appId: '',
        appSecret: '',
        sandbox: true,
        // 是否额外订阅频道（子频道）@消息，需要机器人有公域消息权限
        guildMessages: false,
        helpText: '',
      },
    },
  };
}

// 进程内唯一的配置对象，其它模块直接读它
export const config = defaultConfig();
export const configProblems = [];

let source = 'defaults'; // defaults | env | file

export function configSource() {
  return source;
}

// ============ 小工具 ============

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// .env 里的示例占位符（your-xxx）视为"未配置"
export { isPlaceholder };

// ============ 校验与归一化 ============

function makeCoercer(problems, prefix = '') {
  const path = (key) => (prefix ? `${prefix}.${key}` : key);

  return {
    str(value, fallback, key) {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'string') {
        problems.push(`${path(key)} 必须是字符串`);
        return fallback;
      }
      const v = value.trim();
      return v === '' ? fallback : v;
    },
    num(value, fallback, key, min, max) {
      if (value === undefined || value === null || value === '') return fallback;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        problems.push(`${path(key)} 必须是数字，当前值：${JSON.stringify(value)}`);
        return fallback;
      }
      if (min !== undefined && n < min) {
        problems.push(`${path(key)} 不能小于 ${min}，当前值：${n}`);
        return fallback;
      }
      if (max !== undefined && n > max) {
        problems.push(`${path(key)} 不能大于 ${max}，当前值：${n}`);
        return fallback;
      }
      return n;
    },
    bool(value, fallback, key) {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value === 'boolean') return value;
      const v = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
      problems.push(`${path(key)} 必须是布尔值（true/false），当前值：${JSON.stringify(value)}`);
      return fallback;
    },
  };
}

// 把任意输入归一化成一份完整合法的配置
export function coerceConfig(raw, problems = []) {
  const def = defaultConfig();
  const out = defaultConfig();
  const r = isPlainObject(raw) ? raw : {};
  const c = makeCoercer(problems);

  // admin
  const a = isPlainObject(r.admin) ? r.admin : {};
  out.admin.host = c.str(a.host, def.admin.host, 'admin.host');
  out.admin.port = c.num(a.port, def.admin.port, 'admin.port', 1, 65535);
  out.admin.passwordHash = typeof a.passwordHash === 'string' && a.passwordHash ? a.passwordHash : null;
  out.admin.passwordSalt = typeof a.passwordSalt === 'string' && a.passwordSalt ? a.passwordSalt : null;
  if ((out.admin.passwordHash === null) !== (out.admin.passwordSalt === null)) {
    problems.push('admin 密码数据不完整，已重置为未设置密码');
    out.admin.passwordHash = null;
    out.admin.passwordSalt = null;
  }

  // judge：当前渠道 + 每个渠道各一份配置
  const j = isPlainObject(r.judge) ? r.judge : {};
  // 兼容旧配置（judge.apiKey / judge.model）与 .env 种子：迁移到 gateway 渠道
  const legacyKey = typeof j.apiKey === 'string' ? j.apiKey.trim() : '';
  const legacyModel = typeof j.model === 'string' ? j.model.trim() : '';
  const rp = isPlainObject(j.providers) ? j.providers : {};
  for (const id of PROVIDER_IDS) {
    const src = isPlainObject(rp[id]) ? rp[id] : {};
    const isGateway = id === 'gateway';
    const fallbackKey = isGateway ? legacyKey : '';
    const fallbackModel = isGateway && legacyModel ? legacyModel : def.judge.providers[id].model;
    const entry = out.judge.providers[id];
    entry.apiKey = c.str(src.apiKey, fallbackKey, `judge.providers.${id}.apiKey`) ?? '';
    entry.baseURL = c.str(src.baseURL, '', `judge.providers.${id}.baseURL`) ?? '';
    entry.model = c.str(src.model, fallbackModel, `judge.providers.${id}.model`) ?? '';
    if (entry.baseURL && !/^https?:\/\//i.test(entry.baseURL)) {
      problems.push(`judge.providers.${id}.baseURL 必须以 http:// 或 https:// 开头`);
      entry.baseURL = '';
    }

    // 带多协议的渠道（第三方转发）：校验协议名
    const meta = providerMeta(id);
    if (meta?.protocols?.length) {
      const allowed = meta.protocols.map((p) => p.id);
      // 老配置里的第三方转发走的是 AI Gateway 协议，没写协议名时按老行为迁移
      const fallback = src.baseURL && !src.protocol ? meta.legacyProtocol || meta.defaultProtocol : meta.defaultProtocol;
      const wanted = typeof src.protocol === 'string' && src.protocol ? src.protocol : fallback;
      if (!allowed.includes(wanted)) {
        problems.push(`judge.providers.${id}.protocol 只能是 ${allowed.join(' / ')}，当前值：${wanted}`);
        entry.protocol = meta.defaultProtocol;
      } else {
        entry.protocol = wanted;
        // 协议跟着换时，模型默认值也跟着换（用户自己填过就不动）
        const pDef = meta.protocols.find((p) => p.id === wanted);
        if (!src.model && pDef?.defaultModel) entry.model = pDef.defaultModel;
      }
    }
  }
  const wantedProvider = c.str(j.provider, def.judge.provider, 'judge.provider');
  if (!PROVIDER_IDS.includes(wantedProvider)) {
    problems.push(`judge.provider 只能是 ${PROVIDER_IDS.join(' / ')}，当前值：${wantedProvider}`);
    out.judge.provider = def.judge.provider;
  } else {
    out.judge.provider = wantedProvider;
  }
  // 只有正在使用的渠道才强制要求 Base URL，没在用的渠道留空不算错
  const activeMeta = providerMeta(out.judge.provider);
  if (activeMeta?.requiresBaseURL && !out.judge.providers[out.judge.provider].baseURL) {
    problems.push(`judge.providers.${out.judge.provider} 必须填写 Base URL`);
  }
  out.judge.winThreshold = c.num(j.winThreshold, def.judge.winThreshold, 'judge.winThreshold', 0, 1);
  out.judge.yesThreshold = c.num(j.yesThreshold, def.judge.yesThreshold, 'judge.yesThreshold', 0, 1);

  // discord
  const d = isPlainObject(r.discord) ? r.discord : {};
  out.discord.enabled = c.bool(d.enabled, def.discord.enabled, 'discord.enabled');
  out.discord.token = c.str(d.token, '', 'discord.token') ?? '';
  out.discord.helpText = c.str(d.helpText, '', 'discord.helpText') ?? '';

  // qq.napcat
  const qq = isPlainObject(r.qq) ? r.qq : {};
  const n = isPlainObject(qq.napcat) ? qq.napcat : {};
  out.qq.napcat.enabled = c.bool(n.enabled, def.qq.napcat.enabled, 'qq.napcat.enabled');
  out.qq.napcat.wsUrl = c.str(n.wsUrl, def.qq.napcat.wsUrl, 'qq.napcat.wsUrl');
  out.qq.napcat.accessToken = c.str(n.accessToken, '', 'qq.napcat.accessToken') ?? '';
  out.qq.napcat.helpText = c.str(n.helpText, '', 'qq.napcat.helpText') ?? '';
  if (!/^wss?:\/\//i.test(out.qq.napcat.wsUrl)) {
    problems.push('qq.napcat.wsUrl 必须以 ws:// 或 wss:// 开头');
    out.qq.napcat.wsUrl = def.qq.napcat.wsUrl;
  }

  // qq.official
  const o = isPlainObject(qq.official) ? qq.official : {};
  out.qq.official.enabled = c.bool(o.enabled, def.qq.official.enabled, 'qq.official.enabled');
  out.qq.official.appId = c.str(o.appId, '', 'qq.official.appId') ?? '';
  out.qq.official.appSecret = c.str(o.appSecret, '', 'qq.official.appSecret') ?? '';
  out.qq.official.sandbox = c.bool(o.sandbox, def.qq.official.sandbox, 'qq.official.sandbox');
  out.qq.official.guildMessages = c.bool(
    o.guildMessages,
    def.qq.official.guildMessages,
    'qq.official.guildMessages',
  );
  out.qq.official.helpText = c.str(o.helpText, '', 'qq.official.helpText') ?? '';

  return out;
}

// ============ .env 种子（仅首次运行、且没有 config.json 时使用） ============

function seedFromEnv() {
  const str = (name) => {
    const v = process.env[name];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  const bool = (name) => {
    const v = str(name);
    if (v === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  };
  const num = (name) => {
    const v = str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const secret = (name) => {
    const v = str(name);
    return isPlaceholder(v) ? undefined : v;
  };

  const problems = [];
  const raw = {
    admin: { host: str('ADMIN_HOST'), port: num('ADMIN_PORT') },
    judge: {
      // 旧的环境变量名保持可用：AI_GATEWAY_API_KEY / JEV_MODEL → gateway 渠道
      apiKey: secret('AI_GATEWAY_API_KEY'),
      model: str('JEV_MODEL'),
      winThreshold: num('WIN_THRESHOLD'),
      yesThreshold: num('YES_THRESHOLD'),
      providers: {
        gateway: { apiKey: secret('AI_GATEWAY_API_KEY'), model: str('JEV_MODEL') },
        typesafe: { apiKey: secret('TYPESAFE_API_KEY') },
      },
      provider: str('JUDGE_PROVIDER'),
    },
    discord: {
      enabled: bool('DISCORD_ENABLED'),
      token: secret('DISCORD_TOKEN'),
    },
    qq: {
      napcat: {
        enabled: bool('QQ_ENABLED'),
        wsUrl: str('ONEBOT_WS_URL'),
        accessToken: secret('ONEBOT_ACCESS_TOKEN'),
      },
      official: {
        enabled: bool('QQ_OFFICIAL_ENABLED'),
        appId: secret('QQ_BOT_APPID'),
        appSecret: secret('QQ_BOT_SECRET'),
        sandbox: bool('QQ_BOT_SANDBOX'),
      },
    },
  };

  // 只保留 .env 里真正填写过的字段，其余走默认值
  return { seed: coerceConfig(stripUndefined(raw), problems), problems };
}

// 递归去掉 undefined，避免覆盖 coerce 里的默认值
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const cleaned = stripUndefined(v);
    if (cleaned === undefined) continue;
    if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0) continue;
    out[k] = cleaned;
  }
  return out;
}

// ============ 读写 ============

// 写盘同样串行化 + 临时文件名唯一：两个标签页同时保存配置时，
// 固定临时文件名会互相顶掉，后一个 rename 会 ENOENT 报错
let saveChain = Promise.resolve();
let saveSeq = 0;

export async function saveConfig() {
  const run = saveChain.then(
    () => writeConfigNow(),
    () => writeConfigNow(),
  );
  saveChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function writeConfigNow() {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${++saveSeq}`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmp, CONFIG_FILE);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function loadConfig() {
  configProblems.length = 0;

  if (existsSync(CONFIG_FILE)) {
    let raw;
    try {
      // 记事本等编辑器会写 UTF-8 BOM，这里先去掉，别当成"配置损坏"
      raw = JSON.parse(stripBom(await readFile(CONFIG_FILE, 'utf8')));
    } catch (e) {
      const backup = `${CONFIG_FILE}.corrupt-${Date.now()}.bak`;
      try {
        await writeFile(backup, await readFile(CONFIG_FILE, 'utf8'), 'utf8');
      } catch {}
      error(`配置文件解析失败：${e.message}`);
      error(`原文件已备份到 ${backup}`);
      configProblems.push(`配置文件解析失败：${e.message}`);
      Object.assign(config, defaultConfig());
      return config;
    }
    const problems = [];
    const coerced = coerceConfig(raw, problems);
    Object.assign(config, coerced);
    configProblems.push(...problems);
    source = 'file';
    log(`配置已从 ${CONFIG_FILE} 载入`);
    for (const p of problems) warn(`  - ${p}`);
    return config;
  }

  // 首次运行：用 .env 做种子（如果有），并立即落盘
  const { seed, problems } = seedFromEnv();
  Object.assign(config, seed);
  source = 'env';
  configProblems.push(...problems);
  await saveConfig();
  log(`首次运行：已根据 .env / 默认值生成配置文件 ${CONFIG_FILE}`);
  return config;
}

// 生成对外可见的配置视图：密钥一律掩码
export function publicConfig() {
  const c = config;
  return {
    source,
    admin: {
      host: c.admin.host,
      port: c.admin.port,
      hasPassword: hasPassword(),
    },
    judge: {
      provider: c.judge.provider,
      winThreshold: c.judge.winThreshold,
      yesThreshold: c.judge.yesThreshold,
      // 每个渠道一份掩码，明文只在服务端
      providers: Object.fromEntries(
        PROVIDER_IDS.map((id) => {
          const entry = c.judge.providers[id] ?? {};
          const meta = providerMeta(id);
          const view = {
            apiKey: entry.apiKey ? SECRET_MASK : '',
            apiKeySet: !!entry.apiKey,
            baseURL: entry.baseURL || '',
            model: entry.model || '',
          };
          if (meta?.protocols?.length) view.protocol = entry.protocol || meta.defaultProtocol;
          return [id, view];
        }),
      ),
    },
    discord: {
      enabled: c.discord.enabled,
      helpText: c.discord.helpText,
      token: c.discord.token ? SECRET_MASK : '',
      tokenSet: !!c.discord.token,
    },
    qq: {
      napcat: {
        enabled: c.qq.napcat.enabled,
        wsUrl: c.qq.napcat.wsUrl,
        helpText: c.qq.napcat.helpText,
        accessToken: c.qq.napcat.accessToken ? SECRET_MASK : '',
        accessTokenSet: !!c.qq.napcat.accessToken,
      },
      official: {
        enabled: c.qq.official.enabled,
        appId: c.qq.official.appId,
        sandbox: c.qq.official.sandbox,
        helpText: c.qq.official.helpText,
        guildMessages: c.qq.official.guildMessages,
        appSecret: c.qq.official.appSecret ? SECRET_MASK : '',
        appSecretSet: !!c.qq.official.appSecret,
      },
    },
  };
}

// 应用一次局部更新（来自后台界面）
export async function updateConfig(patch) {
  if (!isPlainObject(patch)) throw new Error('patch 必须是对象');

  const next = JSON.parse(JSON.stringify(config));
  const p = patch;

  // 密钥字段：缺省或空串 => 保持原值；null => 清空；否则设置
  const applySecret = (target, key, value) => {
    if (value === null) {
      target[key] = '';
      return;
    }
    if (value === undefined || String(value) === '') return;
    target[key] = String(value);
  };

  applySecret(next.discord, 'token', p.discord?.token);
  applySecret(next.qq.napcat, 'accessToken', p.qq?.napcat?.accessToken);
  applySecret(next.qq.official, 'appSecret', p.qq?.official?.appSecret);

  // judge 的每个渠道各有一份 apiKey，语义同样是"留空保持、null 清空"
  for (const id of PROVIDER_IDS) {
    const incoming = p.judge?.providers?.[id];
    if (!isPlainObject(incoming) || !isPlainObject(next.judge.providers[id])) continue;
    applySecret(next.judge.providers[id], 'apiKey', incoming.apiKey);
  }

  // 普通字段：直接覆盖
  const set = (target, key, value) => {
    if (value !== undefined) target[key] = value;
  };
  set(next.admin, 'host', p.admin?.host);
  set(next.admin, 'port', p.admin?.port);

  set(next.judge, 'provider', p.judge?.provider);
  set(next.judge, 'winThreshold', p.judge?.winThreshold);
  set(next.judge, 'yesThreshold', p.judge?.yesThreshold);
  for (const id of PROVIDER_IDS) {
    const incoming = p.judge?.providers?.[id];
    if (!isPlainObject(incoming) || !isPlainObject(next.judge.providers[id])) continue;
    set(next.judge.providers[id], 'model', incoming.model);
    set(next.judge.providers[id], 'baseURL', incoming.baseURL);
    set(next.judge.providers[id], 'protocol', incoming.protocol);
  }

  set(next.discord, 'enabled', p.discord?.enabled);
  set(next.discord, 'helpText', p.discord?.helpText);

  set(next.qq.napcat, 'enabled', p.qq?.napcat?.enabled);
  set(next.qq.napcat, 'wsUrl', p.qq?.napcat?.wsUrl);
  set(next.qq.napcat, 'helpText', p.qq?.napcat?.helpText);

  set(next.qq.official, 'enabled', p.qq?.official?.enabled);
  set(next.qq.official, 'appId', p.qq?.official?.appId);
  set(next.qq.official, 'sandbox', p.qq?.official?.sandbox);
  set(next.qq.official, 'guildMessages', p.qq?.official?.guildMessages);
  set(next.qq.official, 'helpText', p.qq?.official?.helpText);

  const problems = [];
  const coerced = coerceConfig(next, problems);
  // 密码相关只由 setPassword 修改，避免被 patch 覆盖
  coerced.admin.passwordHash = next.admin.passwordHash;
  coerced.admin.passwordSalt = next.admin.passwordSalt;

  if (problems.length > 0) {
    return { ok: false, problems, config: publicConfig() };
  }

  Object.assign(config, coerced);
  await saveConfig();
  return { ok: true, problems: [], config: publicConfig() };
}

// ============ 后台密码 ============

const MIN_PASSWORD_LENGTH = 6;

export function hasPassword() {
  return !!(config.admin.passwordHash && config.admin.passwordSalt);
}

export function passwordMinLength() {
  return MIN_PASSWORD_LENGTH;
}

export async function setPassword(password) {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const salt = randomBytes(16).toString('hex');
  config.admin.passwordSalt = salt;
  config.admin.passwordHash = scryptSync(pw, salt, 64).toString('hex');
  await saveConfig();
}

export function verifyPassword(password) {
  if (!hasPassword()) return false;
  const expected = Buffer.from(config.admin.passwordHash, 'hex');
  const actual = scryptSync(String(password ?? ''), config.admin.passwordSalt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
