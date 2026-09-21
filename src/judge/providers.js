// 评判渠道登记表
//
// 结论（2026-09 调研）：目前提供 Jev 的平台有 3 个 ——
//   1. Vercel AI Gateway（typesafe-ai/jev，无需等待名单，本项目的默认渠道）
//   2. TypeSafe 官方直连（api.typesafe.ai，需要早期访问资格）
//   3. Netlify AI Gateway（只能在 Netlify Functions 里用，自建部署用不上）
// 另外 OpenAI / Anthropic / Google 也实现了 AI SDK 的 evaluation model 协议，
// 可以完成同样的「是/否 + 相似度」评判（只是模型不是 Jev）。
//
// 关键点：这些平台都走 AI SDK 同一套 Experimental_EvaluationModel 接口，
// 所以**不需要为每个平台写一套评判逻辑**，只需要在这里登记"怎么拿到模型实例"。
// 想加新平台时，只要它提供 evaluationModel() 工厂，往下面加一条即可。
//
// 注意：本模块刻意不 import config.js（config.js 反过来要用这里的默认值，
// 互相 import 会在模块初始化阶段踩到 TDZ），需要配置的地方由调用方传进来。
import { isPlaceholder } from '../utils/placeholder.js';

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
    note: 'TypeSafe 自家 API，模型名如 jev-latest；需要官方早期访问资格',
    home: 'https://docs.typesafe.ai',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    pkg: '@ai-sdk/openai',
    factory: 'createOpenAI',
    defaultModel: 'gpt-5.6-luna',
    modelExample: 'gpt-5.6-luna',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsBaseURL: true,
    note: '用 OpenAI 模型做同样的评判（不是 Jev，速度与成本不同）',
    home: 'https://ai-sdk.dev/docs/ai-sdk-core/evaluation',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    pkg: '@ai-sdk/anthropic',
    factory: 'createAnthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    modelExample: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    supportsBaseURL: true,
    note: '用 Claude 做同样的评判（不是 Jev）',
    home: 'https://ai-sdk.dev/docs/ai-sdk-core/evaluation',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    pkg: '@ai-sdk/google',
    factory: 'createGoogle',
    defaultModel: 'gemini-3.5-flash-lite',
    modelExample: 'gemini-3.5-flash-lite',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    supportsBaseURL: true,
    note: '用 Gemini 做同样的评判（不是 Jev）',
    home: 'https://ai-sdk.dev/docs/ai-sdk-core/evaluation',
  },
  {
    id: 'custom',
    label: '其他网关（自建 / 代理）',
    pkg: '@ai-sdk/gateway',
    factory: 'createGateway',
    defaultModel: '',
    modelExample: 'typesafe-ai/jev',
    requiresBaseURL: true,
    apiKeyOptional: true,
    supportsBaseURL: true,
    note: '任何兼容 AI Gateway evaluate 协议的自建/第三方网关，必须填 Base URL',
    home: 'https://vercel.com/docs/ai-gateway',
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

// 默认配置里的 providers 段（供 config.js 用，避免两处各写一份默认值）
export function defaultProviderEntries() {
  const out = {};
  for (const p of PROVIDERS) {
    out[p.id] = { apiKey: '', baseURL: '', model: p.defaultModel };
  }
  return out;
}

const factoryCache = new Map();

// 动态加载 provider 包；没装依赖时给出可操作的提示
export async function loadProviderFactory(id) {
  const meta = providerMeta(id);
  if (!meta) throw new Error(`未知的评判渠道：${id}`);

  if (factoryCache.has(meta.pkg)) return factoryCache.get(meta.pkg);

  const promise = import(meta.pkg)
    .then((mod) => {
      const factory = mod[meta.factory];
      if (typeof factory !== 'function') {
        throw new Error(`${meta.pkg} 里找不到 ${meta.factory}`);
      }
      return factory;
    })
    .catch(() => {
      factoryCache.delete(meta.pkg);
      throw new Error(`评判渠道「${meta.label}」需要先安装依赖：npm i ${meta.pkg}`);
    });

  factoryCache.set(meta.pkg, promise);
  return promise;
}

export async function providerInstalled(id) {
  try {
    await loadProviderFactory(id);
    return true;
  } catch {
    return false;
  }
}

// 后台界面用：每个渠道的依赖是否就绪
export async function installedMap() {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p.id, p.builtin ? true : await providerInstalled(p.id)]),
  );
  return Object.fromEntries(entries);
}

// 用某个渠道的配置构造 evaluation model 实例
export async function createEvaluationModel(id, entry) {
  const factory = await loadProviderFactory(id);
  const options = {};
  const apiKey = entry?.apiKey || '';
  const baseURL = entry?.baseURL || '';
  if (apiKey) options.apiKey = apiKey;
  if (baseURL) options.baseURL = baseURL;

  const instance = factory(options);
  if (typeof instance.evaluationModel !== 'function') {
    const meta = providerMeta(id);
    throw new Error(`评判渠道「${meta?.label ?? id}」不支持 evaluationModel（依赖版本过旧？）`);
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
  if (!entry.model) {
    return { ready: false, reason: `${meta.label} 还没有填写模型 ID` };
  }
  if (meta.requiresBaseURL && !entry.baseURL) {
    return { ready: false, reason: `${meta.label} 必须填写 Base URL` };
  }
  const envKey = meta.apiKeyEnv ? process.env[meta.apiKeyEnv] : '';
  if (!entry.apiKey && isPlaceholder(envKey) && !meta.apiKeyOptional) {
    return { ready: false, reason: `${meta.label} 还没有填写 API Key` };
  }

  return { ready: true, meta, entry };
}

// 当前渠道的签名，用于判断是否需要重建模型实例
export function judgeSignature(judgeConfig) {
  const entry = judgeConfig.providers?.[judgeConfig.provider] ?? {};
  return JSON.stringify([judgeConfig.provider, entry.apiKey, entry.baseURL, entry.model]);
}
