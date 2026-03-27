import { Context } from "koishi";
import { SoulProfile, SoulRedPacket } from "../types";
import { isAdminUserId, safeSendPrivateMessage } from "../utils/universal";

// 红包配置
const FEE_RATE = 0.1; // 10% 手续费
const DEFAULT_EXPIRE_TIME_MS = 5 * 60 * 1000; // 默认5分钟有效期
const MAX_EXPIRE_TIME_MINUTES = 1440; // 最大过期时间：1440分钟（24小时）
const MIN_AMOUNT = 10; // 最低金额
const MIN_COUNT = 2; // 最少个数

// 存储活跃红包（内存缓存，用于快速查询）
const activeRedPackets = new Map<string, { groupId: string; expireTimer: ReturnType<typeof setTimeout> }>();

/**
 * 随机分配红包金额（二倍均值法）
 */
function splitRedPacket(totalAmount: number, count: number): number[] {
    const amounts: number[] = [];
    let remaining = totalAmount;

    for (let i = 0; i < count - 1; i++) {
        // 二倍均值法：随机金额在 [1, 剩余金额/剩余人数 * 2] 之间
        const max = Math.floor((remaining / (count - i)) * 2);
        const amount = Math.max(1, Math.floor(Math.random() * max));
        amounts.push(amount);
        remaining -= amount;
    }
    amounts.push(remaining); // 最后一个人拿剩余的

    // 打乱顺序
    return amounts.sort(() => Math.random() - 0.5);
}

/**
 * 注册红包命令
 */
export function registerRedPacketCommands(ctx: Context) {
    // 发红包命令
    // 参数说明：金额 数量 时间(分钟,最大1440) 管理员免费(1=不消耗咕咕币) 口令
    // 注意：口令必须放最后，因为text类型会匹配所有剩余内容
    ctx
        .command("发红包 <amount:number> [count:number] [expireMinutes:number] [adminFree:number] [password:text]")
        .action(async ({ session }, amount, count = 5, expireMinutes, adminFree, password) => {
            if (!session) return;

            // 必须在群里使用
            if (session.isDirect) {
                return "❌ 发红包只能在群里使用哦~";
            }

            // 获取用户档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (!profiles || profiles.length === 0) {
                return "❌ 你还没有创建情缘档案，无法发红包";
            }

            const myProfile = profiles[0] as SoulProfile;

            // 参数校验
            if (!amount || amount < MIN_AMOUNT) {
                return `❌ 红包金额至少 ${MIN_AMOUNT} 咕咕币`;
            }

            if (count < MIN_COUNT) {
                return `❌ 红包至少 ${MIN_COUNT} 个`;
            }

            if (count > 100) {
                return "❌ 红包最多 100 个";
            }

            // 校验时间参数
            let expireTimeMs = DEFAULT_EXPIRE_TIME_MS;
            if (expireMinutes !== undefined) {
                if (expireMinutes < 1) {
                    return "❌ 红包有效期至少 1 分钟";
                }
                if (expireMinutes > MAX_EXPIRE_TIME_MINUTES) {
                    return `❌ 红包有效期最多 ${MAX_EXPIRE_TIME_MINUTES} 分钟（24小时）`;
                }
                expireTimeMs = expireMinutes * 60 * 1000;
            }

            // 检查是否管理员免费发红包
            const isAdmin = isAdminUserId(session.userId!);
            const isFree = isAdmin && adminFree === 1;

            // 计算总费用（含手续费）
            const fee = isFree ? 0 : Math.ceil(amount * FEE_RATE);
            const totalCost = isFree ? 0 : amount + fee;

            if (!isFree && myProfile.coins < totalCost) {
                return `❌ 咕咕币不足！\n红包金额：${amount}\n手续费（10%）：${fee}\n总需：${totalCost} 咕咕币\n当前余额：${myProfile.coins} 咕咕币`;
            }

            // 扣除咕咕币（管理员免费时不扣除）
            if (!isFree) {
                await ctx.database.set(
                    "soul_profiles",
                    { id: myProfile.id },
                    { coins: myProfile.coins - totalCost, updatedAt: Date.now() }
                );
            }

            // 创建红包记录
            const expiredAt = Date.now() + expireTimeMs;
            const redPacket = await ctx.database.create("soul_red_packets", {
                senderId: session.userId!,
                senderPlatform: session.platform!,
                groupId: session.channelId!,
                totalAmount: amount,
                remainingAmount: amount,
                totalCount: count,
                remainingCount: count,
                password: password || undefined,
                receivers: "[]",
                createdAt: Date.now(),
                expiredAt,
            });

            // 设置过期定时器
            const cacheKey = `${session.channelId}-${redPacket.id}`;
            const expireTimer = setTimeout(async () => {
                await handleRedPacketExpire(ctx, redPacket.id!, session.channelId!, isFree);
            }, expireTimeMs);

            activeRedPackets.set(cacheKey, {
                groupId: session.channelId!,
                expireTimer,
            });

            // 构造消息
            const expireMinutesDisplay = expireMinutes || 5;
            let message = `🧧 红包来啦！\n`;
            message += `━━━━━━━━━━━\n`;
            message += `💰 总额：${amount} 咕咕币\n`;
            message += `📦 数量：${count} 个\n`;
            if (password) {
                message += `🔐 口令：${password}\n`;
                message += `\n回复口令即可领取！`;
            } else {
                message += `\n发送「抢红包」即可领取！`;
            }
            message += `\n⏰ ${expireMinutesDisplay}分钟内有效`;
            if (isFree) {
                message += `\n🎁 特殊红包`;
            }

            return message;
        });

    // 抢红包命令
    ctx.command("抢红包").action(async ({ session }) => {
        if (!session) return;

        if (session.isDirect) {
            return "❌ 抢红包只能在群里使用哦~";
        }

        const result = await grabRedPacket(ctx, session.userId!, session.platform!, session.channelId!, null);
        if (result) {
            // 通过私聊通知用户
            await safeSendPrivateMessage(ctx, session.userId!, result);
        }
        return; // 不在群里发送任何消息
    });

    // 监听群消息，处理口令红包
    ctx.middleware(async (session, next) => {
        // 只处理群消息
        if (session.isDirect || !session.content || !session.channelId) {
            return next();
        }

        const content = session.content.trim();

        // 检查是否有匹配口令的红包
        const redPackets = await ctx.database.get("soul_red_packets", {
            groupId: session.channelId,
            remainingCount: { $gt: 0 },
        });

        for (const packet of redPackets) {
            if (packet.password && packet.password === content && packet.expiredAt > Date.now()) {
                const result = await grabRedPacket(ctx, session.userId!, session.platform!, session.channelId!, packet.id!);
                if (result) {
                    // 通过私聊通知用户
                    await safeSendPrivateMessage(ctx, session.userId!, result);
                    return; // 不在群里发送任何消息
                }
            }
        }

        return next();
    });

    ctx.logger.info("群红包命令已加载");
}

