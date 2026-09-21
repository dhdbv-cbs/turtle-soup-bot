# 🐢 海龟汤机器人（Turtle Soup Bot）

Discord + QQ 双平台的海龟汤游戏机器人，用 **Jev** 评判玩家的提问（是 / 不是），并在内部计算与谜底的接近程度，够接近就判通关、公布完整谜底。**判定过程与分数不对外暴露**：玩家只会看到「是 / 不是」、`/ask` 的逐句 ✅/❌，以及是谁问的。

**三个渠道统一用 `/斜杠命令`；所有配置都在网页后台里改，不需要编辑任何配置文件。**

## ✨ 功能特性

- **三条消息通道**：Discord（原生斜杠命令）、QQ（NapCat / OneBot v11）、QQ 官方机器人（QQ 开放平台），可任意组合启用
- **每个渠道一份 `/help`**：Discord 讲原生斜杠命令与 @我，QQ 群讲"先 @我 再发"，官方机器人讲被动消息的时效与条数；文案已在后台预填好，也可覆盖
- **网页后台**：密码登录，配置、题库、运行状态全在浏览器里操作，保存即热重启对应通道，改过 `.env` / 依赖 / 代码还能一键重启进程
- **出站代理**：在概览页填一个 HTTP 代理，评判请求、Discord（REST + 网关）、QQ 官方机器人、远程 NapCat 就都走它——Node 默认不认 Windows 的系统代理，校园网/公司网下这一步常常是能不能连上 Discord 的关键
- **只认 Jev**：评判只用 Jev（System One 模型）的「是/否 + 相似度」，不接普通 LLM；入口可用 Vercel AI Gateway、TypeSafe 官方直连、或第三方转发的 Jev，抽屉式切换，每个入口各存一份密钥
- **相似度通关（内部）**：用 `score` 题型得到 0~100% 的接近程度，达到阈值（默认 80%）自动判胜利并公布谜底；这个分数只在后台日志里能看到，不会出现在群里的回复里
- **多人游戏**：按频道/群隔离状态，任何人都可提问，集体通关；一局进行中只有发起人能换题
- **两种问法**：`@机器人 + 问题` 回一句「是 / 不是」；`/ask 你的结论` 把这段话**拆成一句一句**核对，对的 ✅、错的 ❌（拆句在本地做，不花评判调用）
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

**Windows / Linux / macOS 都能跑**，没有平台相关分支，也不需要编译。差异只在"怎么让它常驻"：

| 平台 | 启动方式 | 常驻 / 重启 |
|------|----------|-------------|
| Windows | 双击 `启动.bat`（会自动开浏览器）或 `npm start` | `启动.bat` 自己就是托管者：点后台「重启进程」后它会把新进程接着跑起来，同一个窗口 |
| Linux（手动） | `npm start`，或 `nohup npm start &` | 没有守护进程时，机器人自己 spawn 新进程再退出（旧进程走了、新进程接上） |
| Linux（服务，推荐） | 下面的 systemd 单元 | `systemctl` 托管：点「重启进程」只是退出自己（退出码 99），systemd 立刻拉起新的 |

```ini
# /etc/systemd/system/turtle-soup-bot.service
[Unit]
Description=Turtle Soup Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=turtle
WorkingDirectory=/opt/turtle-soup-bot
ExecStart=/usr/bin/node src/index.js
# 后台点「重启进程」时进程会以 99 退出，on-failure 正好把它当成"该重开一次"
Restart=on-failure
RestartSec=2
# 日志进 journald：journalctl -u turtle-soup-bot -f
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now turtle-soup-bot
journalctl -u turtle-soup-bot -f
```

用 pm2 也一样（`pm2 start src/index.js --name turtle-soup-bot`）：机器人识别到 `pm_id` 这类环境变量后只退出自己，不会自己再拉一个——否则两个进程同时连 Discord/QQ，同一条消息会被回两次。

