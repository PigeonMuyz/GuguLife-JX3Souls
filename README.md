# 🐦 渡渡鸟情缘机器人 (GuguLife-JX3Souls)

> 基于 [Koishi](https://koishi.chat) 框架的剑网3情缘匹配 QQ 机器人

一个功能丰富的剑网3情缘匹配机器人，支持智能匹配、AI 对话、签到经济系统等多种玩法。

## ✨ 核心功能

| 模块 | 描述 |
|------|------|
| 📋 档案管理 | 登记/更新情缘档案，包含服务器、门派体型、玩法偏好等 |
| 💕 情缘匹配 | 普通匹配、AI 高级匹配、向量匹配、定向匹配 |
| 💘 单相思模式 | 锁定匹配目标，只匹配到指定的人 |
| 💌 匿名表白 | 向指定用户发送匿名表白 |
| 🤖 AI 对话 | 支持 Claude / Gemini 等多模型连续对话 |
| 🔮 缘分签 | AI 生成每日缘分运势 |
| 🚄 旅行助手 | 智能行程规划（火车票查询、中转方案） |
| 🪙 咕咕币经济 | 签到、商城兑换、V50 转账、红包 |
| 📊 数据统计 | 周报、排行榜、匹配洞察 |
| 🏆 成就系统 | 基于使用数据的成就解锁 |
| 📢 档案推广 | 竞价推广自己的档案到群聊 |

完整命令列表请参阅 [COMMANDS.md](./plugins/jx3-soul-new/COMMANDS.md)。

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18.x
- **Yarn** 4.x（项目使用 Yarn Workspaces）
- **QQ 协议端**：需要 OneBot V11 兼容实现（如 [NapCat](https://github.com/NapNeko/NapCatQQ)、[Lagrange](https://github.com/LagrangeDev/Lagrange.Core) 等）

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/PigeonMuyz/GuguLife-JX3Souls.git
cd GuguLife-JX3Souls

# 2. 安装依赖
yarn install

# 3. 配置（见下方「配置说明」）
# 编辑 koishi.yml 和插件源码中的配置

# 4. 编译并启动
bash quick-start-simple.sh
```

启动后访问 `http://localhost:5140` 进入 Koishi 控制台。

## ⚙️ 配置说明

### 1. QQ 适配器配置（必须）

编辑 `koishi.yml`，找到 `adapter-onebot` 部分：

```yaml
adapter-onebot:axrqqs:
  path: /onebot/v11/ws
  endpoint: ws://127.0.0.1:2333/     # 改为你的 OneBot 协议端 WebSocket 地址
  token: your-token-here              # 改为你的 OneBot 连接 Token
  selfId: '000000000'                 # 改为你的机器人 QQ 号
```

### 2. 插件核心配置（必须）

编辑 `plugins/jx3-soul-new/src/config.ts`：

```typescript
// ===== 管理员 QQ 号 =====
const ADMIN_IDS: string[] = ["YOUR_ADMIN_QQ_1", "YOUR_ADMIN_QQ_2"];
// 替换为你的管理员 QQ 号，例如：["123456789", "987654321"]

// ===== JX3API Token =====
const jx3api = {
  tokenv2: "YOUR_JX3API_TOKEN",
  // 从 https://www.jx3api.com 获取
};

// ===== MinIO 对象存储（用于角色名片存储） =====
const minioConfig = {
  endpoint: "YOUR_MINIO_HOST",        // MinIO 服务器地址
  port: 9000,                         // MinIO 端口
  accessKey: "YOUR_MINIO_ACCESS_KEY", // MinIO Access Key
  secretKey: "YOUR_MINIO_SECRET_KEY", // MinIO Secret Key
  bucket: "gugubird",                 // 存储桶名称
};
```

### 3. AI 模型 API 配置（必须）

以下文件中使用了 AI API，需要替换为你自己的 Key：

| 文件 | 用途 | 需要的 Key 类型 |
|------|------|-----------------|
| `src/commands/ai-chat.ts` | AI 连续对话 | OpenAI 兼容 API Key |
| `src/commands/directed-match.ts` | 定向匹配 AI 分析 | Anthropic / OpenAI 兼容 API Key |
| `src/commands/fortune.ts` | 缘分签生成 | ModelScope API Token |
| `src/commands/proactive-match.ts` | 红娘主动出击 | ModelScope API Token |
| `src/commands/profile-score.ts` | 档案评分 | ModelScope API Token |
| `src/commands/travel-assistant.ts` | 旅行助手 | OpenAI 兼容 API Key |
| `src/utils/match.ts` | 匹配 AI 分析 | OpenAI 兼容 API Key |
| `src/utils/fortune.ts` | 运势生成 | Anthropic / OpenAI 兼容 API Key |
| `src/utils/universal.ts` | 通用 AI 调用 | ModelScope API Token |

**替换方法**：在上述文件中搜索 `YOUR_API_KEY` 或 `YOUR_MODELSCOPE_TOKEN`，替换为你的 Key。

> 💡 **API 兼容性**：项目支持 OpenAI、Anthropic、Google (Gemini) 三种 API 协议格式，你可以使用任何兼容这些协议的第三方中转服务。

### 4. 群号配置（必须）

以下文件中硬编码了群号（标记为 `YOUR_GROUP_ID_1` / `YOUR_GROUP_ID_2`），需要替换为你的实际群号：

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 主群 ID、欢迎消息群列表 |
| `src/commands/archive.ts` | 有效群列表（哪些群的成员可以登记档案） |
| `src/commands/blacklist.ts` | 黑名单扫描群 |
| `src/commands/match.ts` | 匹配功能群 |
| `src/commands/partner.ts` | 情缘绑定默认群 |
| `src/commands/promotion.ts` | 档案推广目标群 |

**替换方法**：全局搜索 `YOUR_GROUP_ID_1` 和 `YOUR_GROUP_ID_2`，替换为你的群号。

### 5. API 服务地址配置

以下文件中包含 `YOUR_API_HOST:PORT` 占位符，替换为你的 AI API 中转/代理服务地址：

| 文件 | 说明 |
|------|------|
| `src/commands/directed-match.ts` | Anthropic API 地址 |
| `src/utils/fortune.ts` | AI 运势生成 API 地址 |
| `src/utils/match.ts` | 匹配分析 API 地址 |

## 🏗️ 项目结构

```
GuguLife-JX3Souls/
├── koishi.yml                 # Koishi 框架配置
├── package.json               # 项目依赖
├── tsconfig.json              # TypeScript 配置
├── tsconfig.base.json         # TypeScript 基础配置
├── yakumo.yml                 # 构建工具配置
├── quick-start-simple.sh      # 快速启动脚本
├── .env                       # 环境变量
└── plugins/
    └── jx3-soul-new/          # 情缘匹配核心插件
        ├── package.json
        ├── tsconfig.json
        ├── COMMANDS.md        # 完整命令手册
        └── src/
            ├── index.ts       # 插件入口（数据表定义、命令注册）
            ├── config.ts      # 全局配置（管理员、服务器列表、API 密钥）
            ├── types.ts       # 类型定义
            ├── v50.ts         # V50 转账 & 劫镖系统
            ├── commands/      # 命令模块
            │   ├── archive.ts          # 档案管理
            │   ├── match.ts            # 情缘匹配
            │   ├── directed-match.ts   # 定向匹配
            │   ├── proactive-match.ts  # 红娘主动出击
            │   ├── confession.ts       # 匿名表白
            │   ├── ai-chat.ts          # AI 连续对话
            │   ├── travel-assistant.ts # 旅行助手
            │   ├── fortune.ts          # 缘分签
            │   ├── checkin.ts          # 签到打卡
            │   ├── mall.ts             # 咕咕币商城
            │   ├── lottery.ts          # 抽奖
            │   ├── redpacket.ts        # 红包
            │   ├── quiz.ts             # 问卷
            │   ├── promotion.ts        # 档案推广
            │   ├── partner.ts          # 情缘关系
            │   ├── blacklist.ts        # 黑名单管理
            │   ├── admin.ts            # 管理员命令
            │   ├── achievement.ts      # 成就系统
            │   ├── ranking.ts          # 排行榜
            │   ├── profile-card.ts     # 档案名片
            │   ├── profile-score.ts    # 档案评分
            │   ├── weekly-report.ts    # 周报
            │   └── handover.ts         # 交接
            ├── config/
            │   └── quizzes/            # 问卷题库 (Quiz_1~5.json)
            └── utils/
                ├── match.ts            # 匹配算法 & AI 调用
                ├── universal.ts        # 通用 AI 工具
                ├── fortune.ts          # 运势生成工具
                ├── jx3box-api.ts       # JX3Box API 封装
                └── jx3box-analyzer.ts  # JX3Box 数据分析
```

## 📦 技术栈

- **框架**: [Koishi.js](https://koishi.chat) v4
- **语言**: TypeScript
- **数据库**: SQLite（通过 Koishi 数据库插件）
- **QQ 协议**: OneBot V11
- **AI**: 支持 OpenAI / Anthropic / Google Gemini / ModelScope 多种模型
- **对象存储**: MinIO（角色名片存储）

## 📄 开源协议

本项目基于 [AGPL-3.0](LICENSE) 协议开源。

## 🙏 致谢

- [Koishi.js](https://koishi.chat) - 跨平台机器人框架
- [JX3API](https://www.jx3api.com) - 剑网3数据接口
- [JX3Box](https://www.jx3box.com) - 剑网3资料站
