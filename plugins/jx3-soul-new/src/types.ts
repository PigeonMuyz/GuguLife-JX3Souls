/**
 * AI 配置接口
 * @interface aiConfig
 */
interface aiConfig {
  /**
   * 模型提供商配置
   * @property {object} modelProvider - 提供商信息
   */
  modelProvider: {
    /** 提供商名称 */
    name: string;
    /** API 地址 */
    url: string;
    /** 响应类型，支持 OpenAI 或 Anthropic 格式 */
    responseType: "openai" | "anthropic" | "google-beta" | "openai-responses";
    /**
     * 全局token
     */
    accessToken: string;
    /**
     * 模型供应商权重
     */
    modelProviderWeight: number;
  };
  /**
   * 模型列表
   * @type {model[]}
   */
  models: model[];
}

/**
 * 模型配置接口
 * @interface model
 */
interface model {
  /**
   * 模型唯一标识符
   */
  id: string;
  /**
   * 模型显示名称
   */
  name: string;
  /**
   * 是否支持思考模式
   */
  supportThinking: boolean;
  /**
   * 支持的不同工作级别（仅豆包）
   * @type {"high"|"medium"|"low"|"minimal"|"none"}
   */
  supportEffort?: "high" | "medium" | "low" | "minimal" | "none";
  /**
   * 仅适用于这个模型的token
   */
  accessToken?: string;
  /**
   * 模型权重
   */
  modelWeight?: number;
  /**
   * 是否使用流式输出（仅 Anthropic 协议）
   */
  stream?: boolean;
  /**
   * 是否有每日使用限制
   */
  dailyLimit?: boolean;
}

/**
 * 每日模型使用记录
 */
interface SoulDailyModelUsage {
  id?: number;
  userId: string;
  platform: string;
  modelId: string;      // 模型ID
  usageDate: string;    // YYYY-MM-DD
  createdAt: number;
}

/**
 * 服务器预设
 */
interface serverPreset {
  /**
   * 主服名
   */
  server: string;

  /**
   * 别名
   */
  alias: string[];
}

/**
 * 情缘档案
 */
interface SoulProfile {
  id?: number;
  userId: string;
  platform: string;
  groupId: string;

  /**
   * 服务器列表（空格分隔）
   */
  servers: string;
  /**
   * 大号角色名
   */
  characterName: string;
  /**
   * 角色类型（空格分隔）
   */
  characterTypes: string;
  /**
   * 主要玩法（空格分隔，PVP PVE 其他）
   */
  gameplay: string;
  /**
   * 个人期待（对另一半的要求、避雷点等）
   */
  expectations: string;
  /**
   * 自我介绍
   */
  introduction: string;
  /**
   * 真实性别
   */
  gender: string;
  /**
   * 期待对方性别
   */
  preferGender: string;
  /**
   * 是否接受跨服
   */
  crossServer: string;
  /**
   * 是否接受涉三（奔现）
   */
  realMeetup: string;

  /**
   * 角色名片（last为最新那个）
   */
  characterImageUrl?: string[];

  /**
   * 玩家货币
   */
  coins: number | 0;

  /**
   * 出生年份
   */
  birthYear?: number;
  /**
   * IP属地/常驻地
   */
  location?: string;

  createdAt: number;
  updatedAt: number;

  /**
   * AI 自定义人设提示词
   */
  aiPrompt?: string;
  /**
   * 上次退出时残统的 AI 浓缩记忆
   */
  aiSummary?: string;
  /**
   * 档案语义向量（用于匹配预筛）
   */
  embedding?: number[];
}

/**
 * 归档情缘档案
 */
interface SoulArchivedProfile {
  id?: number;
  userId: string;
  platform: string;
  groupId: string;
  profileId: number; // 对应的soul_profiles.id
  archivedBy: string; // 封存操作者(管理员ID或用户自己)
  archiveReason: string; // 封存原因
  archivedAt: number;
  unArchivedAt?: number; // 解封时间（可选）
  unArchivedBy?: string; // 解封操作者（可选）
}

/**
 * AI请求数据
 */
interface AIRequestData {
  /**
   * 模型ID
   */
  model: string;
  /**
   * 消息{role: 角色,content: 内容}
   */
  messages: { role: string; content: string }[];
  /**
   * 温度
   */
  temperature: number;
  /**
   * 最大输出token长度
   */
  max_tokens: number;
  /**
   * 是否开启思考
   */
  thinking?: {
    type: string;
  };
  /**
   * 是否可调思考
   */
  reasoning_effort?: string;
}

// 排除匹配记录
interface SoulExclusion {
  id?: number;
  userId: string;
  platform: string;
  excludedUserId: string;
  reason?: string;
  createdAt: number;
}

// 保底限制记录
interface SoulBonusRestrictions {
  id?: number;
  userId: string;
  groupId: string;
  platform: string;
  targetUserId: string;
  createdAt: number;
}

