// 运行时：按当前配置启停三条消息通道，并支持保存配置后热重启
//
// 通道：
//   discord  —— Discord 机器人
//   napcat   —— QQ（NapCat / OneBot v11，正向 WebSocket）
//   official —— QQ 官方机器人开放平台
import { config } from './config.js';
import { startDiscord } from './platforms/discord.js';
import { startOneBot } from './platforms/onebot.js';
import { startQqOfficial } from './platforms/qq-official.js';
import { log, warn } from './utils/logger.js';

const CHANNELS = ['discord', 'napcat', 'official'];

export class BotRuntime {
  // factories 可注入，便于测试
  constructor(handler, { factories = {} } = {}) {
    this.handler = handler;
    this.factories = {
      discord: factories.discord || startDiscord,
      napcat: factories.napcat || startOneBot,
      official: factories.official || startQqOfficial,
    };
    this.adapters = { discord: null, napcat: null, official: null };
    this.signatures = { discord: '', napcat: '', official: '' };
    this.queue = Promise.resolve();
    this.appliedAt = null;
  }

  // 串行化，避免并发 apply 造成重复启动
  apply() {
    this.queue = this.queue.then(
      () => this.#applyNow(),
      () => this.#applyNow(),
    );
    return this.queue;
  }

  async #applyNow() {
    for (const channel of CHANNELS) {
      try {
        await this.#sync(channel);
      } catch (e) {
        warn(`[${channel}] 通道启动失败：`, e?.message || String(e));
      }
    }
    this.appliedAt = new Date().toISOString();
  }

  async #sync(channel) {
    const plan = this.plan(channel);

    if (!plan.wanted) {
      await this.#stop(channel);
      this.signatures[channel] = '';
      return;
    }

    const running = this.adapters[channel];
    if (running && this.signatures[channel] === plan.signature) return; // 配置没变，保持现有连接

    await this.#stop(channel);
    const adapter = await this.factories[channel](this.handler);
    this.adapters[channel] = adapter || null;
    this.signatures[channel] = plan.signature;
    if (adapter) log(`[${channel}] 通道已启动：${adapter.name}`);
  }

  async #stop(channel) {
    const adapter = this.adapters[channel];
    if (!adapter) return;
    try {
      await adapter.stop();
    } catch (e) {
      warn(`[${channel}] 停止失败：`, e?.message || String(e));
    }
    this.adapters[channel] = null;
    log(`[${channel}] 通道已停止`);
  }

  async stopAll() {
    for (const channel of CHANNELS) {
      await this.#stop(channel);
      this.signatures[channel] = '';
    }
  }

  // 某个通道是否需要启动 / 为什么没启动
  plan(channel) {
    if (channel === 'discord') {
      const c = config.discord;
      if (!c.enabled) return { wanted: false, reason: '未启用', signature: '' };
      if (!c.token) return { wanted: false, reason: '缺少 Bot Token', signature: '' };
      return {
        wanted: true,
        reason: '',
        signature: JSON.stringify({ token: c.token }),
      };
    }

    if (channel === 'napcat') {
      const c = config.qq.napcat;
      if (!c.enabled) return { wanted: false, reason: '未启用', signature: '' };
      if (!c.wsUrl) return { wanted: false, reason: '缺少 WebSocket 地址', signature: '' };
      return {
        wanted: true,
        reason: '',
        signature: JSON.stringify({ wsUrl: c.wsUrl, accessToken: c.accessToken }),
      };
    }

    if (channel === 'official') {
      const c = config.qq.official;
      if (!c.enabled) return { wanted: false, reason: '未启用', signature: '' };
      const missing = [];
      if (!c.appId) missing.push('AppID');
      if (!c.appSecret) missing.push('AppSecret');
      if (missing.length) {
        return { wanted: false, reason: `缺少 ${missing.join(' / ')}`, signature: '' };
      }
      return {
        wanted: true,
        reason: '',
        signature: JSON.stringify({
          appId: c.appId,
          appSecret: c.appSecret,
          sandbox: c.sandbox,
          guildMessages: c.guildMessages,
        }),
      };
    }

    throw new Error(`未知通道：${channel}`);
  }

  status() {
    const out = {};
    for (const channel of CHANNELS) {
      const plan = this.plan(channel);
      if (!plan.wanted) {
        const enabled = this.#isEnabled(channel);
        out[channel] = {
          state: enabled ? 'unconfigured' : 'disabled',
          detail: plan.reason,
        };
        continue;
      }
      const adapter = this.adapters[channel];
      out[channel] = adapter ? adapter.status() : { state: 'stopped', detail: '未启动' };
    }
    return out;
  }

  #isEnabled(channel) {
    if (channel === 'discord') return config.discord.enabled;
    if (channel === 'napcat') return config.qq.napcat.enabled;
    return config.qq.official.enabled;
  }
}
