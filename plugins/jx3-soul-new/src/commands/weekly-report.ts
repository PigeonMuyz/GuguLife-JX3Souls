import { Context } from "koishi";

/**
 * 注册匹配周报命令
 */
export function registerWeeklyReportCommands(ctx: Context) {
  ctx
    .command("我的周报")
    .alias("匹配周报")
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) {
        return "此命令仅限私聊使用，请私信机器人操作";
      }

      // 检查档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });
      if (!profiles || profiles.length === 0) {
        return '❌ 你还没有档案，请先使用"登记档案"创建';
      }
      const profile = profiles[0];

      const now = Date.now();
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      // 本周主动匹配次数
      const activeMatches = await ctx.database
        .select("soul_match_history")
        .where({
          matcherId: session.userId!,
          matcherPlatform: session.platform!,
        })
        .execute();
      const weeklyActiveMatches = activeMatches.filter(
        (m) => m.createdAt >= weekAgo
      );

      // 本周被匹配次数
      const passiveMatches = await ctx.database
        .select("soul_match_history")
        .where({
          matchedId: session.userId!,
        })
        .execute();
      const weeklyPassiveMatches = passiveMatches.filter(
        (m) => m.createdAt >= weekAgo
      );

      // 匹配类型分布
      const typeCount: Record<string, number> = {};
      for (const m of weeklyActiveMatches) {
        typeCount[m.matchType] = (typeCount[m.matchType] || 0) + 1;
      }
      const typeLabels: Record<string, string> = {
        normal: "普通匹配",
        advanced: "深度匹配",
        bonus: "保底匹配",
        directed: "定向匹配",
      };

      // 排除列表统计
      const activeExclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const passiveExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });

      // 单相思状态
      const whitelist = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
        defaultExclude: true,
      });

      // 构建周报
      let report = `📊 你的情缘周报（近7天）\n`;
      report += `━━━━━━━━━━━━━━━━\n\n`;

      report += `🎯 主动匹配：${weeklyActiveMatches.length} 次\n`;
      if (Object.keys(typeCount).length > 0) {
        const typeStr = Object.entries(typeCount)
          .map(([type, count]) => `${typeLabels[type] || type} ${count}次`)
          .join("、");
        report += `   类型分布：${typeStr}\n`;
      }

      report += `💕 被匹配到：${weeklyPassiveMatches.length} 次\n\n`;

      report += `🚫 排除情况\n`;
      report += `   主动排除：${activeExclusions.length} 人\n`;
      report += `   被排除：${passiveExclusions.length} 人\n\n`;

      if (whitelist.length > 0) {
        report += `💘 单相思：已开启（目标：${whitelist[0].whitelistedUserId}）\n\n`;
      }

      report += `💰 咕咕币余额：${profile.coins}\n`;
      report += `━━━━━━━━━━━━━━━━\n`;
      report += `📅 统计周期：${new Date(weekAgo).toLocaleDateString()} ~ ${new Date(now).toLocaleDateString()}`;

      return report;
    });
}