跨平台上的取舍：文件路径一律用 `node:path` 拼（没有硬编码的 `\` 或 `/`）；配置、题库都是"先写临时文件再 rename"的原子写；批处理固定 CRLF（见 `.gitattributes`）；`npm run lint` 里有一项专门查 **import 路径大小写**——Windows 不区分大小写、Linux 区分，写错大小写在 Windows 上完全看不出来，一搬到 Linux 就 `Cannot find module`。

首次访问会让你设置一个**后台密码**，然后就能在界面里配置一切：

| 页面 | 内容 |
|------|------|
| 概览 | 三条通道的连接状态、评判渠道是否可用、题目数、运行时长、一键重启通道、**一键重启进程**、**出站代理** |
| 评判渠道 | 抽屉式列表：点开某个渠道填密钥/模型，一键切换 |
| Discord | 启用开关、Bot Token、`/help` 文案（已按本渠道填好，可直接改） |
| QQ · NapCat | 启用开关、WebSocket 地址、Access Token、`/help` 文案（已填好） |
| QQ · 官方机器人 | 启用开关、AppID、AppSecret、沙箱/正式环境、是否同时收频道 @消息、`/help` 文案（已填好） |
| 题库 | 新增 / 编辑 / 删除 / 批量导入 / 导出 |
| 后台服务 | 监听地址与端口（改完点概览页的「重启进程」生效） |

### 什么时候要「重启进程」

概览页有两个按钮，管的事不一样：

| 按钮 | 管什么 | 要多久 |
|------|--------|--------|
| **重启所有通道** | 只重连 Discord / QQ 三条通道（不动后台服务） | 一两秒，不用重新登录 |
| **重启进程** | 换一个进程跑：让 `.env`、**新装的依赖**、改过的**代码**、**后台监听地址与端口**生效 | 几秒，期间机器人收不到消息，页面随后自动刷新，**需要重新登录** |

保存配置本身**不需要**重启进程——保存时会自动按新配置热重启对应通道（配置没变的通道保持现有连接）；评判密钥、阈值这类是每次评判现读配置的，改完立即生效。

「重启进程」的实现（`src/restart.js`）分两种情况，都是**先放开后台端口、断开通道，再拉新进程**（反过来的话新进程会因为端口被占而退出）：

- **没有守护进程**（直接 `node src/index.js`）：自己 spawn 一个参数一模一样的新进程，等它真的起来了（收到 `spawn`）才退出；**起不来就留在原地**把后台服务重新监听上，机器人不会没。
- **有守护进程**（pm2 / systemd / supervisord / `启动.bat`）：只退出自己，用**退出码 99**（"我要重启"这个暗号）让它们拉起新的——`启动.bat` 靠它 `goto` 回上面重开一轮，systemd 的 `Restart=on-failure` 也正好接住。自己再拉一个的话，会有两个进程同时连 Discord/QQ，同一条消息被回两次。

配置写盘用 `0600` 权限（里面是 Discord token、QQ AppSecret、评判密钥和后台密码哈希），Linux/macOS 上同机器的其他用户读不到。

`/help` 文案**不需要你自己写**：打开渠道页，输入框里已经是这份按渠道生成好的完整说明（命令表、常用例子、玩法、规则与限制），你只改想改的部分；原样保存不会把它写进配置文件，所以以后内置文案更新了你也能跟着更新；自己改过就以你的为准，清空保存即恢复内置文案。

界面支持锚点直达：`#judge`、`#judge/typesafe`、`#questions` 等。

配置保存在 `data/config.json`（已加入 `.gitignore`），密钥在接口返回时一律掩码。忘记后台密码时，删除 `data/config.json` 重新设置即可。

> 老用户可用 `.env`：**仅当 `data/config.json` 不存在时**，`.env` 的值会作为首次运行的初始值（模板见 `.env.example`）。之后一律以界面里保存的为准。

## 🎮 命令（三个渠道统一）

| 命令 | 说明 |
|------|------|
| `/help` | 查看**本渠道**的用法说明（Discord 里只有自己看得到） |
| `/start` | 开始当前题目，公布汤面；你成为本局发起人 |
| `/ask <结论>` | **提交你的结论**：拆成一句一句核对，对的 ✅、错的 ❌ |
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

### 两种问法：`/ask` 核对结论，`@我` 问是/不是

- **`@机器人 + 问题`（或普通提问）**：回答一句 `✅ 是。` / `❌ 不是。`——适合「他是被谋杀的吗」这种单点问题。
- **`/ask 你的结论`**：把这段话**用代码拆成一句一句**（句末标点、逗号、换行都算断句；`3.5` 这种小数点不算；太短的碎片如「嗯」「对吧」会并到相邻那句上），然后**整段一起发给 Jev、一次调用判完所有句子**——所以「我爱海龟汤，它很好喝」里的「它」有先行词，不会被硬抠成孤立的单句。回复成一张核对清单：

  ```
  @小明：
  🧾 逐句核对（3 句）
  ✅ 他是自杀的
  ❌ 凶手是医生
  ✅ 他留下了一封遗书
  ```

  说中谜底（达到通关判定）时仍然直接 `🎉 通关`，不再逐句报一遍。
