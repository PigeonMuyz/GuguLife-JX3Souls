import { Context } from "koishi";
import { SoulBlacklist } from "../types";
import { isAdminUserId } from "../utils/universal";

/**
 * 注册拉黑命令
 * @param ctx Koishi上下文
 */
export function registerBlacklistCommands(ctx: Context) {
  // 管理员拉黑命令（支持批量）
  ctx
    .command("拉黑 <userIds> <reason:text>")
    .alias("拉黑用户")
    .action(async ({ session }, userIds, reason) => {
      if (!session || !session.isDirect) return "请私聊使用此命令。";
      if (!isAdminUserId(session.userId!)) return "❌ 您没有权限执行此操作";
      if (!userIds || !reason)
        return "格式错误，请使用：拉黑 123456 原因\n或批量：拉黑 123456,789012 原因";

      // 处理单个或多个用户ID（支持逗号分隔）
      const userIdList = userIds.split(",").map((id) => id.trim());
      const successUsers: string[] = [];
      const failedUsers: string[] = [];

      for (const userId of userIdList) {
        try {
          // 检查是否已经在黑名单中
          const existingBlacklist = await ctx.database.get("soul_blacklist", {
            userId,
            platform: session.platform!,
          });

          if (existingBlacklist.length > 0) {
            failedUsers.push(userId);
            continue;
          }

          // 添加到黑名单
          await ctx.database.create("soul_blacklist", {
            userId,
            platform: session.platform!,
            reason,
            createdAt: Date.now(),
            createdBy: session.userId!,
          });

          successUsers.push(userId);
        } catch (error) {
          failedUsers.push(userId);
        }
      }

      let result = `✅ 拉黑操作完成：\n\n`;

      if (successUsers.length > 0) {
        result += `成功拉黑：${successUsers.join(", ")}\n`;
      }

      if (failedUsers.length > 0) {
        result += `已在黑名单中/失败：${failedUsers.join(", ")}\n`;
      }

      result += `原因：${reason}`;

      return result;
    });

  // 管理员解除拉黑命令（支持批量）
  ctx
    .command("解除拉黑 <userIds>")
    .alias("解除拉黑用户")
    .action(async ({ session }, userIds) => {
      if (!session || !session.isDirect) return "请私聊使用此命令。";
      if (!isAdminUserId(session.userId!)) return "❌ 您没有权限执行此操作";
      if (!userIds)
        return "格式错误，请使用：解除拉黑 123456\n或批量：解除拉黑 123456,789012";

      // 处理单个或多个用户ID（支持逗号分隔）
      const userIdList = userIds.split(",").map((id) => id.trim());
      const successUsers: string[] = [];
      const failedUsers: string[] = [];

      for (const userId of userIdList) {
        try {
          const result = await ctx.database.remove("soul_blacklist", {
            userId,
            platform: session.platform!,
          });

          if ((result.removed || 0) > 0) {
            successUsers.push(userId);
          } else {
            failedUsers.push(userId);
          }
        } catch (error) {
          failedUsers.push(userId);
        }
      }

      let result = `✅ 解除拉黑操作完成：\n\n`;

      if (successUsers.length > 0) {
        result += `成功解除拉黑：${successUsers.join(", ")}\n`;
      }

      if (failedUsers.length > 0) {
        result += `不在黑名单中/失败：${failedUsers.join(", ")}\n`;
      }

      return result;
    });

  // 管理员查看黑名单
  ctx.command("查看黑名单").action(async ({ session }) => {
    if (!session || !session.isDirect) return "请私聊使用此命令。";
    if (!isAdminUserId(session.userId!)) return "❌ 您没有权限执行此操作";

    const blacklist = await ctx.database.get("soul_blacklist", {
      platform: session.platform!,
    });

    if (blacklist.length === 0) return "✅ 当前没有用户被拉黑。";

    let message = "📋 当前黑名单：\n\n";
    for (const item of blacklist) {
      const date = new Date(item.createdAt).toLocaleString("zh-CN");
      message += `用户ID: ${item.userId}\n原因: ${item.reason}\n拉黑时间: ${date}\n拉黑者: ${item.createdBy}\n\n`;
    }

    return message;
  });

  // 管理员手动扫描拉黑用户
  ctx.command("扫描拉黑用户").action(async ({ session }) => {
    if (!session || !session.isDirect) return "请私聊使用此命令。";
    if (!isAdminUserId(session.userId!)) return "❌ 您没有权限执行此操作。";

    const GROUP_ID = "YOUR_GROUP_ID_1";

    try {
      // 尝试获取 OneBot 机器人实例
      const onebotBot = ctx.bots.find((bot) => bot.platform === "onebot");
      if (!onebotBot) {
        ctx.logger.error("扫描拉黑用户失败：未找到 OneBot 机器人实例");
        return "❌ 扫描失败：未找到可用的机器人实例";
      }

      // 获取群成员列表
      ctx.logger.info(`开始扫描群 ${GROUP_ID} 的成员`);
      const members = await onebotBot.internal.getGroupMemberList(GROUP_ID);
      if (!members || !Array.isArray(members)) {
        ctx.logger.error("扫描拉黑用户失败：获取群成员列表返回无效数据");
        return "❌ 扫描失败：无法获取群成员列表";
      }

      const groupMemberIds = members
        .map((member) => member.user_id?.toString() || "")
        .filter((id) => id.length > 0);

      ctx.logger.info(
        `成功获取群 ${GROUP_ID} 的 ${groupMemberIds.length} 个成员`
      );

      // 获取所有拉黑记录
      const blacklist = await ctx.database.get("soul_blacklist", {});
      ctx.logger.info(`获取到 ${blacklist.length} 条拉黑记录`);

      // 检查匹配
      const matchedUsers: any[] = [];
      for (const blacklistItem of blacklist) {
        const normalizedBlacklistId = blacklistItem.userId.replace(/^.*:/, "");
        const isMatched = groupMemberIds.some((memberId) => {
          const normalizedMemberId = memberId.replace(/^.*:/, "");
          return (
            normalizedMemberId === normalizedBlacklistId ||
            memberId === blacklistItem.userId
          );
        });

        if (isMatched) {
          matchedUsers.push(blacklistItem);
        }
      }

      ctx.logger.info(`扫描完成，发现 ${matchedUsers.length} 个匹配的拉黑用户`);

      // 构建结果消息
      let message = `✅ 扫描完成：\n\n`;
      message += `群聊ID：${GROUP_ID}\n`;
      message += `扫描时间：${new Date().toLocaleString("zh-CN")}\n`;
      message += `群成员总数：${groupMemberIds.length}\n`;
      message += `拉黑用户总数：${blacklist.length}\n`;
      message += `匹配用户数：${matchedUsers.length}\n\n`;

      if (matchedUsers.length > 0) {
        message += "📋 匹配到的拉黑用户：\n\n";
        for (const user of matchedUsers) {
          message += `用户ID：${user.userId}\n`;
          message += `原因：${user.reason}\n`;
          message += `拉黑时间：${new Date(user.createdAt).toLocaleString(
            "zh-CN"
          )}\n`;
          message += `拉黑者：${user.createdBy}\n\n`;
        }
      } else {
        message += "✅ 未发现任何拉黑用户";
      }

      return message;
    } catch (error) {
      ctx.logger.error("扫描拉黑用户失败：", error);
      return `❌ 扫描失败：${(error as Error).message}`;
    }
  });

}
