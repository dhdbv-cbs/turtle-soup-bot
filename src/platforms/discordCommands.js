// Discord 斜杠命令的注册与去重
//
// 历史坑：以前既注册一份**全局**命令（私聊也能用，但改动最长 1 小时生效），
// 又给每个已加入的服务器各注册一份（改动立刻生效）——同一份命令在客户端里
// 会出现两条 /help（Discord 不会把「全局」和「服务器级」的同名命令合并）。
//
// 现在只注册全局这一份：服务器里和私聊里都能用，只有一个来源不会重复；
// 同时把旧版本留在各服务器里的那一份清掉（否则老用户升级后照样看到两条）。
export function commandSignature(list) {
  return JSON.stringify(
    [...list]
      .map((c) => ({
        name: c.name,
        description: c.description ?? '',
        options: (c.options ?? []).map((o) => ({
          name: o.name,
          description: o.description ?? '',
          type: o.type,
          required: !!o.required,
        })),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
}

/**
 * 让 Discord 上的命令与 `commands` 一致。
 * 参数都是 discord.js 的对象/集合，这里只用到很窄的接口，方便用桩测试。
 *
 * @param {object}   opts
 * @param {object}   opts.application  client.application（要有 .commands.fetch/.set）
 * @param {Iterable} opts.guilds       client.guilds.cache（每个 guild 要有 .commands.fetch/.set）
 * @param {Array}    opts.commands     期望的命令表
 * @param {Function} [opts.log]
 * @param {Function} [opts.warn]
 * @returns {Promise<{registered: boolean, cleaned: number, unchanged: boolean, failed: boolean}>}
 */
export async function syncDiscordCommands({
  application,
  guilds = [],
  commands,
  log = () => {},
  warn = () => {},
}) {
  const result = { registered: false, cleaned: 0, unchanged: false, failed: false };
  const desired = commandSignature(commands);

  // 全局命令：内容没变就不重复提交（每次保存配置都会热重启，没必要反复 PUT）
  try {
    const existing = await application.commands.fetch();
    if (commandSignature(existing.values()) === desired) {
      result.unchanged = true;
      log(`斜杠命令无变化（${commands.length} 个），跳过注册`);
    } else {
      await application.commands.set(commands);
      result.registered = true;
      log(`斜杠命令已注册（${commands.length} 个）：${commands.map((c) => '/' + c.name).join(' ')}`);
      log('提示：全局斜杠命令最长需要 1 小时在客户端生效；私聊里同样可用。');
    }
  } catch (e) {
    result.failed = true;
    warn('Discord 全局斜杠命令注册失败：', e?.message || String(e));
  }

  // 清掉旧版本给每个服务器单独注册的那一份
  for (const guild of guilds) {
    try {
      const own = await guild.commands.fetch();
      if (own.size) {
        await guild.commands.set([]);
        result.cleaned += 1;
      }
    } catch (e) {
      warn(`清理服务器 ${guild.name || guild.id} 的重复斜杠命令失败：`, e?.message || String(e));
    }
  }
  if (result.cleaned) {
    log(`已清理 ${result.cleaned} 个服务器里重复的斜杠命令（现在只保留全局一份）`);
  }

  return result;
}