- 清单里**全是 ✅ 却还没通关**时，会补一句 `💡 每句都对，但还没说中核心谜底，再往真相推一步。`——方向对了，差的是最关键的那一环。
- 一条 `/ask` 最多拆 **6 句**（多的部分并成最后一句，**不会丢内容**）。调用次数：**投结论固定 2 次**（整段判通关 1 次 + 逐句核对 1 次；单句只用 1 次，说中谜底也只用 1 次），**不随句数增长**；另外只占 **1 次提问额度**——长结论不该被罚。
- 拆句完全在本地完成，不花评判调用；清单里只有 ✅ / ❌，依然**不出现任何分数**。

## 👥 多人游戏

- 游戏状态按 **频道 / 群** 隔离，几个团体同时开几局互不影响
- 任何人都可以提问，不需要特殊权限
- 当任意玩家问到跟谜底吻合时，**集体通关**，公布完整谜底并列出所有参与玩家
- 回答用**真正的 @** 开头（Discord `<@id>`、QQ `[CQ:at,qq=id]`，客户端显示成对方昵称），一眼能看出是谁问的
- 回复里**不出现相似度**：`@我` 只有「是 / 不是」，`/ask` 只有逐句 ✅/❌，判定分数只写进后台日志
- 一局进行中只有本局发起人（用 `/start` 的人）能换题；本局结束后任何人都可以换
- 换题即开启新一局，参与人数与提问历史自动清零

## 🧵 并发与兜底

评判是异步的（一次可能要几秒），所以"同时来好几条"是常态。已经做的兜底：

| 场景 | 处理方式 |
|------|----------|
| 几个团体同时开好几局 | 状态按 `平台:群/频道` 隔离，互不影响；不同频道的评判可以并行 |
| 同一个人狂刷提问 | **每人每分钟最多 6 次**（按「频道 + 人」算），超了回一句「问得有点快啦，请等 N 秒」；被拦下的提问不会发给评判模型、也不写历史 |
| 一条 `/ask` 拆成好几句 | 拆句在本地做；逐句核对**整段一次请求**判完（不是一句一次，调用次数不随句数增长），仍然只占 **1 次**提问额度；每次核对占一个全局并发名额 |
| 同一个群多人同时提问 | **同频道内串行评判**：一个人问完才轮到下一个，回答顺序 = 提问顺序，历史顺序也一致 |
| 同一个群刷屏提问 | 每个频道最多 3 条排队，超出直接回「排队的提问有点多」，不会把评判请求堆成雪球 |
| 团体太多、同时开问 | 全局同时最多 8 条评判，超出的在各自频道队列里等，而不是一起打向网关被限流 |
| 两人几乎同时猜中 | 只有第一条算通关，第二条收到「本局已经通关啦」，不会刷两条通关公告 |
| 评判期间有人换题 / `/reset` | 还在飞的（含**还在排队**的）提问结果直接作废，不会写进新一局，也不会让新一局莫名通关 |
| 玩家刷了一堆历史 | 状态表有上限：空闲 12 小时的频道自动回收；超过 500 个频道时从最久没动过的开始回收，进行中的局永不回收 |
| 后台两个标签页同时改题 / 保存配置 | 写盘串行化 + 临时文件名唯一，不会互相顶掉、也不会残留 `.tmp` 文件 |
| 后台改了评判阈值 | 立即生效，不用重启（正在进行的游戏也按新阈值判定） |
| 评判渠道报错 / 超时 | 单次评判 30 秒超时；失败只回一条提示、不写历史；单条出错不会卡住整个频道的队列 |
| 进程级异常 | `unhandledRejection` / `uncaughtException` 都会记日志，不会静默退出；三个平台的事件处理都有 `catch` |

这些数字都写在 `src/limits.js` 里，帮助文案、README 和代码引用的是同一份，改一处即可。

后台「评判渠道」页能看到当前正在评判与排队的条数。

已知边界（有意为之，不是 bug）：

