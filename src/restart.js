// 进程重启：后台界面的「重启进程」按钮用它
//
// 有些改动是热重启通道解决不了的：改了 .env、装了新依赖、换了后台端口、改了代码。
// 这些必须换一个进程跑。做法分两种：
//
//   · 有外部守护进程（pm2 / systemd / supervisord）——**退出自己**，让它把新进程拉起来。
//     自己再 spawn 一个的话，守护进程也会重启我们，结果两个进程同时连 Discord/QQ，
//     同一条消息会被回两次。
//   · 没有守护进程（`npm start` / 双击 启动.bat）——自己 spawn 一个参数完全一样的新进程，
//     等它真的起来了再退出；起不来就留在原地继续跑，绝不把机器人弄没。
//
// 顺序很关键：**先放开后台监听端口、断开通道，再拉新进程**。
// 反过来的话新进程会因为端口被占（EADDRINUSE）直接退出。
import { spawn } from 'node:child_process';
import { error, log } from './utils/logger.js';

// 守护进程会留下的环境变量 → 名字
const SUPERVISORS = [
  ['pm_id', 'pm2'],
  ['pm2_home', 'pm2'],
  ['NODE_APP_INSTANCE', 'pm2'],
  ['INVOCATION_ID', 'systemd'],
  ['JOURNAL_STREAM', 'systemd'],
  ['SUPERVISOR_ENABLED', 'supervisord'],
];

export function detectSupervisor(env = process.env) {
  for (const [key, name] of SUPERVISORS) {
    if (env?.[key]) return name;
  }
  return null;
}

/**
 * 造一个重启器。依赖全部可注入，测试里不会真的动进程。
 *
 * @param {object} opts
 * @param {() => Promise<void>} [opts.stop]     重启前先释放端口/断开通道
 * @param {() => Promise<void>} [opts.onFail]   新进程没起来时把本进程恢复回来（重新监听）
 * @param {Function} [opts.spawnFn]             默认 node:child_process.spawn
 * @param {(code:number)=>void} [opts.exitFn]   默认 process.exit
 */
export function createRestarter({
  stop = null,
  onFail = null,
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  cwd = process.cwd(),
  spawnFn = spawn,
  exitFn = (code) => process.exit(code),
  logFn = log,
  errorFn = error,
} = {}) {
  let busy = false;

  return {
    /**
     * 同步占位：重复点按钮会被挡掉（busy），不会排队重启两次。
     * 返回值里带上这次会走哪种方式，接口可以据此告诉用户"要不要等它自己回来"。
     */
    accept() {
      if (busy) return { ok: false, reason: 'busy' };
      busy = true;
      const supervisor = detectSupervisor(env);
      return { ok: true, mode: supervisor ? 'exit' : 'exec', supervisor: supervisor || '' };
    },

    get busy() {
      return busy;
    },

    // 真正执行：由接口在响应发出去之后调用
    async run() {
      const supervisor = detectSupervisor(env);
      try {
        if (stop) await stop(); // 先放开端口，新进程才抢得到

        if (supervisor) {
          logFn(`检测到外部守护进程（${supervisor}）：退出本进程，由它拉起新的`);
          exitFn(0);
          return { ok: true, mode: 'exit', supervisor };
        }

        const child = spawnFn(execPath, argv.slice(1), {
          cwd,
          env,
          detached: true, // 自己独立一组，父进程退出后继续跑
          stdio: 'inherit', // 日志还是打在同一个控制台里
        });

        // 必须等 'spawn' 才算真的起来了：ENOENT 这类错误是异步事件，try/catch 抓不到
        const started = await new Promise((resolve) => {
          child.once?.('spawn', () => resolve(true));
          child.once?.('error', (e) => {
            errorFn('拉起新进程失败：', e?.message || String(e));
            resolve(false);
          });
        });

        if (!started) {
          // 新进程没起来：把停掉的东西恢复回来，旧进程继续服务
          busy = false;
          if (onFail) await onFail();
          return { ok: false, mode: 'failed', reason: '新进程没能启动' };
        }

        child.unref?.();
        logFn(`新进程已启动（pid ${child.pid}），本进程退出`);
        exitFn(0);
        return { ok: true, mode: 'exec', pid: child.pid };
      } catch (e) {
        busy = false;
        errorFn('重启失败：', e?.message || String(e));
        if (onFail) {
          try {
            await onFail();
          } catch (e2) {
            errorFn('恢复原进程失败：', e2?.message || String(e2));
          }
        }
        return { ok: false, mode: 'failed', reason: e?.message || String(e) };
      }
    },
  };
}
