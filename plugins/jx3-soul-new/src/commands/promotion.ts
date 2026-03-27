import { Context } from "koishi";
import { SoulProfile, AIRequestData } from "../types";
import { AIProviders } from "../utils/universal";
import axios from "axios";

// 推广类型
type PromotionType = "essence" | "notice";

// 最小竞价单位
const BID_UNIT = 50;

// 推广会话状态
interface PromotionSession {
    step: "select_group" | "select_type" | "view_current" | "enter_bid" | "select_ai" | "confirm";
    selectedGroupId?: string;
    selectedType?: PromotionType;
    currentPromotion?: any; // 当前槽位的推广（如果有）
    bidAmount?: number;
    withAiSummary?: boolean;
    lastActivity: number;
}

// 存储推广会话
const promotionSessions = new Map<string, PromotionSession>();

// 会话超时时间（5分钟）
const SESSION_TIMEOUT = 5 * 60 * 1000;

// 推广可用的群列表
const PROMOTION_GROUPS = [
    { id: "YOUR_GROUP_ID_1", name: "情缘群" },
];

/**
 * 获取当前周期的开始和结束时间
 * 周一7:00 ~ 周四7:00（3天），周四7:00 ~ 下周一7:00（4天）
 */
function getCurrentPeriod(): { start: Date; end: Date; periodId: string } {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=周日, 1=周一, ..., 6=周六
    const hour = now.getHours();

    // 计算到周一7:00和周四7:00的距离
    let start = new Date(now);
    let end = new Date(now);

    // 判断当前在哪个周期
    // 周一7:00到周四7:00
    // 周四7:00到下周一7:00

    if (dayOfWeek === 1 && hour >= 7) {
        // 周一7点之后 -> 周期：周一7:00 ~ 周四7:00
        start.setHours(7, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 3); // 周四
    } else if (dayOfWeek > 1 && dayOfWeek < 4) {
        // 周二、周三 -> 周期：周一7:00 ~ 周四7:00
        start.setDate(start.getDate() - (dayOfWeek - 1));
        start.setHours(7, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 3);
    } else if (dayOfWeek === 4 && hour < 7) {
        // 周四7点之前 -> 周期：周一7:00 ~ 周四7:00
        start.setDate(start.getDate() - 3);
        start.setHours(7, 0, 0, 0);
        end = new Date(now);
        end.setHours(7, 0, 0, 0);
    } else if (dayOfWeek === 4 && hour >= 7) {
        // 周四7点之后 -> 周期：周四7:00 ~ 下周一7:00
        start.setHours(7, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 4); // 下周一
    } else if (dayOfWeek > 4 || dayOfWeek === 0) {
        // 周五、周六、周日 -> 周期：周四7:00 ~ 下周一7:00
        const daysFromThursday = dayOfWeek === 0 ? 3 : dayOfWeek - 4;
        start.setDate(start.getDate() - daysFromThursday);
        start.setHours(7, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 4);
    } else if (dayOfWeek === 1 && hour < 7) {
        // 周一7点之前 -> 周期：上周四7:00 ~ 周一7:00
        end.setHours(7, 0, 0, 0);
        start = new Date(end);
        start.setDate(start.getDate() - 4);
    }

    // 生成周期唯一标识
    const periodId = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;

    return { start, end, periodId };
}

/**
 * 计算剩余时间百分比
 */
function calculateRemainingPercentage(createdAt: number, expiredAt: number): number {
    const now = Date.now();
    const totalDuration = expiredAt - createdAt;
    const remainingDuration = expiredAt - now;

    if (remainingDuration <= 0) return 0;
    if (totalDuration <= 0) return 0;

    return Math.min(100, Math.max(0, (remainingDuration / totalDuration) * 100));
}

/**
 * 计算退款金额（按剩余时间百分比，取整）
 */
function calculateRefund(bidAmount: number, createdAt: number, expiredAt: number): number {
    const percentage = calculateRemainingPercentage(createdAt, expiredAt);
    return Math.floor(bidAmount * (percentage / 100));
}