- **消息发送顺序**：状态与历史严格按提问顺序，但"发送"这一步发生在评判之后；如果前一条回复因为长文本分片发送得特别慢，极小的概率下群里看到的两条回复会互换位置。每条回复都带提问者名字（如 `@小明：✅ 是。`），不会认错人。
- **不要同时跑两个机器人进程**：配置文件与题库是"单进程内串行、单文件原子替换"，没有跨进程文件锁。多个实例请用不同的 `data` 目录。
- **题库轮换指针是全局的**：`/next` 按同一份顺序轮换，多个团体同时玩时各自拿到不同的题目（不会撞题），但整体共享一个"轮到第几题"的位置。

## 🧠 评判入口怎么选

三条消息通道只是"在哪儿聊天"；评判是另一套东西，决定"谁来判断对错"。**本项目只用 Jev**（TypeSafe 的 System One 模型），不接普通 LLM —— 评判需要的是稳定的「是/否 + 相似度」，不是聊天。后台「评判渠道」页是一个抽屉列表，点开哪个就能填哪个，同一时间只用一个。

### Jev 目前有这几个入口（2026-09 调研）

| 入口 | 模型名 | 说明 |
|------|--------|------|
| **Vercel AI Gateway** | `typesafe-ai/jev` | 默认入口，**内置依赖、开箱可用、无需等待名单** |
| **TypeSafe 官方直连** | `jev-latest` | `api.typesafe.ai`，需要官方早期访问资格（waitlist） |
| **第三方转发（Jev）** | 看中转站 | 别人搭的 Jev 中转：填它的 Base URL、密钥、模型名，再选它兼容的协议 |

> Netlify AI Gateway 也能用 Jev，但只能在 Netlify Functions 里跑，自建部署用不上。

