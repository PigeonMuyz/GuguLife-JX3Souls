import { ADMIN_IDS, SERVER_PRESETS } from "../config";
import { aiConfig, SoulExclusion, SoulProfile } from "../types";
import axios from "axios";

// Bark 通知配置（用于掉线检测）；在服务环境中设置 BARK_DEVICE_KEY，勿提交密钥。
const BARK_CONFIG = {
  deviceKey: process.env.BARK_DEVICE_KEY?.trim() || "",
  serverUrl: 'https://api.day.app',
  title: 'GuguLite Bot',
  group: 'bot-status',
};

// 掉线状态追踪（避免重复通知）
let lastOfflineNotifyTime = 0;
const OFFLINE_NOTIFY_COOLDOWN = 60000; // 60秒内不重复通知

/**
 * 发送 Bark 掉线通知
 */
async function sendOfflineNotification(selfId: string, error: any) {
  // 未配置时不发送请求，也不占用通知冷却时间。
  if (!BARK_CONFIG.deviceKey) return;

  const now = Date.now();
  // 避免短时间内重复通知
  if (now - lastOfflineNotifyTime < OFFLINE_NOTIFY_COOLDOWN) {
    return;
  }
  lastOfflineNotifyTime = now;

  try {
    const url = `${BARK_CONFIG.serverUrl}/${BARK_CONFIG.deviceKey}`;
    const timestamp = new Date().toLocaleString('zh-CN');
    const params = {
      title: BARK_CONFIG.title,
      body: `🔴 QQ机器人离线 (消息发送失败)\nQQ: ${selfId}\n时间: ${timestamp}\n错误: ${String(error).slice(0, 100)}`,
      group: BARK_CONFIG.group,
      level: 'timeSensitive',
    };
    await axios.get(url, { params, timeout: 10000 });
    console.log(`[掉线检测] 已发送 Bark 通知: ${selfId}`);
  } catch (e) {
    // Axios 错误可能包含带设备密钥的请求 URL，避免将其写入日志。
    console.error('[掉线检测] 发送 Bark 通知失败');
  }
}

/**
 * 安全发送消息（带掉线检测）
 * 当向 OneBot11 机器人发送消息失败时，会触发掉线通知
 * @param ctx Koishi 上下文
 * @param channelId 目标频道/用户ID
 * @param content 消息内容
 * @param options 可选配置
 * @returns 发送结果
 */
async function safeSendMessage(
  ctx: any,
  channelId: string,
  content: string,
  options?: { platform?: string }
): Promise<{ success: boolean; messageIds?: string[]; error?: any }> {
  try {
    // 获取 OneBot 机器人
    const bot = ctx.bots.find((b: any) =>
      b.platform === 'onebot' || b.platform === 'onebot11'
    );

    if (!bot) {
      return { success: false, error: '未找到 OneBot 机器人' };
    }

    const result = await bot.sendMessage(channelId, content);
    const messageIds = Array.isArray(result) ? result : [result];
    return { success: true, messageIds };
  } catch (error) {
    console.error(`[safeSendMessage] 发送消息失败:`, error);

    // 检测是否为网络/连接错误（可能是掉线）
    const errorStr = String(error);
    const isConnectionError =
      errorStr.includes('ECONNREFUSED') ||
      errorStr.includes('ENOTFOUND') ||
      errorStr.includes('timeout') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('socket hang up') ||
      errorStr.includes('connection') ||
      errorStr.includes('websocket') ||
      errorStr.includes('WebSocket');

    if (isConnectionError) {
      // 可能是掉线，发送通知
      const bot = ctx.bots.find((b: any) =>
        b.platform === 'onebot' || b.platform === 'onebot11'
      );
      const selfId = bot?.selfId || 'unknown';
      await sendOfflineNotification(selfId, error);
    }

    return { success: false, error };
  }
}

/**
 * 安全发送私聊消息（带掉线检测）
 */
async function safeSendPrivateMessage(
  ctx: any,
  userId: string,
  content: string
): Promise<{ success: boolean; messageIds?: string[]; error?: any }> {
  return safeSendMessage(ctx, `private:${userId}`, content);
}