// 匹配统计记录
interface SoulMatchStats {
  userId: string;
  platform: string;
  matchCount: number;        // 用于保底概率计算（保底触发后重置）
  totalMatchCount: number;   // 永久统计：自己发起匹配的总次数
  matchedByCount: number;    // 永久统计：被他人匹配到的次数
  lastMatchAt: number;
  bonusProbability?: number;
}

/**
 * 拉黑名单记录
 */
interface SoulBlacklist {
  id?: number;
  userId: string;
  platform: string;
  reason: string;
  createdAt: number;
  createdBy: string; // 拉黑操作的管理员ID
}

/**
 * 定向匹配冷却记录
 */
interface DirectedMatchCooldown {
  id?: number;
  userId: string;
  platform: string;
  cooldownUntil: number; // 冷却结束时间戳
  createdAt: number;
}

/**
 * 匿名表白记录
 */
interface SoulConfession {
  id?: number;
  fromUserId: string;           // 发起人ID
  toUserId: string;             // 接收方ID
  platform: string;
  message: string;              // 表白内容
  status: string;               // 'pending' | 'viewed' | 'accepted' | 'rejected' | 'expired'
  fromUserPaid: number;         // 发起人已付费用 (200)
  toUserPaid: number;           // 接收方已付费用 (0 或 100)
  fromUserRefunded: number;     // 发起人已返还 (0 或 100)
  toUserRefunded: number;       // 接收方已返还 (0 或 50)
  createdAt: number;
  viewedAt?: number;            // 接收方查看发起人时间
  respondedAt?: number;         // 接收方回应时间
}

/**
 * 匹配历史记录（谁匹配到了谁）
 */
interface SoulMatchHistory {
  id?: number;
  matcherId: string;        // 发起匹配者ID
  matchedId: string;        // 被匹配者ID
  matcherPlatform: string;
  matchedPlatform: string;
  matchType: string;        // 'normal' | 'advanced' | 'bonus' | 'directed'
  createdAt: number;
}

/**
 * 群红包记录
 */
interface SoulRedPacket {
  id?: number;
  senderId: string;
  senderPlatform: string;
  groupId: string;
  totalAmount: number;        // 红包总额
  remainingAmount: number;    // 剩余金额
  totalCount: number;         // 红包个数
  remainingCount: number;     // 剩余个数
  password?: string;          // 口令（可选）
  receivers: string;          // JSON: [{userId, amount, time}]
  createdAt: number;
  expiredAt: number;
}

export {
  aiConfig,
  model,
  serverPreset,
  SoulProfile,
  SoulArchivedProfile,
  AIRequestData,
  SoulExclusion,
  SoulBonusRestrictions,
  SoulMatchStats,
  SoulBlacklist,
  DirectedMatchCooldown,
  SoulConfession,
  SoulMatchHistory,
  SoulRedPacket,
  SoulDailyModelUsage,
  SoulPartner,
  SoulAiWhitelist,
  SoulMatchWhitelist,
  SoulProactiveSession,
  SoulProactiveOptout,
  SoulProactiveQueue,
};

/**
 * 匹配白名单（锁定匹配模式）
 * 用户只能匹配到白名单中的人，新建档案的用户也会被自动排除
 */
interface SoulMatchWhitelist {
  id?: number;
  userId: string;              // 设置白名单的用户
  platform: string;
  whitelistedUserId: string;   // 白名单中的目标用户
  defaultExclude: boolean;     // 是否自动排除所有非白名单用户（含新用户）
  createdAt: number;
}

/**
 * 情缘绑定关系
 */
interface SoulPartner {
  id?: number;
  userA_id: string; // 较小的ID
  userB_id: string; // 较大的ID
  platform: string;
  confirmed_at: number; // 确立关系时间
  created_at: number;
}

/**
 * AI 连续对话 免扣费白名单
 */
interface SoulAiWhitelist {
  id?: number;
  userId: string;
  platform: string;
  createdAt: number;
}

/**
 * 红娘主动出击 - 对话会话记录
 */
interface SoulProactiveSession {
  id?: number;
  userId: string;                // 被联系的用户
  platform: string;
  matchedUserId: string | null;  // 匹配到的对象（对话中执行匹配后填入）
  matchScore: number;            // 匹配分数
  matchAnalysis: string;         // 匹配分析
  status: string;                // chatting / matched / proxy_requested / proxy_sent / accepted / rejected / ended / opted_out / timeout
  conversationLog: string;       // JSON 格式对话记录
  createdAt: number;
  updatedAt: number;
}

/**
 * 红娘主动出击 - 永久退出名单
 */
interface SoulProactiveOptout {
  id?: number;
  userId: string;
  platform: string;
  createdAt: number;
}

/**
 * 红娘主动出击 - 轮转队列
 * 记录每一轮已被联系过的用户，确保不重复
 */
interface SoulProactiveQueue {
  id?: number;
  userId: string;
  platform: string;
  roundId: number;     // 当前轮次编号
  contactedAt: number; // 联系时间
}
