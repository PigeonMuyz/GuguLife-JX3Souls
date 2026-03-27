import { Context } from "koishi";
import { SoulProfile } from "../types";
import { getTodayDateString } from "../utils/universal";

// ==================== 配置区 ====================

// 转盘奖池配置
const LOTTERY_PRIZES = [
    { name: "大奖", probability: 5, reward: 100, emoji: "🎉", isLoss: false },
    { name: "小奖", probability: 15, reward: 50, emoji: "✨", isLoss: false },
    { name: "不亏", probability: 35, reward: 30, emoji: "😊", isLoss: false },
    { name: "小亏", probability: 30, reward: 15, emoji: "😅", isLoss: true },
    { name: "血亏", probability: 15, reward: 0, emoji: "💀", isLoss: true },
];

const LOTTERY_COST = 30; // 每次消耗
const DAILY_LIMIT = 10; // 基础每日限制
const NO_LOSS_STREAK_FOR_ADVENTURE = 5; // 连续不亏多少次触发奇遇
const STREAK_FOR_BONUS = 3; // 连击多少次触发奖励

// 次数重置购买价格（每档）
const RESET_PRICES = [50, 100, 200];
const RESET_EXTRA_TIMES = 10; // 每档额外次数

// ==================== 连击状态接口 ====================

interface LotteryStreak {
    lastResult: string;      // 上次结果类型
    streakCount: number;     // 当前连击次数
    noLossStreak: number;    // 不亏连击计数
    purchasedTiers: number;  // 今日已购买档位数
}

// ==================== 核心函数 ====================

/**
 * 根据概率抽取奖项
 */
function spinLottery(): (typeof LOTTERY_PRIZES)[0] {
    const random = Math.random() * 100;
    let cumulative = 0;

    for (const prize of LOTTERY_PRIZES) {
        cumulative += prize.probability;
        if (random < cumulative) {
            return prize;
        }
    }

    return LOTTERY_PRIZES[LOTTERY_PRIZES.length - 1];
}

/**
 * 触发奇遇，返回奖励值和等级
 */
function triggerAdventure(): { reward: number; level: string; emoji: string } {
    // -100 到 +100 的随机值
    const reward = Math.floor(Math.random() * 201) - 100;

    if (reward <= -51) {
        return { reward, level: "黑鬼奇遇", emoji: "💀" };
    } else if (reward >= 51) {
        return { reward, level: "绝世奇遇", emoji: "⭐" };
    } else {
        return { reward, level: "普通奇遇", emoji: "🌙" };
    }
}

/**
 * 触发指定等级的奇遇
 */
function triggerSpecificAdventure(type: "black" | "normal" | "legend"): { reward: number; level: string; emoji: string } {
    let reward: number;
    switch (type) {
        case "black":
            // -100 到 -51
            reward = Math.floor(Math.random() * 50) - 100;
            return { reward, level: "黑鬼奇遇", emoji: "💀" };
        case "legend":
            // +51 到 +100
            reward = Math.floor(Math.random() * 50) + 51;
            return { reward, level: "绝世奇遇", emoji: "⭐" };
        case "normal":
        default:
            // -50 到 +50
            reward = Math.floor(Math.random() * 101) - 50;
            return { reward, level: "普通奇遇", emoji: "🌙" };
    }
}

/**
 * 解析连击状态 JSON
 */
function parseStreakData(data: string | null | undefined): LotteryStreak {
    if (!data) {
        return { lastResult: "", streakCount: 0, noLossStreak: 0, purchasedTiers: 0 };
    }
    try {
        return JSON.parse(data);
    } catch {
        return { lastResult: "", streakCount: 0, noLossStreak: 0, purchasedTiers: 0 };
    }
}

/**
 * 检查并处理连击奖励
 */
