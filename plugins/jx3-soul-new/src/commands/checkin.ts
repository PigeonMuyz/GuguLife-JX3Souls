import { Context } from "koishi";
import { getTodayDateString } from "../utils/universal";

// 签到奖励常量
const CHECKIN_REWARD = 40;           // 每日签到奖励
const ACTIVITY_REWARD_MAX = 30;       // 活跃度每日上限
const ACTIVITY_REWARD_CHANCE = 0.4;   // 每条消息获得奖励的概率 (~2.5条/币)
const MESSAGE_THRESHOLD_FOR_FULL_REWARD = 10;  // 发言达到此条数直接给满额奖励

// 获取或初始化用户的每日奖励记录
async function getOrInitDailyRewards(
  ctx: Context,
  userId: string,
  platform: string
): Promise<{
  id?: number;
  userId: string;
  platform: string;
  lastCheckinDate: string | null;
  lastActivityDate: string | null;
  dailyActivityCoins: number;
  dailyMessageCount: number;
  createdAt: number;
  updatedAt: number;
}> {
  const records = await ctx.database.get("daily_rewards", { userId, platform });

  if (records.length > 0) {
    const record = records[0] as any;
    // 兼容旧记录：如果没有新字段，添加默认值
    return {
      ...record,
      lastCheckinDate: record.lastCheckinDate ?? record.lastGroupCheckinRewardDate ?? record.lastPrivateCheckinRewardDate ?? null,
      lastActivityDate: record.lastActivityDate ?? record.lastGroupMessageRewardDate ?? null,
      dailyActivityCoins: record.dailyActivityCoins ?? 0,
      dailyMessageCount: record.dailyMessageCount ?? 0,
    };
  }

  // 初始化记录
  const now = Date.now();
  const newRecord = {
    userId,
    platform,
    lastCheckinDate: null,
    lastActivityDate: null,
    dailyActivityCoins: 0,
    dailyMessageCount: 0,
    // 保留旧字段兼容性
    lastGroupMessageRewardDate: null,
    lastGroupCheckinRewardDate: null,
    lastPrivateCheckinRewardDate: null,
    createdAt: now,
    updatedAt: now,
  };

  const created = await ctx.database.create("daily_rewards", newRecord);
  return created as any;
}

// 为用户添加硬币
async function addCoins(
  ctx: Context,
  userId: string,
  platform: string,
  amount: number
): Promise<number | null> {
  const profiles = await ctx.database.get("soul_profiles", {
    userId,
    platform,
  });
  if (profiles.length === 0) {
    return null;
  }

  const profile = profiles[0];
  const newCoins = profile.coins + amount;

  await ctx.database.set(
    "soul_profiles",
    { id: profile.id },
    {
      coins: newCoins,
      updatedAt: Date.now(),
    }
  );

  return newCoins;
}

// 活跃度奖励（静默）
function registerActivityReward(ctx: Context) {
  ctx.logger.info("活跃度奖励组件已加载");

  ctx.on("message", async (session) => {
    if (!session.userId || !session.platform) return;

    // 检查用户是否有档案
    const profiles = await ctx.database.get("soul_profiles", {
      userId: session.userId,
      platform: session.platform,
    });

    if (profiles.length === 0) return;

    const todayDate = getTodayDateString();

    // 获取奖励记录
    const records = await getOrInitDailyRewards(
      ctx,
      session.userId,
      session.platform
    );

    // 检查是否是新的一天，重置活跃度和发言计数
    let currentActivityCoins = records.dailyActivityCoins || 0;
    let currentMessageCount = records.dailyMessageCount || 0;
    if (records.lastActivityDate !== todayDate) {
      currentActivityCoins = 0;
      currentMessageCount = 0;
    }

    // 检查是否已达每日上限
    if (currentActivityCoins >= ACTIVITY_REWARD_MAX) {
      return;
    }

    // 增加今日发言计数
    currentMessageCount += 1;

    // 情况1：刚好达到发言阈值（第10条），补足到20币
    if (currentMessageCount === MESSAGE_THRESHOLD_FOR_FULL_REWARD) {
      const targetCoins = 20; // 发言满10条时应该累积获得20币
      if (currentActivityCoins < targetCoins) {
        const bonusCoins = targetCoins - currentActivityCoins;
        await addCoins(ctx, session.userId, session.platform, bonusCoins);
        currentActivityCoins = targetCoins;
      }

      // 更新活跃度记录
      await ctx.database.set(
        "daily_rewards",
        { userId: session.userId, platform: session.platform },
        {
          lastActivityDate: todayDate,
          dailyActivityCoins: currentActivityCoins,
          dailyMessageCount: currentMessageCount,
          updatedAt: Date.now(),
        }
      );
      return;
    }

    // 情况2：发言未满10条，40%概率给1币
    // 情况3：发言超过10条，继续40%概率给1币直到30上限
    let coinsToAdd = 0;
    if (Math.random() <= ACTIVITY_REWARD_CHANCE) {
      coinsToAdd = 1;
      await addCoins(ctx, session.userId, session.platform, 1);
    }

    // 更新活跃度记录
    await ctx.database.set(
      "daily_rewards",
      { userId: session.userId, platform: session.platform },
      {
        lastActivityDate: todayDate,
        dailyActivityCoins: currentActivityCoins + coinsToAdd,
        dailyMessageCount: currentMessageCount,
        updatedAt: Date.now(),
      }
    );
  });
}

// 注册打卡签到命令
export function registerCheckinCommands(ctx: Context) {
  // 统一签到命令（群聊/私聊通用）
  ctx
    .command("打卡")
    .alias("签到")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) {
        return;
      }

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      if (profiles.length === 0) {
        return;
      }

      const todayDate = getTodayDateString();

      // 获取奖励记录
      const records = await getOrInitDailyRewards(
        ctx,
        session.userId,
        session.platform
      );

      // 检查今日是否已签到
      if (records.lastCheckinDate === todayDate) {
        return `<at id="${session.userId}"/> 今日已经签到过了！当前咕咕币：${profiles[0].coins}`;
      }

      // 发放签到奖励
      const newCoins = await addCoins(
        ctx,
        session.userId,
        session.platform,
        CHECKIN_REWARD
      );

      if (newCoins === null) {
        return;
      }

      // 更新签到日期
      await ctx.database.set(
        "daily_rewards",
        { userId: session.userId, platform: session.platform },
        {
          lastCheckinDate: todayDate,
          updatedAt: Date.now(),
        }
      );

      ctx.logger.info(
        `[签到] 用户：${session.userId} +${CHECKIN_REWARD} 咕咕币，余额：${newCoins}`
      );

      return `<at id="${session.userId}"/> 签到成功！获得 ${CHECKIN_REWARD} 咕咕币，当前余额：${newCoins}`;
    });

  ctx.logger.info("签到系统已加载");

  // 注册活跃度奖励
  registerActivityReward(ctx);
}
