import { Context, Session } from "koishi";
import { SoulProfile } from "../types";
import { isAdminUserId } from "../utils/universal";

export function registerAdminCommands(ctx: Context) {
    const logger = ctx.logger;

    // 权限检查中间件
    const checkAdminAndPrivate = async (session: Session, next: () => Promise<void>) => {
        if (!session.isDirect) {
            return "⚠️ 为了保护用户隐私，此命令仅限私聊使用。";
        }
        if (!isAdminUserId(session.userId!)) {
            return "⚠️ 权限不足，仅限管理员使用。";
        }
        return next();
    };

    // 检测不活跃群成员（管理员专用）- 支持指定日期、移除和白名单
    ctx.command("检测不活跃成员 <groupId:string> [dateOrAction:string] [action:string]", "检测不活跃且无档案的成员")
        .action(async ({ session }, groupId, dateOrAction, action) => {
            if (!session) return;
            if (!session.isDirect) return "⚠️ 仅限私聊使用";
            if (!isAdminUserId(session.userId!)) return "⚠️ 权限不足";

            if (!groupId) return "请提供群号";

            // 解析参数：支持 "检测不活跃成员 群号 日期 移除" 或 "检测不活跃成员 群号 移除"
            let cutoffTimestamp: number;
            let cutoffDisplay: string;
            let shouldKick = false;

            if (dateOrAction === "移除") {
                // 没有日期，默认 90 天
                const now = Math.floor(Date.now() / 1000);
                cutoffTimestamp = now - (90 * 24 * 60 * 60);
                cutoffDisplay = "90 天前";
                shouldKick = true;
            } else if (dateOrAction && /^\d{4}-\d{1,2}-\d{1,2}$/.test(dateOrAction)) {
                // 提供了日期
                const cutoffDate = new Date(dateOrAction);
                if (isNaN(cutoffDate.getTime())) {
                    return "❌ 日期格式错误，请使用 YYYY-MM-DD 格式";
                }
                // 设为当天 23:59:59（含当天）
                cutoffDate.setHours(23, 59, 59, 999);
                cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);
                cutoffDisplay = dateOrAction;
                shouldKick = action === "移除";
            } else {
                // 默认 90 天
                const now = Math.floor(Date.now() / 1000);
                cutoffTimestamp = now - (90 * 24 * 60 * 60);
                cutoffDisplay = "90 天前";
            }

            await session.send(`正在检测群 ${groupId} 中 ${cutoffDisplay} 之前不活跃的成员${shouldKick ? "（移除模式）" : ""}...`);

            // 获取机器人实例
            const bot = ctx.bots.find(b => b.platform === "onebot");
            if (!bot) {
                return "❌ 未找到 OneBot 机器人实例";
            }

            try {
                // 获取群成员列表（OneBot 11 返回包含 last_sent_time）
                const members = await bot.internal.getGroupMemberList(groupId);
                if (!members || !Array.isArray(members)) {
                    return "❌ 获取群成员列表失败";
                }

                // 筛选截止日期之前不活跃的成员
                const inactiveMembers = members.filter(member => {
                    const lastSentTime = member.last_sent_time || 0;
                    return lastSentTime < cutoffTimestamp;
                });

                if (inactiveMembers.length === 0) {
                    return `✅ 群 ${groupId} 中没有 ${cutoffDisplay} 之前不活跃的成员`;
                }

                // 查询已有档案的用户
                const existingProfiles = await ctx.database.get("soul_profiles", {
                    platform: session.platform,
                });
                const profileUserIds = new Set(existingProfiles.map(p => p.userId.replace(/^.*:/, "")));

                // 查询白名单用户
                const whitelist = await ctx.database.get("soul_member_whitelist", {
                    groupId: groupId,
                    platform: session.platform,
                });
                const whitelistUserIds = new Set(whitelist.map(w => w.userId));

                // 筛选没有档案且不在白名单的不活跃成员
                const inactiveWithoutProfile = inactiveMembers.filter(member => {
                    const memberId = member.user_id?.toString() || "";
                    return !profileUserIds.has(memberId) && !whitelistUserIds.has(memberId);
                });

                if (inactiveWithoutProfile.length === 0) {
                    let msg = `✅ 群 ${groupId} 中 ${cutoffDisplay} 之前不活跃的成员都已有档案或在白名单中\n\n`;
                    msg += `📊 统计：共 ${inactiveMembers.length} 人在 ${cutoffDisplay} 之前无发言`;
                    if (whitelist.length > 0) msg += `，${whitelist.length} 人在白名单中`;
                    return msg;
                }

                // 构造输出消息
                let message = `📊 不活跃成员检测结果\n`;
                message += `群号: ${groupId}\n`;
                message += `截止日期: ${cutoffDisplay}\n`;
                message += `检测时间: ${new Date().toLocaleString("zh-CN")}\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                message += `🔴 ${cutoffDisplay} 之前未发言且无档案（${inactiveWithoutProfile.length} 人）：\n\n`;

                for (const member of inactiveWithoutProfile) {
                    const userId = member.user_id?.toString() || "未知";
                    const card = member.card || member.nickname || "无昵称";
                    const lastSentTime = member.last_sent_time || 0;
                    const lastActiveDate = lastSentTime > 0
                        ? new Date(lastSentTime * 1000).toLocaleDateString("zh-CN")
                        : "从未发言";

                    message += `QQ: ${userId} | ${card}\n`;
                    message += `最后发言: ${lastActiveDate}\n`;
                    message += `---\n`;
                }

                message += `\n📈 完整统计：\n`;
                message += `- 群总人数: ${members.length}\n`;
                message += `- ${cutoffDisplay}前未发言: ${inactiveMembers.length}\n`;
                message += `- 无档案无白名单: ${inactiveWithoutProfile.length}\n`;
                message += `- 白名单用户: ${whitelist.length}`;

                // 如果需要移除
                if (shouldKick) {
                    await session.send(message);

                    await session.send(`\n⚠️ 即将移除以上 ${inactiveWithoutProfile.length} 个不活跃成员\n回复【确认移除】执行，回复【标记白名单 QQ号】保留用户，其他回复取消`);

                    const confirm = await session.prompt(60000);

                    if (!confirm) {
                        return "❌ 超时，已取消操作";
                    }

                    // 检查是否是标记白名单
                    if (confirm.startsWith("标记白名单")) {
                        const userIdToWhitelist = confirm.replace("标记白名单", "").trim();
                        if (userIdToWhitelist) {
                            const memberToWhitelist = members.find(m => m.user_id?.toString() === userIdToWhitelist);
                            if (memberToWhitelist) {
                                await ctx.database.upsert("soul_member_whitelist", [{
                                    userId: userIdToWhitelist,
                                    groupId: groupId,
                                    platform: session.platform!,
                                    nickname: memberToWhitelist.card || memberToWhitelist.nickname || "",
                                    reason: "管理员手动标记",
                                    createdBy: session.userId!,
                                    createdAt: Date.now(),
                                }]);
                                return `✅ 已将 ${userIdToWhitelist} 加入白名单，请重新运行检测`;
                            }
                        }
                        return "❌ 未找到该用户，请检查QQ号";
                    }

                    if (confirm !== "确认移除") {
                        return "❌ 已取消移除操作";
                    }

                    let successCount = 0;
                    let failedUsers: string[] = [];

                    for (const member of inactiveWithoutProfile) {
                        const userId = member.user_id?.toString();
                        if (!userId) continue;

                        try {
                            await bot.internal.setGroupKick(groupId, userId, false);
                            successCount++;
                            logger.info(`已移除群 ${groupId} 成员: ${userId}`);
                        } catch (error) {
                            failedUsers.push(userId);
                            logger.error(`移除群成员失败 ${userId}: ${error}`);
                        }
                    }

                    let result = `📊 批量移除完成\n`;
                    result += `━━━━━━━━━━━━━━━━━━━━\n`;
                    result += `✅ 成功: ${successCount}\n`;
                    result += `❌ 失败: ${failedUsers.length}\n`;

                    if (failedUsers.length > 0) {
                        result += `\n失败列表: ${failedUsers.join(", ")}`;
                    }

                    return result;
                }

                message += `\n\n💡 提示: 添加"移除"参数可批量移除，例如:\n检测不活跃成员 ${groupId} 移除`;
                return message;
            } catch (error) {
                logger.error(`检测不活跃成员失败: ${error}`);
                return `❌ 检测失败: ${error instanceof Error ? error.message : "未知错误"}`;
            }
        });

    // 管理白名单（查看/添加/删除）
    ctx.command("成员白名单 <action:string> <groupId:string> [userIds:text]", "管理成员白名单")
        .action(async ({ session }, action, groupId, userIdsStr) => {
            if (!session) return;
            if (!session.isDirect) return "⚠️ 仅限私聊使用";
            if (!isAdminUserId(session.userId!)) return "⚠️ 权限不足";

            if (!action) return "请提供操作：查看/添加/删除";
            if (!groupId) return "请提供群号";

            if (action === "查看") {
                const whitelist = await ctx.database.get("soul_member_whitelist", {
                    groupId: groupId,
                    platform: session.platform,
                });

                if (whitelist.length === 0) {
                    return `群 ${groupId} 的白名单为空`;
                }

                let message = `📋 群 ${groupId} 白名单（${whitelist.length} 人）\n━━━━━━━━━━━━━━━━━━━━\n\n`;
                for (const item of whitelist) {
                    message += `QQ: ${item.userId}\n`;
                    message += `昵称: ${item.nickname || "无"}\n`;
                    message += `原因: ${item.reason || "无"}\n`;
                    message += `---\n`;
                }
                return message;
            }

            if (action === "添加") {
                if (!userIdsStr) return "请提供用户QQ号（多个用逗号分隔）";

                // 解析多个用户ID（支持中英文逗号、空格），并去重
                const userIds = [...new Set(
                    userIdsStr.split(/[,，\s]+/)
                        .map(id => id.trim())
                        .filter(id => id.length > 0 && /^\d+$/.test(id))
                )];

                if (userIds.length === 0) {
                    return "❌ 未识别到有效的QQ号";
                }

                // 获取群成员信息
                const bot = ctx.bots.find(b => b.platform === "onebot");
                let memberMap = new Map<string, string>();
                if (bot) {
                    try {
                        const members = await bot.internal.getGroupMemberList(groupId);
                        for (const m of members || []) {
                            memberMap.set(m.user_id?.toString() || "", m.card || m.nickname || "");
                        }
                    } catch { }
                }

                // 查询已存在的白名单用户
                const existing = await ctx.database.get("soul_member_whitelist", {
                    groupId: groupId,
                    platform: session.platform,
                });
                const existingUserIds = new Set(existing.map(e => e.userId));

                // 筛选出新用户（排除已存在的）
                const newUserIds = userIds.filter(uid => !existingUserIds.has(uid));
                const skippedCount = userIds.length - newUserIds.length;

                if (newUserIds.length === 0) {
                    return `⚠️ 所有用户都已在白名单中（跳过 ${skippedCount} 人）`;
                }

                // 批量添加新用户
                for (const uid of newUserIds) {
                    await ctx.database.create("soul_member_whitelist", {
                        userId: uid,
                        groupId: groupId,
                        platform: session.platform!,
                        nickname: memberMap.get(uid) || "",
                        reason: "管理员批量添加",
                        createdBy: session.userId!,
                        createdAt: Date.now(),
                    });
                }

                let result = `✅ 已将 ${newUserIds.length} 人加入群 ${groupId} 白名单:\n${newUserIds.join(", ")}`;
                if (skippedCount > 0) {
                    result += `\n\n⏭️ 跳过 ${skippedCount} 人（已在白名单中）`;
                }
                return result;
            }

            if (action === "删除") {
                if (!userIdsStr) return "请提供用户QQ号（多个用逗号分隔）";

                // 解析多个用户ID，并去重
                const userIds = [...new Set(
                    userIdsStr.split(/[,，\s]+/)
                        .map(id => id.trim())
                        .filter(id => id.length > 0 && /^\d+$/.test(id))
                )];

                if (userIds.length === 0) {
                    return "❌ 未识别到有效的QQ号";
                }

                for (const uid of userIds) {
                    await ctx.database.remove("soul_member_whitelist", {
                        userId: uid,
                        groupId: groupId,
                        platform: session.platform,
                    });
                }

                return `✅ 已将 ${userIds.length} 人从群 ${groupId} 白名单移除:\n${userIds.join(", ")}`;
            }

            return "未知操作，请使用：查看/添加/删除";
        });

    // 检测新成员档案（管理员专用）- 支持日期区间和移除功能
    ctx.command("检测新成员档案 <groupId:string> <dateRange:string> [action:string]", "检测指定日期/区间加入且无档案的成员")
        .action(async ({ session }, groupId, dateRange, action) => {
            if (!session) return;
            if (!session.isDirect) return "⚠️ 仅限私聊使用";
            if (!isAdminUserId(session.userId!)) return "⚠️ 权限不足";

            if (!groupId) return "请提供群号";
            if (!dateRange) return "请提供日期或日期区间（格式：YYYY-MM-DD 或 YYYY-MM-DD至YYYY-MM-DD）";

            // 解析日期区间（支持 "2025-11-20至2025-11-30" 或单独日期）
            let startTimestamp: number;
            let endTimestamp: number;
            let dateDisplayStr: string;

            if (dateRange.includes("至")) {
                const [startStr, endStr] = dateRange.split("至").map(s => s.trim());
                const startDate = new Date(startStr);
                const endDate = new Date(endStr);

                if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                    return "❌ 日期格式错误，请使用 YYYY-MM-DD至YYYY-MM-DD 格式";
                }

                // 结束日期设为当天23:59:59
                endDate.setHours(23, 59, 59, 999);

                startTimestamp = Math.floor(startDate.getTime() / 1000);
                endTimestamp = Math.floor(endDate.getTime() / 1000);
                dateDisplayStr = `${startStr} 至 ${endStr}`;
            } else {
                const targetDate = new Date(dateRange);
                if (isNaN(targetDate.getTime())) {
                    return "❌ 日期格式错误，请使用 YYYY-MM-DD 格式";
                }
                startTimestamp = Math.floor(targetDate.getTime() / 1000);
                endTimestamp = Math.floor(Date.now() / 1000); // 到当前时间
                dateDisplayStr = `${dateRange} 之后`;
            }

            const shouldKick = action === "移除";
            await session.send(`正在检测群 ${groupId} 中 ${dateDisplayStr} 加入的新成员${shouldKick ? "（移除模式）" : ""}...`);

            // 获取机器人实例
            const bot = ctx.bots.find(b => b.platform === "onebot");
            if (!bot) {
                return "❌ 未找到 OneBot 机器人实例";
            }

            try {
                // 获取群成员列表
                const members = await bot.internal.getGroupMemberList(groupId);
                if (!members || !Array.isArray(members)) {
                    return "❌ 获取群成员列表失败";
                }

                // 筛选指定日期区间加入的成员
                const newMembers = members.filter(member => {
                    const joinTime = member.join_time || 0;
                    return joinTime >= startTimestamp && joinTime <= endTimestamp;
                });

                if (newMembers.length === 0) {
                    return `✅ 群 ${groupId} 中没有 ${dateDisplayStr} 加入的成员`;
                }

                // 查询已有档案的用户
                const existingProfiles = await ctx.database.get("soul_profiles", {
                    platform: session.platform,
                });
                const profileUserIds = new Set(existingProfiles.map(p => p.userId.replace(/^.*:/, "")));

                // 筛选没有档案的新成员
                const newMembersWithoutProfile = newMembers.filter(member => {
                    const memberId = member.user_id?.toString() || "";
                    return !profileUserIds.has(memberId);
                });

                if (newMembersWithoutProfile.length === 0) {
                    return `✅ 群 ${groupId} 中 ${dateDisplayStr} 加入的成员都已有档案\n\n📊 统计：共 ${newMembers.length} 人在此期间加入，都已创建档案`;
                }

                // 构造输出消息
                let message = `📊 新成员档案检测结果\n`;
                message += `群号: ${groupId}\n`;
                message += `筛选日期: ${dateDisplayStr}\n`;
                message += `检测时间: ${new Date().toLocaleString("zh-CN")}\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                message += `🔍 共发现 ${newMembersWithoutProfile.length} 人无档案：\n\n`;

                for (const member of newMembersWithoutProfile) {
                    const userId = member.user_id?.toString() || "未知";
                    const card = member.card || member.nickname || "无昵称";
                    const joinTime = member.join_time || 0;
                    const joinDate = joinTime > 0
                        ? new Date(joinTime * 1000).toLocaleDateString("zh-CN")
                        : "未知";

                    message += `QQ: ${userId}\n`;
                    message += `群名片: ${card}\n`;
                    message += `加群时间: ${joinDate}\n`;
                    message += `---\n`;
                }

                message += `\n📈 完整统计：\n`;
                message += `- 群总人数: ${members.length}\n`;
                message += `- 期间加入: ${newMembers.length}\n`;
                message += `- 无档案的新成员: ${newMembersWithoutProfile.length}`;

                // 如果需要移除
                if (shouldKick) {
                    await session.send(message);
                    await session.send(`\n⚠️ 即将移除以上 ${newMembersWithoutProfile.length} 个成员\n回复【确认移除】执行操作，其他回复取消`);

                    const confirm = await session.prompt(30000);
                    if (confirm !== "确认移除") {
                        return "❌ 已取消移除操作";
                    }

                    let successCount = 0;
                    let failedUsers: string[] = [];

                    for (const member of newMembersWithoutProfile) {
                        const userId = member.user_id?.toString();
                        if (!userId) continue;

                        try {
                            await bot.internal.setGroupKick(groupId, userId, false);
                            successCount++;
                            logger.info(`已移除群 ${groupId} 成员: ${userId}`);
                        } catch (error) {
                            failedUsers.push(userId);
                            logger.error(`移除群成员失败 ${userId}: ${error}`);
                        }
                    }

                    let result = `📊 批量移除完成\n`;
                    result += `━━━━━━━━━━━━━━━━━━━━\n`;
                    result += `✅ 成功: ${successCount}\n`;
                    result += `❌ 失败: ${failedUsers.length}\n`;

                    if (failedUsers.length > 0) {
                        result += `\n失败列表: ${failedUsers.join(", ")}`;
                    }

                    return result;
                }

                return message;
            } catch (error) {
                logger.error(`检测新成员档案失败: ${error}`);
                return `❌ 检测失败: ${error instanceof Error ? error.message : "未知错误"}`;
            }
        });

    // 批量移除群成员（管理员专用）
    ctx.command("批量移除成员 <groupId:string> <userIds:text>", "批量移除群成员（用中英文逗号分隔多个QQ号）")
        .action(async ({ session }, groupId, userIdsStr) => {
            if (!session) return;
            if (!session.isDirect) return "⚠️ 仅限私聊使用";
            if (!isAdminUserId(session.userId!)) return "⚠️ 权限不足";

            if (!groupId) return "请提供群号";
            if (!userIdsStr) return "请提供要移除的用户QQ号（用中英文逗号分隔多个）";

            // 解析用户ID列表（支持中英文逗号和空格）
            const userIds = userIdsStr
                .split(/[,，\s]+/)
                .map(id => id.trim())
                .filter(id => id.length > 0 && /^\d+$/.test(id));

            if (userIds.length === 0) {
                return "❌ 未识别到有效的QQ号，请检查输入格式";
            }

            // 获取机器人实例
            const bot = ctx.bots.find(b => b.platform === "onebot");
            if (!bot) {
                return "❌ 未找到 OneBot 机器人实例";
            }

            await session.send(`⚠️ 即将移除 ${userIds.length} 个成员，请确认：\n${userIds.join(", ")}\n\n回复【确认移除】执行操作，其他回复取消`);

            // 等待确认
            const confirm = await session.prompt(30000);
            if (confirm !== "确认移除") {
                return "❌ 已取消操作";
            }

            let successCount = 0;
            let failedUsers: string[] = [];

            for (const userId of userIds) {
                try {
                    // 调用 OneBot 的 setGroupKick API
                    await bot.internal.setGroupKick(groupId, userId, false);
                    successCount++;
                    logger.info(`已移除群 ${groupId} 成员: ${userId}`);
                } catch (error) {
                    failedUsers.push(userId);
                    logger.error(`移除群成员失败 ${userId}: ${error}`);
                }
            }

            let result = `📊 批量移除完成\n`;
            result += `群号: ${groupId}\n`;
            result += `━━━━━━━━━━━━━━━━━━━━\n`;
            result += `✅ 成功: ${successCount}\n`;
            result += `❌ 失败: ${failedUsers.length}\n`;

            if (failedUsers.length > 0) {
                result += `\n失败列表: ${failedUsers.join(", ")}`;
            }

            return result;
        });

    // 管理员封存用户档案命令
    ctx.command("封存用户 <userId:string> [reason:string]", "封存指定用户的档案")
        .action(async ({ session }, userId, reason) => {
            if (!session) return;
            if (!session.isDirect) return "⚠️ 仅限私聊使用";
            if (!isAdminUserId(session.userId!)) return "⚠️ 权限不足";

            if (!userId) return "❌ 请提供用户QQ号";

            try {
                // 查找用户档案
                const profiles = await ctx.database.get("soul_profiles", {
                    userId: userId,
                });

                if (profiles.length === 0) {
                    return `❌ 未找到用户 ${userId} 的档案`;
                }

                const profile = profiles[0] as SoulProfile;

                // 检查是否已被封存
                const existingArchive = await ctx.database.get(
                    "soul_archived_profiles",
                    {
                        profileId: profile.id!,
                        unArchivedAt: null,
                    }
                );

                if (existingArchive.length > 0) {
                    return `❌ 用户 ${userId} 的档案已经被封存\n封存时间：${new Date(
                        existingArchive[0].archivedAt
                    ).toLocaleString()}\n封存原因：${existingArchive[0].archiveReason}`;
                }

                const archiveReason = reason || "管理员封存";

                // 创建封存记录
                await ctx.database.upsert("soul_archived_profiles", [
                    {
                        userId: profile.userId,
                        platform: profile.platform,
                        groupId: profile.groupId,
                        profileId: profile.id!,
                        archivedBy: session.userId!,
                        archiveReason: archiveReason,
                        archivedAt: Date.now(),
                        unArchivedAt: null,
                        unArchivedBy: "",
                    },
                ], ["profileId"]);

                logger.info(
                    `管理员 ${session.userId} 封存了用户 ${userId} 的档案 ${profile.id} (${profile.characterName})`
                );

                return `✅ 已封存用户档案\n用户QQ：${userId}\n角色名：${profile.characterName}\n封存原因：${archiveReason}\n封存时间：${new Date().toLocaleString()}`;
            } catch (error) {
                logger.error("管理员封存档案失败:", error);
                return `❌ 封存失败: ${error instanceof Error ? error.message : "未知错误"}`;
            }
        });
}
