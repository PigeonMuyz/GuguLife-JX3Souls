import { Context } from "koishi";
import { $ } from "minato";

// 进行中的V50交易记录（用于劫镖功能）
interface PendingV50Transfer {
  senderId: string;
  receiverId: string;
  platform: string;
  groupId: string;
  amount: number; // 转账金额
  receivedAmount: number; // 接收者实际收到的金额（扣税后）
  isThursday: boolean;
  isFreeTransfer: boolean; // 是否为免费转账（疯狂星期四触发）
  timestamp: number;
  attemptedRobbers: Set<string>; // 已尝试劫镖的用户ID列表
}

// 存储进行中的V50交易，key为groupId，value为该群的交易列表（支持多镖）
const pendingV50Transfers = new Map<string, PendingV50Transfer[]>();

// 劫镖成功冷却记录，key为`${platform}:${userId}`，value为上次劫镖成功的时间戳
const robberyCooldowns = new Map<string, number>();
const ROBBERY_COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却
const ROBBERY_WINDOW_MS = 50 * 1000; // 50秒劫镖窗口

/**
 * 计算交易税（超出50的部分按5%，向上取整，不足1按1）
 */
function calculateTax(amount: number): number {
  const excess = amount - 50;
  if (excess <= 0) return 0;
  return Math.ceil(excess * 0.05);
}

/**
 * 计算劫镖成功率（百分比）
 * v50~v100: 40% + (amount-50)/10 * 2%
 * v100~v500: 50% + (amount-100)/100 * 5%
 * v500+: 封顶70%
 */
function getRobberySuccessRate(amount: number): number {
  if (amount <= 100) {
    return 40 + Math.floor((amount - 50) / 10) * 2;
  } else if (amount < 500) {
    return 50 + Math.floor((amount - 100) / 100) * 5;
  } else {
    return 70; // 封顶
  }
}

/**
 * 计算劫镖者收益
 * v50~v99: 1~50随机（现有逻辑）
 * v100+: (receivedAmount - 50) 的 70%~100% 随机
 */
function calculateRobberyGain(amount: number, receivedAmount: number): { robberGain: number; receiverKeeps: number } {
  if (amount < 100) {
    // 保持现有逻辑：劫镖者获得1-50随机
    const robberGain = Math.floor(Math.random() * 50) + 1;
    return { robberGain, receiverKeeps: 0 };
  } else {
    // v100+: 接收者保留50，劫镖者获得可劫池的70%~100%
    const pool = receivedAmount - 50;
    const percentage = 70 + Math.floor(Math.random() * 31); // 70~100
    const robberGain = Math.floor(pool * percentage / 100);
    return { robberGain, receiverKeeps: 50 };
  }
}