/**
 * 抢红包逻辑
 */
async function grabRedPacket(
    ctx: Context,
    userId: string,
    platform: string,
    groupId: string,
    specificPacketId: number | null
): Promise<string | null> {
    // 查找可用红包
    let packets: SoulRedPacket[];
    if (specificPacketId) {
        packets = await ctx.database.get("soul_red_packets", { id: specificPacketId });
    } else {
        // 查找不需要口令的红包
        packets = await ctx.database
            .select("soul_red_packets")
            .where({
                groupId,
                remainingCount: { $gt: 0 },
            })
            .execute();
        // 过滤掉需要口令的和已过期的
        packets = packets.filter((p) => !p.password && p.expiredAt > Date.now());
    }

    if (packets.length === 0) {
        return "🧧 没有可抢的红包哦~";
    }

    const packet = packets[0];

    // 检查是否已过期
    if (packet.expiredAt <= Date.now()) {
        return "⏰ 红包已过期";
    }

    // 检查是否已经抢过
    const receivers = JSON.parse(packet.receivers || "[]") as Array<{ userId: string; amount: number; time: number }>;
    if (receivers.some((r) => r.userId === userId)) {
        return "🧧 你已经抢过这个红包啦~";
    }

    // 检查是否抢完
    if (packet.remainingCount <= 0) {
        return "🧧 红包已被抢完啦~";
    }

    // 计算本次金额
    const amounts = splitRedPacket(packet.remainingAmount, packet.remainingCount);
    const myAmount = amounts[0];

    // 更新红包记录
    receivers.push({ userId, amount: myAmount, time: Date.now() });
    await ctx.database.set("soul_red_packets", { id: packet.id }, {
        remainingAmount: packet.remainingAmount - myAmount,
        remainingCount: packet.remainingCount - 1,
        receivers: JSON.stringify(receivers),
    });

    // 给领取者加咕咕币
    const userProfiles = await ctx.database.get("soul_profiles", { userId, platform });
    if (userProfiles.length > 0) {
        const profile = userProfiles[0];
        await ctx.database.set("soul_profiles", { id: profile.id }, {
            coins: profile.coins + myAmount,
            updatedAt: Date.now(),
        });
    }

    // 检查是否抢完
    const newRemainingCount = packet.remainingCount - 1;
    let message = `🎉 恭喜领取红包！\n`;
    message += `💰 获得 ${myAmount} 咕咕币\n`;
    message += `（剩余 ${newRemainingCount}/${packet.totalCount} 个）`;

    if (newRemainingCount === 0) {
        message += `\n\n🧧 红包已被抢光！`;
        // 清理缓存
        const cacheKey = `${groupId}-${packet.id}`;
        const cached = activeRedPackets.get(cacheKey);
        if (cached) {
            clearTimeout(cached.expireTimer);
            activeRedPackets.delete(cacheKey);
        }
    }

    return message;
}

/**
 * 红包过期处理
 */
async function handleRedPacketExpire(ctx: Context, packetId: number, groupId: string, isFree: boolean = false) {
    const packets = await ctx.database.get("soul_red_packets", { id: packetId });
    if (packets.length === 0) return;

    const packet = packets[0];

    // 如果还有剩余金额，返还给发送者（管理员免费红包不返还）
    if (packet.remainingAmount > 0 && !isFree) {
        const senderProfiles = await ctx.database.get("soul_profiles", {
            userId: packet.senderId,
            platform: packet.senderPlatform,
        });

        if (senderProfiles.length > 0) {
            const sender = senderProfiles[0];
            await ctx.database.set("soul_profiles", { id: sender.id }, {
                coins: sender.coins + packet.remainingAmount,
                updatedAt: Date.now(),
            });

            ctx.logger.info(
                `红包过期返还 - ID:${packetId}, 返还${packet.remainingAmount}咕咕币给${packet.senderId}`
            );
        }
    }

    // 清理缓存
    const cacheKey = `${groupId}-${packetId}`;
    activeRedPackets.delete(cacheKey);
}
