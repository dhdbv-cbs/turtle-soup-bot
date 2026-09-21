// 后台管理服务：登录 + 配置管理 + 题库管理 + 运行状态
import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE,
  config,
  configProblems,
  hasPassword,
  passwordMinLength,
  publicConfig,
  setPassword,
  updateConfig,
  verifyPassword,
} from '../config.js';
import { PROVIDERS, installedMap, judgeReadiness } from '../judge/providers.js';
import { error, log, warn } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// judgeReadiness 里带着渠道的原始配置（含明文密钥），对外只暴露必要字段
function publicJudgeStatus() {
  const r = judgeReadiness(config.judge);
  if (!r.ready) return { ready: false, reason: r.reason };
  return {
    ready: true,
    provider: config.judge.provider,
    label: r.meta?.label ?? '',
    note: r.meta?.note ?? '',
    model: r.entry?.model ?? '',
  };
}

// 并发情况：同时几个团体在玩时，能一眼看到有没有堆积
function judgeLoad(games) {
  if (!games) return { active: 0, queued: 0, channels: 0 };
  return {
    active: games.activeJudges,
    queued: games.pendingTotal(),
    channels: games.states.size,
  };
}

export function createAdminApp({ runtime, questionStore, games = null }) {
  const app = express();
  const sessions = new Map(); // token -> expiresAt
  const loginFailures = new Map(); // ip -> { count, since }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  function newSession() {
    const token = randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function sessionValid(token) {
    if (!token) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function tokenOf(req) {
    const header = req.get('x-auth-token');
    if (header) return header;
    const auth = req.get('authorization') || '';
    return auth.replace(/^Bearer\s+/i, '');
  }

  function auth(req, res, next) {
    if (!sessionValid(tokenOf(req))) {
      return res.status(401).json({ error: '未登录或登录已过期' });
    }
    next();
  }

  function tooManyFailures(ip) {
    const entry = loginFailures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
      loginFailures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  function noteFailure(ip) {
    const now = Date.now();
    const entry = loginFailures.get(ip);
    if (!entry || now - entry.since > LOGIN_WINDOW_MS) {
      loginFailures.set(ip, { count: 1, since: now });
      return;
    }
    entry.count += 1;
  }

  // ---------- 登录态 ----------

  app.get('/api/state', (req, res) => {
    res.json({
      needsSetup: !hasPassword(),
      authenticated: sessionValid(tokenOf(req)),
      passwordMinLength: passwordMinLength(),
      version: appVersion(),
    });
  });

  app.post('/api/setup', async (req, res) => {
    if (hasPassword()) return res.status(409).json({ error: '后台密码已经设置过了' });
    try {
      await setPassword(req.body?.password);
      log('后台密码已设置');
      res.json({ ok: true, token: newSession() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/login', (req, res) => {
    if (!hasPassword()) return res.status(409).json({ error: '尚未设置后台密码' });

    const ip = req.ip || 'unknown';
    if (tooManyFailures(ip)) {
      return res.status(429).json({ error: '尝试次数过多，请一分钟后再试' });
    }
    if (!verifyPassword(req.body?.password)) {
      noteFailure(ip);
      return res.status(401).json({ error: '密码不正确' });
    }
    loginFailures.delete(ip);
    res.json({ ok: true, token: newSession() });
  });

  app.post('/api/logout', auth, (req, res) => {
    sessions.delete(tokenOf(req));
    res.json({ ok: true });
  });

  // ---------- 运行状态 ----------

  app.get('/api/overview', auth, (req, res) => {
    res.json({
      version: appVersion(),
      uptime: Math.round(process.uptime()),
      configFile: CONFIG_FILE,
      configProblems,
      appliedAt: runtime.appliedAt,
      channels: runtime.status(),
      questions: questionStore.count,
      judge: { ...publicJudgeStatus(), ...judgeLoad(games) },
    });
  });

  // 评判渠道清单（含依赖是否已安装），后台界面用它渲染抽屉列表
  app.get('/api/judge/providers', auth, async (req, res) => {
    try {
      const installed = await installedMap();
      res.json({
        active: config.judge.provider,
        readiness: publicJudgeStatus(),
        providers: PROVIDERS.map((p) => ({
          id: p.id,
          label: p.label,
          pkg: p.pkg,
          defaultModel: p.defaultModel,
          modelExample: p.modelExample,
          apiKeyEnv: p.apiKeyEnv || '',
          note: p.note,
          home: p.home,
          requiresBaseURL: !!p.requiresBaseURL,
          apiKeyOptional: !!p.apiKeyOptional,
          supportsBaseURL: !!p.supportsBaseURL,
          installed: !!installed[p.id]?.installed,
          // 第三方转发这类渠道可以选协议（TypeSafe / AI Gateway）
          protocols: (p.protocols ?? []).map((t) => ({
            id: t.id,
            label: t.label,
            pkg: t.pkg,
            defaultModel: t.defaultModel,
            installed: !!installed[p.id]?.protocols?.[t.id],
          })),
          defaultProtocol: p.defaultProtocol || '',
        })),
      });
    } catch (e) {
      error('读取评判渠道失败：', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/runtime/apply', auth, (req, res) => {
    runtime.apply().catch((e) => error('通道重启失败：', e?.message || String(e)));
    res.json({ ok: true, channels: runtime.status() });
  });

  // ---------- 配置 ----------

  app.get('/api/config', auth, (req, res) => {
    res.json({ config: publicConfig(), problems: configProblems, configFile: CONFIG_FILE });
  });

  app.put('/api/config', auth, async (req, res) => {
    try {
      const result = await updateConfig(req.body || {});
      if (!result.ok) {
        return res.status(400).json({ ok: false, problems: result.problems, config: result.config });
      }
      // 配置变了就按新配置热重启通道，但不阻塞本次响应
      runtime.apply().catch((e) => error('通道热重启失败：', e?.message || String(e)));
      log('配置已更新，正在按新配置重启通道');
      res.json({
        ok: true,
        problems: [],
        config: result.config,
        note: '已保存，正在按新配置重启通道（监听地址与端口需重启进程才生效）',
      });
    } catch (e) {
      error('保存配置失败：', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 题库 ----------

  app.get('/api/questions', auth, (req, res) => {
    res.json({ count: questionStore.count, questions: questionStore.listAll() });
  });

  app.post('/api/questions', auth, async (req, res) => {
    try {
      const body = req.body;
      const items = Array.isArray(body) ? body : body?.questions;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: '请求体必须是题目数组，或 { questions: [...] }' });
      }
      const added = await questionStore.import(items);
      res.json({ ok: true, added, total: questionStore.count });
    } catch (e) {
      error('导入题目失败：', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/questions/:id', auth, async (req, res) => {
    try {
      const updated = await questionStore.update(req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: `没有找到 #${req.params.id} 题` });
      res.json({ ok: true, question: updated });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/questions/:id', auth, async (req, res) => {
    try {
      const ok = await questionStore.remove(req.params.id);
      if (!ok) return res.status(404).json({ error: `没有找到 #${req.params.id} 题` });
      res.json({ ok: true, total: questionStore.count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/questions/export', auth, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="questions.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(`${JSON.stringify(questionStore.listAll(), null, 2)}\n`);
  });

  // ---------- 静态界面 ----------

  app.use(express.static(PUBLIC_DIR));

  app.get('*', (req, res) => {
    // 未命中的 API 返回 JSON，不要回一个 HTML 页面
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: `接口不存在：${req.method} ${req.path}` });
    }
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  // 兜底错误处理，避免异常把请求挂死
  app.use((err, req, res, _next) => {
    warn('后台服务异常：', err?.message || String(err));
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  });

  return app;
}
