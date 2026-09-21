# 🐢 海龟汤机器人（Turtle Soup Bot）

Discord + QQ 双平台的海龟汤游戏机器人，用 **Jev** 评判玩家的提问（是 / 不是），并实时计算与谜底的相似度，达到 80% 即通关并公布完整谜底。

**三个渠道统一用 `/斜杠命令`；所有配置都在网页后台里改，不需要编辑任何配置文件。**

## ✨ 功能特性

- **三条消息通道**：Discord（原生斜杠命令）、QQ（NapCat / OneBot v11）、QQ 官方机器人（QQ 开放平台），可任意组合启用
- **每个渠道一份 `/help`**：Discord 讲原生斜杠命令与 @我，QQ 群讲"先 @我 再发"，官方机器人讲被动回复的条数限制；文案可在后台里覆盖
- **网页后台**：密码登录，配置、题库、运行状态全在浏览器里操作，保存即热重启对应通道
- **多评判渠道**：Vercel AI Gateway / TypeSafe 官方直连 / OpenAI / Anthropic / Google / 自建网关，抽屉式切换，每个渠道各存一份密钥
- **相似度通关**：用 `score` 题型得到 0~100% 的接近程度，达到阈值自动判胜利并公布谜底
- **多人游戏**：按频道/群隔离状态，任何人都可提问，集体通关；一局进行中只有发起人能换题
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
| 概览 | 三条通道的连接状态、评判渠道是否可用、题目数、运行时长、一键重启通道 |
| 评判渠道 | 抽屉式列表：点开某个渠道填密钥/模型，一键切换 |
| Discord | 启用开关、Bot Token、`/help` 文案 |
| QQ · NapCat | 启用开关、WebSocket 地址、Access Token、`/help` 文案 |
| QQ · 官方机器人 | 启用开关、AppID、AppSecret、沙箱/正式环境、`/help` 文案 |
| 题库 | 新增 / 编辑 / 删除 / 批量导入 / 导出 |
| 后台服务 | 监听地址与端口（改动需重启进程） |

界面支持锚点直达：`#judge`、`#judge/typesafe`、`#questions` 等。

配置保存在 `data/config.json`（已加入 `.gitignore`），密钥在接口返回时一律掩码。忘记后台密码时，删除 `data/config.json` 重新设置即可。

> 老用户可用 `.env`：**仅当 `data/config.json` 不存在时**，`.env` 的值会作为首次运行的初始值（模板见 `.env.example`）。之后一律以界面里保存的为准。

## 🎮 命令（三个渠道统一）

| 命令 | 说明 |
|------|------|
| `/help` | 查看**本渠道**的用法说明（Discord 里只有自己看得到） |
| `/start` | 开始当前题目，公布汤面；你成为本局发起人 |
| `/ask <问题>` | 直接向谜底提问（等同于 @机器人） |
| `/list` | 查看所有题目 |
| `/pick <编号>` | 跳到指定题目（进行中仅本局发起人可用） |
| `/next` | 按顺序切换到下一题（进行中仅本局发起人可用） |
| `/status` | 查看本局状态 |
| `/history` | 查看最近提问记录 |
| `/reveal` | 手动公布谜底 |
| `/reset` | 重置本频道的游戏状态 |

**各渠道怎么触发机器人**（`/help` 里会按渠道说明）：

- **Discord**：在输入框打 `/` 就能看到命令列表（原生斜杠命令）；也可以 `@机器人 + 问题` 提问
- **QQ（NapCat）**：群里命令直接发 `/start`，提问先 `@机器人`；私聊可以直接发命令或问题
- **QQ 官方机器人**：群里必须先 `@机器人` 再发内容；单聊直接发

回复只会 @ 提问者本人，不会因为题库文本里出现 `@everyone` 而误伤全群。

## 👥 多人游戏

- 游戏状态按 **频道 / 群** 隔离，互不干扰
- 任何人都可以提问，不需要特殊权限
- 当任意玩家的提问与谜底相似度达标，**集体通关**，公布完整谜底并列出所有参与玩家
- 一局进行中只有本局发起人（用 `/start` 的人）能换题；本局结束后任何人都可以换
- 换题即开启新一局，参与人数与提问历史自动清零

## 🧠 评判渠道怎么选

三条通道只是"在哪儿聊天"；评判模型是另一套东西，决定"谁来判断对错"。后台「评判渠道」页是一个抽屉列表，点开哪个就能填哪个，同一时间只用一个。

### 哪些平台能跑 Jev（2026-09 调研）

| 平台 | 模型名 | 说明 |
|------|--------|------|
| **Vercel AI Gateway** | `typesafe-ai/jev` | 默认渠道，**内置依赖开箱可用，不需要等待名单** |
| **TypeSafe 官方直连** | `jev-latest` | `api.typesafe.ai`，需要官方早期访问资格（waitlist） |
| Netlify AI Gateway | `typesafe-ai/jev` | 只能在 Netlify Functions 里用，自建部署用不上 |

另外 OpenAI、Anthropic、Google 也实现了 AI SDK 的 evaluation model 协议，可以完成同样的「是/否 + 相似度」评判（模型不是 Jev，速度与成本不同），也在抽屉列表里。