参考：[Vercel AI Gateway 的 Evaluation 文档](https://vercel.com/docs/ai-gateway/modalities/evaluation)、[AI SDK Evaluation 文档](https://ai-sdk.dev/docs/ai-sdk-core/evaluation)、[TypeSafe 发布公告](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[Netlify 的 Jev 上线说明](https://www.netlify.com/changelog/typesafe-jev-ai-gateway)。

### 题面怎么写才合 System One 的脾气

`state` / `questions` 不是聊天提示词：官方要的是「懂行的人一秒内能给出的判断」，写成一串推理要求会白花一次评判。依据：[State](https://docs.typesafe.ai/concepts/state)、[Primitives](https://docs.typesafe.ai/primitives)、[Advanced: structure](https://docs.typesafe.ai/primitives/advanced)。

| 官方规则 | 本项目的落地 |
|----------|--------------|
| **一个问题只放一个瞬间判断**——"Ask for one snap judgment per question"，"Analyze this message and determine the best course of action" 被明确列为反例 | 三道题的题面都是短问题：`「玩家发言」是否符合谜底？`、`「玩家发言」离完整谜底有多近？`、逐句核对的 `「玩家发言」里的这一句是否符合谜底？` |
| **要带的材料用结构化字段跟着问题走**——"pass in the relevant subfields instead of serializing them into a string template" | 逐句核对把句子放进 `instructions`：`{ question, sentence, focus }`，而不是拼进题面字符串 |
| **state 用带名字的字段**——"Use an object for most requests so each part of the state has a descriptive name" | `state = { 汤面, 谜底, 玩家发言 }`（Jev 只吃文本，字段值都是字符串） |
| **多个判断放同一次请求**——所有问题共享同一个 state、各自独立求值、答案按你给的 key 返回 | `/ask` 的「整段相似度 + 每句一个布尔题」就是一次请求；`@ai-sdk/typesafe-ai` 也只发**一次** `POST /v1/systemone` |
| **问题的 id 不会发给模型**——"The ids are not sent to the model" | 题面自足：句子写在 `instructions.sentence` 里，绝不写"判断 s2 那一句" |
| **`criteria` 说明"是/否"各代表什么**（Noul 的 `criteria.true/false` 是可选澄清） | 判断标准放 criteria，不堆在题面里 |
| `type: 'boolean'` 在 TypeSafe 侧就是 **Noul** 原语 | 返回的是 0~1 的 `noul`，本项目按 `config.judge.yesThreshold` 折成 ✅/❌ |

题面里**不该出现**的词（`test/jevJudge.test.js` 里当回归断言盯着）：`不要` / `分析` / `只有当` / `不能给高分`——一旦出现，就说明又把"慢慢推理"和调校话术塞回了题面。校准信息留在该在的地方：相似度的 5 级 `criteria` 里已经写明「完整揭示 = 准确、完整地复述了谜底的核心真相」。

**语义没动的部分**：`similarity` 的等级表（`SIMILARITY_LEVELS`）和 state 的内容一字未改，只是题面变短、state 从带【】标签的整段文本变成命名对象；`config.judge.winThreshold` 的标定依据因此保持原样。首次配好 Key 真跑时，若觉得通关松紧不对，调 `winThreshold` 或等级描述，而不是把长题面加回来。

**题面语言保持中文**（自觉的取舍）：官方 [State](https://docs.typesafe.ai/concepts/state) 页写明 Jev 的主要训练语言是英语，"other languages, including CJK scripts, are accepted but **currently have lower accuracy**"。材料只能是中文，指令改英文理论上更准，但那会让"判断标准"和"材料"变成两种语言，且眼下没法实测对比，所以不做。

### 要不要为每个入口写一套？

**不用。** 这些入口都实现了 AI SDK 同一套 `Experimental_EvaluationModel` 接口（`provider.evaluationModel(modelId)`，返回的对象实现 `doEvaluate`），所以评判逻辑只有一份，差别仅在"怎么拿到模型实例"。代码里对应 `src/judge/providers.js` 的登记表：一个入口一条记录（依赖包 + 工厂函数 + 默认模型），运行时按当前渠道动态构造。

第三方转发的两种常见协议都支持，在下拉框里选：

| 协议 | 适用 | 模型名一般是 |
|------|------|--------------|
| **TypeSafe 直连协议**（默认） | 中转站转发的是 `api.typesafe.ai` | `jev-latest` |
| **AI Gateway 协议** | 中转站转发的是 Vercel AI Gateway（`/v4/ai`） | `typesafe-ai/jev` |

想加新入口，只要它有 `evaluationModel()` 工厂，往那张表里加一条即可。

### 依赖说明

`@ai-sdk/gateway` 随 `ai` 一起装好（Vercel 入口和中转的 AI Gateway 协议都用它）；只有 TypeSafe 直连协议需要额外装一个包：

```bash
npm i @ai-sdk/typesafe-ai   # TypeSafe 官方直连 / 中转的 TypeSafe 协议
```

没装时界面里对应协议会标注「依赖未安装」并给出安装命令，不影响其它入口使用。

## 🔌 三条消息通道怎么配

### Discord
1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Application
2. Bot 页面获取 Token，开启 **Message Content Intent**
3. 用 OAuth2 URL Generator 邀请机器人（勾选 bot + Send Messages + Read Message History）
4. 把 Token 填进后台的「Discord」页面

斜杠命令只注册**一份全局命令**：服务器里能用，私聊里也能用，改动最长 1 小时在客户端生效。**不会**再给每个服务器单独注册——那样客户端里同一个 `/help` 会出现两条（Discord 不合并全局与服务器级的同名命令）；启动时若发现旧版本留下过服务器级命令会自动清掉。命令内容没变化时跳过重复注册，所以保存配置导致的热重启不会反复打扰 Discord。

提问时频道里会显示「机器人 正在输入…」（就是 Discord 的输入状态）：评判可能要好几秒，这个状态每 8 秒自动续期一次（Discord 的输入状态本身只维持约 10 秒），**回复一发出去就结束**；斜杠命令不用这一套——Discord 自己会用 `deferReply` 显示「正在思考…」。

### QQ · NapCat（OneBot v11）
1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ) / [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)
2. 在 NapCat 里开启 **WebSocket 服务端**（机器人会主动连过去），端口默认 `3001`
3. 后台「QQ · NapCat」页面填入 `ws://127.0.0.1:3001`；NapCat 设了 token 就填同样的 token
4. 保存后概览页会显示连接状态

### QQ · 官方机器人（QQ 开放平台）
1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，拿到 **AppID / AppSecret**
2. 在「开发设置」里开启事件订阅，选择 **WebSocket 长连接**方式
3. 开通消息权限：群聊 @机器人、单聊消息（对应 `GROUP_AND_C2C_EVENT`）
4. 配置沙箱账号用于测试（沙箱群还需在后台「沙箱配置」里选群，群成员不能超过 20 人）；**正式环境必须把服务器公网 IP 加到「开发设置」→「IP 白名单」**，否则连不上网关、调不了 OpenAPI（沙箱不受影响）
5. 后台「QQ · 官方机器人」页面填 AppID / AppSecret，先用沙箱环境联调

⚠️ **现实情况（2026 年，先看这条再决定要不要走官方这条路）**：官方机器人已明显偏向 AI 助手场景，社区普遍反馈**新创建的机器人基本加不进 QQ 群**——2026-01 起不再支持直接绑定 QQ 群，沙箱群需要在后台配置且群成员 ≤ 20 人、群名要带「测试」，不少新机器人甚至只有单聊/频道入口。所以：
- 想在**群里**玩海龟汤，用 **NapCat 那条通道**（功能也全，@ 得到人、拿得到昵称）
- 官方这条通道更适合当**私聊版**（单聊 + 频道）；私聊还需要在「沙箱配置 → 在消息列表配置」里加上用户的 QQ 号，用户再在资料卡里点「添加使用」

注意事项（对照[官方文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)）：
- 官方区分**被动消息**（带 `msg_id`）和**主动消息**（不带）。被动消息有回复时效与次数上限：群聊 5 分钟内每条消息最多回 5 次、单聊 60 分钟内最多回 4 次、频道 5 分钟内不限次数；机器人已按此裁剪回复条数
- 主动消息官方是允许的，但有频控（群 60 qpm、单聊 10 qps、每个群/好友每天 1000 条），且用户能在资料卡里关闭推送；本机器人只用被动消息，不主动找人
- 昵称优先取事件里的 `author.username`，它为空（单聊事件里常见）才退回 `群友xxxx`（openid 尾号）；社区也有反馈「官方拿不到昵称」，实际取决于事件里给不给这个字段
- 发送接口只有 `content` / `markdown` / `media`，**没有 @ 用户的字段**，所以官方渠道的回复只能写昵称、@ 不出来；反过来，群聊里机器人被动回复时 QQ 客户端可能自己带上「@提问者」，若看到重复（`@小明 小明：…`）可以把昵称前缀去掉
- 群聊只推「@了机器人」的消息（`GROUP_AT_MESSAGE_CREATE`）；能看到全部群消息的全量模式（`GROUP_MESSAGE_CREATE`）需要额外权限，本项目没用
- 常见错误码：`40034128` 被动回复时间/次数超限、`40054005` 消息被去重（`msg_id + msg_seq` 重复）、`40054007` 消息长度超限、`40034101/40054003` 机器人不是群成员、`40034105` 主动消息无权限
- 「同时接收频道（子频道）@消息」需要额外开通公域消息权限，没开通时开着它可能连不上网关

## 🌐 网络代理：连不上 Discord / 评判接口时用

**先判断是不是网络问题。** Node 不会使用 Windows/macOS 的"系统代理"设置：浏览器挂了梯子能打开 `discord.com`，机器人却可能报

```
Discord 登录失败：connect ECONNREFUSED 127.0.0.1:443
```

这通常不是代码问题——`discord.com` 被 DNS 解析到了 `127.0.0.1`（校园网/公司网的常见做法），本机 443 又没人监听，于是直连必然失败。`gateway.discord.gg`、`cdn.discordapp.com` 也可能被解析到无关的 IP。**改 DNS 通常没用**（污染来自上游），要么让流量走代理，要么开代理软件的 TUN 模式。

### 在后台里配（推荐）

概览页 →「网络代理（出站）」：

| 字段 | 说明 |
| --- | --- |
| 启用代理 | 勾上才生效 |
| 代理地址 | 填 HTTP 代理，例如 Clash / FlClash 的混合端口 `http://127.0.0.1:7890`；`127.0.0.1:7890` 这样写会自动补 `http://` |
| 代理用户名 / 密码 | 代理需要认证时才填 |
| 不走代理的地址 | 逗号分隔，支持 `*.example.com` 通配；默认 `localhost,127.0.0.1,::1,0.0.0.0`（NapCat 装在本机时不该绕出去），留空表示所有地址都走代理 |

保存后立刻生效（不用重启进程），概览页会显示「已生效」和当前地址。生效范围：

- 评判请求（`fetch`）、QQ 官方机器人的 REST
- Discord 的 REST 和**网关 WebSocket**
- QQ 官方机器人的网关 WebSocket、远程 NapCat 的 WebSocket

要点与限制：

- **只支持 HTTP / HTTPS 代理**（走 CONNECT 隧道）。SOCKS5 不在 Node 原生能力范围内，填了会被配置校验拒绝——请改用代理软件的 TUN 模式（或它的 HTTP 混合端口）
- 只影响机器人的**出站**请求；后台网页服务本身照旧监听 `127.0.0.1`
- 代理日志里会看到 `CONNECT` 记录（undici 连 http 目标也是 CONNECT），这是正常的
- 不能只代理一部分：如果代理规则里 Discord 走直连，机器人一样连不上

### 或者：开 TUN 模式

Clash / FlClash / v2rayN 都支持 TUN（虚拟网卡）模式，它接管整机流量，Node 无需任何配置就能连上。代价是需要管理员权限、可能影响其它软件；如果你已经有 TUN，就不用在这里填代理了。

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

# 第三方转发的 Jev（protocol 可选 typesafe / gateway）
curl -s -X PUT http://127.0.0.1:4319/api/config \
  -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"judge":{"provider":"custom","providers":{"custom":{"baseURL":"https://jev.example.com","apiKey":"relay-xxx","model":"jev-latest","protocol":"typesafe"}}}}'

# 只重连三条通道（不动后台服务）
curl -s -X POST http://127.0.0.1:4319/api/runtime/apply -H "X-Auth-Token: $TOKEN"

# 重启整个进程（换新进程跑，用来让 .env / 依赖 / 代码改动生效）
curl -s -X POST http://127.0.0.1:4319/api/restart -H "X-Auth-Token: $TOKEN"

# 批量导入题目
curl -s -X POST http://127.0.0.1:4319/api/questions \
  -H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"questions":[{"title":"题目名称","puzzle":"汤面","answer":"汤底"}]}'
