import { Context } from "koishi";
import { SoulProfile, SoulConfession } from "../types";

// 匿名表白费用常量
const CONFESSION_COST = 200;            // 发起表白扣除
const VIEW_SENDER_COST = 100;           // 查看发起人扣除
const SENDER_REFUND = 100;              // 双方接受后发起人返还
const RECEIVER_REFUND = 50;             // 双方接受后接收方返还
const EXPIRY_DAYS = 7;                  // 表白过期天数
const REJECT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 被拒绝后冷却24小时

/**
 * 注册匿名表白命令
 */
export function registerConfessionCommands(ctx: Context) {
    // 匿名表白命令 - 只能在私聊中使用
    ctx
        .command("匿名表白 <targetQQ:string> <message:text>")
        .action(async ({ session }, targetQQ, message) => {
            if (!session) return;

            // 必须在私聊中使用
            if (!session.isDirect) {
                return "❌ 匿名表白只能在私聊中使用";
            }

            if (!targetQQ) {
                return "❌ 请提供对方的QQ号，格式：匿名表白 <QQ号> <表白内容>";
            }

            if (!message || message.trim().length === 0) {
                return "❌ 请提供表白内容，格式：匿名表白 <QQ号> <表白内容>";
            }

            // 规范化目标QQ号
            const normalizedTargetQQ = targetQQ.replace(/^.*:/, "");
            const normalizedSelfId = session.userId!.replace(/^.*:/, "");

            // 不能向自己表白
            if (normalizedTargetQQ === normalizedSelfId) {
                return "❌ 不能向自己发起匿名表白";
            }

            try {
                // 获取发起者档案
                const senderProfiles = await ctx.database.get("soul_profiles", {
                    userId: session.userId!,
                    platform: session.platform!,
                });

                if (!senderProfiles || senderProfiles.length === 0) {
                    return '❌ 你还没有档案，请先使用"登记档案"创建';
                }

                const senderProfile = senderProfiles[0];

                // 检查咕咕币是否足够
                if (senderProfile.coins < CONFESSION_COST) {
                    return `❌ 咕咕币不足！发起匿名表白需要 ${CONFESSION_COST} 咕咕币\n当前余额：${senderProfile.coins} 咕咕币`;
                }

                // 检查是否有待处理的表白（防止重复发起）
                const pendingConfessions = await ctx.database.get("soul_confessions", {
                    fromUserId: session.userId!,
                    platform: session.platform!,
                    status: { $in: ["pending", "viewed"] },
                });

                if (pendingConfessions.length > 0) {
                    return `❌ 你还有 ${pendingConfessions.length} 个待处理的表白，请等待对方回应后再发起新表白`;
                }

                // 检查是否在被拒绝冷却期（通过查找最近被拒绝的记录）
                const recentRejection = await ctx.database.get("soul_confessions", {
                    fromUserId: session.userId!,
                    platform: session.platform!,
                    status: "rejected",
                });

                for (const rejection of recentRejection) {
                    if (rejection.respondedAt && Date.now() - rejection.respondedAt < REJECT_COOLDOWN_MS) {
                        const remainingHours = Math.ceil((REJECT_COOLDOWN_MS - (Date.now() - rejection.respondedAt)) / (60 * 60 * 1000));
                        return `❌ 你最近有表白被拒绝，需要等待 ${remainingHours} 小时后才能再次发起表白`;
                    }
                }

                // 检查发起者档案是否被封存
                const senderArchived = await ctx.database.get("soul_archived_profiles", {
                    profileId: senderProfile.id,
                    unArchivedAt: null,
                });
                if (senderArchived.length > 0) {
                    return "❌ 你的档案已被封存，无法发起匿名表白";
                }

                // 检查目标用户档案
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

                // 检查接收方是否已有待处理的表白（限制同时只能收到一个）
                const targetPendingConfessions = await ctx.database.get("soul_confessions", {
                    toUserId: targetProfile.userId,
                    platform: session.platform!,
                    status: { $in: ["pending", "viewed"] },
                });

                if (targetPendingConfessions.length > 0) {
                    return "❌ 对方目前有待处理的表白，请等对方处理完后再试";
                }

                // 检查目标档案是否被封存
                const targetArchived = await ctx.database.get("soul_archived_profiles", {
                    profileId: targetProfile.id,
                    unArchivedAt: null,
                });
                if (targetArchived.length > 0) {
                    return "❌ 对方的档案已被封存，无法发起匿名表白";
                }

                // 检查双方是否互相排除
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

                if (exclusionA && exclusionA.length > 0) {
                    return "❌ 你已将对方加入排除名单，无法发起表白";
                }
                if (exclusionB && exclusionB.length > 0) {
                    return "❌ 对方已将你加入排除名单，无法发起表白";
                }

                // 检查发起人是否处于单相思模式（不能对非目标表白）
                const senderWhitelist = await ctx.database.get("soul_match_whitelist", {
                    userId: session.userId!,
                    platform: session.platform!,
                    defaultExclude: true,
                });
                if (senderWhitelist.length > 0) {
                    const whitelistedTarget = senderWhitelist[0].whitelistedUserId;
                    if (targetProfile.userId !== whitelistedTarget) {
                        return "❌ 你都开了单相思了还想着去撩别人？";
                    }
                }

                // 检查接收方是否处于单相思模式（已有心仪对象）
                const targetWhitelist = await ctx.database.get("soul_match_whitelist", {
                    userId: targetProfile.userId,
                    defaultExclude: true,
                });
                if (targetWhitelist.length > 0) {
                    // 只有单相思目标本人可以向TA表白
                    const whitelistedTarget = targetWhitelist[0].whitelistedUserId;
                    if (session.userId! !== whitelistedTarget) {
                        return "❌ 对方已经有心仪的对象了，别插足啦";
                    }
                    // 单相思目标本人向TA表白，提示对方对你开启了单相思
                    await session.send("💘 提示：对方已对你开启了「单相思」模式，你在 TA 心中是唯一的匹配目标哦~\n表白正在发送中...");
                }

                // 扣除咕咕币
                await ctx.database.set(
                    "soul_profiles",
                    { userId: session.userId!, platform: session.platform! },
                    { coins: senderProfile.coins - CONFESSION_COST }
                );

                // 创建表白记录
                await ctx.database.create("soul_confessions", {
                    fromUserId: session.userId!,
                    toUserId: targetProfile.userId,
                    platform: session.platform!,
                    message: message.trim(),
                    status: "pending",
                    fromUserPaid: CONFESSION_COST,
                    toUserPaid: 0,
                    fromUserRefunded: 0,
                    toUserRefunded: 0,
                    createdAt: Date.now(),
                });

                // 发送匿名表白给接收方
                try {
                    const targetPrivateChannelId = `private:${targetProfile.userId}`;
                    const confessionMessage = `💌 匿名表白

有人向你发送了一条匿名表白！

━━━━━━━━━━━━━━━━
${message.trim()}
━━━━━━━━━━━━━━━━

💡 你可以：
• 回复「查看表白」查看所有待处理表白
• 回复「查看发起人1」花费 ${VIEW_SENDER_COST} 咕咕币查看发起人QQ
• 回复「接受1」接受这份表白
• 回复「拒绝1」婉拒这份表白

⏰ 表白将在 ${EXPIRY_DAYS} 天后过期`;

                    await session.bot?.sendMessage(targetPrivateChannelId, confessionMessage);

                    ctx.logger.info(`匿名表白已发送 - 发起人: ${session.userId}, 接收方: ${targetProfile.userId}`);

                    return `✅ 匿名表白已发送给对方！

💰 已扣除 ${CONFESSION_COST} 咕咕币，剩余 ${senderProfile.coins - CONFESSION_COST} 咕咕币

💡 提示：
• 如果对方接受，你将获得 ${SENDER_REFUND} 咕咕币返还
• 对方可以选择花费 ${VIEW_SENDER_COST} 咕咕币查看你的QQ
• 表白 ${EXPIRY_DAYS} 天后过期`;

                } catch (error) {
                    // 发送失败，回滚咕咕币
                    await ctx.database.set(
                        "soul_profiles",
                        { userId: session.userId!, platform: session.platform! },
                        { coins: senderProfile.coins }
                    );
                    // 删除表白记录
                    await ctx.database.remove("soul_confessions", {
                        fromUserId: session.userId!,
                        toUserId: targetProfile.userId,
                        platform: session.platform!,
                        status: "pending",
                    });

                    ctx.logger.error(`发送匿名表白失败: ${error}`);
                    return "❌ 发送失败，对方可能未添加机器人为好友";
                }

            } catch (error: any) {
                ctx.logger.error("匿名表白失败:", error);
                return `❌ 匿名表白失败: ${error.message || "未知错误"}`;
            }
        });

    // 查看表白命令
    ctx
        .command("查看表白")
        .alias("我的表白")
        .action(async ({ session }) => {
            if (!session) return;

            // 必须在私聊中使用
            if (!session.isDirect) {
                return "❌ 查看表白只能在私聊中使用";
            }

            try {
                // 获取当前用户收到的待处理表白
                const confessions = await ctx.database.get("soul_confessions", {
                    toUserId: session.userId!,
                    platform: session.platform!,
                    status: { $in: ["pending", "viewed"] },
                });

                if (confessions.length === 0) {
                    return "📭 你目前没有待处理的匿名表白";
                }

                // 按时间排序（最新的在前）
                confessions.sort((a, b) => b.createdAt - a.createdAt);

                let response = `💌 你有 ${confessions.length} 条待处理的匿名表白：\n\n`;

                for (let i = 0; i < confessions.length; i++) {
                    const confession = confessions[i];
                    const timeAgo = getTimeAgo(confession.createdAt);
                    const statusText = confession.status === "viewed" ? "（已查看发起人）" : "";
                    const senderQQ = confession.status === "viewed"
                        ? `\n   发起人QQ: ${confession.fromUserId.replace(/^.*:/, "")}`
                        : "";

                    response += `【${i + 1}】${timeAgo} ${statusText}
━━━━━━━━━━━━━━━━
${confession.message}${senderQQ}
━━━━━━━━━━━━━━━━\n\n`;
                }

                response += `💡 操作指令：
• 「查看发起人X」查看第X条表白的发起人（花费${VIEW_SENDER_COST}咕咕币）
• 「接受X」接受第X条表白
• 「拒绝X」拒绝第X条表白`;

                return response;

            } catch (error: any) {
                ctx.logger.error("查看表白失败:", error);
                return `❌ 查看表白失败: ${error.message || "未知错误"}`;
            }
        });

    // 私聊消息中间件 - 处理表白回应
    ctx.middleware(async (session, next) => {
        // 只处理私聊消息
        if (!session.isDirect || !session.content) {
            return next();
        }

        const content = session.content.trim();

        // 匹配操作指令
        const viewSenderMatch = content.match(/^查看发起人(\d+)$/);
        const acceptMatch = content.match(/^接受(\d+)$/);
        const rejectMatch = content.match(/^拒绝(\d+)$/);

        if (!viewSenderMatch && !acceptMatch && !rejectMatch) {
            return next();
        }

        try {
            // 获取当前用户收到的待处理表白
            const confessions = await ctx.database.get("soul_confessions", {
                toUserId: session.userId!,
                platform: session.platform!,
                status: { $in: ["pending", "viewed"] },
            });

            if (confessions.length === 0) {
                await session.send("📭 你目前没有待处理的匿名表白");
                return;
            }

            // 按时间排序
            confessions.sort((a, b) => b.createdAt - a.createdAt);

            // 获取索引
            let index: number;
            if (viewSenderMatch) {
                index = parseInt(viewSenderMatch[1]) - 1;
            } else if (acceptMatch) {
                index = parseInt(acceptMatch[1]) - 1;
            } else {
                index = parseInt(rejectMatch![1]) - 1;
            }

            if (index < 0 || index >= confessions.length) {
                await session.send(`❌ 无效的序号，请输入 1-${confessions.length} 之间的数字`);
                return;
            }

            const confession = confessions[index];

            // 处理"查看发起人"
            if (viewSenderMatch) {
                if (confession.status === "viewed") {
                    const senderQQ = confession.fromUserId.replace(/^.*:/, "");
                    await session.send(`📋 第 ${index + 1} 条表白的发起人QQ：${senderQQ}\n（你已经查看过了，无需再次付费）`);
                    return;
                }

                // 检查用户咕咕币余额
                const profiles = await ctx.database.get("soul_profiles", {
                    userId: session.userId!,
                    platform: session.platform!,
                });

                if (!profiles || profiles.length === 0) {
                    await session.send("❌ 你还没有档案");
                    return;
                }

                const profile = profiles[0];
                if (profile.coins < VIEW_SENDER_COST) {
                    await session.send(`❌ 咕咕币不足！查看发起人需要 ${VIEW_SENDER_COST} 咕咕币\n当前余额：${profile.coins} 咕咕币`);
                    return;
                }

                // 扣除咕咕币
                await ctx.database.set(
                    "soul_profiles",
                    { userId: session.userId!, platform: session.platform! },
                    { coins: profile.coins - VIEW_SENDER_COST }
                );

                // 更新表白状态
                await ctx.database.set(
                    "soul_confessions",
                    { id: confession.id },
                    {
                        status: "viewed",
                        toUserPaid: VIEW_SENDER_COST,
                        viewedAt: Date.now()
                    }
                );

                const senderQQ = confession.fromUserId.replace(/^.*:/, "");
                await session.send(`📋 第 ${index + 1} 条表白的发起人QQ：${senderQQ}\n\n💰 已扣除 ${VIEW_SENDER_COST} 咕咕币，剩余 ${profile.coins - VIEW_SENDER_COST} 咕咕币\n\n💡 你仍可以回复「接受${index + 1}」或「拒绝${index + 1}」来回应这份表白`);

                ctx.logger.info(`查看表白发起人 - 接收方: ${session.userId}, 发起人: ${confession.fromUserId}`);
                return;
            }

            // 处理"接受"
            if (acceptMatch) {
                // 更新表白状态
                await ctx.database.set(
                    "soul_confessions",
                    { id: confession.id },
                    {
                        status: "accepted",
                        respondedAt: Date.now(),
                        fromUserRefunded: SENDER_REFUND,
                        toUserRefunded: confession.status === "viewed" ? RECEIVER_REFUND : 0
                    }
                );

                // 返还发起人咕咕币
                const senderProfiles = await ctx.database.get("soul_profiles", {
                    userId: confession.fromUserId,
                    platform: session.platform!,
                });
                if (senderProfiles && senderProfiles.length > 0) {
                    await ctx.database.set(
                        "soul_profiles",
                        { userId: confession.fromUserId, platform: session.platform! },
                        { coins: senderProfiles[0].coins + SENDER_REFUND }
                    );
                }

                // 如果接收方查看过发起人，返还接收方咕咕币
                if (confession.status === "viewed") {
                    const receiverProfiles = await ctx.database.get("soul_profiles", {
                        userId: session.userId!,
                        platform: session.platform!,
                    });
                    if (receiverProfiles && receiverProfiles.length > 0) {
                        await ctx.database.set(
                            "soul_profiles",
                            { userId: session.userId!, platform: session.platform! },
                            { coins: receiverProfiles[0].coins + RECEIVER_REFUND }
                        );
                    }
                }

                const senderQQ = confession.fromUserId.replace(/^.*:/, "");
                const receiverQQ = session.userId!.replace(/^.*:/, "");

                // 封存双方档案
                const now = Date.now();
                const archiveReason = "匿名表白成功，双方牵手";

                // 封存发起人档案
                if (senderProfiles && senderProfiles.length > 0) {
                    const senderProfile = senderProfiles[0];
                    try {
                        await ctx.database.upsert("soul_archived_profiles", [{
                            userId: senderProfile.userId,
                            platform: senderProfile.platform,
                            groupId: senderProfile.groupId,
                            profileId: senderProfile.id!,
                            archivedBy: "system",
                            archiveReason: archiveReason,
                            archivedAt: now,
                        }], ["profileId"]);
                        ctx.logger.info(`已封存发起人档案: ${senderProfile.userId}`);
                    } catch (e) {
                        ctx.logger.warn("封存发起人档案失败:", e);
                    }
                }

                // 封存接收方档案
                const receiverProfiles2 = await ctx.database.get("soul_profiles", {
                    userId: session.userId!,
                    platform: session.platform!,
                });
                if (receiverProfiles2 && receiverProfiles2.length > 0) {
                    const receiverProfile = receiverProfiles2[0];
                    try {
                        await ctx.database.upsert("soul_archived_profiles", [{
                            userId: receiverProfile.userId,
                            platform: receiverProfile.platform,
                            groupId: receiverProfile.groupId,
                            profileId: receiverProfile.id!,
                            archivedBy: "system",
                            archiveReason: archiveReason,
                            archivedAt: now,
                        }], ["profileId"]);
                        ctx.logger.info(`已封存接收方档案: ${receiverProfile.userId}`);
                    } catch (e) {
                        ctx.logger.warn("封存接收方档案失败:", e);
                    }
                }

                // 通知发起人
                try {
                    const senderPrivateChannel = `private:${confession.fromUserId}`;
                    await session.bot?.sendMessage(senderPrivateChannel,
                        `🎉 你的匿名表白被接受了！

对方QQ：${receiverQQ}

💰 已返还 ${SENDER_REFUND} 咕咕币
📦 双方档案已自动封存

祝你们缘分美满~`);
                } catch (e) {
                    ctx.logger.warn("无法通知表白发起人:", e);
                }

                // 回复接收方
                let receiverMessage = `✅ 你接受了这份表白！

发起人QQ：${senderQQ}`;

                if (confession.status === "viewed") {
                    receiverMessage += `\n\n💰 已返还 ${RECEIVER_REFUND} 咕咕币`;
                }

                receiverMessage += "\n📦 双方档案已自动封存\n\n祝你们缘分美满~";

                await session.send(receiverMessage);

                ctx.logger.info(`表白被接受 - 发起人: ${confession.fromUserId}, 接收方: ${session.userId}, 双方档案已封存`);
                return;
            }

            // 处理"拒绝"
            if (rejectMatch) {
                // 更新表白状态
                await ctx.database.set(
                    "soul_confessions",
                    { id: confession.id },
                    {
                        status: "rejected",
                        respondedAt: Date.now()
                    }
                );

                // 通知发起人
                try {
                    const senderPrivateChannel = `private:${confession.fromUserId}`;
                    await session.bot?.sendMessage(senderPrivateChannel,
                        `💔 你的匿名表白被婉拒了

对方婉拒了你的表白，不要灰心，缘分有时只是需要时间~

⏰ 你将在 24 小时后才能再次发起匿名表白`);
                } catch (e) {
                    ctx.logger.warn("无法通知表白发起人:", e);
                }

                await session.send("✅ 已婉拒这份表白");

                ctx.logger.info(`表白被拒绝 - 发起人: ${confession.fromUserId}, 接收方: ${session.userId}`);
                return;
            }

        } catch (error: any) {
            ctx.logger.error("处理表白回应失败:", error);
            await session.send(`❌ 操作失败: ${error.message || "未知错误"}`);
            return;
        }
    });

    // 定时清理过期表白（每小时执行一次）
    setInterval(async () => {
        try {
            const expiryTime = Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1000;

            // 获取过期的表白
            const expiredConfessions = await ctx.database.get("soul_confessions", {
                status: { $in: ["pending", "viewed"] },
                createdAt: { $lt: expiryTime },
            });

            for (const confession of expiredConfessions) {
                // 标记为过期
                await ctx.database.set(
                    "soul_confessions",
                    { id: confession.id },
                    { status: "expired", respondedAt: Date.now() }
                );

                // 通知发起人
                try {
                    const bot = ctx.bots.find(b => b.platform === "onebot");
                    if (bot) {
                        const senderPrivateChannel = `private:${confession.fromUserId}`;
                        await bot.sendMessage(senderPrivateChannel,
                            "⏰ 你的匿名表白已过期（${EXPIRY_DAYS}天未响应）\n\n你可以再次发起新的表白");
                    }
                } catch (e) {
                    ctx.logger.warn("无法通知表白过期:", e);
                }

                ctx.logger.info(`表白过期 - ID: ${confession.id}, 发起人: ${confession.fromUserId}`);
            }

            if (expiredConfessions.length > 0) {
                ctx.logger.info(`已清理 ${expiredConfessions.length} 条过期表白`);
            }
        } catch (error) {
            ctx.logger.error("清理过期表白失败:", error);
        }
    }, 60 * 60 * 1000); // 每小时执行一次
}

/**
 * 获取时间友好显示
 */
function getTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) {
        return `${days}天前`;
    } else if (hours > 0) {
        return `${hours}小时前`;
    } else if (minutes > 0) {
        return `${minutes}分钟前`;
    } else {
        return "刚刚";
    }
}
