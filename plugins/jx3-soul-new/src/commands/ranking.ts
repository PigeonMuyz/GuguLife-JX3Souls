import { Context } from "koishi";

// 注册排行榜命令
export function registerRankingCommands(ctx: Context) {
  // 注册排行榜命令
  ctx.command("咕咕币排行榜").action(async () => {
    // 查询所有用户的档案
    let profiles = await ctx.database.get("soul_profiles", {});

    // 在内存中排序：先按 coins 降序，再按创建时间升序
    profiles.sort((a, b) => {
      const coinDiff = b.coins - a.coins;
      if (coinDiff !== 0) return coinDiff;
      return a.createdAt - b.createdAt;
    });

    // 只取前5名
    const top5Profiles = profiles.slice(0, 5);

    if (profiles.length === 0) {
      return "暂无排行榜数据";
    }

    // 构建排行榜消息
    let message = "🏆 咕咕币排行榜（只取前5，不算并列）\n\n";

    top5Profiles.forEach((profile, index) => {
      const rankIcon =
        [
          "🥇", // 第1名
          "🥈", // 第2名
          "🥉", // 第3名
          "🎖️", // 第4名
          "🎖️", // 第5名
        ][index] || "🎖️";

      message += `${rankIcon} ${profile.characterName}：${profile.coins} 枚咕咕币\n`;
    });

    return message;
  });

  ctx.logger.info("排行榜命令已加载成功");
}