参考：[Vercel AI Gateway 的 Evaluation 文档](https://vercel.com/docs/ai-gateway/modalities/evaluation)、[AI SDK Evaluation 文档](https://ai-sdk.dev/docs/ai-sdk-core/evaluation)、[TypeSafe 发布公告](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[Netlify 的 Jev 上线说明](https://www.netlify.com/changelog/typesafe-jev-ai-gateway)。

### 要不要为每个平台写一套？

**不用。** 这些平台都实现了 AI SDK 同一套 `Experimental_EvaluationModel` 接口（`provider.evaluationModel(modelId)`，返回的对象实现 `doEvaluate`），所以评判逻辑只有一份，差别仅在"怎么拿到模型实例"。代码里对应 `src/judge/providers.js` 的登记表：一个平台一条记录（依赖包名 + 工厂函数 + 默认模型），运行时按当前渠道动态构造。

想加新平台，只要它有 `evaluationModel()` 工厂，往那张表里加一条即可。

### 依赖说明

`@ai-sdk/gateway` 是随 `ai` 一起装好的；另外四个渠道的 provider 包是 **optionalDependencies**：

```bash
npm i @ai-sdk/typesafe-ai   # TypeSafe 官方直连
npm i @ai-sdk/openai        # OpenAI
npm i @ai-sdk/anthropic     # Anthropic
npm i @ai-sdk/google        # Google Gemini
```

没装的渠道在界面里会显示「依赖未安装」，按钮禁用并给出安装命令；没装不影响其它渠道使用。

## 🔌 三条消息通道怎么配

### Discord
1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Application
2. Bot 页面获取 Token，开启 **Message Content Intent**
3. 用 OAuth2 URL Generator 邀请机器人（勾选 bot + Send Messages + Read Message History）
4. 把 Token 填进后台的「Discord」页面

启动时会把 `/help` `/start` 等命令注册到**已加入的每个服务器**（立即生效），同时也注册一份全局命令（最长 1 小时生效）。

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
- 官方接口要求**被动回复**（带 `msg_id`），群消息 5 分钟内最多回 5 条、单聊 60 分钟内最多回 4 条；机器人已按此限制裁剪回复条数
- 官方接口不返回昵称，历史里显示的是 `群友xxxx`（openid 尾号）
- 「同时接收频道（子频道）@消息」需要额外开通公域消息权限，没开通时开着它可能连不上网关

## 🔐 后台 API（可选，给脚本用）

界面本身就是调用这些接口，脚本也可以直接用：

```bash
# 登录拿会话令牌
TOKEN=$(curl -s -X POST http://127.0.0.1:4319/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"你的后台密码"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 看有哪些评判渠道、依赖装没装
curl -s http://127.0.0.1:4319/api/judge/providers -H "X-Auth-Token: $TOKEN"

# 一个请求完成"填凭据 + 切换渠道"
curl -s -X PUT http://127.0.0.1:4319/api/config \
  -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"judge":{"provider":"typesafe","providers":{"typesafe":{"apiKey":"ts-xxx","model":"jev-latest"}}}}'

# 批量导入题目
curl -s -X POST http://127.0.0.1:4319/api/questions \
  -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"questions":[{"title":"题目名称","puzzle":"汤面","answer":"汤底"}]}'
```

密钥字段的语义：**不传或空串 = 保持原值，`null` = 清空，字符串 = 设置**。未命中的接口路径返回 JSON 404，未登录返回 401。

## 🧪 开发

```bash
npm run lint    # 对 src / test / scripts / public 做语法检查（无需额外依赖）
npm test        # 单元测试，全部用桩替身，不联网、不碰真实配置与题库、不调用任何 API
npm run check   # lint + test
```

测试覆盖：配置中心（含旧配置迁移、损坏备份）、评判渠道接线（离线构造每个平台的 evaluation model）、三条通道的启停与热重启、后台 API、题库 CRUD、命令解析与各渠道 `/help`、后台界面渲染（在假 DOM 里真跑一遍 `public/app.js`，含抽屉交互）。

## 📁 项目结构

```
turtle-soup-bot/
├── .env.example            # 可选的首次运行种子（正常不需要）
├── package.json
├── README.md
├── 启动.bat
├── public/                 # 后台界面（零依赖，无构建）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
│   ├── questions.json      # 题库（内置 3 道示例题）
│   └── config.json         # 运行时配置（自动生成，已被 gitignore）
├── scripts/lint.mjs        # 无依赖语法检查
├── test/                   # node:test 单元测试
└── src/
    ├── index.js            # 入口
    ├── config.js           # 配置中心（校验 / 掩码 / 密码 / 旧配置迁移）
    ├── commands.js         # 命令表与各渠道 /help 文案
    ├── runtime.js          # 三条通道的启停与热重启
    ├── CommandHandler.js   # 共享命令处理器
    ├── game/
    │   ├── QuestionStore.js # 题库管理（原子写 / 损坏备份）
    │   ├── JevJudge.js      # 评判封装（是/不是 + 相似度）
    │   └── GameManager.js   # 游戏状态机
    ├── judge/
    │   └── providers.js     # 评判渠道登记表（平台 → 依赖包 → 模型工厂）
    ├── platforms/
    │   ├── discord.js       # Discord（原生斜杠命令）
    │   ├── onebot.js        # QQ（NapCat / OneBot v11）
    │   ├── qq-official.js   # QQ 官方机器人开放平台
    │   └── format.js        # 各平台共用的回复文案
    ├── web/server.js        # 后台界面服务 + API
    └── utils/
        ├── logger.js
        └── placeholder.js
```