export function registerV50Listener(ctx: Context) {
  const logger = ctx.logger;

  // 监听v转账消息（格式：<at id="xxxxxxx" /> v数量）
  ctx.on("message", async (session) => {
    if (session.isDirect) return;
    if (!session.content) return;

    // 匹配 @某人 v数量 的格式
    const vPattern = /^<at id="(\d+)"[^\/]*\/> v(\d+)$/i;
    const match = session.content.match(vPattern);

    if (!match) {
      return;
    }

    const receiverId = match[1];
    const amount = parseInt(match[2], 10);
    const senderId = session.userId;
    const platform = session.platform;
    const groupId = session.channelId;

    // 检查金额是否>=50
    if (amount < 50) {
      await session.send(`<at id="${senderId}" /> 最低转账 50 咕咕币哦！`);
      return;
    }

    // 检查是否给自己转账
    if (senderId === receiverId) {
      await session.send(`<at id="${senderId}" /> 你还要v自己？`);
      return;
    }

    // 获取双方档案
    const senderProfile = await ctx.database.get("soul_profiles", {
      userId: senderId,
      platform,
    });

    const receiverProfile = await ctx.database.get("soul_profiles", {
      userId: receiverId,
      platform,
    });

    // 检查双方是否有档案
    if (!senderProfile || senderProfile.length === 0) {
      await session.send(`<at id="${senderId}" /> 你没有情缘档案！不能转账！`);
      return;
    }
    if (!receiverProfile || receiverProfile.length === 0) {
      await session.send(`<at id="${senderId}" /> Ta没有情缘档案！不能转账！`);
      return;
    }

    const sender = senderProfile[0];
    const receiver = receiverProfile[0];

    // 检查是否为星期四
    const isThursday = new Date().getDay() === 4;
    let deductCoins = true;
    let isFreeTransfer = false;

    // 周四免费逻辑（仅对v50适用）
    const today = new Date().toISOString().split("T")[0];

    // 检查今天是否已触发免费v50
    let freeTriggered = false;
    if (isThursday) {
      const freeRecord = await ctx.database.get("soul_v50_free_records", {
        userId: senderId,
        platform,
        freeDate: today,
      });
      freeTriggered = freeRecord.length > 0;
    }

    // 每日对同一人转账次数限制（2次）
    // 周四豁免：免费触发完成之前不受限制
    const skipDailyLimit = isThursday && !freeTriggered;
    if (!skipDailyLimit) {
      const transferRecords = await ctx.database.get("soul_v50_transfer_records", {
        senderId: senderId!,
        receiverId,
        platform: platform!,
        transferDate: today,
      });

      if (transferRecords.length > 0 && transferRecords[0].count >= 2) {
        await session.send(`<at id="${senderId}" /> ❌ 你今天已经给Ta转了 2 次啦，明天再来吧！`);
        return;
      }
    }

    // 周四免费判定（仅v50且未使用过免费额度时）
    if (isThursday && amount === 50 && !freeTriggered) {
      const random = Math.random() * 100;
      if (random >= 20 && random <= 50) {
        deductCoins = false;
        isFreeTransfer = true;
        await ctx.database.create("soul_v50_free_records", {
          userId: senderId,
          platform,
          freeDate: today,
          createdAt: Date.now(),
        });
      }
    }

    // 计算税额
    const tax = calculateTax(amount);
    const receivedAmount = amount - tax;

    // 如果需要扣除，检查是否有足够的咕咕币
    if (deductCoins) {
      if (sender.coins < amount) {
        await session.send(
          `<at id="${senderId}" /> ❌ 你只有 ${sender.coins} 个咕咕币，无法转账 ${amount} 个咕咕币！`
        );
        return;
      }
      // 扣除发送者咕咕币（扣的是原始金额，使用原子操作防止竞态条件）
      await ctx.database.set(
        "soul_profiles",
        { userId: senderId, platform },
        (row) => ({ coins: $.subtract(row.coins, amount) })
      );
    }

    // 给接收者增加咕咕币（扣税后的金额，使用原子操作防止竞态条件）
    await ctx.database.set(
      "soul_profiles",
      { userId: receiverId, platform },
      (row) => ({ coins: $.add(row.coins, receivedAmount) })
    );

    // 更新每日转账次数记录
    const existingRecord = await ctx.database.get("soul_v50_transfer_records", {
      senderId: senderId!,
      receiverId,
      platform: platform!,
      transferDate: today,
    });

    if (existingRecord.length > 0) {
      await ctx.database.set(
        "soul_v50_transfer_records",
        { senderId: senderId!, receiverId, platform: platform!, transferDate: today },
        { count: existingRecord[0].count + 1 }
      );
    } else {
      await ctx.database.create("soul_v50_transfer_records", {
        senderId: senderId!,
        receiverId,
        platform: platform!,
        transferDate: today,
        count: 1,
      });
    }

    // 构建转账成功消息
    const deductionMsg = deductCoins ? "" : "（恭喜！本次不扣除咕咕币）";
    const taxMsg = tax > 0 ? `\n📦 交易税: ${tax} 咕咕币（对方实收 ${receivedAmount}）` : "";
    await session.send(
      `<at id="${senderId}" /> 好诶！你成功的给<at id="${receiverId}" />送了${amount}个咕咕币！${deductionMsg}${taxMsg}\n💡 50秒内有人可以发送「劫镖」试试运气！`
    );

    // 记录V50交易状态（用于劫镖功能）
    const transferInfo: PendingV50Transfer = {
      senderId: senderId!,
      receiverId,
      platform: platform!,
      groupId: groupId!,
      amount,
      receivedAmount,
      isThursday,
      isFreeTransfer,
      timestamp: Date.now(),
      attemptedRobbers: new Set<string>(),
    };

    // 添加到群的镖列表中（支持多镖）
    const groupTransfers = pendingV50Transfers.get(groupId!) || [];
    groupTransfers.push(transferInfo);
    pendingV50Transfers.set(groupId!, groupTransfers);

    // 50秒后自动清理该笔交易
    setTimeout(() => {
      const transfers = pendingV50Transfers.get(groupId!);
      if (transfers) {
        const index = transfers.findIndex(t => t.timestamp === transferInfo.timestamp && t.senderId === transferInfo.senderId);
        if (index !== -1) {
          transfers.splice(index, 1);
          if (transfers.length === 0) {
            pendingV50Transfers.delete(groupId!);
          }
          logger.info(`V50交易记录已过期清理 - 群: ${groupId}, 金额: ${amount}`);
        }
      }
    }, ROBBERY_WINDOW_MS);

    logger.info(
      `v转账完成 - 发送者: ${senderId}, 接收者: ${receiverId}, 金额: ${amount}, 税额: ${tax}, 实收: ${receivedAmount}, 扣除咕咕币: ${deductCoins}, 周四活动: ${isThursday}, 免费转账: ${isFreeTransfer}`
    );
  });

  // 监听劫镖消息
  ctx.on("message", async (session) => {
    if (session.isDirect) return;
    if (!session.content) return;

    // 检查是否为劫镖命令
    if (session.content.trim() !== "劫镖") return;

    const robberId = session.userId!;
    const platform = session.platform!;
    const groupId = session.channelId!;

    // 获取该群所有进行中的镖
    const allTransfers = pendingV50Transfers.get(groupId);
    if (!allTransfers || allTransfers.length === 0) {
      await session.send(`<at id="${robberId}" /> 🚫 当前没有可劫的镖！`);
      return;
    }

    // 检查劫镖者是否有档案
    const robberProfile = await ctx.database.get("soul_profiles", {
      userId: robberId,
      platform,
    });
    if (!robberProfile || robberProfile.length === 0) {
      await session.send(`<at id="${robberId}" /> ❌ 你没有情缘档案，不能劫镖！`);
      return;
    }

    // 检查劫镖冷却
    const cooldownKey = `${platform}:${robberId}`;
    const lastRobberyTime = robberyCooldowns.get(cooldownKey);
    if (lastRobberyTime) {
      const elapsed = Date.now() - lastRobberyTime;
      if (elapsed < ROBBERY_COOLDOWN_MS) {
        const remainingMinutes = Math.ceil((ROBBERY_COOLDOWN_MS - elapsed) / 60000);
        await session.send(`<at id="${robberId}" /> ⏳ 劫镖冷却中，还需等待 ${remainingMinutes} 分钟`);
        return;
      }
    }

    // 过滤出有效的镖（未过期、劫镖者不是发送者/接收者、未尝试过）
    const now = Date.now();
    const validTransfers: PendingV50Transfer[] = [];
    const skippedReasons: string[] = [];

    for (const transfer of allTransfers) {
      // 检查是否超时
      if (now - transfer.timestamp > ROBBERY_WINDOW_MS) {
        continue; // 跳过超时的
      }
      // 不能劫自己发送的
      if (robberId === transfer.senderId) {
        skippedReasons.push("你发的镖不能劫");
        continue;
      }
      // 不能劫给自己的
      if (robberId === transfer.receiverId) {
        skippedReasons.push("送给你的不能劫");
        continue;
      }
      // 检查是否已尝试过
      if (transfer.attemptedRobbers.has(robberId)) {
        skippedReasons.push("已经尝试过了");
        continue;
      }
      validTransfers.push(transfer);
    }

    if (validTransfers.length === 0) {
      const reason = skippedReasons.length > 0 ? `（${skippedReasons[0]}）` : "";
      await session.send(`<at id="${robberId}" /> 🚫 没有可劫的镖${reason}`);
      return;
    }

    // 对所有有效的镖依次尝试
    let totalGain = 0;
    let successCount = 0;
    let failCount = 0;
    const resultDetails: string[] = [];
    let hasAnySuccess = false;
    let hasCounterRobbery = false;
    const counterRobberyMessages: string[] = [];

    for (const transfer of validTransfers) {
      // 记录这次尝试
      transfer.attemptedRobbers.add(robberId);

      // 计算成功率
      const successRate = getRobberySuccessRate(transfer.amount);
      const roll = Math.floor(Math.random() * 100) + 1;
      const isSuccess = roll <= successRate;

      logger.info(`劫镖判定 - 金额: ${transfer.amount}, 成功率: ${successRate}%, 掷骰: ${roll}, 成功: ${isSuccess}`);

      if (!isSuccess) {
        failCount++;
        resultDetails.push(`v${transfer.amount} ❌`);
        continue;
      }

      // 劫镖成功
      hasAnySuccess = true;
      successCount++;

      // 获取接收者当前档案
      const receiverProfile = await ctx.database.get("soul_profiles", {
        userId: transfer.receiverId,
        platform,
      });
      if (!receiverProfile || receiverProfile.length === 0) {
        resultDetails.push(`v${transfer.amount} ❌ 目标档案不存在`);
        continue;
      }
      const receiverCurrent = receiverProfile[0];

      let robberGain = 0;
      let extraMessage = "";

      if (transfer.isThursday && transfer.isFreeTransfer) {
        // 疯狂星期四 + 免费转账情况
        const senderProfile = await ctx.database.get("soul_profiles", {
          userId: transfer.senderId,
          platform,
        });
        if (senderProfile && senderProfile.length > 0) {
          await ctx.database.set(
            "soul_profiles",
            { userId: transfer.senderId, platform },
            (row) => ({ coins: $.if($.gte(row.coins, 50), $.subtract(row.coins, 50), 0) })
          );
          extraMessage = "⚡发送者额外-50";
        }
        robberGain = 50;
        // 接收者被扣回全部
        await ctx.database.set(
          "soul_profiles",
          { userId: transfer.receiverId, platform },
          (row) => ({ coins: $.if($.gte(row.coins, transfer.receivedAmount), $.subtract(row.coins, transfer.receivedAmount), 0) })
        );
      } else {
        // 根据金额计算收益
        const result = calculateRobberyGain(transfer.amount, transfer.receivedAmount);
        robberGain = result.robberGain;

        if (transfer.amount >= 100) {
          // v100+：接收者保留50，扣回 receivedAmount - 50
          const deductFromReceiver = transfer.receivedAmount - result.receiverKeeps;
          await ctx.database.set(
            "soul_profiles",
            { userId: transfer.receiverId, platform },
            (row) => ({ coins: $.if($.gte(row.coins, deductFromReceiver), $.subtract(row.coins, deductFromReceiver), 0) })
          );
        } else {
          // v50-v99：接收者被扣回全部
          await ctx.database.set(
            "soul_profiles",
            { userId: transfer.receiverId, platform },
            (row) => ({ coins: $.if($.gte(row.coins, transfer.receivedAmount), $.subtract(row.coins, transfer.receivedAmount), 0) })
          );
        }
      }

      // === 反劫镖判定 ===
      // 劫镖成功后，1-20%概率被接收者反劫
      const counterRobberyRate = Math.floor(Math.random() * 20) + 1; // 1-20
      const counterRoll = Math.floor(Math.random() * 100) + 1;
      const isCounterRobbed = counterRoll <= counterRobberyRate;

      if (isCounterRobbed && robberGain > 0) {
        // 反劫镖触发！
        // 反劫池 = 可劫池的50%
        const originalPool = transfer.amount >= 100
          ? transfer.receivedAmount - 50
          : transfer.receivedAmount;
        const counterPool = Math.floor(originalPool * 0.5);

        if (counterPool > 0) {
          // 系统回收5%
          const systemTake = Math.ceil(counterPool * 0.05);
          const remaining = counterPool - systemTake;

          // 双方平分剩余
          const eachShare = Math.floor(remaining / 2);
          const receiverCounterGain = remaining - eachShare; // 多余的给接收者

          // 调整劫镖者收益：减去反劫池，再加回自己的份额
          const robberLoss = counterPool - eachShare;
          robberGain = Math.max(0, robberGain - robberLoss);

          // 给接收者返还反劫收益（在之前已扣款的基础上加回，使用原子操作）
          await ctx.database.set(
            "soul_profiles",
            { userId: transfer.receiverId, platform },
            (row) => ({ coins: $.add(row.coins, receiverCounterGain) })
          );

          hasCounterRobbery = true;
          counterRobberyMessages.push(
            `<at id="${robberId}" /> 你被成功反劫镖了！扣除 ${robberLoss} 咕咕币！\n<at id="${transfer.receiverId}" /> 保住了 ${receiverCounterGain} 咕咕币！`
          );
          logger.info(
            `反劫镖触发 - 反劫池: ${counterPool}, 系统回收: ${systemTake}, 劫镖者损失: ${robberLoss}, 接收者回收: ${receiverCounterGain}`
          );
        }
      }

      totalGain += robberGain;

      const keepMsg = transfer.amount >= 100 ? "（对方保留50）" : "";
      const thursdayMsg = extraMessage ? ` ${extraMessage}` : "";
      resultDetails.push(`v${transfer.amount} ✅ +${robberGain}${keepMsg}${thursdayMsg}`);

      // 从镖列表中移除已被劫成功的镖
      const transfers = pendingV50Transfers.get(groupId);
      if (transfers) {
        const index = transfers.findIndex(t => t.timestamp === transfer.timestamp && t.senderId === transfer.senderId);
        if (index !== -1) {
          transfers.splice(index, 1);
          if (transfers.length === 0) {
            pendingV50Transfers.delete(groupId);
          }
        }
      }

      logger.info(
        `劫镖成功 - 劫镖者: ${robberId}, 获得: ${robberGain}, 发送者: ${transfer.senderId}, 接收者: ${transfer.receiverId}, 金额: ${transfer.amount}, 被反劫: ${isCounterRobbed}`
      );
    }

    // 给劫镖者增加总收益（使用原子操作）
    if (totalGain > 0) {
      await ctx.database.set(
        "soul_profiles",
        { userId: robberId, platform },
        (row) => ({ coins: $.add(row.coins, totalGain) })
      );
    }

    // 构建汇总消息
    let totalMsg: string;
    const counterMsg = counterRobberyMessages.join("\n");

    if (validTransfers.length === 1) {
      if (hasAnySuccess) {
        if (hasCounterRobbery) {
          totalMsg = counterMsg;
        } else {
          totalMsg = `<at id="${robberId}" /> 🎉 劫镖成功！获得 ${totalGain} 咕咕币！`;
        }
      } else {
        totalMsg = `<at id="${robberId}" /> 劫镖失败了捏`;
      }
    } else {
      // 多镖：树形格式
      const formattedDetails = resultDetails.map((detail, index) => {
        const prefix = index === resultDetails.length - 1 ? "└" : "├";
        return `${prefix} ${detail}`;
      }).join("\n");

      totalMsg = `<at id="${robberId}" /> 🏴‍☠️ 劫了 ${validTransfers.length} 趟镖：${successCount}成功 ${failCount}失败，共获 ${totalGain} 咕咕币\n${formattedDetails}`;
      if (hasCounterRobbery) {
        totalMsg += `\n${counterMsg}`;
      }
    }

    await session.send(totalMsg);

    // 记录劫镖成功冷却
    if (hasAnySuccess) {
      robberyCooldowns.set(cooldownKey, Date.now());
    }
  });
}
