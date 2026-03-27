import { Context } from "koishi";
import {
  SoulProfile,
  SoulArchivedProfile,
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
} from "./types";
import { ADMIN_IDS } from "./config";
import { registerArchiveCommands, registerViewProfileCommand, registerResetExclusionListCommand } from "./commands/archive";
import { registerMatchCommands } from "./commands/match";
import { registerCheckinCommands } from "./commands/checkin";
import { registerMallCommands } from "./commands/mall";
import { registerRankingCommands } from "./commands/ranking";
import { registerBlacklistCommands } from "./commands/blacklist";
import { registerAdminCommands } from "./commands/admin";
import { registerDirectedMatchCommands } from "./commands/directed-match";
import { registerProfileCardCommands } from "./commands/profile-card";
import { registerConfessionCommands } from "./commands/confession";
import { registerLotteryCommands } from "./commands/lottery";
import { registerRedPacketCommands } from "./commands/redpacket";
import { registerQuizCommands } from "./commands/quiz";
import { registerPromotionCommands, cleanupExpiredPromotions } from "./commands/promotion";
import { registerTravelAssistantCommands } from "./commands/travel-assistant";
import { registerPartnerCommands } from "./commands/partner";
import { registerHandoverCommands } from "./commands/handover";
import { registerFortuneCommands } from "./commands/fortune";
import { registerWeeklyReportCommands } from "./commands/weekly-report";
import { registerProfileScoreCommands } from "./commands/profile-score";
import { registerAiChatCommands } from "./commands/ai-chat";
import { registerProactiveMatchCommands, scheduleProactiveMatch } from "./commands/proactive-match";
import { registerAchievementCommands } from "./commands/achievement";
import { registerV50Listener } from "./v50";

// 插件入口
export const name = "jx3-soul-new";
export const version = "1.0.0";
export const using = ["database"];

// 插件配置类型
export interface Config { }

// 进行中的匹配
export const ongoingMatches = new Map<string, number>();
//
export const postMatchExclusionTrack = new Map<
  string,
  { matchTime: number; exclusionCount: number }
>();

// 等待确认的联系请求
export const pendingContactRequests = new Map<
  string,
  {
    targetUserId: string;
    matchResult: string;
    startTime: number;
  }
>();

// 定向匹配等待确认的请求
export const pendingDirectedMatchRequests = new Map<
  string,
  {
    requesterId: string;
    requesterPlatform: string;
    targetUserId: string;
    startTime: number;
  }
>();

