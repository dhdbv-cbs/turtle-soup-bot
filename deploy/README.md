# deploy —— 部署与运维脚本

这个目录装的是「把本仓库的代码更新到 VPS 上」的全套动作，以及部署前后的体检工具。
它只包含**通用脚本**：服务器地址、端口、私钥路径一律走参数或环境变量，不写进仓库。

## 一条铁律：部署包绝不许包含 `data/`

线上 `/opt/1panel/apps/turtle-soup-bot/data/` 里有两样东西只属于那台机器：

- `questions.json`：**线上题库（几十到几百题）**，是运营出来的资产；
- `config.json`：**带密钥的配置**（Discord 令牌、QQ appSecret、评判 apiKey、后台密码哈希）。

仓库里的 `data/questions.json` 只是 3 题样例、供本地开发用。**一旦打包时带上 `data/`，
解包就会把线上题库覆盖成 3 题、把线上配置覆盖成本机的**。这条闸门在三个地方都拦：

1. `deploy/package.ps1` 用 `git archive` + `:(exclude)data` 打包，并校验一遍才出包；
2. `deploy/install.sh` 解包前再 grep 一次，含 `data/` 直接拒绝退出；
3. `deploy/check-tmp.sh` 复查 `/tmp` 里遗留的包有没有夹带凭证。

## 标准流程（升级一次完整的动作）

VPS 上那个目录**不是 git 仓库**（没有 `.git`），所以是「本机打包 → 上传 → VPS 解包」，
不是 `git pull`。

```powershell
# ① 本机：打包（自动排除 data/，并校验包里没有密钥文件）
powershell -ExecutionPolicy Bypass -File deploy\package.ps1
# 产物：turtle-soup-bot-<短sha>.tar.gz，记录它打印的 md5

# ② 上传到 VPS 的 /tmp（任选一种）
agentsshcli upload --connection <你的连接> --local .\turtle-soup-bot-<sha>.tar.gz --remote /tmp/turtle-soup-bot-<sha>.tar.gz
# 或者： scp -P <端口> -i <私钥> .\turtle-soup-bot-<sha>.tar.gz root@<地址>:/tmp/
```

```bash
# ③ VPS：先看此刻有没有人在玩（提问不写日志，所以要看频道消息）
TS_WATCH_CHANNELS="<频道id1>,<频道id2>" bash /opt/1panel/apps/turtle-soup-bot/deploy/check-activity.sh

# ④ VPS：备份 + 解包 + 重启 + 校验（最近 3 分钟有日志时会要求加 --yes）
bash /opt/1panel/apps/turtle-soup-bot/deploy/install.sh /tmp/turtle-soup-bot-<sha>.tar.gz

# ⑤ VPS：健康检查
bash /opt/1panel/apps/turtle-soup-bot/deploy/verify.sh

# ⑥ VPS：清理 /tmp 里的包（可选，但建议）
bash /opt/1panel/apps/turtle-soup-bot/deploy/cleanup-tmp.sh
```

## 回滚

`install.sh` 在解包前会把当前源码与 `data/` 备份到 `/root/ts-backup/`，
它最后会打印本次的时间戳，回滚就是把备份盖回去：

```bash
tar -xzf /root/ts-backup/src-<时间戳>.tar.gz -C /opt/1panel/apps
systemctl restart turtle-soup-bot
```

## 文件说明

| 文件 | 在哪跑 | 作用 |
|---|---|---|
| `package.ps1` | 本机 Windows | 打包（`git archive`，排除 `data/`），校验不含密钥文件，打印 md5 |
| `install.sh` | VPS | 拦 `data/` → 备份 → 解包 → 权限 → 题库核对 → 重启 → 调 `verify.sh` |
| `verify.sh` | VPS | 部署后体检：进程/内存/端口/题库/斜杠命令/告警（只读） |
| `check-activity.sh` | VPS | 部署前确认「此刻有没有人在玩」（只读；`/api/state` 看不到对局） |
| `check-tmp.sh` | VPS | 查 `/tmp` 里的部署包有没有夹带 `config.json` 凭证（只读） |
| `cleanup-tmp.sh` | VPS | 删除 `/tmp` 里的部署包 |
| `tunnel.ps1` | 本机 Windows | 把 VPS 后台 `127.0.0.1:4319` 映射到本机，用浏览器登录 |
| `service.sh` | VPS | **首次装机**创建 systemd 服务（升级不要跑） |

## 已知坑（都踩过）

- **VPS 不是 git 仓库**：`git pull` 会报 `not a git repository`，别试。
- **依赖没变就别 `npm ci`**：`package.json` 只改 `scripts` 时不需要重装依赖（`package-lock.json` 的 md5 一致即可）；`node_modules/` 解包时会被完整保留。
- **重启会清掉内存里的对局**：状态存在 RAM 里，重启即丢。所以第 ③ 步别省。
- **玩家的普通提问不写日志**：日志里只有开局/通关/切模式等事件，「日志安静」不等于没人玩。
- **全局斜杠命令最长 1 小时生效**：新增命令（如 `/card`）注册成功后，客户端要等一会儿才出现。
- **`/api/state` 看不到对局**：它只返回 `needsSetup/authenticated/passwordMinLength/version`。
- **`data/questions.json` 在仓库里是 3 题样例**，与线上题库无关，永远不要拿它去覆盖线上。

## 安全

- 凭证只存在于 VPS 的 `data/config.json`（权限 `600`，`data/` 目录 `700`）。
- 部署包放 `/tmp` 期间是 1777 目录（谁都能读），所以包里绝不能有凭证，传完就 `cleanup-tmp.sh` 清掉。
- 曾经有一次打包把 `config.json` 打进去了（那份包已删除）。若怀疑凭证外泄，轮换顺序建议：
  Discord 令牌 → 评判 apiKey → QQ appSecret；后台密码走「忘记密码」重置流程。
- `npm run check:secrets` 会在提交前扫描真实凭证值与常见令牌格式，提交前跑一次。
