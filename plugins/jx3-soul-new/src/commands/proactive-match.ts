import { Context } from "koishi";
import { SoulProfile } from "../types";
import {
  getArchivedProfileIds,
  filterMatchableCandidates,
  getLockedUserIds,
  isAdminUserId,
  formatProfileCompact,
  getTodayDateString,
  safeSendPrivateMessage,
} from "../utils/universal";
import { callNormalPair } from "../utils/match";
import axios from "axios";

// ========== 常量配置 ==========
const PLATFORM = "onebot";
const DAILY_LIMIT = 5;                      // 每日最多主动联系人数
const MAX_TURNS = 10;                       // 最大对话轮次
const FIRST_REPLY_TIMEOUT = 30 * 60 * 1000; // 首次回复超时 30 分钟
const REPLY_TIMEOUT = 5 * 60 * 1000;        // 后续回复超时 5 分钟
const TIMEOUT_MESSAGE = "看来你不需要情缘喵！下次再说吧喵！";
const OPTOUT_COMMAND = "退出红娘推荐";
const RESTORE_COMMAND = "恢复红娘推荐";

// Qwen3.5 通过 ModelScope API
const AI_CONFIG = {
  url: "https://api-inference.modelscope.cn/v1/chat/completions",
  model: "Qwen/Qwen3.5-397B-A17B",
  accessToken: "YOUR_MODELSCOPE_TOKEN",
};

// 活跃的红娘对话会话（内存中）
interface ProactiveSession {
  sessionId: number;        // 数据库 ID
  userId: string;
  platform: string;
  messages: { role: string; content: string }[];
  turns: number;
  status: string;
  matchedUserId: string | null;
  matchScore: number;
  matchAnalysis: string;
  crushInfo: string | null;  // 单相思者信息
  userProfile: SoulProfile;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  isFirstMessage: boolean;   // 是否还在等待首次回复
}

const activeProactiveSessions = new Map<string, ProactiveSession>();

// 运行时开关（默认开启）
let proactiveEnabled = true;

// ========== AI 调用 ==========

/**
 * 调用 Qwen3.5 进行对话
 */