// 扩展Koishi的Tables类型
declare module "koishi" {
  interface Tables {
    soul_profiles: SoulProfile;
    soul_archived_profiles: SoulArchivedProfile;
    soul_exclusions: SoulExclusion;
    soul_bonus_restrictions: SoulBonusRestrictions;
    soul_match_stats: SoulMatchStats;
    soul_blacklist: SoulBlacklist;
    directed_match_cooldowns: DirectedMatchCooldown;
    soul_confessions: SoulConfession;
    questionnaire_results: {
      id: number;
      userId: string;
      platform: string;
      passed: boolean;
      passedAt: number;
      answers: string;
      createdAt: number;
      updatedAt: number;
    };
    questionnaire_whitelist: {
      id: number;
      userId: string;
      platform: string;
      createdAt: number;
    };
    // jx3-specfriends plugin tables (for cross-plugin access)
    spec_friends_profiles: {
      id: number;
      userId: string;
      platform: string;
      servers: string;
      characterName: string;
      characterTypes: string;
      introduction: string;
      interests: string;
      friendExpectations: string;
      crossServer: string;
      createdAt: number;
      updatedAt: number;
    };
    daily_rewards: {
      id: number;
      userId: string;
      platform: string;
      // New unified fields
      lastCheckinDate: string | null;
      lastActivityDate: string | null;
      dailyActivityCoins: number;
      dailyMessageCount: number;  // 今日发言次数
      // Legacy fields (kept for compatibility)
      lastGroupMessageRewardDate: string | null;
      lastGroupCheckinRewardDate: string | null;
      lastPrivateCheckinRewardDate: string | null;
      createdAt: number;
      updatedAt: number;
    };
    soul_v50_free_records: {
      id: number;
      userId: string;
      platform: string;
      freeDate: string; // YYYY-MM-DD 格式
      createdAt: number;
    };
    soul_v50_transfer_records: {
      id: number;
      senderId: string;
      receiverId: string;
      platform: string;
      transferDate: string; // YYYY-MM-DD
      count: number;
    };
    soul_command_usage: {
      id: number;
      userId: string;
      platform: string;
      command: string;
      count: number;
      streakData: string | null;  // JSON 格式存储连击状态
      createdAt: number;
      updatedAt: number;
    };
    // 咕咕币兑换商城相关表
    mall_products: {
      id: number;
      name: string;
      description: string;
      category: string;
      price: number;
      stock: number;
      item_type: "ai_image" | "ai_video" | "physical" | any;
      item_config: any; // 存储AI类型商品的具体配置
      is_active: boolean;
      createdAt: number;
      updatedAt: number;
    };
    mall_exchange_records: {
      id: number;
      userId: string;
      platform: string;
      product_id: number;
      product_name: string;
      coins_used: number;
      status: "pending" | "processing" | "shipped" | "completed" | "cancelled";
      exchange_date: number;
      order_id: string; // 订单唯一标识
      remarks: string | null;
      updatedAt: number;
    };
    // 成员白名单（眼熟用户，管理员标记保留）
    soul_member_whitelist: {
      id: number;
      userId: string;
      groupId: string;
      platform: string;
      nickname: string; // 群名片/昵称，便于识别
      reason: string;   // 标记原因
      createdBy: string; // 标记的管理员
      createdAt: number;
    };
    soul_match_history: SoulMatchHistory;
    soul_red_packets: SoulRedPacket;
    // 档案推广竞价记录
    soul_promotions: {
      id: number;
      userId: string;
      platform: string;
      groupId: string;
      type: "essence" | "notice";
      bidAmount: number;           // 竞价金额
      withAiSummary: boolean;
      messageId: string | null;    // 精华消息ID
      noticeId: string | null;     // 群公告ID
      periodId: string;            // 周期标识 YYYY-MM-DD
      isActive: boolean;           // 是否当前有效
      createdAt: number;
      expiredAt: number;           // 过期时间
      cleanedUpAt: number | null;  // 清理时间
      replacedBy: string | null;   // 被谁顶替
      replacedAt: number | null;   // 被顶替时间
    };
    // 每日模型使用记录
    soul_daily_model_usage: SoulDailyModelUsage;
    // 情缘绑定关系
    soul_partners: SoulPartner;
    // AI连续对话免流白名单
    soul_ai_whitelist: SoulAiWhitelist;
    soul_match_whitelist: SoulMatchWhitelist;
    soul_proactive_sessions: SoulProactiveSession;
    soul_proactive_optout: SoulProactiveOptout;
    soul_proactive_queue: SoulProactiveQueue;
  }
}