/**
 * 是否为管理员
 * @param userId 用户ID
 * @returns 是否为管理员
 */
function isAdminUserId(userId: string): boolean {
  const normalized = userId.replace(/^.*:/, "");
  if (ADMIN_IDS.includes(normalized) || ADMIN_IDS.includes(userId)) {
    return true;
  }
  return false;
}

/**
 * 标准化服务器名
 * @param serverName 服务器名（可用别称）
 * @returns 主服名称
 */
function normalizeServerName(serverName: string): string | null {
  const normalized = serverName.trim();
  for (const preset of SERVER_PRESETS) {
    if (preset.server === normalized) {
      return preset.server;
    }
    if (
      preset.alias.some((a) => a.toLowerCase() === normalized.toLowerCase())
    ) {
      return preset.server;
    }
  }
  return null;
}

/**
 * 验证并标准化多个服务器
 * @param serversInput 包含多个别称的字符串
 * @returns 服务器字符串数组
 */
function normalizeMultipleServers(serversInput: string): {
  valid: string[];
  invalid: string[];
} {
  const servers = serversInput.split(/\s+/).filter((s) => s.length > 0);
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const server of servers) {
    const normalized = normalizeServerName(server);
    if (normalized) {
      // 避免重复
      if (!valid.includes(normalized)) {
        valid.push(normalized);
      }
    } else {
      invalid.push(server);
    }
  }
  return { valid, invalid };
}

/**
 * 获取今天的日期字符串（YYYY-MM-DD格式）
 * @returns YYYY-MM-DD
 */
function getTodayDateString(): string {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0")
  );
}

/**
 * 精简档案格式化
 * @param profile 原始档案
 * @returns 格式化后的档案
 */
function formatProfileCompact(profile: SoulProfile): string {
  const currentYear = new Date().getFullYear();
  let ageInfo = "未知";
  if (profile.birthYear) {
    const age = currentYear - profile.birthYear;
    ageInfo = `${age}岁（${profile.birthYear}年生）`;
  }

  return `用户标识：${profile.userId}
服务器：${profile.servers}
角色名：${profile.characterName}
门派体型：${profile.characterTypes}
玩法：${profile.gameplay}
性别：${profile.gender}
需要寻找的性别：${profile.preferGender}
跨服：${profile.crossServer ? "接受" : "拒绝"}
涉三（奔现）：${profile.realMeetup ? "接受" : "拒绝"}
年龄：${ageInfo}
IP属地：${profile.location || "未知"}
对另外一半的期待：${profile.expectations}
自我介绍：${profile.introduction}`;
}

/**
 * AI供应商
 */
// Set NVIDIA_API_KEY in the service environment before startup. Never commit keys.
// Missing or blank keys disable NVIDIA selection without affecting other providers.
const nvidiaApiKey = process.env.NVIDIA_API_KEY?.trim() || "";