async function callQwen(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  ctx: Context,
  onRetry?: () => Promise<void>
): Promise<string> {
  const requestData = {
    model: AI_CONFIG.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
    temperature: 0.8,
    max_tokens: 500,
  };

  const MAX_RETRIES = 5;
  const BASE_DELAY = 10000; // 10 秒起步
  let notifiedUser = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(AI_CONFIG.url, requestData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AI_CONFIG.accessToken}`,
        },
        timeout: 180000, // 3 分钟超时
      });

      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Qwen3.5 返回空内容");
      }
      return content.trim();
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 429 && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY * Math.pow(2, attempt);
        ctx.logger.warn(`[红娘主动出击] Qwen3.5 触发限流(429)，${delay / 1000}秒后重试（第${attempt + 1}次）`);
        // 第一次 429 时通知用户
        if (!notifiedUser && onRetry) {
          notifiedUser = true;
          await onRetry();
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Qwen3.5 多次重试后仍失败");
}

// ========== 系统 Prompt 生成 ==========

function buildSystemPrompt(
  profile: SoulProfile,
  crushInfo: string | null,
  turnCount: number
): string {
  let prompt = `你是"小红娘"，一个热心、幽默、贴心的剑网三情缘匹配助手。你正在主动联系一位用户关心TA的近况和情缘需求。

用户档案概要（仅供你了解背景，不要直接复述这些信息）：
- 角色名: ${profile.characterName}
- 服务器: ${profile.servers}
- 门派体型: ${profile.characterTypes}
- 玩法: ${profile.gameplay}
- 性别: ${profile.gender}, 想找: ${profile.preferGender}
`;

  if (crushInfo) {
    prompt += `\n单相思信息：\n- ${crushInfo}（在聊到情缘话题时可以自然地提及"有人对你挺上心的哦"）\n`;
  }

  prompt += `
你的任务：
1. 先像朋友一样问候、闲聊（比如最近游戏玩得怎样、${profile.characterTypes}最近有没有加强之类的）
2. 自然地聊到情缘话题（比如"最近有没有遇到心仪的人呀"）
3. 如果用户说已经找到了情缘/不需要，就祝福TA并优雅结束
4. 如果用户表示感兴趣（想找情缘、想了解单相思者等），在回复末尾加上 [MATCH_TRIGGER] 标记（用户看不到此标记）
5. 如果用户说"${OPTOUT_COMMAND}"或明确表示不想被推荐了，在回复末尾加上 [OPTOUT_TRIGGER] 标记
6. 如果用户说已经找到情缘了，在回复末尾加上 [FOUND_PARTNER] 标记

重要限制：
- 不要暴露你是定时任务触发的，你就是红娘，自然地来关心用户
- 回复要简短、自然、口语化，像QQ聊天而不是写文章
- 不要使用 Markdown 格式（不要用粗体、斜体、列表等）
- 每次回复控制在 2~4 行以内`;

  if (turnCount < 3) {
    prompt += `\n- 当前是对话初期（第${turnCount + 1}轮），不要提及用户的自我介绍内容`;
  } else {
    prompt += `\n- 对话已经比较深入了，可以适当引用用户的自我介绍来拉近距离`;
    if (profile.introduction) {
      prompt += `\n- 用户自我介绍：${profile.introduction}`;
    }
  }

  prompt += `\n- 期待、年龄、地理位置等隐私信息绝对不能提及`;

  return prompt;
}

/**
 * 生成红娘代聊时的推荐话术 Prompt
 */
function buildProxyChatPrompt(
  sourceProfile: SoulProfile,
  targetProfile: SoulProfile,
  matchAnalysis: string
): string {
  return `你是"小红娘"，你要以第三人称介绍一位用户给另一位用户。

推荐人公开信息（可以提到）：
- 服务器: ${sourceProfile.servers}
- 门派体型: ${sourceProfile.characterTypes}
- 玩法: ${sourceProfile.gameplay}
- 性别: ${sourceProfile.gender}

推荐人隐私信息（绝对不能提到）：
- 自我介绍内容、对另一半的期待、QQ号、年龄、地理位置

匹配分析（供参考，可以转化为口语化表述）：
${matchAnalysis}

目标用户信息（供入参考）：
- 角色名: ${targetProfile.characterName}
- 门派: ${targetProfile.characterTypes}

你的任务：
1. 自然开场：告诉对方"有一位小伙伴对你很感兴趣"
2. 用公开信息简要描述推荐人的特点
3. 结合匹配分析，说说为什么觉得他们合适（但不暴露隐私）
4. 询问对方是否愿意了解更多或加好友
5. 回复要简短口语化，控制在 4~6 行
6. 不要使用 Markdown 格式`;
}

// ========== 用户筛选 ==========

/**
 * 获取当前轮次编号
 */
async function getCurrentRoundId(ctx: Context): Promise<number> {
  const latestQueue = await ctx.database.get("soul_proactive_queue", {}, {
    sort: { roundId: "desc" },
    limit: 1,
  });
  return latestQueue.length > 0 ? latestQueue[0].roundId : 1;
}

/**
 * 检查今日已联系人数
 */
async function getTodayContactCount(ctx: Context): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sessions = await ctx.database.get("soul_proactive_sessions", {
    createdAt: { $gte: todayStart.getTime() },
  });
  return sessions.length;
}

/**
 * 筛选一个可联系的用户（轮转不重复）
 */
async function selectEligibleUser(ctx: Context, targetUserId?: string): Promise<SoulProfile | null> {
  // 获取所有有效档案
  const allProfiles = await ctx.database.get("soul_profiles", {});
  const archivedProfileIds = await getArchivedProfileIds(ctx as any);

  // 如果指定了用户（手动触发），跳过所有限制检查
  if (targetUserId) {
    const normalizedId = targetUserId.replace(/^.*:/, "");
    const profile = allProfiles.find(
      (p) => p.userId === normalizedId || p.userId === targetUserId
    );
    if (!profile) {
      ctx.logger.warn(`[红娘主动出击] 手动触发: 用户 ${normalizedId} 不存在档案`);
      return null;
    }
    ctx.logger.info(`[红娘主动出击] 手动触发: 跳过所有限制，直接联系 ${profile.characterName}（${normalizedId}）`);
    return profile;
  }

  // 以下为自动筛选路径，检查每日上限
  const todayCount = await getTodayContactCount(ctx);
  if (todayCount >= DAILY_LIMIT) {
    ctx.logger.info(`[红娘主动出击] 今日已联系 ${todayCount} 人，达到上限 ${DAILY_LIMIT}，跳过`);
    return null;
  }

  // 获取黑名单
  const blacklist = await ctx.database.get("soul_blacklist", {});
  const blacklistUserIds = new Set(blacklist.map((b) => b.userId));

  // 获取单相思模式用户
  const whitelistLocked = await ctx.database.get("soul_match_whitelist", {
    defaultExclude: true,
  });
  const lockedUserIds = new Set(whitelistLocked.map((w) => w.userId));

  // 获取永久退出名单
  const optouts = await ctx.database.get("soul_proactive_optout", {});
  const optoutUserIds = new Set(optouts.map((o) => o.userId));

  // 获取已有情缘绑定的用户
  const partners = await ctx.database.get("soul_partners", {});
  const partneredUserIds = new Set<string>();
  for (const p of partners) {
    partneredUserIds.add(p.userA_id);
    partneredUserIds.add(p.userB_id);
  }

  // 获取当前轮次已联系的用户
  const currentRoundId = await getCurrentRoundId(ctx);
  const contacted = await ctx.database.get("soul_proactive_queue", {
    roundId: currentRoundId,
  });
  const contactedUserIds = new Set(contacted.map((c) => c.userId));

  // 筛选候选人
  const candidates = allProfiles.filter((p) => {
    if (archivedProfileIds.includes(p.id!)) return false;
    if (blacklistUserIds.has(p.userId)) return false;
    if (lockedUserIds.has(p.userId)) return false;
    if (optoutUserIds.has(p.userId)) return false;
    if (partneredUserIds.has(p.userId)) return false;
    if (contactedUserIds.has(p.userId)) return false;
    return true;
  });

  if (candidates.length === 0) {
    // 所有人都轮过一次了，开始新一轮
    ctx.logger.info(`[红娘主动出击] 当前轮次 ${currentRoundId} 所有用户已轮完，开始新一轮`);
    const newRoundId = currentRoundId + 1;

    // 重新筛选（不考虑轮转限制）
    const freshCandidates = allProfiles.filter((p) => {
      if (archivedProfileIds.includes(p.id!)) return false;
      if (blacklistUserIds.has(p.userId)) return false;
      if (lockedUserIds.has(p.userId)) return false;
      if (optoutUserIds.has(p.userId)) return false;
      if (partneredUserIds.has(p.userId)) return false;
      return true;
    });

    if (freshCandidates.length === 0) {
      ctx.logger.info("[红娘主动出击] 没有可联系的用户");
      return null;
    }

    // 随机选一个
    const selected = freshCandidates[Math.floor(Math.random() * freshCandidates.length)];

    // 记入新轮次队列
    try {
      await ctx.database.create("soul_proactive_queue", {
        userId: selected.userId,
        platform: selected.platform,
        roundId: newRoundId,
        contactedAt: Date.now(),
      });
    } catch (e) {
      ctx.logger.warn(`[红娘主动出击] 记录轮转队列失败: ${e}`);
    }

    return selected;
  }

  // 随机选一个
  const selected = candidates[Math.floor(Math.random() * candidates.length)];

  // 记入当前轮次队列
  try {
    await ctx.database.create("soul_proactive_queue", {
      userId: selected.userId,
      platform: selected.platform,
      roundId: currentRoundId,
      contactedAt: Date.now(),
    });
  } catch (e) {
    ctx.logger.warn(`[红娘主动出击] 记录轮转队列失败: ${e}`);
  }

  return selected;
}

// ========== 核心对话流程 ==========

/**
 * 检查是否有人单相思目标用户
 */
async function getCrushInfo(ctx: Context, userId: string): Promise<string | null> {
  const crushEntries = await ctx.database.get("soul_match_whitelist", {
    whitelistedUserId: userId,
    defaultExclude: true,
  });

  if (crushEntries.length === 0) return null;

  // 获取单相思者的档案
  const crusherId = crushEntries[0].userId;
  const crusherProfiles = await ctx.database.get("soul_profiles", {
    userId: crusherId,
  });

  if (crusherProfiles.length === 0) return null;

  const crusher = crusherProfiles[0];
  return `有一位 ${crusher.servers} 的 ${crusher.characterTypes}（${crusher.gender}）对当前用户开启了单相思模式`;
}

/**
 * 发起主动对话
 */
async function startProactiveChat(ctx: Context, profile: SoulProfile): Promise<void> {
  const sessionKey = `proactive-${profile.userId}-${profile.platform}`;

  // 检查是否已有活跃会话
  if (activeProactiveSessions.has(sessionKey)) {
    ctx.logger.info(`[红娘主动出击] 用户 ${profile.userId} 已有活跃会话，跳过`);
    return;
  }

  // 检查单相思信息
  const crushInfo = await getCrushInfo(ctx, profile.userId);

  // 创建数据库记录
  const dbSession = await ctx.database.create("soul_proactive_sessions", {
    userId: profile.userId,
    platform: profile.platform,
    matchedUserId: null,
    matchScore: 0,
    matchAnalysis: "",
    status: "chatting",
    conversationLog: "[]",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // 生成第一条消息
  const systemPrompt = buildSystemPrompt(profile, crushInfo, 0);
  const firstMessage = await callQwen(
    systemPrompt,
    [{ role: "user", content: "请你主动发起对话，用一句轻松的问候开场，关心用户最近的游戏近况。注意在末尾提到如果不想被打扰可以回复「退出红娘推荐」，如果想结束本次对话可以回复「结束对话」。" }],
    ctx
  );

  // 清理 AI 标记
  const cleanedMessage = firstMessage
    .replace(/\[MATCH_TRIGGER\]/g, "")
    .replace(/\[OPTOUT_TRIGGER\]/g, "")
    .replace(/\[FOUND_PARTNER\]/g, "")
    .trim();

  // 发送消息
  const sendResult = await safeSendPrivateMessage(ctx, profile.userId, cleanedMessage);
  if (!sendResult.success) {
    ctx.logger.warn(`[红娘主动出击] 无法私聊用户 ${profile.userId}: ${sendResult.error}`);
    await ctx.database.set("soul_proactive_sessions", { id: dbSession.id }, {
      status: "ended",
      updatedAt: Date.now(),
    });
    return;
  }

  // 创建内存会话
  const session: ProactiveSession = {
    sessionId: dbSession.id!,
    userId: profile.userId,
    platform: profile.platform,
    messages: [
      { role: "assistant", content: cleanedMessage },
    ],
    turns: 0,
    status: "chatting",
    matchedUserId: null,
    matchScore: 0,
    matchAnalysis: "",
    crushInfo,
    userProfile: profile,
    isFirstMessage: true,
  };

  // 设置首次回复超时（30 分钟）
  session.timeoutTimer = setTimeout(async () => {
    await handleTimeout(ctx, sessionKey);
  }, FIRST_REPLY_TIMEOUT);

  activeProactiveSessions.set(sessionKey, session);
  ctx.logger.info(`[红娘主动出击] 已向 ${profile.userId} 发起对话${crushInfo ? "（含单相思提示）" : ""}`);
}

/**
 * 处理超时
 */
async function handleTimeout(ctx: Context, sessionKey: string): Promise<void> {
  const session = activeProactiveSessions.get(sessionKey);
  if (!session) return;

  // 发送超时消息
  await safeSendPrivateMessage(ctx, session.userId, TIMEOUT_MESSAGE);

  // 更新数据库
  await ctx.database.set("soul_proactive_sessions", { id: session.sessionId }, {
    status: "timeout",
    conversationLog: JSON.stringify(session.messages),
    updatedAt: Date.now(),
  });

  activeProactiveSessions.delete(sessionKey);
  ctx.logger.info(`[红娘主动出击] 用户 ${session.userId} 对话超时`);
}

/**
 * 结束会话
 */
async function endSession(
  ctx: Context,
  sessionKey: string,
  status: string,
  farewell?: string
): Promise<void> {
  const session = activeProactiveSessions.get(sessionKey);
  if (!session) return;

  clearTimeout(session.timeoutTimer);

  if (farewell) {
    await safeSendPrivateMessage(ctx, session.userId, farewell);
  }

  await ctx.database.set("soul_proactive_sessions", { id: session.sessionId }, {
    status,
    matchedUserId: session.matchedUserId,
    matchScore: session.matchScore,
    matchAnalysis: session.matchAnalysis,
    conversationLog: JSON.stringify(session.messages),
    updatedAt: Date.now(),
  });

  activeProactiveSessions.delete(sessionKey);
  ctx.logger.info(`[红娘主动出击] 用户 ${session.userId} 对话结束，状态: ${status}`);
}

/**
 * 执行匹配并发送结果
 */
async function executeMatchAndSend(ctx: Context, session: ProactiveSession): Promise<void> {
  const profile = session.userProfile;

  // 获取筛选所需数据
  const allProfiles = await ctx.database.get("soul_profiles", {});
  const archivedProfileIds = await getArchivedProfileIds(ctx as any);
  const exclusions = await ctx.database.get("soul_exclusions", {
    userId: profile.userId,
    platform: profile.platform,
  });
  const reverseExclusions = await ctx.database.get("soul_exclusions", {
    excludedUserId: profile.userId,
  });
  const lockedUserIds = await getLockedUserIds(ctx, profile.userId);
  const excludedUserIds = [
    ...exclusions.map((e) => e.excludedUserId),
    ...reverseExclusions.map((e) => e.userId),
    ...lockedUserIds,
  ];

  const validProfiles = filterMatchableCandidates(
    profile,
    allProfiles,
    excludedUserIds,
    archivedProfileIds
  );

  if (validProfiles.length === 0) {
    await safeSendPrivateMessage(ctx, session.userId,
      "啊 我找了一圈发现你的池子里暂时没有合适的人选 不好意思喵～\n下次有新人加入我再帮你看看！"
    );
    return;
  }

  // 通知用户正在匹配
  await safeSendPrivateMessage(ctx, session.userId,
    "好嘞！让我帮你看看有没有合适的～稍等一下下喵"
  );

  try {
    const matchResult = await callNormalPair(profile, validProfiles, ctx);
    if (!matchResult) {
      await safeSendPrivateMessage(ctx, session.userId,
        "唔...匹配系统好像有点累了 下次再试试吧喵！"
      );
      return;
    }

    const { response, modelName } = matchResult;
    let responseContent = typeof response === "string" ? response : JSON.stringify(response);

    // 解析 JSON
    let cleanContent = responseContent
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "");
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await safeSendPrivateMessage(ctx, session.userId,
        "唔...分析结果好像有点问题 我再帮你想想办法喵！"
      );
      return;
    }

    const result = JSON.parse(jsonMatch[0]);
    if (!result.matches || result.matches.length === 0) {
      await safeSendPrivateMessage(ctx, session.userId,
        "嗯...分析了一圈暂时没有特别合适的 不过别灰心 下次继续帮你看喵！"
      );
      return;
    }

    // 取最佳匹配
    const bestMatch = result.matches[0];
    let candidate: SoulProfile | undefined = validProfiles[bestMatch.candidateIndex - 1];
    if (!candidate && bestMatch.userId) {
      candidate = validProfiles.find((p: SoulProfile) => p.userId === bestMatch.userId);
    }
    if (!candidate) {
      await safeSendPrivateMessage(ctx, session.userId,
        "唔 出了点小问题 下次再帮你看看吧喵！"
      );
      return;
    }

    // 保存匹配信息
    session.matchedUserId = candidate.userId;
    session.matchScore = Math.min(bestMatch.score, 100);
    session.matchAnalysis = bestMatch.analysis || "";
    session.status = "matched";

    // 发送匹配结果
    let matchMsg = `✨ 找到了一位不错的有缘人！\n\n`;
    matchMsg += `━━━ 匹配结果 ━━━\n`;
    matchMsg += `💕 匹配度：${session.matchScore}分\n`;
    matchMsg += `角色名：${candidate.characterName}\n`;
    matchMsg += `服务器：${candidate.servers}\n`;
    matchMsg += `门派体型：${candidate.characterTypes}\n`;
    matchMsg += `自我介绍：${candidate.introduction}\n`;
    matchMsg += `匹配理由：${session.matchAnalysis}\n\n`;
    matchMsg += `回复 1️⃣ → 查看对方QQ号\n`;
    matchMsg += `回复 2️⃣ → 让我代劳去跟TA打个招呼\n`;
    matchMsg += `回复 3️⃣ → 不太感兴趣，下次再说`;

    await safeSendPrivateMessage(ctx, session.userId, matchMsg);

    // 如果有名片，发送
    if (candidate.characterImageUrl && candidate.characterImageUrl.length > 0) {
      const latestCard = candidate.characterImageUrl[candidate.characterImageUrl.length - 1];
      try {
        const bot = ctx.bots.find((b) => b.platform === "onebot");
        if (bot) {
          await bot.sendMessage(`private:${session.userId}`, `<image url="${latestCard}" />`);
        }
      } catch (e) {
        ctx.logger.warn(`[红娘主动出击] 发送名片失败: ${e}`);
      }
    }

    // 更新数据库
    await ctx.database.set("soul_proactive_sessions", { id: session.sessionId }, {
      status: "matched",
      matchedUserId: candidate.userId,
      matchScore: session.matchScore,
      matchAnalysis: session.matchAnalysis,
      updatedAt: Date.now(),
    });

  } catch (error: any) {
    ctx.logger.error(`[红娘主动出击] 匹配失败: ${error.message}`);
    await safeSendPrivateMessage(ctx, session.userId,
      "唔...匹配系统好像不太给力 下次再帮你看看吧喵！"
    );
  }
}

/**
 * 红娘代聊
 */
async function proxyChatWithTarget(ctx: Context, session: ProactiveSession): Promise<void> {
  if (!session.matchedUserId) return;

  // 获取目标用户档案
  const targetProfiles = await ctx.database.get("soul_profiles", {
    userId: session.matchedUserId,
  });
  if (targetProfiles.length === 0) {
    await safeSendPrivateMessage(ctx, session.userId, "啊 对方的档案好像找不到了喵...");
    return;
  }
  const targetProfile = targetProfiles[0] as SoulProfile;

  // AI 生成代聊话术
  const proxyChatPrompt = buildProxyChatPrompt(
    session.userProfile,
    targetProfile,
    session.matchAnalysis
  );

  try {
    const proxyMessage = await callQwen(
      proxyChatPrompt,
      [{ role: "user", content: "请生成一条自然、友好的推荐消息。" }],
      ctx
    );

    // 发送给目标用户
    const sendResult = await safeSendPrivateMessage(ctx, session.matchedUserId, proxyMessage);

    if (!sendResult.success) {
      await safeSendPrivateMessage(ctx, session.userId,
        "唔 好像联系不上对方 TA可能没加我好友喵...\n要不你直接加TA好友试试？"
      );
      // 发送对方QQ号
      await safeSendPrivateMessage(ctx, session.userId,
        `对方QQ号：${session.matchedUserId}`
      );
      return;
    }

    session.status = "proxy_sent";
    await ctx.database.set("soul_proactive_sessions", { id: session.sessionId }, {
      status: "proxy_sent",
      updatedAt: Date.now(),
    });

    await safeSendPrivateMessage(ctx, session.userId,
      "✅ 已经帮你跟对方打过招呼啦！\n有消息了第一时间告诉你喵～"
    );

    ctx.logger.info(`[红娘主动出击] 已代聊 ${session.userId} → ${session.matchedUserId}`);

  } catch (error: any) {
    ctx.logger.error(`[红娘主动出击] 代聊失败: ${error.message}`);
    await safeSendPrivateMessage(ctx, session.userId,
      "唔 代聊的时候出了点问题 你要不直接试试？"
    );
  }
}

/**
 * 自动封存用户档案（用户说已找到情缘时）
 */
async function autoArchiveProfile(ctx: Context, userId: string, platform: string): Promise<void> {
  const profiles = await ctx.database.get("soul_profiles", { userId, platform });
  if (profiles.length === 0) return;

  const profile = profiles[0];

  // 检查是否已封存
  const existing = await ctx.database.get("soul_archived_profiles", {
    profileId: profile.id!,
    unArchivedAt: null,
  });
  if (existing.length > 0) return;

  try {
    await ctx.database.create("soul_archived_profiles", {
      userId: profile.userId,
      platform: profile.platform,
      groupId: profile.groupId,
      profileId: profile.id!,
      archivedBy: "system",
      archiveReason: "红娘对话确认已找到情缘",
      archivedAt: Date.now(),
    });
    ctx.logger.info(`[红娘主动出击] 已自动封存用户 ${userId} 的档案`);
  } catch (e) {
    ctx.logger.warn(`[红娘主动出击] 封存档案失败: ${e}`);
  }
}

// ========== 命令注册和中间件 ==========

export function registerProactiveMatchCommands(ctx: Context) {
  // 管理员命令：手动触发推荐（指定QQ号，仅私聊可用）
  ctx
    .command("手动触发推荐 <targetQQ:string>")
    .action(async ({ session }, targetQQ) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }
      if (!session.isDirect) {
        return "❌ 手动触发推荐仅限私聊使用";
      }

      if (!proactiveEnabled) {
        return "❌ 主动推荐功能当前已关闭，请先发「主动推荐开关」开启";
      }

      if (!targetQQ) {
        return "❌ 请提供目标QQ号，格式：手动触发推荐 <QQ号>";
      }

      const normalizedQQ = targetQQ.replace(/^.*:/, "");

      const profile = await selectEligibleUser(ctx, normalizedQQ);
      if (!profile) {
        return `❌ 未找到用户 ${normalizedQQ} 的有效档案（可能已封存/被拉黑/处于单相思模式）`;
      }

      // 立即返回成功，后台异步执行 AI 对话
      startProactiveChat(ctx, profile).catch((error) => {
        ctx.logger.error(`[红娘主动出击] 后台对话失败 ${normalizedQQ}: ${error.message}`);
      });

      return `✅ 已发起对 ${profile.characterName}（${normalizedQQ}）的红娘主动对话，后台执行中...`;
    });

  // 管理员命令：主动推荐开关
  ctx
    .command("主动推荐开关")
    .action(async ({ session }) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }

      proactiveEnabled = !proactiveEnabled;
      return proactiveEnabled
        ? "✅ 红娘主动推荐已开启"
        : "❌ 红娘主动推荐已关闭";
    });

  // 管理员命令：查看主动推荐统计
  ctx
    .command("主动推荐统计")
    .action(async ({ session }) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todaySessions = await ctx.database.get("soul_proactive_sessions", {
        createdAt: { $gte: todayStart.getTime() },
      });

      const totalSessions = await ctx.database.get("soul_proactive_sessions", {});
      const optouts = await ctx.database.get("soul_proactive_optout", {});
      const currentRound = await getCurrentRoundId(ctx);
      const roundContacted = await ctx.database.get("soul_proactive_queue", {
        roundId: currentRound,
      });

      // 统计各状态
      const statusCounts: Record<string, number> = {};
      for (const s of totalSessions) {
        statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
      }

      let msg = `📊 红娘主动推荐统计\n━━━━━━━━━━━\n`;
      msg += `今日已联系: ${todaySessions.length}/${DAILY_LIMIT}\n`;
      msg += `当前轮次: 第${currentRound}轮（已轮 ${roundContacted.length} 人）\n`;
      msg += `永久退出: ${optouts.length} 人\n`;
      msg += `活跃会话: ${activeProactiveSessions.size} 个\n`;
      msg += `━━━━━━━━━━━\n`;
      msg += `历史总计: ${totalSessions.length} 次\n`;
      for (const [status, count] of Object.entries(statusCounts)) {
        msg += `  ${status}: ${count}\n`;
      }

      return msg;
    });

  // 用户命令：恢复红娘推荐
  ctx
    .command(RESTORE_COMMAND)
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) return "❌ 此命令仅限私聊使用";

      const existing = await ctx.database.get("soul_proactive_optout", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (existing.length === 0) {
        return "你目前没有退出红娘推荐哦~";
      }

      await ctx.database.remove("soul_proactive_optout", {
        userId: session.userId!,
        platform: session.platform!,
      });

      return "✅ 已恢复红娘推荐！我会在合适的时候主动找你聊天的喵~";
    });

  // 中间件：处理红娘主动对话的用户回复
  ctx.middleware(async (session, next) => {
    if (!session.isDirect || !session.content) return next();

    const content = session.content.trim();
    const sessionKey = `proactive-${session.userId}-${session.platform}`;
    const proactiveSession = activeProactiveSessions.get(sessionKey);

    if (!proactiveSession) {
      // 检查是否是退出红娘推荐的命令（可能不在活跃会话中）
      if (content === OPTOUT_COMMAND) {
        try {
          await ctx.database.create("soul_proactive_optout", {
            userId: session.userId!,
            platform: session.platform!,
            createdAt: Date.now(),
          });
          await session.send("好的好的 完全理解！\n以后不会主动打扰你啦，如果以后改主意了\n随时可以发「恢复红娘推荐」重新加入喵！\n拜拜～");
        } catch (e) {
          // 可能已经在 optout 中
        }
        return;
      }
      return next();
    }

    // 重置超时定时器
    clearTimeout(proactiveSession.timeoutTimer);
    proactiveSession.isFirstMessage = false;

    // 处理退出对话命令
    if (content === "结束对话" || content === "不聊了") {
      await endSession(ctx, sessionKey, "ended", "好的 那下次再聊喵！有需要随时找我～");
      return;
    }

    // 处理退出推荐命令
    if (content === OPTOUT_COMMAND) {
      try {
        await ctx.database.create("soul_proactive_optout", {
          userId: session.userId!,
          platform: session.platform!,
          createdAt: Date.now(),
        });
      } catch (e) { /* 已存在 */ }
      await endSession(ctx, sessionKey, "opted_out",
        "好的好的 完全理解！\n以后不会主动打扰你啦，如果以后改主意了\n随时可以发「恢复红娘推荐」重新加入喵！\n拜拜～"
      );
      return;
    }

    // ===== 匹配结果后的选项处理 =====
    if (proactiveSession.status === "matched") {
      if (content === "1" || content === "1️⃣") {
        // 查看QQ号
        if (proactiveSession.matchedUserId) {
          await safeSendPrivateMessage(ctx, session.userId!,
            `对方QQ号：${proactiveSession.matchedUserId}\n快去加好友聊聊吧～祝你们聊得开心喵！`
          );
          await endSession(ctx, sessionKey, "accepted");
        }
        return;
      }
      if (content === "2" || content === "2️⃣") {
        // 代聊
        await safeSendPrivateMessage(ctx, session.userId!,
          "好嘞！我这就去帮你打招呼\n放心 我不会泄露你的具体信息的～\n有消息了第一时间告诉你喵！"
        );
        await proxyChatWithTarget(ctx, proactiveSession);
        await endSession(ctx, sessionKey, "proxy_requested");
        return;
      }
      if (content === "3" || content === "3️⃣") {
        await endSession(ctx, sessionKey, "rejected",
          "没关系的 缘分到了自然就来啦～\n下次再帮你看看喵！"
        );
        return;
      }
    }

    // ===== 封存确认处理 =====
    if (proactiveSession.status === "awaiting_archive") {
      if (content === "封存" || content === "好" || content === "是") {
        await autoArchiveProfile(ctx, session.userId!, session.platform!);
        await endSession(ctx, sessionKey, "ended",
          "✅ 已帮你封存档案啦！祝你们甜甜蜜蜜～有需要随时找我喵！"
        );
      } else {
        await endSession(ctx, sessionKey, "ended",
          "好的 那档案先留着～以后有需要随时找我喵！"
        );
      }
      return;
    }

    // ===== 常规对话处理 =====
    proactiveSession.turns++;
    proactiveSession.messages.push({ role: "user", content });

    // 检查是否达到最大轮次
    if (proactiveSession.turns >= MAX_TURNS) {
      await endSession(ctx, sessionKey, "ended",
        "跟你聊天好开心！不过我还要去关心其他小伙伴了～\n下次有空再聊喵！"
      );
      return;
    }

    // 调用 AI 生成回复
    try {
      const systemPrompt = buildSystemPrompt(
        proactiveSession.userProfile,
        proactiveSession.crushInfo,
        proactiveSession.turns
      );

      const aiResponse = await callQwen(systemPrompt, proactiveSession.messages, ctx, async () => {
        await safeSendPrivateMessage(ctx, session.userId!, "稍等一下喵 我还在思考...");
      });

      // 检测特殊标记
      const hasMatchTrigger = aiResponse.includes("[MATCH_TRIGGER]");
      const hasOptoutTrigger = aiResponse.includes("[OPTOUT_TRIGGER]");
      const hasFoundPartner = aiResponse.includes("[FOUND_PARTNER]");

      // 清理标记后发送给用户
      const cleanedResponse = aiResponse
        .replace(/\[MATCH_TRIGGER\]/g, "")
        .replace(/\[OPTOUT_TRIGGER\]/g, "")
        .replace(/\[FOUND_PARTNER\]/g, "")
        .trim();

      proactiveSession.messages.push({ role: "assistant", content: cleanedResponse });
      await safeSendPrivateMessage(ctx, session.userId!, cleanedResponse);

      // 处理特殊标记
      if (hasFoundPartner) {
        // 用户说已找到情缘 → 询问是否封存档案（不自动封存）
        proactiveSession.status = "awaiting_archive";
        await safeSendPrivateMessage(ctx, session.userId!,
          "恭喜找到情缘！🎉\n需要我帮你封存档案吗？封存后其他人就不会匹配到你了\n回复「封存」确认，或回复「不用」跳过"
        );
        // 设置超时等待确认
        proactiveSession.timeoutTimer = setTimeout(async () => {
          await endSession(ctx, sessionKey, "ended");
        }, REPLY_TIMEOUT);
        return;
      }

      if (hasOptoutTrigger) {
        try {
          await ctx.database.create("soul_proactive_optout", {
            userId: session.userId!,
            platform: session.platform!,
            createdAt: Date.now(),
          });
        } catch (e) { /* 已存在 */ }
        await endSession(ctx, sessionKey, "opted_out");
        return;
      }

      if (hasMatchTrigger) {
        // 用户感兴趣 → 执行匹配
        await executeMatchAndSend(ctx, proactiveSession);
        // 匹配后设置超时等待用户选择
        proactiveSession.timeoutTimer = setTimeout(async () => {
          await handleTimeout(ctx, sessionKey);
        }, REPLY_TIMEOUT);
        return;
      }

      // 设置后续超时（5 分钟）
      proactiveSession.timeoutTimer = setTimeout(async () => {
        await handleTimeout(ctx, sessionKey);
      }, REPLY_TIMEOUT);

    } catch (error: any) {
      ctx.logger.error(`[红娘主动出击] AI 对话失败: ${error.message}`);
      await endSession(ctx, sessionKey, "ended",
        "啊 我脑子好像短路了 下次再聊吧喵...",
      );
    }
  }, true); // priority = true, 优先处理
}

// ========== 定时任务 ==========

/**
 * 计算下一次执行时间
 */
function getNextExecutionDelay(targetHour: number, targetMinute: number): number {
  const now = new Date();
  const next = new Date();
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * 获取今天的定时时间表
 */
function getTodaySchedule(): { hour: number; minute: number }[] {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=周日, 6=周六

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    // 周末：10-18 每小时
    return [
      { hour: 10, minute: 0 },
      { hour: 11, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 13, minute: 0 },
      { hour: 14, minute: 0 },
      { hour: 15, minute: 0 },
      { hour: 16, minute: 0 },
      { hour: 17, minute: 0 },
      { hour: 18, minute: 0 },
    ];
  } else {
    // 工作日：9-17 每两小时
    return [
      { hour: 9, minute: 0 },
      { hour: 11, minute: 0 },
      { hour: 13, minute: 0 },
      { hour: 15, minute: 0 },
      { hour: 17, minute: 0 },
    ];
  }
}

/**
 * 执行一次主动出击任务
 */
async function runProactiveTask(ctx: Context): Promise<void> {
  ctx.logger.info("[红娘主动出击] 定时任务触发");

  if (!proactiveEnabled) {
    ctx.logger.info("[红娘主动出击] 功能已关闭，跳过");
    return;
  }

  try {
    const profile = await selectEligibleUser(ctx);
    if (!profile) {
      ctx.logger.info("[红娘主动出击] 未找到可联系的用户，本次跳过");
      return;
    }

    await startProactiveChat(ctx, profile);
  } catch (error: any) {
    ctx.logger.error(`[红娘主动出击] 任务执行失败: ${error.message}`);
  }
}

/**
 * 注册定时任务
 */
export function scheduleProactiveMatch(
  ctx: Context,
  scheduledTimers: ReturnType<typeof setTimeout>[]
): void {
  const schedule = getTodaySchedule();

  function scheduleForTime(time: { hour: number; minute: number }) {
    const delay = getNextExecutionDelay(time.hour, time.minute);

    const timerId = setTimeout(async () => {
      await runProactiveTask(ctx);
      // 重新安排下次执行
      scheduleForTime(time);
    }, delay);

    scheduledTimers.push(timerId);
    ctx.logger.info(
      `[红娘主动出击] 已安排: ${new Date(Date.now() + delay).toLocaleString("zh-CN")}`
    );
  }

  for (const time of schedule) {
    scheduleForTime(time);
  }

  ctx.logger.info(`[红娘主动出击] 定时任务已启动，今日 ${schedule.length} 个时间点`);
}