/**
 * 生成AI档案亮点总结
 */
async function generateProfileSummary(
    profile: SoulProfile,
    ctx: Context
): Promise<string | null> {
    try {
        const provider = AIProviders.find(
            (p) => p.modelProvider.name === "火山方舟"
        );

        if (!provider) return null;

        const model = provider.models.find(
            (m) => m.id === "doubao-seed-1-6-flash-250828"
        );
        if (!model) return null;

        const prompt = `你是一个剑网3情缘推荐文案专家。请根据以下档案信息，生成一段简短有趣的推荐语（50字以内），突出这个人的亮点和特色。

档案信息：
- 服务器：${profile.servers}
- 角色名：${profile.characterName}
- 门派体型：${profile.characterTypes}
- 玩法：${profile.gameplay}
- 性别：${profile.gender}
- 自我介绍：${profile.introduction}
- 对另一半的期待：${profile.expectations}

要求：用轻松活泼的语气，抓住1-2个亮点，可用表情符号，不超过50字。只返回推荐语。`;

        const requestData: AIRequestData = {
            model: model.id,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8,
            max_tokens: 200,
        };

        const response = await axios.post(provider.modelProvider.url, requestData, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${provider.modelProvider.accessToken}`,
            },
            timeout: 30000,
        });

        return response.data.choices[0].message.content.trim();
    } catch (error) {
        ctx.logger.error("生成AI总结失败:", error);
        return null;
    }
}

/**
 * 格式化推广内容
 */
function formatPromotionContent(
    profile: SoulProfile,
    userId: string,
    aiSummary?: string,
    includeAt: boolean = false
): string {
    let content = `【情缘推荐】\n`;
    content += `━━━━━━━━━━━━━━━━\n`;
    content += `🎮 服务器：${profile.servers}\n`;
    content += `🎭 角色名：${profile.characterName}\n`;
    content += `👤 性别：${profile.gender}\n`;
    content += `📝 个人介绍：${profile.introduction}\n`;

    if (aiSummary) {
        content += `✨ AI推荐语：${aiSummary}\n`;
    }

    content += `━━━━━━━━━━━━━━━━\n`;
    content += `📧 联系TA：${userId}`;

    if (includeAt) {
        content = `<at id="${userId}"/>\n` + content;
    }

    return content;
}

/**
 * 检查用户余额
 */
async function checkBalance(
    ctx: Context,
    userId: string,
    platform: string,
    amount: number
): Promise<{ enough: boolean; balance: number }> {
    const profiles = await ctx.database.get("soul_profiles", { userId, platform });
    if (profiles.length === 0) return { enough: false, balance: 0 };
    return { enough: profiles[0].coins >= amount, balance: profiles[0].coins };
}

/**
 * 扣除咕咕币
 */
async function deductCoins(
    ctx: Context,
    userId: string,
    platform: string,
    amount: number
): Promise<number | null> {
    const profiles = await ctx.database.get("soul_profiles", { userId, platform });
    if (profiles.length === 0 || profiles[0].coins < amount) return null;

    const newCoins = profiles[0].coins - amount;
    await ctx.database.set(
        "soul_profiles",
        { id: profiles[0].id },
        { coins: newCoins, updatedAt: Date.now() }
    );
    return newCoins;
}

/**
 * 增加咕咕币（退款）
 */
async function addCoins(
    ctx: Context,
    userId: string,
    platform: string,
    amount: number
): Promise<number | null> {
    const profiles = await ctx.database.get("soul_profiles", { userId, platform });
    if (profiles.length === 0) return null;

    const newCoins = profiles[0].coins + amount;
    await ctx.database.set(
        "soul_profiles",
        { id: profiles[0].id },
        { coins: newCoins, updatedAt: Date.now() }
    );
    return newCoins;
}

/**
 * 获取当前周期的活跃推广
 */
async function getActivePromotions(
    ctx: Context,
    groupId: string
): Promise<any[]> {
    const { periodId } = getCurrentPeriod();

    return await ctx.database.get("soul_promotions", {
        groupId,
        periodId,
        isActive: true,
    });
}

/**
 * 获取指定类型的当前推广
 */
async function getCurrentPromotion(
    ctx: Context,
    groupId: string,
    type: PromotionType
): Promise<any | null> {
    const promotions = await getActivePromotions(ctx, groupId);
    return promotions.find((p) => p.type === type) || null;
}

/**
 * 检查用户是否在当前周期已竞价过
 */
async function hasUserBidInPeriod(
    ctx: Context,
    userId: string,
    platform: string
): Promise<boolean> {
    const { periodId } = getCurrentPeriod();

    const promotions = await ctx.database.get("soul_promotions", {
        userId,
        platform,
        periodId,
    });

    return promotions.length > 0;
}

/**
 * 发送精华消息
 */
async function sendEssenceMessage(
    ctx: Context,
    groupId: string,
    content: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const bot = ctx.bots.find((b) => b.platform === "onebot");
    if (!bot) return { success: false, error: "未找到 OneBot 机器人" };

    try {
        const result = await bot.sendMessage(groupId, content);
        let messageId: string = Array.isArray(result) ? result[0] : result as string;

        await new Promise((resolve) => setTimeout(resolve, 1000));

        try {
            await (bot.internal as any).setEssenceMsg(messageId);
        } catch (e) {
            ctx.logger.warn("设置精华消息失败:", e);
        }

        return { success: true, messageId };
    } catch (error) {
        ctx.logger.error("发送精华消息失败:", error);
        return { success: false, error: String(error) };
    }
}

/**
 * 发送群公告
 */
async function sendGroupNotice(
    ctx: Context,
    groupId: string,
    content: string
): Promise<{ success: boolean; noticeId?: string; error?: string }> {
    const bot = ctx.bots.find((b) => b.platform === "onebot");
    if (!bot) return { success: false, error: "未找到 OneBot 机器人" };

    try {
        const cleanContent = content.replace(/<at[^>]*\/>/g, "").trim();
        const result = await (bot.internal as any).sendGroupNotice(groupId, cleanContent);
        // 尝试获取公告ID（可能因API不同而不同）
        const noticeId = result?.notice_id || result?.id || null;
        return { success: true, noticeId };
    } catch (error) {
        ctx.logger.error("发送群公告失败:", error);
        return { success: false, error: String(error) };
    }
}

/**
 * 删除精华消息
 */
async function deleteEssenceMessage(ctx: Context, messageId: string): Promise<boolean> {
    const bot = ctx.bots.find((b) => b.platform === "onebot");
    if (!bot) return false;

    try {
        await (bot.internal as any).deleteEssenceMsg(messageId);
        return true;
    } catch (error) {
        ctx.logger.error("删除精华消息失败:", error);
        return false;
    }
}

/**
 * 删除群公告
 */
async function deleteGroupNotice(ctx: Context, groupId: string, noticeId: string): Promise<boolean> {
    const bot = ctx.bots.find((b) => b.platform === "onebot");
    if (!bot) return false;

    try {
        await (bot.internal as any).delGroupNotice(groupId, noticeId);
        return true;
    } catch (error) {
        ctx.logger.error("删除群公告失败:", error);
        return false;
    }
}

/**
 * 清理过期/被顶的推广内容
 */
async function cleanupPromotion(ctx: Context, promotion: any): Promise<void> {
    if (promotion.type === "essence" && promotion.messageId) {
        await deleteEssenceMessage(ctx, promotion.messageId);
    } else if (promotion.type === "notice" && promotion.noticeId) {
        await deleteGroupNotice(ctx, promotion.groupId, promotion.noticeId);
    }
}

/**
 * 清理过期的推广（周期结束时调用）
 */
export async function cleanupExpiredPromotions(ctx: Context): Promise<void> {
    const now = Date.now();

    try {
        const expiredPromotions = await ctx.database.get("soul_promotions", {
            expiredAt: { $lte: now },
            isActive: true,
        });

        for (const promotion of expiredPromotions) {
            await cleanupPromotion(ctx, promotion);
            await ctx.database.set(
                "soul_promotions",
                { id: promotion.id },
                { isActive: false, cleanedUpAt: Date.now() }
            );
            ctx.logger.info(`已清理过期推广: ${promotion.id}`);
        }
    } catch (error) {
        ctx.logger.error("清理过期推广失败:", error);
    }
}

/**
 * 注册推广命令
 */
export function registerPromotionCommands(ctx: Context) {
    // 推广档案命令（私聊使用）
    ctx
        .command("推广档案")
        .alias("档案推广")
        .action(async ({ session }) => {
            if (!session?.userId || !session?.platform) return;
            if (session.guildId) return "推广档案功能请在私聊中使用！";

            // 检查是否有档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (profiles.length === 0) {
                return "你还没有登记档案，请先发送「登记档案」创建档案！";
            }

            // 检查是否当前周期已竞价过
            const hasBid = await hasUserBidInPeriod(ctx, session.userId, session.platform);
            if (hasBid) {
                return "你在当前周期内已经竞价过了，每个周期（周一~周四或周四~下周一）只能竞价一次！";
            }

            const sessionKey = `${session.platform}:${session.userId}`;

            // 默认使用第一个群（保留数组供以后扩展）
            const defaultGroup = PROMOTION_GROUPS[0];

            // 获取当前槽位状态
            const essencePromo = await getCurrentPromotion(ctx, defaultGroup.id, "essence");
            const noticePromo = await getCurrentPromotion(ctx, defaultGroup.id, "notice");

            promotionSessions.set(sessionKey, {
                step: "select_type", // 跳过选群步骤，直接进入选择类型
                selectedGroupId: defaultGroup.id,
                lastActivity: Date.now(),
            });

            let menu = "📢 档案推广竞价系统\n";
            menu += "━━━━━━━━━━━━━━━━\n\n";

            const { end } = getCurrentPeriod();
            const endStr = `${end.getMonth() + 1}月${end.getDate()}日 7:00`;
            menu += `⏰ 当前周期截止：${endStr}\n\n`;

            menu += "请选择推广类型：\n\n";

            menu += "1. 精华消息";
            if (essencePromo) {
                const remaining = calculateRemainingPercentage(essencePromo.createdAt, essencePromo.expiredAt);
                menu += `（当前出价：${essencePromo.bidAmount}，剩余${Math.round(remaining)}%时间）`;
            } else {
                menu += "（无人占用，起拍价 100）";
            }
            menu += "\n";

            menu += "2. 群公告";
            if (noticePromo) {
                const remaining = calculateRemainingPercentage(noticePromo.createdAt, noticePromo.expiredAt);
                menu += `（当前出价：${noticePromo.bidAmount}，剩余${Math.round(remaining)}%时间）`;
            } else {
                menu += "（无人占用，起拍价 100）";
            }
            menu += "\n\n";

            menu += "回复 1 或 2 选择，或回复「退出」取消";

            return menu;
        });

    // 处理推广会话中间件
    ctx.middleware(async (session, next) => {
        if (!session.userId || !session.platform) return next();
        if (session.guildId) return next();

        const sessionKey = `${session.platform}:${session.userId}`;
        const promotionSession = promotionSessions.get(sessionKey);

        if (!promotionSession) return next();

        if (Date.now() - promotionSession.lastActivity > SESSION_TIMEOUT) {
            promotionSessions.delete(sessionKey);
            return next();
        }

        const input = session.content?.trim() || "";

        if (input === "退出" || input === "取消") {
            promotionSessions.delete(sessionKey);
            return "已取消推广操作";
        }

        promotionSession.lastActivity = Date.now();

        const profiles = await ctx.database.get("soul_profiles", {
            userId: session.userId,
            platform: session.platform,
        });

        if (profiles.length === 0) {
            promotionSessions.delete(sessionKey);
            return "未找到你的档案";
        }

        const profile = profiles[0];

        switch (promotionSession.step) {
            case "select_type": {
                if (input !== "1" && input !== "2") {
                    return "请回复 1 或 2 选择推广类型";
                }

                const type: PromotionType = input === "1" ? "essence" : "notice";
                promotionSession.selectedType = type;

                const currentPromo = await getCurrentPromotion(ctx, promotionSession.selectedGroupId!, type);
                promotionSession.currentPromotion = currentPromo;
                promotionSession.step = "enter_bid";

                const typeName = type === "essence" ? "精华消息" : "群公告";
                let menu = `📊 ${typeName}竞价\n`;
                menu += "━━━━━━━━━━━━━━━━\n\n";

                if (currentPromo) {
                    const remaining = calculateRemainingPercentage(currentPromo.createdAt, currentPromo.expiredAt);
                    const minBid = currentPromo.bidAmount + BID_UNIT;
                    menu += `当前持有者出价：${currentPromo.bidAmount} 咕咕币\n`;
                    menu += `剩余时间：${Math.round(remaining)}%\n`;
                    menu += `最低竞价：${minBid} 咕咕币\n\n`;
                    menu += `💡 如果你成功竞价，对方将获得 ${Math.floor(currentPromo.bidAmount * remaining / 100)} 咕咕币退款\n\n`;
                } else {
                    menu += "当前无人占用\n";
                    menu += "起拍价：100 咕咕币\n\n";
                }

                menu += `你的余额：${profile.coins} 咕咕币\n\n`;
                menu += "请输入你的竞价金额（必须是50的倍数）：";

                return menu;
            }

            case "enter_bid": {
                const bidAmount = parseInt(input);

                if (isNaN(bidAmount) || bidAmount <= 0) {
                    return "请输入有效的数字金额";
                }

                if (bidAmount % BID_UNIT !== 0) {
                    return `竞价金额必须是 ${BID_UNIT} 的倍数，例如：100, 150, 200, 250...`;
                }

                const currentPromo = promotionSession.currentPromotion;
                const minBid = currentPromo ? currentPromo.bidAmount + BID_UNIT : 100;

                if (bidAmount < minBid) {
                    return `竞价金额必须至少为 ${minBid} 咕咕币`;
                }

                const { enough, balance } = await checkBalance(ctx, session.userId, session.platform, bidAmount);
                if (!enough) {
                    return `余额不足！需要 ${bidAmount} 咕咕币，当前余额 ${balance} 咕咕币`;
                }

                promotionSession.bidAmount = bidAmount;
                promotionSession.step = "select_ai";

                let menu = "是否需要AI推荐语？\n\n";
                menu += "AI会根据你的档案生成一段有趣的推荐语~\n\n";
                menu += "1. 不需要\n";
                menu += "2. 需要（展示效果更佳）\n\n";
                menu += "回复 1 或 2 选择";

                return menu;
            }

            case "select_ai": {
                if (input !== "1" && input !== "2") {
                    return "请回复 1 或 2 选择";
                }

                promotionSession.withAiSummary = input === "2";
                promotionSession.step = "confirm";

                const type = promotionSession.selectedType!;
                const typeName = type === "essence" ? "精华消息" : "群公告";
                const groupName = PROMOTION_GROUPS.find((g) => g.id === promotionSession.selectedGroupId)?.name;
                const bidAmount = promotionSession.bidAmount!;
                const currentPromo = promotionSession.currentPromotion;

                let confirm = "📋 确认竞价信息\n";
                confirm += "━━━━━━━━━━━━━━━━\n";
                confirm += `推广群：${groupName}\n`;
                confirm += `推广类型：${typeName}\n`;
                confirm += `竞价金额：${bidAmount} 咕咕币\n`;
                confirm += `AI推荐语：${promotionSession.withAiSummary ? "是" : "否"}\n`;

                if (currentPromo) {
                    const remaining = calculateRemainingPercentage(currentPromo.createdAt, currentPromo.expiredAt);
                    const refund = Math.floor(currentPromo.bidAmount * remaining / 100);
                    confirm += `\n⚠️ 将顶替当前推广者\n`;
                    confirm += `对方将获得 ${refund} 咕咕币退款\n`;
                }

                confirm += "━━━━━━━━━━━━━━━━\n\n";
                confirm += "回复「确认」完成竞价，或回复「退出」取消";

                return confirm;
            }

            case "confirm": {
                if (input !== "确认" && input !== "确定") {
                    return "请回复「确认」继续，或回复「退出」取消";
                }

                const type = promotionSession.selectedType!;
                const groupId = promotionSession.selectedGroupId!;
                const bidAmount = promotionSession.bidAmount!;
                const withAi = promotionSession.withAiSummary!;
                const currentPromo = promotionSession.currentPromotion;

                // 再次检查余额
                const newBalance = await deductCoins(ctx, session.userId, session.platform, bidAmount);
                if (newBalance === null) {
                    promotionSessions.delete(sessionKey);
                    return "扣费失败，请稍后重试";
                }

                // 如果有当前推广者，处理退款和清理
                if (currentPromo) {
                    const refund = calculateRefund(currentPromo.bidAmount, currentPromo.createdAt, currentPromo.expiredAt);

                    // 清理旧的推广内容
                    await cleanupPromotion(ctx, currentPromo);

                    // 标记旧推广为非活跃
                    await ctx.database.set(
                        "soul_promotions",
                        { id: currentPromo.id },
                        { isActive: false, replacedBy: session.userId, replacedAt: Date.now() }
                    );

                    // 退款给被顶者
                    if (refund > 0) {
                        await addCoins(ctx, currentPromo.userId, currentPromo.platform, refund);
                        ctx.logger.info(`用户 ${currentPromo.userId} 被顶，退款 ${refund} 咕咕币`);

                        // 私聊通知被顶者
                        try {
                            const bot = ctx.bots.find((b) => b.platform === "onebot");
                            if (bot) {
                                await bot.sendPrivateMessage(currentPromo.userId,
                                    `⚠️ 你的${type === "essence" ? "精华消息" : "群公告"}推广被他人竞价顶替\n\n` +
                                    `已按剩余时间比例返还 ${refund} 咕咕币到你的账户`
                                );
                            }
                        } catch (e) {
                            ctx.logger.warn("通知被顶者失败:", e);
                        }
                    }
                }

                // 生成AI总结
                let aiSummary: string | undefined;
                if (withAi) {
                    await session.send("正在生成AI推荐语...");
                    aiSummary = (await generateProfileSummary(profile, ctx)) || undefined;
                }

                // 生成推广内容
                const content = formatPromotionContent(profile, session.userId, aiSummary, type === "essence");

                // 发送推广
                let result: { success: boolean; messageId?: string; noticeId?: string; error?: string };

                if (type === "essence") {
                    result = await sendEssenceMessage(ctx, groupId, content);
                } else {
                    result = await sendGroupNotice(ctx, groupId, content);
                }

                promotionSessions.delete(sessionKey);

                if (result.success) {
                    const { end, periodId } = getCurrentPeriod();

                    // 记录推广
                    await ctx.database.create("soul_promotions", {
                        userId: session.userId,
                        platform: session.platform,
                        groupId,
                        type,
                        bidAmount,
                        withAiSummary: withAi,
                        messageId: result.messageId || null,
                        noticeId: result.noticeId || null,
                        periodId,
                        isActive: true,
                        createdAt: Date.now(),
                        expiredAt: end.getTime(),
                        cleanedUpAt: null,
                        replacedBy: null,
                        replacedAt: null,
                    });

                    const typeName = type === "essence" ? "精华消息" : "群公告";
                    const endStr = `${end.getMonth() + 1}月${end.getDate()}日 7:00`;
                    return `✅ 竞价成功！\n\n已通过${typeName}方式推广你的档案\n竞价金额：${bidAmount} 咕咕币\n余额：${newBalance} 咕咕币\n有效期至：${endStr}`;
                } else {
                    // 失败时返还费用
                    await addCoins(ctx, session.userId, session.platform, bidAmount);
                    return `❌ 推广失败：${result.error}\n\n费用已返还`;
                }
            }
        }

        return next();
    }, true);

    ctx.logger.info("档案推广竞价系统已加载");
}