const AIProviders: aiConfig[] = [
  // {
  //   modelProvider: {
  //     name: "火山方舟",
  //     url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  //     responseType: "openai",
  //     accessToken: process.env.VOLCENGINE_API_KEY?.trim() || "",
  //     modelProviderWeight: 40,
  //   },
  //   models: [
  //     {
  //       id: "doubao-seed-1-6-lite-251015",
  //       name: "豆包 1.6 Lite",
  //       supportThinking: true,
  //       supportEffort: "high",
  //       modelWeight: 50,
  //     },
  //     {
  //       id: "doubao-seed-1-6-251015",
  //       name: "豆包 1.6",
  //       supportThinking: true,
  //       supportEffort: "high",
  //       modelWeight: 10,
  //     },
  //     {
  //       id: "doubao-seed-1-8-251228",
  //       name: "豆包 1.8",
  //       supportThinking: true,
  //       supportEffort: "high",
  //       modelWeight: 40,
  //     }
  //   ],
  // },
  {
    modelProvider: {
      name: "ModelScope",
      url: "https://api-inference.modelscope.cn/v1/chat/completions",
      responseType: "openai",
      accessToken: "YOUR_MODELSCOPE_TOKEN",
      modelProviderWeight: 80,
    },
    models: [
      {
        id: "moonshotai/Kimi-K2.5",
        name: "Kimi K2.5",
        supportThinking: false,
        modelWeight: 15,
      },
      {
        id: "meituan-longcat/LongCat-Flash-Lite",
        name: "美团 Longcat Lite",
        supportThinking: false,
        modelWeight: 15,
      },
      {
        id: "ZhipuAI/GLM-5",
        name: "GLM-5",
        supportThinking: false,
        modelWeight: 20,
      },
      {
        id: "MiniMax/MiniMax-M2.5",
        name: "MiniMax M2.5",
        supportThinking: false,
        modelWeight: 20,
      },
      {
        id: "Qwen/Qwen3.5-397B-A17B",
        name: "通义千问3.5",
        supportThinking: false,
        modelWeight: 20,
      },
      {
        id: "ZhipuAI/GLM-4.7-Flash",
        name: "GLM 4.7 Flash",
        supportThinking: false,
        modelWeight: 10,
      },
    ],
  },
  // {
  //   modelProvider: {
  //     name: "GuguAPI",
  //     url: "http://YOUR_API_HOST:PORT/v1/messages",
  //     responseType: "anthropic",
  //     accessToken: "YOUR_API_KEY",
  //     modelProviderWeight: 10,
  //   },
  //   models: [
  //     {
  //       id: "gemini-3-flash",
  //       name: "Gemini 3 Flash",
  //       supportThinking: true,
  //       stream: true,
  //       modelWeight: 40,
  //       dailyLimit: false,
  //     },
  //     {
  //       id: "claude-opus-4-6-thinking",
  //       name: "Claude Opus 4.6 Thinking",
  //       supportThinking: true,
  //       stream: true,
  //       dailyLimit: true,
  //       modelWeight: 30,
  //     },
  //     {
  //       id: "claude-sonnet-4-6",
  //       name: "Claude Sonnet 4.6",
  //       supportThinking: false,
  //       stream: true,
  //       dailyLimit: false,
  //       modelWeight: 30,
  //     },
  //   ],
  // },
  // {
  //   modelProvider: {
  //     name: "GuguAI002",
  //     url: "http://35.208.254.115:65530/v1beta/models/{modelsName}:generateContent",
  //     responseType: "google-beta",
  //     accessToken: "YOUR_API_KEY",
  //     modelProviderWeight: 25,
  //   },
  //   models: [
  //     {
  //       id: "gemini-3-flash-preview",
  //       name: "Gemini 3 Flash Preview",
  //       supportThinking: false,
  //       modelWeight: 60,
  //     },
  //     {
  //       id: "gemini-3-pro-preview",
  //       name: "Gemini 3 Pro Preview",
  //       supportThinking: false,
  //       modelWeight: 40,
  //     },
  //     {
  //       id: "gemini-3.1-pro-high",
  //       name: "Gemini 3.1 Pro High",
  //       supportThinking: false,
  //     },
  //   ],
  // },
  {
    modelProvider: {
      name: "NVIDIA",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      responseType: "openai",
      accessToken: nvidiaApiKey,
      modelProviderWeight: nvidiaApiKey ? 20 : 0,
    },
    models: [
      {
        id: "minimaxai/minimax-m2.1",
        name: "MiniMax M2.1",
        supportThinking: false,
        modelWeight: 100,
      },
    ],
  },
];

/**
 * 获取所有未封存的档案ID
 * @param ctx 上下文对象
 * @returns 未封存的档案ID数组
 */
async function getArchivedProfileIds(ctx: any): Promise<number[]> {
  try {
    // 获取所有归档记录，在代码层过滤未解封的
    // 因为 Koishi ORM 中 null 和空字符串/0 的查询行为不一致
    const archivedProfiles = await ctx.database.get("soul_archived_profiles", {});
    return archivedProfiles
      .filter((ap: any) => !ap.unArchivedAt) // null、undefined、0、"" 都视为未解封
      .map((ap: any) => ap.profileId);
  } catch (error) {
    console.error("获取已封存档案列表失败:", error);
    return [];
  }
}