function checkStreakBonus(
    currentResult: string,
    streak: LotteryStreak
): {
    bonusReward: number;
    bonusMessage: string;
    adventure: { reward: number; level: string; emoji: string } | null;
} {
    let bonusReward = 0;
    let bonusMessage = "";
    let adventure: { reward: number; level: string; emoji: string } | null = null;

    if (streak.streakCount >= STREAK_FOR_BONUS) {
        switch (currentResult) {
            case "大奖":
                // 50% 概率额外100币，50% 概率触发绝世奇遇
                if (Math.random() < 0.5) {
                    bonusReward = 100;
                    bonusMessage = `\n🔥 【三连大奖】达成！\n✨ 额外获得 +${bonusReward} 咕咕币！`;
                } else {
                    adventure = triggerSpecificAdventure("legend");
                    bonusMessage = `\n🔥 【三连大奖】达成！\n${adventure.emoji} 触发【${adventure.level}】！\n⭐ 额外获得 +${adventure.reward} 咕咕币！`;
                    bonusReward = adventure.reward;
                }
                break;
            case "小奖":
                adventure = triggerSpecificAdventure("normal");
                bonusMessage = `\n🔥 【三连小奖】达成！\n${adventure.emoji} 触发【${adventure.level}】！\n${adventure.reward >= 0 ? "✨" : "😅"} ${adventure.reward >= 0 ? "额外获得" : "倒扣"} ${adventure.reward >= 0 ? "+" : ""}${adventure.reward} 咕咕币${adventure.reward < 0 ? "..." : "！"}`;
                bonusReward = adventure.reward;
                break;
            case "小亏":
                adventure = triggerSpecificAdventure("normal");
                bonusMessage = `\n😰 【三连小亏】触发！\n${adventure.emoji} 触发【${adventure.level}】作为安慰~\n${adventure.reward >= 0 ? "✨" : "😅"} ${adventure.reward >= 0 ? "获得" : "倒扣"} ${adventure.reward >= 0 ? "+" : ""}${adventure.reward} 咕咕币${adventure.reward < 0 ? "..." : "！"}`;
                bonusReward = adventure.reward;
                break;
            case "血亏":
                adventure = triggerSpecificAdventure("black");
                bonusMessage = `\n☠️ 【三连血亏】触发！\n${adventure.emoji} 触发【${adventure.level}】，倒扣 ${adventure.reward} 咕咕币...`;
                bonusReward = adventure.reward;
                break;
        }
    }

    return { bonusReward, bonusMessage, adventure };
}

/**
 * 构建结果消息
 */
function buildResultMessage(
    prize: (typeof LOTTERY_PRIZES)[0],
    finalCoins: number,
    todayCount: number,
    dailyLimit: number,
    adventureMessage: string,
    streakBonusMessage: string,
    isLastChance: boolean,
    canBuyMore: boolean,
    nextPrice: number
): string {
    const separator = "━━━━━━━━━━";

    // 主结果描述
    let prizeDesc: string;
    if (prize.name === "血亏") {
        prizeDesc = `${prize.emoji} 很遗憾，血本无归...`;
    } else if (prize.isLoss) {
        prizeDesc = `${prize.emoji} 获得 +${prize.reward} 咕咕币`;
    } else {
        prizeDesc = `${prize.emoji} 恭喜获得 +${prize.reward} 咕咕币`;
    }

    let message = `🎰 转盘停在了...【${prize.name}】！\n${separator}\n${prizeDesc}`;

    // 添加奇遇信息
    if (adventureMessage) {
        message += `\n${adventureMessage}`;
    }

    // 添加连击奖励信息
    if (streakBonusMessage) {
        message += streakBonusMessage;
    }

    // 添加底部统计
    message += `\n${separator}\n💰 余额：${finalCoins} | 📊 今日 ${todayCount}/${dailyLimit}`;

    // 如果是最后一次且可以购买更多次数，添加提示
    if (isLastChance && canBuyMore) {
        message += `\n💡 发送「转盘加次」花费${nextPrice}币可解锁额外10次`;
    }

    return message;
}

// ==================== 命令注册 ====================

/**
 * 注册转盘命令
 */
