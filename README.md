# 🐢 海龟汤机器人（Turtle Soup Bot）

Discord + QQ 双平台的海龟汤游戏机器人，使用 **Jev** 评判模型判断玩家提问的"是/不是"，并实时计算与谜底的相似度，达到 80% 即通关并公布完整谜底。

**所有配置都在网页后台里改，不需要编辑任何配置文件。**

## ✨ 功能特性

- **三条消息通道**：Discord、QQ（NapCat / OneBot v11）、QQ 官方机器人（QQ 开放平台），可任意组合启用
- **网页后台**：密码登录，配置、题库、运行状态全在浏览器里操作，保存即热重启对应通道
- **Jev 评判**：基于 Vercel AI SDK 的 `experimental_evaluate`，调用 `typesafe-ai/jev` 模型
- **双重评判**：每次提问同时判断「这句话是否成立」和「与谜底的相似度」
- **相似度通关**：用 `score` 题型得到 0~100% 的接近程度，达到阈值自动判胜利并公布谜底
- **多人游戏**：按频道/群隔离状态，任何人都可 @机器人 提问，集体通关
- **换题权限**：一局进行中只有本局发起人能换题
- **题库管理**：界面上增删改查、批量导入 JSON、导出备份
- **配置校验**：非法取值会被拒绝并说明原因，不会静默按默认值运行

## 📦 安装与启动

```bash
cd turtle-soup-bot
npm install
npm start
```

要求 Node.js ≥ 20。启动后打开：

```
http://127.0.0.1:4319
```

首次访问会让你设置一个**后台密码**，然后就能在界面里配置一切：

| 页面 | 内容 |
|------|------|
| 概览 | 三条通道的连接状态、题目数、运行时长、一键重启通道 |
| 评判模型 | AI Gateway API Key、模型 ID、通关相似度阈值 |
| Discord | 启用开关、Bot Token、命令前缀 |
| QQ · NapCat | 启用开关、WebSocket 地址、Access Token、命令前缀 |
| QQ · 官方机器人 | 启用开关、AppID、AppSecret、沙箱/正式环境、命令前缀 |
| 题库 | 新增 / 编辑 / 删除 / 批量导入 / 导出 |

配置保存在 `data/config.json`（已加入 `.gitignore`），密钥在接口返回时一律掩码。忘记后台密码时，删除 `data/config.json` 重新设置即可。

> 老用户可用 `.env`：**仅当 `data/config.json` 不存在时**，`.env` 的值会作为首次运行的初始值（模板见 `.env.example`）。之后一律以界面里保存的为准。

## 🎮 命令

三个平台的命令格式一致，只是前缀可能不同（默认 Discord `!`，QQ `#`）：

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

- 游戏状态按 **频道 / 群** 隔离，互不干扰
- 任何人都可以 @机器人 提问，不需要特殊权限
- 当任意玩家的提问与谜底相似度达标，**集体通关**，公布完整谜底并列出所有参与玩家
- 一局进行中只有本局发起人（用「汤 开始」的人）能换题；本局结束后任何人都可以换
- 换题即开启新一局，参与人数与提问历史自动清零

## 🔌 三条通道怎么配

### Discord
1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Application
2. Bot 页面获取 Token，开启 **Message Content Intent**
3. 用 OAuth2 URL Generator 邀请机器人（勾选 bot + Send Messages + Read Message History）
4. 把 Token 填进后台的「Discord」页面

### QQ · NapCat（OneBot v11）
1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ) / [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)
2. 在 NapCat 里开启 **WebSocket 服务端**（机器人会主动连过去），端口默认 `3001`
3. 后台「QQ · NapCat」页面填入 `ws://127.0.0.1:3001`；NapCat 设了 token 就填同样的 token
4. 保存后概览页会显示连接状态

### QQ · 官方机器人（QQ 开放平台）
1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，拿到 **AppID / AppSecret**
2. 在「开发设置」里开启事件订阅，选择 **WebSocket 长连接**方式
3. 开通消息权限：群聊 @机器人、单聊消息（对应 `GROUP_AND_C2C_EVENT`）
4. 配置沙箱群 / 沙箱私聊账号用于测试；正式环境记得把部署 IP 加入 **IP 白名单**
5. 后台「QQ · 官方机器人」页面填 AppID / AppSecret，先用沙箱环境联调

注意事项：
- 官方接口要求**被动回复**（带 `msg_id`），群消息 5 分钟内最多回 5 条、单聊 60 分钟内最多回 4 条；机器人已按此限制裁剪回复条数，超长内容会被截断
- 官方接口不返回昵称，历史里显示的是 `群友xxxx`（openid 尾号）
- 「同时接收频道（子频道）@消息」需要额外开通公域消息权限，没开通时开着它可能连不上网关

## 🔐 后台 API（可选，给脚本用）

界面本身就是调用这些接口，脚本也可以直接用：

```bash
# 登录拿会话令牌
TOKEN=$(curl -s -X POST http://127.0.0.1:4319/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"你的后台密码"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 读取配置（密钥是掩码）
curl -s http://127.0.0.1:4319/api/config -H "X-Auth-Token: $TOKEN"

# 批量导入题目
curl -s -X POST http://127.0.0.1:4319/api/questions \
  -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"questions":[{"title":"题目名称","puzzle":"汤面","answer":"汤底"}]}'
```

未设置的接口路径会返回 JSON 404；未登录访问受保护接口返回 401。

## 🧪 开发

```bash
npm run lint    # 对 src / test / scripts 做语法检查（无需额外依赖）
npm test        # 单元测试，全部用桩替身，不联网、不碰真实配置与题库
npm run check   # lint + test
```

## 📁 项目结构

```
turtle-soup-bot/
├── .env.example            # 可选的首次运行种子（正常不需要）
├── package.json
├── README.md
├── 启动.bat
├── public/
│   ├── index.html          # 后台界面外壳
│   ├── app.js              # 后台界面逻辑（零依赖）
│   └── style.css           # 界面样式
├── data/
│   ├── questions.json      # 题库（内置 3 道示例题）
│   └── config.json         # 运行时配置（自动生成，已被 gitignore）
├── scripts/lint.mjs        # 无依赖语法检查
├── test/                   # node:test 单元测试
└── src/
    ├── index.js            # 入口
    ├── config.js           # 配置中心（校验 / 掩码 / 密码）
    ├── runtime.js          # 三条通道的启停与热重启
    ├── CommandHandler.js   # 共享命令处理器
    ├── game/
    │   ├── QuestionStore.js # 题库管理（原子写 / 损坏备份）
    │   ├── JevJudge.js      # Jev 评判封装（是/不是 + 相似度）
    │   └── GameManager.js   # 游戏状态机
    ├── platforms/
    │   ├── discord.js       # Discord
    │   ├── onebot.js        # QQ（NapCat / OneBot v11）
    │   ├── qq-official.js   # QQ 官方机器人开放平台
    │   └── format.js        # 各平台共用的回复文案
    ├── web/server.js        # 后台界面服务 + API
    └── utils/logger.js
```