/**
 * 数据迁移辅助函数：将旧表数据迁移到新表
 * @param ctx 上下文对象
 * @returns 迁移结果
 */
async function migrateOldData(ctx: any): Promise<{
  success: boolean;
  message: string;
  profileCount: number;
  archiveCount: number;
}> {
  try {
    // 1. 迁移soul_profiles表
    const oldProfiles = await ctx.database.get("soul_profiles", {});
    const newProfiles = oldProfiles.map((profile: any) => {
      // 移除不需要的字段
      const { aiAnalysis, needsReview, ...newProfile } = profile;
      return newProfile;
    });

    // 清空新表（可选，根据实际需求）
    // await ctx.database.drop("soul_profiles");
    // 重新创建表结构（需要根据实际表结构定义）

    // 插入新数据
    for (const profile of newProfiles) {
      await ctx.database.create("soul_profiles", profile);
    }

    // 2. 迁移soul_archived_profiles表（不需要修改字段）
    const oldArchives = await ctx.database.get("soul_archived_profiles", {});
    // 清空新表（可选）
    // await ctx.database.drop("soul_archived_profiles");

    for (const archive of oldArchives) {
      await ctx.database.create("soul_archived_profiles", archive);
    }

    return {
      success: true,
      message: "数据迁移成功",
      profileCount: newProfiles.length,
      archiveCount: oldArchives.length,
    };
  } catch (error) {
    console.error("数据迁移失败:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "未知错误",
      profileCount: 0,
      archiveCount: 0,
    };
  }
}

/**
 * 筛选可匹配的候选人（公共函数）
 * 统一处理：排除自己、封存档案、排除列表、性别匹配、涉三态度一致、跨服检查
 * @param myProfile 当前用户档案
 * @param allProfiles 所有档案
 * @param excludedUserIds 排除列表中的用户ID
 * @param archivedProfileIds 已封存的档案ID
 * @returns 过滤后的可匹配档案列表
 */
function filterMatchableCandidates(
  myProfile: SoulProfile,
  allProfiles: SoulProfile[],
  excludedUserIds: string[],
  archivedProfileIds: number[],
  whitelistUserIds?: string[]
): SoulProfile[] {
  return allProfiles.filter((profile: SoulProfile) => {
    // 排除自己
    if (profile.id === myProfile.id) return false;

    // 排除已封存的档案
    if (archivedProfileIds.includes(profile.id!)) return false;

    // 白名单模式：只保留白名单中的用户
    if (whitelistUserIds && whitelistUserIds.length > 0) {
      if (!whitelistUserIds.includes(profile.userId)) return false;
    }

    // 排除被屏蔽的用户（白名单模式下仍然生效）
    if (excludedUserIds.includes(profile.userId)) return false;

    // 性别匹配（双向检查）
    if (
      myProfile.preferGender !== "不限" &&
      myProfile.preferGender !== "都可以" &&
      profile.gender !== myProfile.preferGender
    ) {
      return false;
    }
    if (
      profile.preferGender !== "不限" &&
      profile.preferGender !== "都可以" &&
      myProfile.gender !== profile.preferGender
    ) {
      return false;
    }

    // 涉三检查：双方态度必须一致
    if (myProfile.realMeetup !== profile.realMeetup) {
      return false;
    }

    // 跨服检查：先检查是否同服
    const myServers = myProfile.servers.split(/\s+/);
    const candidateServers = profile.servers.split(/\s+/);
    const sameServer = myServers.some((s) => candidateServers.includes(s));
    if (!sameServer) {
      if (myProfile.crossServer === "否" || profile.crossServer === "否") {
        return false;
      }
    }

    return true;
  });
}

