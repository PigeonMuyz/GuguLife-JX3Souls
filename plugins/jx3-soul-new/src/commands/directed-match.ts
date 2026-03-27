import { Context } from "koishi";
import { SoulProfile } from "../types";
import { characterTypePrompt, scoringRulesPrompt, ADMIN_IDS } from "../config";
import { formatProfileCompact, AIProviders, getArchivedProfileIds } from "../utils/universal";
import { callAnthropicStream } from "../utils/match";
import { pendingDirectedMatchRequests } from "..";
import axios from "axios";

// 定向匹配咕咕币消费常量
const DIRECTED_MATCH_REQUIRED_COINS = 100; // 使用前需要的咕咕币
const DIRECTED_MATCH_SUCCESS_COST = 20; // 成功扣除
const DIRECTED_MATCH_REJECT_COST = 100; // 拒绝扣除
const COOLDOWN_DURATION_MS = 60 * 60 * 1000; // 60分钟冷却
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15分钟超时

/**
 * 调用 Claude Opus 4.6 进行定向匹配分析
 */
async function callAIForDirectedMatch(
    ctx: Context,
    prompt: string
): Promise<string> {
    const API_URL = "http://YOUR_API_HOST:PORT/v1/messages";
    const API_KEY = "YOUR_API_KEY";
    const MODEL_ID = "claude-opus-4-6-thinking";
    const FALLBACK_MODEL_ID = "claude-sonnet-4-6";

    ctx.logger.info(`定向匹配使用模型: Claude Opus 4.6 Thinking`);

    const requestData = {
        model: MODEL_ID,
        system: "你是专业的游戏情缘匹配分析师，需要根据用户档案进行精准匹配。直接返回JSON，不要使用代码块包裹。",
        messages: [
            {
                role: "user" as const,
                content: prompt,
            },
        ],
        max_tokens: 8000,
        thinking: { type: "enabled" },
    };

    try {
        return await callAnthropicStream(API_URL, requestData, API_KEY, 600000);
    } catch (error) {
        ctx.logger.warn(`Claude Opus 4.6 调用失败，降级为 Sonnet 4.6: ${error.message}`);
        // 降级为 Sonnet 4.6
        const fallbackData = { ...requestData, model: FALLBACK_MODEL_ID };
        return await callAnthropicStream(API_URL, fallbackData, API_KEY, 600000);
    }
}

/**
 * 生成定向匹配分析prompt（使用jx3-soul原版prompt）
 */
function generateDirectedMatchPrompt(
    myProfile: SoulProfile,
    targetProfile: SoulProfile,
    isRequester: boolean
): string {
    const roleLabel = isRequester ? "发起人" : "接受方";
    const otherLabel = isRequester ? "对方" : "对方";

    return `你是剑网3情缘匹配专家。这是一个定向匹配请求，请从${roleLabel}的角度分析与对方的匹配度。

${characterTypePrompt}

## 你的档案
${formatProfileCompact(myProfile)}

## ${otherLabel}档案
${formatProfileCompact(targetProfile)}

${scoringRulesPrompt}

## 深度思考分析要求：
请从${roleLabel}的角度进行深度分析：
1. 分析对方是否符合你的期待和要求
2. 分析你们之间的契合点和潜在问题
3. 给出你应该如何与对方互动的建议

请返回JSON格式：
{
  "score": 65,
  "analysis": "从你的角度详细分析对方，写出一个为什么合适而不是列出具体的加分或减分项",
  "highlights": ["你可以这样开场白", "你们可以聊这些话题", "你应该注意的互动技巧", "建议的相处方式"],
  "concerns": ["你需要注意的问题"]
}

重要：analysis和highlights都要从"你"的角度出发，给出针对性的建议。`;
}

/**
 * 注册定向匹配命令
 */