export function registerLotteryCommands(ctx: Context) {
    // 主转盘命令
    ctx
        .command("咕咕大转盘")
        .alias("大转盘")
        .action(async ({ session }) => {
            if (!session) return;

            // 获取用户档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (!profiles || profiles.length === 0) {
                return "❌ 你还没有创建情缘档案";
            }

            const myProfile = profiles[0] as SoulProfile;

            // 检查咕咕币是否足够
            if (myProfile.coins < LOTTERY_COST) {
                return `❌ 咕咕币不足（需${LOTTERY_COST}，当前${myProfile.coins}）`;
            }

            // 获取今日使用记录
            const today = getTodayDateString();
            const usageKey = {
                userId: session.userId!,
                platform: session.platform!,
                command: "lottery",
            };

            const usageRecords = await ctx.database.get("soul_command_usage", usageKey);
            let todayCount = 0;
            let streakData: LotteryStreak = { lastResult: "", streakCount: 0, noLossStreak: 0, purchasedTiers: 0 };

            if (usageRecords.length > 0) {
                const record = usageRecords[0];
                const recordDate = new Date(record.updatedAt).toISOString().split("T")[0];
                if (recordDate === today) {
                    todayCount = record.count;
                    streakData = parseStreakData(record.streakData);
                } else {
                    // 新的一天，重置连击和购买状态
                    streakData = { lastResult: "", streakCount: 0, noLossStreak: 0, purchasedTiers: 0 };
                }
            }

            // 计算今日限制
            const dailyLimit = DAILY_LIMIT + streakData.purchasedTiers * RESET_EXTRA_TIMES;

            if (todayCount >= dailyLimit) {
                if (streakData.purchasedTiers < RESET_PRICES.length) {
                    const nextPrice = RESET_PRICES[streakData.purchasedTiers];
                    return `❌ 今日已玩满${dailyLimit}次\n💡 发送「转盘加次」可花费${nextPrice}币解锁额外10次`;
                } else {
                    return `❌ 今日已玩满${dailyLimit}次，明天再来~`;
                }
            }

            // 扣除咕咕币
            let currentCoins = myProfile.coins - LOTTERY_COST;
            await ctx.database.set(
                "soul_profiles",
                { id: myProfile.id },
                { coins: currentCoins, updatedAt: Date.now() }
            );

            // 抽奖
            const prize = spinLottery();

            // 添加奖励
            currentCoins += prize.reward;

            // 更新连击状态
            if (prize.name === streakData.lastResult) {
                streakData.streakCount++;
            } else {
                streakData.streakCount = 1;
                streakData.lastResult = prize.name;
            }

            // 更新不亏连击
            if (!prize.isLoss) {
                streakData.noLossStreak++;
            } else {
                streakData.noLossStreak = 0;
            }

            // 检查奇遇触发（连续不亏5次）
            let adventureMessage = "";
            if (streakData.noLossStreak >= NO_LOSS_STREAK_FOR_ADVENTURE && streakData.noLossStreak % NO_LOSS_STREAK_FOR_ADVENTURE === 0) {
                const adventure = triggerAdventure();
                currentCoins += adventure.reward;
                if (adventure.reward >= 0) {
                    adventureMessage = `\n🌟 触发【${adventure.level}】！\n${adventure.emoji} 额外获得 +${adventure.reward} 咕咕币！`;
                } else {
                    adventureMessage = `\n💀 触发【${adventure.level}】！\n😱 倒扣 ${adventure.reward} 咕咕币...`;
                }
                // 奇遇触发后清零不亏连击计数
                streakData.noLossStreak = 0;
            }

            // 检查连击奖励
            const { bonusReward, bonusMessage } = checkStreakBonus(prize.name, streakData);
            currentCoins += bonusReward;

            // 连击奖励触发后重置连击计数
            if (bonusMessage) {
                streakData.streakCount = 0;
            }

            // 更新最终余额
            await ctx.database.set(
                "soul_profiles",
                { id: myProfile.id },
                { coins: currentCoins, updatedAt: Date.now() }
            );

            // 更新使用次数和连击状态
            const newCount = todayCount + 1;
            const updatedStreakData = JSON.stringify(streakData);

            if (usageRecords.length > 0) {
                const recordDate = new Date(usageRecords[0].updatedAt).toISOString().split("T")[0];
                if (recordDate === today) {
                    await ctx.database.set("soul_command_usage", usageKey, {
                        count: newCount,
                        updatedAt: Date.now(),
                        streakData: updatedStreakData,
                    });
                } else {
                    await ctx.database.set("soul_command_usage", usageKey, {
                        count: 1,
                        updatedAt: Date.now(),
                        streakData: updatedStreakData,
                    });
                }
            } else {
                await ctx.database.create("soul_command_usage", {
                    ...usageKey,
                    count: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    streakData: updatedStreakData,
                });
            }

            // 构造结果消息
            const isLastChance = newCount >= dailyLimit;
            const canBuyMore = streakData.purchasedTiers < RESET_PRICES.length;
            const nextPrice = canBuyMore ? RESET_PRICES[streakData.purchasedTiers] : 0;
            return buildResultMessage(prize, currentCoins, newCount, dailyLimit, adventureMessage, bonusMessage, isLastChance, canBuyMore, nextPrice);
        });

    // 转盘加次命令
    ctx
        .command("转盘加次")
        .alias("大转盘加次")
        .action(async ({ session }) => {
            if (!session) return;

            // 获取用户档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (!profiles || profiles.length === 0) {
                return "❌ 你还没有创建情缘档案";
            }

            const myProfile = profiles[0] as SoulProfile;

            // 获取今日使用记录
            const today = getTodayDateString();
            const usageKey = {
                userId: session.userId!,
                platform: session.platform!,
                command: "lottery",
            };

            const usageRecords = await ctx.database.get("soul_command_usage", usageKey);
            let streakData: LotteryStreak = { lastResult: "", streakCount: 0, noLossStreak: 0, purchasedTiers: 0 };

            if (usageRecords.length > 0) {
                const record = usageRecords[0];
                const recordDate = new Date(record.updatedAt).toISOString().split("T")[0];
                if (recordDate === today) {
                    streakData = parseStreakData(record.streakData);
                }
            }

            // 检查是否已达最大购买次数
            if (streakData.purchasedTiers >= RESET_PRICES.length) {
                return `❌ 今日已购买全部${RESET_PRICES.length}档额外次数，无法再购买`;
            }

            // 获取当前档位价格
            const currentTier = streakData.purchasedTiers;
            const price = RESET_PRICES[currentTier];

            // 检查咕咕币是否足够
            if (myProfile.coins < price) {
                return `❌ 咕咕币不足（需${price}，当前${myProfile.coins}）`;
            }

            // 扣除咕咕币
            const newCoins = myProfile.coins - price;
            await ctx.database.set(
                "soul_profiles",
                { id: myProfile.id },
                { coins: newCoins, updatedAt: Date.now() }
            );

            // 更新购买档位
            streakData.purchasedTiers = currentTier + 1;
            const updatedStreakData = JSON.stringify(streakData);

            if (usageRecords.length > 0) {
                const recordDate = new Date(usageRecords[0].updatedAt).toISOString().split("T")[0];
                if (recordDate === today) {
                    await ctx.database.set("soul_command_usage", usageKey, {
                        updatedAt: Date.now(),
                        streakData: updatedStreakData,
                    });
                } else {
                    // 新的一天，创建新记录
                    await ctx.database.set("soul_command_usage", usageKey, {
                        count: 0,
                        updatedAt: Date.now(),
                        streakData: updatedStreakData,
                    });
                }
            } else {
                await ctx.database.create("soul_command_usage", {
                    ...usageKey,
                    count: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    streakData: updatedStreakData,
                });
            }

            const newLimit = DAILY_LIMIT + streakData.purchasedTiers * RESET_EXTRA_TIMES;
            const nextTierInfo = streakData.purchasedTiers < RESET_PRICES.length
                ? `\n💡 下一档：${RESET_PRICES[streakData.purchasedTiers]}币`
                : "";

            return `✅ 成功购买第${streakData.purchasedTiers}档额外次数！\n━━━━━━━━━━\n💰 花费：-${price} 咕咕币\n📊 今日上限：${newLimit}次\n💰 余额：${newCoins}${nextTierInfo}`;
        });

    ctx.logger.info("咕咕大转盘命令已加载");
}