```

密钥字段的语义：**不传或空串 = 保持原值，`null` = 清空，字符串 = 设置**。未命中的接口路径返回 JSON 404，未登录返回 401。

## 🧪 开发

```bash
npm run lint    # 语法检查 + 跨平台检查（import 路径大小写、只差大小写的重名文件）
npm test        # 单元测试，全部用桩替身，不联网、不碰真实配置与题库、不调用任何 API
npm run check   # lint + test
```

测试覆盖：配置中心（含旧配置迁移、损坏备份、BOM 容错、密钥文件权限）、评判渠道接线（离线构造每个平台的 evaluation model）、三条通道的启停与热重启、后台 API、题库 CRUD、命令解析与各渠道 `/help`、后台界面渲染（在假 DOM 里真跑一遍 `public/app.js`，含抽屉交互）、**进程重启**（spawn 参数 / 守护进程识别 / 新进程起不来时原地恢复 / 接口 200·409·501），以及**并发兜底**（同频道串行、只通关一次、换题期间结果作废、排队上限、全局并发上限、状态回收、并发写盘）。

## 📁 项目结构

```
turtle-soup-bot/
├── .env.example            # 可选的首次运行种子（正常不需要）
├── .gitattributes          # 批处理保持 CRLF，其余统一 LF
├── package.json
├── README.md
├── 启动.bat                # Windows 一键启动（也是"重启进程"的托管者）
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
    ├── proxy.js            # 出站代理（fetch / discord.js REST / ws 三条链路）
    ├── commands.js         # 命令表与各渠道 /help 文案
    ├── runtime.js          # 三条通道的启停与热重启
    ├── restart.js          # 进程重启（有无守护进程两种走法）
    ├── CommandHandler.js   # 共享命令处理器
    ├── game/
    │   ├── QuestionStore.js # 题库管理（原子写 / 损坏备份）
    │   ├── JevJudge.js      # 评判封装（是/不是 + 相似度）
    │   ├── sentences.js     # /ask 的拆句（本地完成，不花评判调用）
    │   └── GameManager.js   # 游戏状态机（提问串行、逐句核对、通关判定）
    ├── judge/
    │   └── providers.js     # 评判入口登记表（入口 → 依赖包 → 模型工厂，含中转协议）
    ├── platforms/
    │   ├── discord.js       # Discord（原生斜杠命令）
    │   ├── discordCommands.js # 斜杠命令注册与去重
    │   ├── typing.js        # Discord「正在输入…」状态（续期 + 结束）
    │   ├── onebot.js        # QQ（NapCat / OneBot v11）
    │   ├── qq-official.js   # QQ 官方机器人开放平台
    │   └── format.js        # 各平台共用的回复文案（是/不是、逐句核对清单）
    ├── web/server.js        # 后台界面服务 + API
    └── utils/
        ├── logger.js
        └── strings.js       # 密钥占位符判断 / 去 BOM 等小工具
```
