// 评判渠道登记表
//
// 本项目只评判「是/否 + 相似度」，只用 Jev 这类 System One 模型，不接普通 LLM。
// Jev 目前可用的入口：
//   1. Vercel AI Gateway（typesafe-ai/jev，无需等待名单，本项目的默认渠道）
//   2. TypeSafe 官方直连（api.typesafe.ai，需要早期访问资格）
//   3. 第三方转发：别人搭的 Jev 中转，自己填 Base URL 与密钥，协议看它兼容哪一种
//   （Netlify AI Gateway 也能用 Jev，但只能在 Netlify Functions 里跑，自建部署用不上）
//
// 这些入口都实现了 AI SDK 同一套 Experimental_EvaluationModel 接口
// （provider.evaluationModel(modelId)，返回的对象实现 doEvaluate），
// 所以**不需要为每个入口写一套评判逻辑**，这里只登记"怎么拿到模型实例"。
//
// 注意：本模块刻意不 import config.js（config.js 反过来要用这里的默认值，
// 互相 import 会在模块初始化阶段踩到 TDZ），需要配置的地方由调用方传进来。
import { isPlaceholder } from '../utils/strings.js';

export const PROVIDERS = [
  {
    id: 'gateway',
    label: 'Vercel AI Gateway',
    pkg: '@ai-sdk/gateway',
    factory: 'createGateway',
    builtin: true,
    defaultModel: 'typesafe-ai/jev',
    modelExample: 'typesafe-ai/jev',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    supportsBaseURL: true,
    note: '官方网关，内置依赖开箱可用，无需等待名单即可调用 Jev',
    home: 'https://vercel.com/docs/ai-gateway/modalities/evaluation',
  },
  {
    id: 'typesafe',
    label: 'TypeSafe 官方直连',
    pkg: '@ai-sdk/typesafe-ai',
    factory: 'createTypeSafeAi',
    defaultModel: 'jev-latest',
    modelExample: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    supportsBaseURL: true,
    note: 'TypeSafe 自家 API（api.typesafe.ai），模型名如 jev-latest；需要官方早期访问资格',
    home: 'https://docs.typesafe.ai',
  },
  {
    id: 'custom',
    label: '第三方转发（Jev）',
    // 中转站两种常见协议都支持，让用户选它兼容哪一种
    protocols: [
      {
        id: 'typesafe',
        label: 'TypeSafe 直连协议（api.typesafe.ai 风格）',
        pkg: '@ai-sdk/typesafe-ai',
        factory: 'createTypeSafeAi',
        defaultModel: 'jev-latest',
      },
      {
        id: 'gateway',
        label: 'AI Gateway 协议（/v4/ai 风格）',
        pkg: '@ai-sdk/gateway',
        factory: 'createGateway',
        builtin: true,
        defaultModel: 'typesafe-ai/jev',
      },
    ],
    defaultProtocol: 'typesafe',
    // 这个渠道早期只有 AI Gateway 一种协议，老配置没写协议名时沿用旧行为
    legacyProtocol: 'gateway',
    defaultModel: 'jev-latest',
    modelExample: 'jev-latest',
    requiresBaseURL: true,
    supportsBaseURL: true,
    note: '第三方中转的 Jev 服务：填它的 Base URL、密钥和模型名，协议选它兼容的那一种',
    home: 'https://docs.typesafe.ai',
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

// 把一个渠道（可能带多协议）拆成可用的目标：普通渠道只有一个目标
export function providerTargets(meta) {
  if (!meta) return [];
  if (meta.protocols?.length) return meta.protocols;
  return [
    {
      id: meta.id,
      label: meta.label,
      pkg: meta.pkg,
      factory: meta.factory,
      builtin: !!meta.builtin,
      defaultModel: meta.defaultModel,
      apiKeyEnv: meta.apiKeyEnv,
    },
  ];
}

// 当前配置实际会用哪个目标（渠道 + 协议）
export function resolveTarget(id, entry = {}) {
  const meta = providerMeta(id);
  if (!meta) throw new Error(`未知的评判渠道：${id}`);

  const targets = providerTargets(meta);
  const wanted = entry.protocol || meta.defaultProtocol || targets[0].id;
  const target = targets.find((t) => t.id === wanted);
  if (!target) {
    throw new Error(`${meta.label} 不支持协议「${wanted}」，可选：${targets.map((t) => t.id).join(' / ')}`);
  }
  return { meta, target, targets };
}

// 默认配置里的 providers 段（供 config.js 用，避免两处各写一份默认值）
export function defaultProviderEntries() {
  const out = {};
  for (const p of PROVIDERS) {
    const entry = { apiKey: '', baseURL: '', model: p.defaultModel };
    if (p.protocols?.length) entry.protocol = p.defaultProtocol;
    out[p.id] = entry;
  }
  return out;
}

const factoryCache = new Map();

// 动态加载 provider 包；没装依赖时给出可操作的提示
export async function loadProviderFactory(id, entry = {}) {
  const { target } = resolveTarget(id, entry);

  if (factoryCache.has(target.pkg)) return factoryCache.get(target.pkg);

  const promise = import(target.pkg)
    .then((mod) => {
      const factory = mod[target.factory];
      if (typeof factory !== 'function') {
        throw new Error(`${target.pkg} 里找不到 ${target.factory}`);
      }
      return factory;
    })
    .catch(() => {
      factoryCache.delete(target.pkg);
      throw new Error(`评判渠道「${target.label}」需要先安装依赖：npm i ${target.pkg}`);
    });

  factoryCache.set(target.pkg, promise);
  return promise;
}

export async function providerInstalled(id, entry = {}) {
  try {
    await loadProviderFactory(id, entry);
    return true;
  } catch {
    return false;
  }
}

// 后台界面用：每个渠道（以及渠道内的每种协议）依赖是否就绪
export async function installedMap() {
  const out = {};
  for (const p of PROVIDERS) {
    const protocolFlags = {};
    for (const t of providerTargets(p)) {
      protocolFlags[t.id] = t.builtin ? true : await providerInstalled(p.id, { protocol: t.id });
    }
    out[p.id] = {
      installed: Object.values(protocolFlags).some(Boolean),
      protocols: protocolFlags,
    };
  }
  return out;
}

// 用某个渠道的配置构造 evaluation model 实例
export async function createEvaluationModel(id, entry) {
  const { target } = resolveTarget(id, entry);
  const factory = await loadProviderFactory(id, entry);

  const options = {};
  const apiKey = entry?.apiKey || '';
  const baseURL = entry?.baseURL || '';
  if (apiKey) options.apiKey = apiKey;
  if (baseURL) options.baseURL = baseURL;

  const instance = factory(options);
  if (typeof instance.evaluationModel !== 'function') {
    throw new Error(`评判渠道「${target.label}」不支持 evaluationModel（依赖版本过旧？）`);
  }
  return instance.evaluationModel(entry.model);
}

// 当前渠道是否可用于评判；不可用时给出人话原因
export function judgeReadiness(judgeConfig) {
  const meta = providerMeta(judgeConfig.provider);
  if (!meta) {
    return { ready: false, reason: `未知的评判渠道：${judgeConfig.provider}` };
  }

  const entry = judgeConfig.providers?.[meta.id] ?? {};

  let target;
  try {
    ({ target } = resolveTarget(meta.id, entry));
  } catch (e) {
    return { ready: false, reason: e.message };
  }

  if (!entry.model) {
    return { ready: false, reason: `${meta.label} 还没有填写模型 ID` };
  }
  if (meta.requiresBaseURL && !entry.baseURL) {
    return { ready: false, reason: `${meta.label} 必须填写 Base URL` };
  }
  const envKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : '';
  if (!entry.apiKey && isPlaceholder(envKey) && !meta.apiKeyOptional) {
    return { ready: false, reason: `${meta.label} 还没有填写 API Key` };
  }

  return { ready: true, meta, target, entry };
}

// 当前渠道的签名，用于判断是否需要重建模型实例
export function judgeSignature(judgeConfig) {
  const entry = judgeConfig.providers?.[judgeConfig.provider] ?? {};
  return JSON.stringify([judgeConfig.provider, entry.protocol || '', entry.apiKey, entry.baseURL, entry.model]);
}
