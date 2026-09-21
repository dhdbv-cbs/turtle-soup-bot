// 入口：启动双平台机器人 + 后台管理 API
import express from 'express';
import { QuestionStore } from './game/QuestionStore.js';
import { JevJudge } from './game/JevJudge.js';
import { GameManager } from './game/GameManager.js';
import { CommandHandler } from './CommandHandler.js';
import { startDiscord } from './platforms/discord.js';
import { startQQ } from './platforms/onebot.js';
import { config, configProblems } from './config.js';
import { log, error, warn } from './utils/logger.js';

// 进程级兜底：任何漏网的异步异常都记录下来，而不是让机器人静默退出
process.on('unhandledRejection', (reason) => {
  error('未处理的 Promise 拒绝：', reason?.stack || String(reason));
});
process.on('uncaughtException', (e) => {
  error('未捕获异常：', e?.stack || String(e));
});

async function main() {
  // 0. 配置校验：非法值一律拒绝启动，避免"填错了但静默按默认值跑"
  if (configProblems.length > 0) {
    error('配置有误，已拒绝启动：');
    for (const p of configProblems) error(`  - ${p}`);
    error('请修正 .env 后重试。');
    process.exit(1);
  }

  log('========================================');
  log('  海龟汤机器人启动中…');
  log('========================================');

  // 1. 题目库
  const qs = new QuestionStore();
  await qs.load();
  if (qs.loadError) {
    warn('题目库当前为空，后台 API 与游戏仍可启动，但需要先导入题目。');
  }

  // 2. Jev 评判
  const judge = new JevJudge();

  // 3. 游戏管理器
  const gm = new GameManager(judge);

  // 4. 命令处理器
  const handler = new CommandHandler(gm, qs);

  // 5. 后台管理 API（导入题目）
  const { host: adminHost, port: adminPort, token: adminToken } = config.admin;
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // 简易鉴权中间件
  const auth = (req, res, next) => {
    if (adminToken && req.headers['x-admin-token'] !== adminToken) {
      return res.status(401).json({ error: '未授权' });
    }
    next();
  };

  // 列出题目
  app.get('/api/questions', (req, res) => {
    res.json({ count: qs.count, questions: qs.list() });
  });

  // 批量导入题目
  // body: { questions: [{title?, puzzle, answer}] } 或直接数组
  app.post('/api/questions', auth, async (req, res) => {
    try {
      const body = req.body;
      const items = Array.isArray(body) ? body : body?.questions;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: '请求体必须是题目数组，或 { questions: [...] }' });
      }
      const added = await qs.import(items);
      res.json({ ok: true, added, total: qs.count });
    } catch (e) {
      error('导入题目失败：', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, questions: qs.count, time: new Date().toISOString() });
  });

  // 只监听回环地址：默认不把无鉴权的写接口暴露到局域网
  const server = app.listen(adminPort, adminHost, () => {
    log(`后台管理 API 已启动：http://${adminHost}:${adminPort}`);
    log(`  GET  /api/questions        列出题目`);
    log(`  POST /api/questions        导入题目（需 X-Admin-Token）`);
    log(`  GET  /api/health           健康检查`);
    if (!adminToken) {
      warn('ADMIN_TOKEN 为空：任何能访问该端口的人都可以导入题目。建议在 .env 里设置一个令牌。');
    }
    if (adminHost !== '127.0.0.1' && adminHost !== 'localhost') {
      warn(`ADMIN_HOST=${adminHost} 监听的不是回环地址，请确认这是你想要的。`);
    }
  });

  // 6. 启动 Discord
  const discordClient = await startDiscord(handler);

  // 7. 启动 QQ
  const qqBot = startQQ(handler);

  log('----------------------------------------');
  log('启动完成。在 Discord 用「!汤 帮助」，在 QQ 用「#汤 帮助」查看命令。');
  log('========================================');

  // 优雅退出
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('正在关闭…');
    try {
      discordClient?.destroy();
    } catch {}
    try {
      qqBot?.close();
    } catch {}
    try {
      server.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  error('启动失败：', e?.stack || e?.message || String(e));
  process.exit(1);
});
