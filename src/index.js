// 入口：启动后台界面 + 三条消息通道
import { config, configProblems, hasPassword, loadConfig } from './config.js';
import { QuestionStore } from './game/QuestionStore.js';
import { JevJudge } from './game/JevJudge.js';
import { GameManager } from './game/GameManager.js';
import { CommandHandler } from './CommandHandler.js';
import { BotRuntime } from './runtime.js';
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
  const app = createAdminApp({ runtime, questionStore: questions });
  const { host, port } = config.admin;
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  }).catch((e) => {
    error(`后台服务启动失败（${host}:${port}）：${e.message}`);
    process.exit(1);
  });

  log(`后台界面已启动：http://${host}:${port}`);
  if (!hasPassword()) {
    log('  首次使用：打开上面的地址，按提示设置一个后台密码');
  }

  // 6. 按配置连接各条通道
  await runtime.apply();

  log('----------------------------------------');
  log(`后台界面：http://${host}:${port}`);
  log('Discord 用「!汤 帮助」，QQ 用「#汤 帮助」查看命令。');
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