// 插件入口函数
export function apply(ctx: Context, config: Config = {}) {
  // 使用ctx.logger记录日志
  const logger = ctx.logger;

  // 定义数据表结构
  ctx.model.extend(
    "soul_partners",
    {
      id: "unsigned",
      userA_id: "string",
      userB_id: "string",
      platform: "string",
      confirmed_at: "unsigned",
      created_at: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userA_id", "platform"], ["userB_id", "platform"]], // 确保每个人只能有一个情缘
    }
  );

  ctx.model.extend(
    "soul_profiles",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      groupId: "string",
      servers: "string",
      characterName: "string",
      characterTypes: "string",
      gameplay: "string",
      expectations: "text",
      introduction: "text",
      gender: "string",
      preferGender: "string",
      crossServer: "string",
      realMeetup: "string",
      characterImageUrl: { type: "json" },
      coins: { type: "integer", initial: 20 },
      birthYear: { type: "integer", nullable: true },
      location: { type: "string", nullable: true },
      createdAt: "unsigned",
      updatedAt: "unsigned",
      aiPrompt: { type: 'text', initial: '' },
      aiSummary: { type: 'text', initial: '' },
      embedding: { type: 'json', nullable: true },
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );
  ctx.model.extend(
    "soul_ai_whitelist",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );
  ctx.model.extend(
    "soul_archived_profiles",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      groupId: "string",
      profileId: "integer",
      archivedBy: "string",
      archiveReason: "text",
      archivedAt: "unsigned",
      unArchivedAt: "unsigned",
      unArchivedBy: "string",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["profileId"]],
    }
  );
  ctx.model.extend(
    "soul_exclusions",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      excludedUserId: "string",
      reason: { type: "string", initial: "" },
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "excludedUserId"]],
    }
  );
  // 扩展保底限制表
  ctx.model.extend(
    "soul_bonus_restrictions",
    {
      id: "unsigned",
      userId: "string",
      groupId: "string",
      platform: "string",
      targetUserId: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 匹配统计表
  ctx.model.extend(
    "soul_match_stats",
    {
      userId: "string",
      platform: "string",
      matchCount: { type: "unsigned", initial: 0 },
      totalMatchCount: { type: "unsigned", initial: 0 },
      matchedByCount: { type: "unsigned", initial: 0 },
      lastMatchAt: "unsigned",
      bonusProbability: "float",
    },
    {
      primary: ["userId", "platform"],
    }
  );

  // 拉黑记录表
  ctx.model.extend(
    "soul_blacklist",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      reason: "string",
      createdAt: "unsigned",
      createdBy: "string",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // 问卷结果表
  ctx.model.extend(
    "questionnaire_results",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      passed: "boolean",
      passedAt: "unsigned",
      answers: "text",
      createdAt: "unsigned",
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // 问卷白名单表
  ctx.model.extend(
    "questionnaire_whitelist",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // 每日奖励记录表
  ctx.model.extend(
    "daily_rewards",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      // New unified fields
      lastCheckinDate: { type: "string", nullable: true },
      lastActivityDate: { type: "string", nullable: true },
      dailyActivityCoins: { type: "integer", initial: 0 },
      dailyMessageCount: { type: "integer", initial: 0 },  // 今日发言次数
      // Legacy fields (kept for compatibility)
      lastGroupMessageRewardDate: { type: "string", nullable: true },
      lastGroupCheckinRewardDate: { type: "string", nullable: true },
      lastPrivateCheckinRewardDate: { type: "string", nullable: true },
      createdAt: "unsigned",
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // V50免费转账记录
  ctx.model.extend(
    "soul_v50_free_records",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      freeDate: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "freeDate"]],
    }
  );

  // V50每日转账次数记录
  ctx.model.extend(
    "soul_v50_transfer_records",
    {
      id: "unsigned",
      senderId: "string",
      receiverId: "string",
      platform: "string",
      transferDate: "string",
      count: { type: "integer", initial: 0 },
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["senderId", "receiverId", "platform", "transferDate"]],
    }
  );

  // 咕咕币命令使用次数
  ctx.model.extend(
    "soul_command_usage",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      command: "string",
      count: { type: "integer", initial: 0 },
      streakData: { type: "text", nullable: true },  // JSON 格式存储连击状态
      createdAt: "unsigned",
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "command"]],
    }
  );

  // 咕咕币兑换商城相关表
  ctx.model.extend(
    "mall_products",
    {
      id: "unsigned",
      name: "string",
      description: "text",
      category: "string",
      price: "unsigned",
      stock: "unsigned",
      item_type: "string",
      item_config: "json",
      is_active: "boolean",
      createdAt: "unsigned",
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  ctx.model.extend(
    "mall_exchange_records",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      product_id: "unsigned",
      product_name: "string",
      coins_used: "unsigned",
      status: "string",
      exchange_date: "unsigned",
      order_id: "string",
      remarks: { type: "text", nullable: true },
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 成员白名单表（眼熟用户）
  ctx.model.extend(
    "soul_member_whitelist",
    {
      id: "unsigned",
      userId: "string",
      groupId: "string",
      platform: "string",
      nickname: "string",
      reason: "string",
      createdBy: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "groupId", "platform"]],
    }
  );

  // 定向匹配冷却表
  ctx.model.extend(
    "directed_match_cooldowns",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      cooldownUntil: "unsigned",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // 匿名表白记录表
  ctx.model.extend(
    "soul_confessions",
    {
      id: "unsigned",
      fromUserId: "string",
      toUserId: "string",
      platform: "string",
      message: "text",
      status: "string",
      fromUserPaid: { type: "integer", initial: 0 },
      toUserPaid: { type: "integer", initial: 0 },
      fromUserRefunded: { type: "integer", initial: 0 },
      toUserRefunded: { type: "integer", initial: 0 },
      createdAt: "unsigned",
      viewedAt: { type: "unsigned", nullable: true },
      respondedAt: { type: "unsigned", nullable: true },
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 匹配历史表（谁匹配到了谁）
  ctx.model.extend(
    "soul_match_history",
    {
      id: "unsigned",
      matcherId: "string",
      matchedId: "string",
      matcherPlatform: "string",
      matchedPlatform: "string",
      matchType: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 群红包表
  ctx.model.extend(
    "soul_red_packets",
    {
      id: "unsigned",
      senderId: "string",
      senderPlatform: "string",
      groupId: "string",
      totalAmount: "unsigned",
      remainingAmount: "unsigned",
      totalCount: "unsigned",
      remainingCount: "unsigned",
      password: { type: "string", nullable: true },
      receivers: "text",
      createdAt: "unsigned",
      expiredAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 档案推广竞价记录表
  ctx.model.extend(
    "soul_promotions",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      groupId: "string",
      type: "string",
      bidAmount: "unsigned",
      withAiSummary: "boolean",
      messageId: { type: "string", nullable: true },
      noticeId: { type: "string", nullable: true },
      periodId: "string",
      isActive: { type: "boolean", initial: true },
      createdAt: "unsigned",
      expiredAt: "unsigned",
      cleanedUpAt: { type: "unsigned", nullable: true },
      replacedBy: { type: "string", nullable: true },
      replacedAt: { type: "unsigned", nullable: true },
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 每日模型使用记录表
  ctx.model.extend(
    "soul_daily_model_usage",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      modelId: "string",
      usageDate: "string",      // YYYY-MM-DD
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "modelId", "usageDate"]],
    }
  );

  // 匹配白名单表（锁定匹配模式）
  ctx.model.extend(
    "soul_match_whitelist",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      whitelistedUserId: "string",
      defaultExclude: "boolean",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "whitelistedUserId"]],
    }
  );

  // 红娘主动出击 - 对话会话表
  ctx.model.extend(
    "soul_proactive_sessions",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      matchedUserId: { type: "string", nullable: true },
      matchScore: { type: "integer", initial: 0 },
      matchAnalysis: { type: "text", initial: "" },
      status: { type: "string", initial: "chatting" },
      conversationLog: { type: "text", initial: "[]" },
      createdAt: "unsigned",
      updatedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
    }
  );

  // 红娘主动出击 - 永久退出表
  ctx.model.extend(
    "soul_proactive_optout",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      createdAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform"]],
    }
  );

  // 红娘主动出击 - 轮转队列表
  ctx.model.extend(
    "soul_proactive_queue",
    {
      id: "unsigned",
      userId: "string",
      platform: "string",
      roundId: { type: "integer", initial: 1 },
      contactedAt: "unsigned",
    },
    {
      primary: "id",
      autoInc: true,
      unique: [["userId", "platform", "roundId"]],
    }
  );

  // 注册所有命令
  registerArchiveCommands(ctx);
  registerMatchCommands(ctx);
  registerCheckinCommands(ctx);
  registerMallCommands(ctx);
  registerRankingCommands(ctx);
  registerBlacklistCommands(ctx);
  registerViewProfileCommand(ctx);
  registerResetExclusionListCommand(ctx);
  registerAdminCommands(ctx);
  registerDirectedMatchCommands(ctx);
  registerProfileCardCommands(ctx);
  registerConfessionCommands(ctx);
  registerLotteryCommands(ctx);
  registerRedPacketCommands(ctx);
  registerQuizCommands(ctx);
  registerPromotionCommands(ctx);
  registerTravelAssistantCommands(ctx);
  registerPartnerCommands(ctx);
  registerHandoverCommands(ctx);
  registerFortuneCommands(ctx);
  registerAchievementCommands(ctx);
  registerWeeklyReportCommands(ctx);
  registerProfileScoreCommands(ctx);
  registerAiChatCommands(ctx);
  registerProactiveMatchCommands(ctx);

  // 注册v50转账功能
  registerV50Listener(ctx);

  // 定时检查群成员是否有拉黑用户功能
  // ------------------------------------------------------------
  const GROUP_ID = "YOUR_GROUP_ID_1";
  const CHECK_TIMES = [
    { hour: 9, minute: 0 },   // 每天上午9点
    { hour: 15, minute: 0 }   // 每天下午3点
  ];

  // 保存定时器引用，用于插件卸载时清理
  const scheduledTimers: ReturnType<typeof setTimeout>[] = [];

  // 注册红娘主动出击定时任务
  scheduleProactiveMatch(ctx, scheduledTimers);

  // 获取群成员列表
  async function getGroupMembers(groupId: string): Promise<string[]> {
    const bot = ctx.bots.find(b => b.platform === "onebot");
    if (!bot) {
      ctx.logger.error("未找到OneBot机器人实例");
      return [];
    }

    try {
      // 使用OneBot的getGroupMemberList接口获取群成员列表
      const members = await bot.internal.getGroupMemberList(groupId);
      if (!members || !Array.isArray(members)) {
        ctx.logger.error("获取群成员列表失败：返回数据无效");
        return [];
      }

      // 提取用户ID列表并去重
      const memberIds = new Set(members.map(member => member.user_id?.toString() || "").filter(id => id));
      return Array.from(memberIds);
    } catch (error) {
      ctx.logger.error(`获取群成员列表失败：${error}`);
      return [];
    }
  }

  // 检查群成员是否有拉黑用户并通知管理员
  async function checkBlacklistMembers() {
    ctx.logger.info("开始检查群成员拉黑情况");

    try {
      // 获取群成员列表
      const groupMembers = await getGroupMembers(GROUP_ID);
      ctx.logger.info(`获取到群成员 ${groupMembers.length} 人`);

      if (groupMembers.length === 0) {
        ctx.logger.warn("未获取到任何群成员，检查终止");
        return;
      }

      // 获取所有拉黑用户
      const blacklist = await ctx.database.get("soul_blacklist", {});
      ctx.logger.info(`获取到拉黑用户 ${blacklist.length} 人`);

      if (blacklist.length === 0) {
        ctx.logger.info("当前没有拉黑用户，检查终止");
        return;
      }

      // 检查是否有匹配的用户
      const matchedUsers = new Map<string, SoulBlacklist>();

      for (const item of blacklist) {
        const normalizedBlacklistId = item.userId.replace(/^.*:/, "");

        for (const memberId of groupMembers) {
          const normalizedMemberId = memberId.replace(/^.*:/, "");

          if (normalizedMemberId === normalizedBlacklistId || memberId === item.userId) {
            if (!matchedUsers.has(item.userId)) {
              matchedUsers.set(item.userId, item);
            }
            break;
          }
        }
      }

      if (matchedUsers.size > 0) {
        // 构造通知消息
        let message = "🚨 检测到被拉黑用户出现在群聊中：\n\n";
        message += `群聊ID：${GROUP_ID}\n`;
        message += `检测时间：${new Date().toLocaleString("zh-CN")}\n\n`;
        message += `共发现 ${matchedUsers.size} 个黑名单用户：\n\n`;

        for (const [userId, user] of matchedUsers.entries()) {
          const date = new Date(user.createdAt).toLocaleString("zh-CN");
          message += `用户ID: ${userId}\n`;
          message += `原因: ${user.reason}\n`;
          message += `拉黑时间: ${date}\n`;
          message += `拉黑者: ${user.createdBy}\n\n`;
        }

        message += "请管理员及时处理！";

        // 通知所有管理员
        const bot = ctx.bots.find(b => b.platform === "onebot");
        if (bot) {
          for (const adminId of ADMIN_IDS) {
            try {
              await bot.sendPrivateMessage(adminId, message);
              ctx.logger.info(`已通知管理员 ${adminId}`);
            } catch (error) {
              ctx.logger.error(`通知管理员 ${adminId} 失败：${error}`);
            }
          }
        }
      } else {
        ctx.logger.info("未检测到被拉黑用户");
      }
    } catch (error) {
      ctx.logger.error(`检查拉黑用户失败：${error}`);
    }
  }

  // 计算下一次执行时间
  function getNextExecutionTime(targetHour: number, targetMinute: number): number {
    const now = new Date();
    const next = new Date();

    next.setHours(targetHour);
    next.setMinutes(targetMinute);
    next.setSeconds(0);
    next.setMilliseconds(0);

    // 如果已经过了今天的时间，就设置为明天的时间
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
  }

  // 设置定时任务（单个时间点）
  function scheduleCheckForTime(time: { hour: number; minute: number }) {
    const delay = getNextExecutionTime(time.hour, time.minute);

    const timerId = setTimeout(async () => {
      // 执行检查
      await checkBlacklistMembers();
      ctx.logger.info(`定时检查完成，下一次检查将在明天 ${time.hour}:${time.minute}`);

      // 只重新安排当前这个时间点的下次执行
      scheduleCheckForTime(time);
    }, delay);

    // 追踪定时器，用于清理
    scheduledTimers.push(timerId);

    // 记录下次检查时间
    ctx.logger.info(`已安排下次检查：${new Date(Date.now() + delay).toLocaleString("zh-CN")}`);
  }

  // 初始化所有定时任务
  function scheduleChecks() {
    for (const time of CHECK_TIMES) {
      scheduleCheckForTime(time);
    }
  }

  // 启动定时任务
  scheduleChecks();

  // 插件卸载时清理所有定时器，防止热重载导致重复执行
  ctx.on('dispose', () => {
    for (const timerId of scheduledTimers) {
      clearTimeout(timerId);
    }
    scheduledTimers.length = 0;
    ctx.logger.info('已清理所有拉黑检查定时器');
  });
  // ------------------------------------------------------------

  // 退群自动删除档案功能
  // ------------------------------------------------------------
  ctx.on('guild-member-removed', async (session) => {
    const userId = session.userId
    const platform = session.platform

    if (!userId || !platform) {
      return
    }

    try {
      // 查询该用户是否有档案
      const profiles = await ctx.database.get('soul_profiles', {
        userId: userId,
        platform: platform,
      })

      if (profiles.length > 0) {
        const profile = profiles[0]

        // 直接删除档案
        try {
          await ctx.database.remove('soul_profiles', {
            userId: userId,
            platform: platform,
          })

          ctx.logger.info(
            `🚪 ${platform}:${userId} 退群，已自动删除档案\n` +
            `  - 角色名: ${profile.characterName}\n` +
            `  - 服务器: ${profile.servers}\n` +
            `  - 退群时间: ${new Date().toLocaleString('zh-CN')}`
          )
        } catch (deleteError) {
          ctx.logger.error('删除档案失败:', deleteError)
        }
      } else {
        ctx.logger.info(`🚪 ${platform}:${userId} 退群（无档案）`)
      }
    } catch (error) {
      ctx.logger.error('查询退群用户档案出错:', error)
    }
  })
  // ------------------------------------------------------------

  // 新成员进群欢迎功能
  // ------------------------------------------------------------
  const WELCOME_GROUP_IDS = ["YOUR_GROUP_ID_1"]; // 需要发送欢迎消息的群列表

  ctx.on('guild-member-added', async (session) => {
    const userId = session.userId;
    const guildId = session.guildId;
    const platform = session.platform;

    if (!userId || !guildId || !platform) {
      return;
    }

    // 只在指定群聊发送欢迎消息
    if (!WELCOME_GROUP_IDS.includes(guildId)) {
      return;
    }

    ctx.logger.info(`📥 新成员加入群 ${guildId}: ${userId}`);

    try {
      // 欢迎消息
      const welcomeMessage = `<at id="${userId}"/> 欢迎加入✨网络一线牵✨！

🌸 想找情缘？
发送「登记档案」开始创建你的情缘档案~

🌸 想找亲友？
发送「登记亲友档案」开始创建你的亲友档案~

请不要在任何地方泄漏他人的个人介绍和匹配结果哦！
📋 提示：档案登记需要在私聊中完成哦！（必须要添加好友）`;

      await session.send(welcomeMessage);
      ctx.logger.info(`已向新成员 ${userId} 发送欢迎消息`);
    } catch (error) {
      ctx.logger.error(`发送欢迎消息失败: ${error}`);
    }
  });
  // ------------------------------------------------------------

  // 定期清理无效档案（每天凌晨 3 点和下午 6 点）
  // ------------------------------------------------------------
  const CLEANUP_TIMES = [
    { hour: 3, minute: 0 },
    { hour: 18, minute: 0 }
  ]

  async function cleanupInvalidProfiles() {
    ctx.logger.info('开始清理无效档案...')

    const bot = ctx.bots.find(b => b.platform === 'onebot')
    if (!bot) {
      ctx.logger.warn('未找到 OneBot 实例，跳过清理')
      return
    }

    try {
      // 获取所有档案
      const allProfiles = await ctx.database.get('soul_profiles', {})
      if (allProfiles.length === 0) {
        ctx.logger.info('无档案需要清理')
        return
      }

      // 按群分组处理
      const groupProfiles = new Map<string, typeof allProfiles>()
      for (const profile of allProfiles) {
        const key = profile.groupId
        if (!groupProfiles.has(key)) {
          groupProfiles.set(key, [])
        }
        groupProfiles.get(key)!.push(profile)
      }

      let totalDeleted = 0
      const deletedList: string[] = []

      for (const [groupId, profiles] of groupProfiles.entries()) {
        try {
          // 获取群成员列表
          const members = await bot.internal.getGroupMemberList(groupId)
          if (!members || !Array.isArray(members)) {
            ctx.logger.warn(`无法获取群 ${groupId} 成员列表`)
            continue
          }

          const memberIds = new Set(members.map((m: any) => m.user_id?.toString()))

          // 检查哪些档案用户不在群里
          for (const profile of profiles) {
            const normalizedUserId = profile.userId.replace(/^.*:/, '')

            if (!memberIds.has(normalizedUserId) && !memberIds.has(profile.userId)) {
              // 用户不在群里，直接删除档案
              try {
                await ctx.database.remove('soul_profiles', { id: profile.id })
                totalDeleted++
                deletedList.push(`${profile.userId} (${profile.characterName})`)
                ctx.logger.info(`已删除无效档案: ${profile.userId} (${profile.characterName})`)
              } catch { }
            }
          }
        } catch (error) {
          ctx.logger.error(`处理群 ${groupId} 时出错:`, error)
        }
      }

      if (totalDeleted > 0) {
        ctx.logger.info(`清理完成，共删除 ${totalDeleted} 个无效档案`)
      } else {
        ctx.logger.info('清理完成，无需删除任何档案')
      }
    } catch (error) {
      ctx.logger.error('清理无效档案失败:', error)
    }
  }

  // 设置清理任务（单个时间点）
  function scheduleCleanupForTime(time: { hour: number; minute: number }) {
    const delay = getNextExecutionTime(time.hour, time.minute);

    const timerId = setTimeout(async () => {
      await cleanupInvalidProfiles()
      // 只重新安排当前这个时间点的下次执行
      scheduleCleanupForTime(time)
    }, delay)

    scheduledTimers.push(timerId);
    ctx.logger.info(`已安排档案清理任务：${new Date(Date.now() + delay).toLocaleString("zh-CN")}`)
  }

  // 初始化所有清理任务
  function scheduleCleanup() {
    for (const time of CLEANUP_TIMES) {
      scheduleCleanupForTime(time);
    }
  }

  // 启动清理任务
  scheduleCleanup()
  // ------------------------------------------------------------

  // 推广过期清理任务
  // ------------------------------------------------------------
  // 每小时检查一次过期推广，启动时延迟30秒后也检查一次
  const PROMOTION_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1小时

  ctx.on('ready', () => {
    // 启动30秒后执行一次检查（处理机器人掉线期间过期的推广）
    setTimeout(async () => {
      ctx.logger.info('执行启动后的推广过期清理检查...');
      await cleanupExpiredPromotions(ctx);
    }, 30000);

    // 每小时执行一次
    setInterval(async () => {
      await cleanupExpiredPromotions(ctx);
    }, PROMOTION_CLEANUP_INTERVAL);

    ctx.logger.info('推广过期清理任务已启动（每小时检查一次）');
  });
  // ------------------------------------------------------------

  ctx.logger.info("jx3-soul-new 插件已加载")
}
