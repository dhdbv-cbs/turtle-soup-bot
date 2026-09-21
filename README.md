# 🐢 海龟汤机器人（Turtle Soup Bot）

Discord + QQ 双平台的海龟汤游戏机器人，使用 **Jev** 评判模型判断玩家提问的"是/不是"，并实时计算与谜底的相似度，达到 80% 即通关并公布完整谜底。

## ✨ 功能特性

- **双平台**：同时支持 Discord 和 QQ（OneBot v11，兼容 NapCat / Lagrange / LLOneBot）
- **Jev 评判**：基于 Vercel AI SDK 的 `experimental_evaluate`，调用 `typesafe-ai/jev` 模型
- **双重评判**：每次提问同时判断「这句话是否成立」和「与谜底的相似度」
- **相似度通关**：相似度 ≥ 80% 自动判胜利，公布完整谜底（用 `score` 题型得到 0~100% 的接近程度，不是布尔概率）
- **多人游戏**：按频道/群隔离状态，任何人都可 @机器人 提问，集体通关
- **换题权限**：一局进行中只有本局发起人能换题，避免有人中途把题目换掉
- **题目管理**：后台 API 批量导入题目，按顺序出题，支持选指定题目
- **提问历史**：记录所有提问及判断结果，可随时查看
- **配置校验**：`.env` 填错会在启动时给出具体原因并拒绝启动，不会静默按默认值运行

## 📦 安装

```bash
cd turtle-soup-bot
npm install
```

要求 Node.js ≥ 20。

## ⚙️ 配置

复制 `.env.example` 为 `.env`（仓库里已忽略 `.env`）并填写：

```env
# Jev（必填）
AI_GATEWAY_API_KEY=你的_vck_key
JEV_MODEL=typesafe-ai/jev
WIN_THRESHOLD=0.8          # 相似度 >= 此值通关（0~1）
YES_THRESHOLD=0.5          # 判定"是"的概率阈值（0~1）

# Discord
DISCORD_ENABLED=true
DISCORD_TOKEN=你的Discord机器人Token
DISCORD_PREFIX=!

# QQ (OneBot v11)
QQ_ENABLED=true
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=
QQ_PREFIX=#

# 后台管理 API
ADMIN_HOST=127.0.0.1       # 默认只监听回环地址
ADMIN_PORT=4319
ADMIN_TOKEN=可选的导入鉴权令牌
```

> 取值不合法的项（例如 `WIN_THRESHOLD=八十`、`ADMIN_PORT=99999`）会在启动时打印具体原因并退出，避免"看起来在跑其实永远不通关"。

### Discord 配置
1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Application
2. 在 Bot 页面获取 Token，开启 **Message Content Intent**
3. 用 OAuth2 URL Generator 邀请机器人到服务器（勾选 bot + Send Messages + Read Message History）

### QQ 配置
1. 安装任一 OneBot v11 实现（推荐 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)）
2. 配置 WebSocket 连接，默认地址 `ws://127.0.0.1:3001`
3. 登录你的 QQ 号，机器人会自动连接

## 🎮 命令

两个平台命令格式一致，只是前缀不同（Discord 默认 `!`，QQ 默认 `#`）：

| 命令 | 说明 |
|------|------|
| `汤 帮助` | 查看命令说明 |
| `汤 列表` | 查看所有题目 |
| `汤 下一题` | 按顺序切换到下一题（进行中仅本局发起人可用） |
| `汤 选 <编号>` | 跳到指定题目（进行中仅本局发起人可用） |
| `汤 开始` | 开始当前题目（公布汤面），你成为本局发起人 |
| `汤 状态` | 查看本局状态 |
| `汤 历史` | 查看最近提问记录 |
| `汤 公布` | 手动公布谜底 |
| `汤 重置` | 重置本频道状态 |

**提问方式**：游戏开始后，直接 **@机器人 + 你的问题**，机器人会回答「是」或「不是」，并显示与谜底的相似度。回复只会 @ 提问者本人，不会因为题库文本里出现 `@everyone` 而误伤全群。

## 👥 多人游戏

- 游戏状态按 **Discord 频道 / QQ 群** 隔离，互不干扰
- 任何人都可以 @机器人 提问，不需要特殊权限
- 提问历史记录每位玩家的提问及判断结果
- 当任意玩家的提问与谜底相似度 ≥ 80%，**集体通关**，机器人公布完整谜底并列出所有参与玩家
- 一局进行中只有本局发起人（用「汤 开始」的人）能换题；本局结束后任何人都可以换
- 换题即开启新一局，参与人数与提问历史自动清零
- 用 `汤 下一题` 即可开始新的一局

## 📥 后台导入题目

启动后管理 API 默认运行在 `http://127.0.0.1:4319`（只监听回环地址，局域网其它机器访问不到）：

```bash
# 列出题目
curl http://127.0.0.1:4319/api/questions

# 批量导入题目
curl -X POST http://127.0.0.1:4319/api/questions \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: 你的令牌" \
  -d '{
    "questions": [
      {
        "title": "题目名称",
        "puzzle": "汤面内容",
        "answer": "汤底（完整谜底）"
      }
    ]
  }'
```

题目也可以直接编辑 `data/questions.json` 文件，重启后生效（仓库内置了 3 道经典示例）。写入采用"临时文件 + 原子替换"，如果文件被写坏（JSON 无法解析），启动时会自动备份为 `questions.json.corrupt-<时间>.bak` 并以空库继续，不会静默覆盖丢题。

## 🚀 启动

```bash
npm start
```

或 Windows 双击 `启动.bat`。

## 🧪 开发

```bash
npm run lint    # 对 src / test / scripts 做语法检查（无需额外依赖）
npm test        # 单元测试，全部用桩替身，不联网、不碰真实题库
npm run check   # lint + test
```

## 📁 项目结构

```
turtle-soup-bot/
├── .env.example            # 配置模板（复制成 .env）
├── package.json
├── README.md
├── 启动.bat
├── data/
│   └── questions.json      # 题目库（内置示例题）
├── scripts/
│   └── lint.mjs            # 无依赖语法检查
├── test/                   # node:test 单元测试
└── src/
    ├── index.js            # 入口（双平台 + 后台API + 进程级异常兜底）
    ├── config.js           # 集中配置 + 合法性校验
    ├── CommandHandler.js   # 共享命令处理器
    ├── game/
    │   ├── QuestionStore.js # 题目库管理（原子写 / 损坏备份）
    │   ├── JevJudge.js      # Jev 评判封装（是/不是 + 相似度）
    │   └── GameManager.js   # 游戏状态机（多人/隔离/发起人）
    ├── platforms/
    │   ├── discord.js       # Discord 适配器
    │   └── onebot.js        # QQ OneBot v11 适配器
    └── utils/
        └── logger.js
```
