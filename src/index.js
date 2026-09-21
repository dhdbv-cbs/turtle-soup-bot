// 入口：启动后台界面 + 三条消息通道
import { config, configProblems, hasPassword, loadConfig } from './config.js';
import { applyProxy } from './proxy.js';
import { QuestionStore } from './game/QuestionStore.js';
import { JevJudge } from './game/JevJudge.js';
import { GameManager } from './game/GameManager.js';
import { CommandHandler } from './CommandHandler.js';
import { BotRuntime } from './runtime.js';
import { createRestarter } from './restart.js';
import { judgeReadiness } from './judge/providers.js';
import { createAdminApp } from './web/server.js';
import { log, error, warn } from './utils/logger.js';

// 进程级兜底：任何漏网的异步异常都记录下来，而不是让机器人静默退出
process.on('unhandledRejection', (reason) => {
  error('未处理的 Promise 拒绝：', reason?.stack || String(reason));
});
process.on('uncaughtException', (e) => {
  error('未捕获异常：', e?.stack || String(e));
});

async function main() {
  log('========================================');
  log('  海龟汤机器人启动中…');
  log('========================================');

  // 1. 配置（首次运行会根据 .env / 默认值生成 data/config.json，之后都在后台界面里改）
  await loadConfig();
  for (const p of configProblems) warn(`配置：${p}`);

  // 1.5 出站代理：必须在任何通道/评判请求之前装好
  const proxy = applyProxy(config.proxy);
  if (proxy.active) {
    log(`出站代理已启用：${proxy.url}（不走代理：${proxy.bypass || '—'}）`);
  } else if (proxy.error) {
    warn(`代理没有生效：${proxy.error}`);
  }

  // 2. 题目库
  const questions = new QuestionStore();
  await questions.load();
  if (questions.loadError) {
    warn('题目库当前为空，请在后台界面里导入题目。');
  }

  // 3. 游戏
  const judge = new JevJudge();
  const games = new GameManager(judge);
  const handler = new CommandHandler(games, questions);

  // 4. 运行时（三条通道）
  const runtime = new BotRuntime(handler);

  // 5. 后台界面 + API
  const { host, port } = config.admin;
  let server = null; // 重启时要先放开它（否则新进程抢不到端口）

  // 起监听（函数声明会提升，所以可以先在重启器里引用；app 在下面才创建，调用时才有值）
  function listen() {
    return new Promise((resolve, reject) => {
      const s = app.listen(port, host, () => resolve(s));
      s.on('error', reject);
    });
  }

  // 进程重启：停通道 + 放开端口 → 拉新进程（有守护进程时只退出自己）→ 本进程退出
  const restarter = createRestarter({
    stop: async () => {
      await runtime.stopAll();
      const closing = server;
      server = null;
      if (!closing) return;
      await new Promise((resolve) => {
        closing.close(() => resolve());
        // 浏览器那边的 keep-alive 连接会拖住 close 的回调，直接掐掉
        closing.closeAllConnections?.();
        setTimeout(resolve, 1500).unref?.();
      });
    },
    // 新进程没起来：本进程恢复监听、连回通道，继续服务
    onFail: async () => {
      try {
        server = await listen();
        log(`新进程没起来，后台界面已在原进程恢复：http://${host}:${port}`);
      } catch (e) {
        error(`后台界面没能恢复：${e.message}`);
      }
      await runtime.apply();
    },
  });

  const app = createAdminApp({ runtime, questionStore: questions, games, restart: restarter });

  server = await listen().catch((e) => {
    error(`后台服务启动失败（${host}:${port}）：${e.message}`);
    process.exit(1);
  });

  log(`后台界面已启动：http://${host}:${port}`);
  if (!hasPassword()) {
    log('  首次使用：打开上面的地址，按提示设置一个后台密码');
  }

  // 6. 按配置连接各条通道
  await runtime.apply();

  // 7. 评判渠道没配好时提前提醒（游戏能开，但提问会失败）
  const judgeStatus = judgeReadiness(config.judge);
  if (!judgeStatus.ready) {
    warn(`评判渠道还没配好：${judgeStatus.reason}`);
    warn('  在后台界面「评判渠道」里填上密钥即可，保存后立即生效。');
  }

  log('----------------------------------------');
  log(`后台界面：http://${host}:${port}`);
  log('三个渠道统一用 /斜杠命令：/help 查看各自渠道的用法。');
  log('========================================');

  // 优雅退出
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('正在关闭…');
    try {
      await runtime.stopAll();
    } catch {}
    try {
      server?.close();
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