export function registerDirectedMatchCommands(ctx: Context) {
    // 定向匹配命令 - 只能在私聊中使用
    ctx
        .command("定向匹配 <targetQQ:string>")
        .action(async ({ session }, targetQQ) => {
            if (!session) return;

            // 必须在私聊中使用
            if (!session.isDirect) {
                return "❌ 定向匹配只能在私聊中使用";
            }

            if (!targetQQ) {
                return "❌ 请提供对方的QQ号，格式：定向匹配 <QQ号>";
            }

            // 规范化目标QQ号（移除可能的前缀）
            const normalizedTargetQQ = targetQQ.replace(/^.*:/, "");

            // 不能匹配自己
            const normalizedSelfId = session.userId!.replace(/^.*:/, "");
            if (normalizedTargetQQ === normalizedSelfId) {
                return "❌ 不能向自己发起定向匹配";
            }

            try {
                // 获取发起者档案
                const requesterProfiles = await ctx.database.get("soul_profiles", {
                    userId: session.userId!,
                    platform: session.platform!,
                });

                if (!requesterProfiles || requesterProfiles.length === 0) {
                    return '❌ 你还没有档案，请先使用"登记档案"创建';
                }

                const requesterProfile = requesterProfiles[0];

                // 检查咕咕币是否足够
                if (requesterProfile.coins < DIRECTED_MATCH_REQUIRED_COINS) {
                    return `❌ 咕咕币不足！使用定向匹配需要 ${DIRECTED_MATCH_REQUIRED_COINS} 咕咕币\n当前余额：${requesterProfile.coins} 咕咕币`;
                }

                // 检查是否在冷却期
                const cooldownRecords = await ctx.database.get(
                    "directed_match_cooldowns",
                    {
                        userId: session.userId!,
                        platform: session.platform!,
                    }
                );

                if (cooldownRecords.length > 0) {
                    const cooldown = cooldownRecords[0];
                    if (Date.now() < cooldown.cooldownUntil) {
                        const remainingMinutes = Math.ceil(
                            (cooldown.cooldownUntil - Date.now()) / 60000
                        );
                        return `❌ 你的定向匹配功能正在冷却中，还需等待 ${remainingMinutes} 分钟`;
                    } else {
                        // 冷却已过期，删除记录
                        await ctx.database.remove("directed_match_cooldowns", {
                            id: cooldown.id,
                        });
                    }
                }

                // 检查发起者档案是否被封存
                const requesterArchived = await ctx.database.get(
                    "soul_archived_profiles",
                    {
                        profileId: requesterProfile.id,
                        unArchivedAt: null,
                    }
                );
                if (requesterArchived.length > 0) {
                    const archivedProfile = requesterArchived[0];
                    const archiveTime = new Date(
                        archivedProfile.archivedAt
                    ).toLocaleString();
                    const archivedBy =
                        archivedProfile.archivedBy === session.userId ? "自己" : "管理员";

                    return `你的档案已被封存，无法发起定向匹配\n封存时间：${archiveTime}\n封存者：${archivedBy}\n封存原因：${archivedProfile.archiveReason}\n\n请先使用"解封档案"恢复档案后再尝试`;
                }

                // 检查目标用户档案（尝试多种可能的userId格式）
                const possibleTargetIds = [
                    normalizedTargetQQ,
                    `${session.platform}:${normalizedTargetQQ}`,
                    targetQQ,
                ];

                let targetProfile: SoulProfile | null = null;
                for (const targetId of possibleTargetIds) {
                    const profiles = await ctx.database.get("soul_profiles", {
                        userId: targetId,
                        platform: session.platform!,
                    });
                    if (profiles && profiles.length > 0) {
                        targetProfile = profiles[0];
                        break;
                    }
                }

                if (!targetProfile) {
                    return `❌ 未找到QQ号 ${normalizedTargetQQ} 的档案，请确认对方已登记档案`;
                }

                // 构建请求key（目标用户的key）
                const targetKey = `${targetProfile.userId}-${session.platform}`;

                // 检查目标档案是否被封存
                const targetArchived = await ctx.database.get(
                    "soul_archived_profiles",
                    {
                        profileId: targetProfile.id,
                        unArchivedAt: null,
                    }
                );
                if (targetArchived.length > 0) {
                    const archivedProfile = targetArchived[0];
                    const archiveTime = new Date(
                        archivedProfile.archivedAt
                    ).toLocaleString();
                    const archivedBy =
                        archivedProfile.archivedBy === targetProfile.userId
                            ? "对方自己"
                            : "管理员";

                    return `❌ 对方的档案已被封存，无法发起定向匹配\n封存时间：${archiveTime}\n封存者：${archivedBy}\n封存原因：${archivedProfile.archiveReason}`;
                }

                // 检查任意一方是否将对方加入排除名单（双向排除）
                const exclusionA = await ctx.database.get("soul_exclusions", {
                    userId: session.userId!,
                    excludedUserId: targetProfile.userId,
                    platform: session.platform!,
                });
                const exclusionB = await ctx.database.get("soul_exclusions", {
                    userId: targetProfile.userId,
                    excludedUserId: session.userId!,
                    platform: session.platform!,
                });

                if (
                    (exclusionA && exclusionA.length > 0) ||
                    (exclusionB && exclusionB.length > 0)
                ) {
                    if (exclusionA && exclusionA.length > 0) {
                        return "你已将对方排除匹配了，定向个毛线呢？";
                    }
                    if (exclusionB && exclusionB.length > 0) {
                        return "对方已经把你排除匹配了，赶紧下一位吧🤔";
                    }
                }

                // 检查目标用户是否已有待处理的定向匹配请求
                if (pendingDirectedMatchRequests.has(targetKey)) {
                    return "❌ 对方还有待处理的定向匹配请求，请稍后再试";
                }

                // 检查目标用户是否处于单相思模式（已有心仪对象，不接受其他匹配）
                const targetWhitelist = await ctx.database.get("soul_match_whitelist", {
                    userId: targetProfile.userId,
                    defaultExclude: true,
                });
                if (targetWhitelist.length > 0) {
                    return "❌ 对方当前不接受匹配请求";
                }

                // 存储定向匹配请求
                pendingDirectedMatchRequests.set(targetKey, {
                    requesterId: session.userId!,
                    requesterPlatform: session.platform!,
                    targetUserId: targetProfile.userId,
                    startTime: Date.now(),
                });

                // 给目标用户发送私聊请求
                try {
                    const targetPrivateChannelId = `private:${targetProfile.userId}`;
                    const requestMessage = `💌 定向匹配请求

有人向你发起了定向匹配请求！
👤 发起人QQ: ${normalizedSelfId}

定向匹配将使用 AI 进行深度分析，给出你们双方的匹配度、交友建议，并互相告知QQ号。

⏰ 请在15分钟内回复：
✅ 回复"同意"接受匹配
❌ 回复"拒绝"婉拒请求

💡 提示：
- 如果拒绝，对方将被扣除 ${DIRECTED_MATCH_REJECT_COST} 咕咕币并冷却60分钟
- 如果同意，对方仅扣除 ${DIRECTED_MATCH_SUCCESS_COST} 咕咕币`;

                    await session.bot?.sendMessage(
                        targetPrivateChannelId,
                        requestMessage
                    );

                    await session.send(
                        `✅ 定向匹配请求已发送给对方！\n请耐心等待对方回复（15分钟内有效）\n\n💰 如果对方同意，将扣除 ${DIRECTED_MATCH_SUCCESS_COST} 咕咕币\n💰 如果对方拒绝，将扣除 ${DIRECTED_MATCH_REJECT_COST} 咕咕币`
                    );

                    ctx.logger.info(
                        `定向匹配请求已发送 - 发起人: ${session.userId}, 目标: ${targetProfile.userId}`
                    );
                } catch (error) {
                    pendingDirectedMatchRequests.delete(targetKey);
                    ctx.logger.error(`发送定向匹配请求失败: ${error}`);
                    return "❌ 发送请求失败，对方可能未添加机器人为好友";
                }
            } catch (error: any) {
                ctx.logger.error("定向匹配失败:", error);
                return `❌ 定向匹配失败: ${error.message || "未知错误"}`;
            }
        });

    // 私聊消息中间件 - 处理定向匹配确认
    ctx.middleware(async (session, next) => {
        // 只处理私聊消息
        if (!session.isDirect || !session.content) {
            return next();
        }

        const requestKey = `${session.userId}-${session.platform}`;
        const directedMatchRequest = pendingDirectedMatchRequests.get(requestKey);

        if (!directedMatchRequest) {
            return next();
        }

        const elapsed = Date.now() - directedMatchRequest.startTime;

        // 检查是否超时
        if (elapsed > REQUEST_TIMEOUT_MS) {
            pendingDirectedMatchRequests.delete(requestKey);

            // 扣除发起人咕咕币并设置冷却（与拒绝相同的惩罚）
            const requesterProfiles = await ctx.database.get("soul_profiles", {
                userId: directedMatchRequest.requesterId,
                platform: directedMatchRequest.requesterPlatform,
            });

            if (requesterProfiles && requesterProfiles.length > 0) {
                const requesterProfile = requesterProfiles[0];
                const newCoins = Math.max(0, requesterProfile.coins - DIRECTED_MATCH_REJECT_COST);

                await ctx.database.set(
                    "soul_profiles",
                    { userId: directedMatchRequest.requesterId, platform: directedMatchRequest.requesterPlatform },
                    { coins: newCoins }
                );

                // 设置冷却时间
                await ctx.database.upsert("directed_match_cooldowns", [{
                    userId: directedMatchRequest.requesterId,
                    platform: directedMatchRequest.requesterPlatform,
                    cooldownUntil: Date.now() + COOLDOWN_DURATION_MS,
                    createdAt: Date.now(),
                }], ["userId", "platform"]);

                // 通知发起人
                try {
                    const requesterPrivateChannel = `private:${directedMatchRequest.requesterId}`;
                    await session.bot?.sendMessage(
                        requesterPrivateChannel,
                        `⏰ 你的定向匹配请求已超时（15分钟未响应）\n已扣除 ${DIRECTED_MATCH_REJECT_COST} 咕咕币（剩余 ${newCoins}）\n⏳ 你已进入 60 分钟冷却期`
                    );
                } catch (e) {
                    ctx.logger.warn("无法通知定向匹配超时:", e);
                }

                ctx.logger.info(
                    `定向匹配超时 - 发起人: ${directedMatchRequest.requesterId} 扣除${DIRECTED_MATCH_REJECT_COST}币并进入冷却`
                );
            }

            await session.send("⏰ 定向匹配请求已超时（15分钟）");
            return;
        }

        const userReply = session.content.trim();

        if (userReply === "同意") {
            pendingDirectedMatchRequests.delete(requestKey);

            try {
                await session.send(
                    "✅ 已接受定向匹配请求！\n正在使用 AI 为你们进行深度匹配分析..."
                );

                // 通知发起人对方已同意
                try {
                    const requesterPrivateChannel = `private:${directedMatchRequest.requesterId}`;
                    await session.bot?.sendMessage(
                        requesterPrivateChannel,
                        `🎉 对方已同意你的定向匹配请求！\n正在进行 AI 匹配分析，请稍候...`
                    );
                } catch (e) {
                    ctx.logger.warn("无法通知发起人同意:", e);
                }

                // 获取双方档案
                const requesterProfile = await ctx.database.get("soul_profiles", {
                    userId: directedMatchRequest.requesterId,
                    platform: directedMatchRequest.requesterPlatform,
                });

                const targetProfile = await ctx.database.get("soul_profiles", {
                    userId: directedMatchRequest.targetUserId,
                    platform: session.platform!,
                });

                if (!requesterProfile || requesterProfile.length === 0) {
                    await session.send("❌ 发起人档案不存在");
                    return;
                }

                if (!targetProfile || targetProfile.length === 0) {
                    await session.send("❌ 你的档案不存在");
                    return;
                }

                const requesterData = requesterProfile[0];
                const targetData = targetProfile[0];

                // 扣除发起人咕咕币（成功只扣20）
                await ctx.database.set(
                    "soul_profiles",
                    { userId: directedMatchRequest.requesterId, platform: directedMatchRequest.requesterPlatform },
                    { coins: requesterData.coins - DIRECTED_MATCH_SUCCESS_COST }
                );

                ctx.logger.info(
                    `定向匹配成功 - 扣除发起人 ${directedMatchRequest.requesterId} ${DIRECTED_MATCH_SUCCESS_COST} 咕咕币`
                );

                // 规范化QQ号
                const requesterQQ = directedMatchRequest.requesterId.replace(/^.*:/, "");
                const targetQQ = directedMatchRequest.targetUserId.replace(/^.*:/, "");

                // 为发起人生成匹配分析
                const requesterPrompt = generateDirectedMatchPrompt(
                    requesterData,
                    targetData,
                    true
                );

                // 为接受方生成匹配分析
                const targetPrompt = generateDirectedMatchPrompt(
                    targetData,
                    requesterData,
                    false
                );

                // 调用AI分析
                const requesterResponse = await callAIForDirectedMatch(
                    ctx,
                    requesterPrompt
                );

                const targetResponse = await callAIForDirectedMatch(
                    ctx,
                    targetPrompt
                );

                // 解析发起人的响应
                const requesterJsonMatch = requesterResponse.match(/\{[\s\S]*\}/g);
                if (!requesterJsonMatch) {
                    throw new Error("AI响应格式错误（发起人）");
                }
                const requesterResult = JSON.parse(
                    requesterJsonMatch[requesterJsonMatch.length - 1]
                );
                const requesterScore = Math.min(requesterResult.score || 0, 100);

                // 解析接受方的响应
                const targetJsonMatch = targetResponse.match(/\{[\s\S]*\}/g);
                if (!targetJsonMatch) {
                    throw new Error("AI响应格式错误（接受方）");
                }
                const targetResult = JSON.parse(
                    targetJsonMatch[targetJsonMatch.length - 1]
                );
                const targetScore = Math.min(targetResult.score || 0, 100);

                // 构建发起人的结果消息
                const requesterMessage = `💕 定向匹配结果

🎯 匹配度：${requesterScore}%

TA的个人介绍：${targetData.introduction}

📊 从你的角度看对方：
${requesterResult.analysis}

✨ 给你的互动建议：
${requesterResult.highlights
                        ? requesterResult.highlights.map((h: string, i: number) => `${i + 1}. ${h}`).join("\n")
                        : "建议主动交流"
                    }

${requesterResult.concerns && requesterResult.concerns.length > 0
                        ? `⚠️ 你需要注意：\n${requesterResult.concerns
                            .map((c: string, i: number) => `${i + 1}. ${c}`)
                            .join("\n")}\n`
                        : ""
                    }
👤 对方QQ号：${targetQQ}

💰 本次消费 ${DIRECTED_MATCH_SUCCESS_COST} 咕咕币，剩余 ${requesterData.coins - DIRECTED_MATCH_SUCCESS_COST} 咕咕币`;

                // 构建接受方的结果消息
                const targetMessage = `💕 定向匹配结果

🎯 匹配度：${targetScore}%

TA的个人介绍：${requesterData.introduction}

📊 从你的角度看对方：
${targetResult.analysis}

✨ 给你的互动建议：
${targetResult.highlights
                        ? targetResult.highlights.map((h: string, i: number) => `${i + 1}. ${h}`).join("\n")
                        : "建议主动交流"
                    }

${targetResult.concerns && targetResult.concerns.length > 0
                        ? `⚠️ 你需要注意：\n${targetResult.concerns
                            .map((c: string, i: number) => `${i + 1}. ${c}`)
                            .join("\n")}\n`
                        : ""
                    }
👤 对方QQ号：${requesterQQ}`;

                // 给双方发送各自的结果
                const requesterPrivateChannel = `private:${directedMatchRequest.requesterId}`;
                const targetPrivateChannel = `private:${directedMatchRequest.targetUserId}`;

                await session.bot?.sendMessage(requesterPrivateChannel, requesterMessage);
                await session.bot?.sendMessage(targetPrivateChannel, targetMessage);

                // 记录匹配历史（双向记录）
                try {
                    await ctx.database.create("soul_match_history", {
                        matcherId: directedMatchRequest.requesterId,
                        matchedId: directedMatchRequest.targetUserId,
                        matcherPlatform: directedMatchRequest.requesterPlatform,
                        matchedPlatform: session.platform!,
                        matchType: "directed",
                        createdAt: Date.now(),
                    });
                    await ctx.database.create("soul_match_history", {
                        matcherId: directedMatchRequest.targetUserId,
                        matchedId: directedMatchRequest.requesterId,
                        matcherPlatform: session.platform!,
                        matchedPlatform: directedMatchRequest.requesterPlatform,
                        matchType: "directed",
                        createdAt: Date.now(),
                    });
                    ctx.logger.info(`定向匹配历史已记录: ${directedMatchRequest.requesterId} <-> ${directedMatchRequest.targetUserId}`);
                } catch (e) {
                    ctx.logger.warn(`记录定向匹配历史失败: ${e}`);
                }

                await session.send("✅ 匹配完成！结果已发送给双方~");

                ctx.logger.info(
                    `定向匹配完成 - 用户A: ${requesterQQ}(${requesterScore}%), 用户B: ${targetQQ}(${targetScore}%)`
                );
            } catch (error: any) {
                ctx.logger.error("定向匹配执行失败:", error);
                await session.send(`❌ 匹配失败: ${error.message || "未知错误"}`);
            }

            return;
        } else if (userReply === "拒绝") {
            pendingDirectedMatchRequests.delete(requestKey);

            // 获取发起人档案并扣除咕咕币
            const requesterProfiles = await ctx.database.get("soul_profiles", {
                userId: directedMatchRequest.requesterId,
                platform: directedMatchRequest.requesterPlatform,
            });

            if (requesterProfiles && requesterProfiles.length > 0) {
                const requesterProfile = requesterProfiles[0];
                const newCoins = Math.max(0, requesterProfile.coins - DIRECTED_MATCH_REJECT_COST);

                await ctx.database.set(
                    "soul_profiles",
                    { userId: directedMatchRequest.requesterId, platform: directedMatchRequest.requesterPlatform },
                    { coins: newCoins }
                );

                ctx.logger.info(
                    `定向匹配被拒绝 - 扣除发起人 ${directedMatchRequest.requesterId} ${DIRECTED_MATCH_REJECT_COST} 咕咕币`
                );
            }

            // 给发起人设置60分钟冷却
            const cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
            try {
                await ctx.database.upsert("directed_match_cooldowns", [
                    {
                        userId: directedMatchRequest.requesterId,
                        platform: directedMatchRequest.requesterPlatform,
                        cooldownUntil,
                        createdAt: Date.now(),
                    },
                ]);

                await session.send("✅ 已拒绝定向匹配请求");

                // 通知发起人
                const requesterPrivateChannel = `private:${directedMatchRequest.requesterId}`;
                await session.bot?.sendMessage(
                    requesterPrivateChannel,
                    `❌ 对方拒绝了你的定向匹配请求\n💰 已扣除 ${DIRECTED_MATCH_REJECT_COST} 咕咕币\n⏰ 你的定向匹配功能已被冷却60分钟`
                );

                ctx.logger.info(
                    `定向匹配被拒绝 - 发起人: ${directedMatchRequest.requesterId}, 已设置60分钟冷却`
                );
            } catch (error) {
                ctx.logger.error("设置定向匹配冷却失败:", error);
                await session.send("✅ 已拒绝定向匹配请求");
            }

            return;
        }

        // 如果不是"同意"或"拒绝"，继续处理其他消息
        return next();
    });

    // 定时清理过期的定向匹配请求（每5分钟）
    setInterval(() => {
        const now = Date.now();
        for (const [key, request] of pendingDirectedMatchRequests.entries()) {
            if (now - request.startTime > REQUEST_TIMEOUT_MS) {
                pendingDirectedMatchRequests.delete(key);
                ctx.logger.info(`清理过期定向匹配请求: ${key}`);
            }
        }
    }, 5 * 60 * 1000);
}
