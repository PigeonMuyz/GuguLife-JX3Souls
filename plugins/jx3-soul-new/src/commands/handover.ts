import { Context } from "koishi";

export function registerHandoverCommands(ctx: Context) {
    ctx.command("上交")
        .alias("上交工资")
        .alias("上交家产")
        .action(async ({ session }) => {
            if (!session) return;

            // 1. 寻找情缘
            // 查询 soul_partners 表，查找当前用户是否作为 A 或 B 存在
            const relations = await ctx.database.get("soul_partners", {
                $or: [
                    { userA_id: session.userId!, platform: session.platform! },
                    { userB_id: session.userId!, platform: session.platform! }
                ]
            });

            if (relations.length === 0) {
                return "❌ 你还没有绑定的情缘，不如上交给渡渡鸟吧！\n（请先使用“绑定情缘”指令）";
            }

            const relation = relations[0];
            // 确定对象的 ID
            const partnerId = relation.userA_id === session.userId ? relation.userB_id : relation.userA_id;

            // 2. 获取自己档案
            const myProfiles = await ctx.database.get("soul_profiles", {
                userId: session.userId!,
                platform: session.platform!
            });
            if (myProfiles.length === 0) return "❌ 你的档案不存在，请先登记档案";
            const myProfile = myProfiles[0];

            if (myProfile.coins <= 0) {
                return "❌ 你的口袋比脸还干净，这是想卡bug吗🤔";
            }

            // 3. 获取对象档案
            const partnerProfiles = await ctx.database.get("soul_profiles", {
                userId: partnerId,
                platform: session.platform!
            });
            if (partnerProfiles.length === 0) return "❌ 对象的档案找不到了（可能已删除？）";
            const partnerProfile = partnerProfiles[0];

            const amount = myProfile.coins;

            // 4. 转账
            try {
                // 扣除自己的（清零）
                await ctx.database.set("soul_profiles", { id: myProfile.id }, {
                    coins: 0,
                    updatedAt: Date.now()
                });

                // 增加对象的
                await ctx.database.set("soul_profiles", { id: partnerProfile.id }, {
                    coins: partnerProfile.coins + amount,
                    updatedAt: Date.now()
                });

                // 5. 通知
                // 私聊通知对象
                try {
                    const partnerPrivateChannel = `private:${partnerId}`;
                    await session.bot?.sendMessage(partnerPrivateChannel,
                        `💰 [收到转账] 你的情缘已经上交了全部咕咕币！\n\n获得：${amount} 咕咕币\n当前余额：${partnerProfile.coins + amount} 咕咕币`);
                } catch (e) {
                    // 忽略发送失败
                }

                return `✅ 成功上交了 ${amount} 咕咕币给情缘！\n你的余额已清零。`;

            } catch (e) {
                ctx.logger.error("上交失败", e);
                return "❌ 上交失败，请联系管理员";
            }
        });
}