// 生成匹配建议
function getMatchSuggestion(
  myProfile: SoulProfile,
  allProfiles: SoulProfile[],
  candidates: SoulProfile[],
  excludedUserIds: string[],
  archivedProfileIds: number[],
  userId: string,
  exclusions: SoulExclusion[]
): string | null {
  if (candidates.length > 1) {
    return null;
  }

  // 预估放宽条件能增加的人数
  let potentialCrossServer = 0;
  if (myProfile.crossServer === "否") {
    const relaxedCandidates = allProfiles
      .filter(
        (p) =>
          p.userId !== userId &&
          !excludedUserIds.includes(p.userId) &&
          !archivedProfileIds.includes(p.id!)
      )
      .filter((candidate) => {
        if (
          myProfile.preferGender !== "不限" &&
          myProfile.preferGender !== "都可以" &&
          candidate.gender !== myProfile.preferGender
        )
          return false;
        if (
          candidate.preferGender !== "不限" &&
          candidate.preferGender !== "都可以" &&
          myProfile.gender !== candidate.preferGender
        )
          return false;
        if (myProfile.realMeetup !== candidate.realMeetup) return false;
        const myServers = myProfile.servers.split(/\s+/);
        const candidateServers = candidate.servers.split(/\s+/);
        if (!myServers.some((s) => candidateServers.includes(s))) {
          if (candidate.crossServer === "否") return false; // 只检查对方
        }
        return true;
      });
    potentialCrossServer =
      relaxedCandidates.length > candidates.length
        ? relaxedCandidates.length - candidates.length
        : 0;
  }

  let potentialRealMeetup = 0;
  if (myProfile.realMeetup === "否") {
    const relaxedCandidates = allProfiles
      .filter(
        (p) =>
          p.userId !== userId &&
          !excludedUserIds.includes(p.userId) &&
          !archivedProfileIds.includes(p.id!)
      )
      .filter((candidate) => {
        if (
          myProfile.preferGender !== "不限" &&
          myProfile.preferGender !== "都可以" &&
          candidate.gender !== myProfile.preferGender
        )
          return false;
        if (
          candidate.preferGender !== "不限" &&
          candidate.preferGender !== "都可以" &&
          myProfile.gender !== candidate.preferGender
        )
          return false;
        if (candidate.realMeetup !== "是") return false;
        const myServers = myProfile.servers.split(/\s+/);
        const candidateServers = candidate.servers.split(/\s+/);
        if (!myServers.some((s) => candidateServers.includes(s))) {
          if (myProfile.crossServer === "否" || candidate.crossServer === "否")
            return false;
        }
        return true;
      });
    potentialRealMeetup = relaxedCandidates.length;
  }

  let suggestion = "";
  if (potentialCrossServer > 0 && potentialCrossServer >= potentialRealMeetup) {
    suggestion = `尝试接受跨服（使用“更新档案”），预计可增加 ${potentialCrossServer} 位匹配人选`;
  } else if (potentialRealMeetup > 0) {
    suggestion = `尝试接受涉三（使用“更新档案”），预计可增加 ${potentialRealMeetup} 位匹配人选`;
  } else if (exclusions.length > 20) {
    suggestion = `你的排除列表有 ${exclusions.length} 人，这可能严重影响匹配到合适的人`;
  }

  if (suggestion) {
    return `<at id="${userId!}"/> 条件过于严格，当前群内没有更多符合用户档案，无法进行匹配。\n\n💡 建议：${suggestion}`;
  } else {
    return `<at id="${userId!}"/> 条件过于严格，当前群内没有更多符合用户档案，无法进行匹配`;
  }
}
/**
 * 获取所有处于单相思模式的用户ID（从其他人的候选池中排除）
 * @param ctx Koishi上下文
 * @param currentUserId 当前用户ID（不排除自己）
 * @returns 需要从候选池中排除的用户ID列表
 */
async function getLockedUserIds(ctx: any, currentUserId: string): Promise<string[]> {
  const lockedWhitelist = await ctx.database.get("soul_match_whitelist", {
    defaultExclude: true,
  });
  return lockedWhitelist
    .filter((w: any) => w.userId !== currentUserId)
    .map((w: any) => w.userId);
}

export {
  isAdminUserId,
  normalizeServerName,
  normalizeMultipleServers,
  getTodayDateString,
  formatProfileCompact,
  AIProviders,
  getArchivedProfileIds,
  migrateOldData,
  getMatchSuggestion,
  filterMatchableCandidates,
  safeSendMessage,
  safeSendPrivateMessage,
  getLockedUserIds,
};
