import { Context } from "koishi";
import { SoulProfile, SoulPartner, SoulArchivedProfile } from "../types";
import { pendingDirectedMatchRequests } from "..";

// 绑定确认等待
const pendingBindRequests = new Map<string, {
    requesterId: string;
    requesterPlatform: string;
    targetUserId: string;
    startTime: number;
    groupId?: string; // 发起绑定的群组ID
}>();

// 公开广播确认等待
const pendingAnnouncements = new Map<string, {
    userA_id: string; // Requester
    userB_id: string; // Target
    groupId: string;
    platform: string;
    startTime: number;
    userA_agreed: boolean;
    userB_agreed: boolean;
}>();

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟超时
const ANNOUNCE_TIMEOUT_MS = 3 * 60 * 1000; // 广播确认3分钟超时

export function registerPartnerCommands(ctx: Context) {
    const logger = ctx.logger;

    // 绑定情缘命令
    ctx.command("绑定情缘 <targetQQ:string>")
        .alias("结缘")
        .action(async ({ session }, targetQQ) => {
            if (!session) return;
            if (!session.isDirect) {
                return "❌ 情缘系统涉及隐私，请在私聊中使用（绑定/解绑/分手）指令。";
            }

            if (!targetQQ) {
                return "❌ 请提供对方的QQ号，格式：绑定情缘 <QQ号>";
            }

            const normalizedTargetQQ = targetQQ.replace(/^.*:/, "");
            const normalizedSelfId = session.userId!.replace(/^.*:/, "");

            if (normalizedTargetQQ === normalizedSelfId) {
                return "❌ 不能和自己绑定情缘（我们还行吧！那当然！）";
            }

            // 1. 检查自己是否有档案
            const myProfiles = await ctx.database.get("soul_profiles", {
                userId: session.userId!,
                platform: session.platform!,
            });
            if (myProfiles.length === 0) return "❌ 你还没有档案，请先登记档案";
            const myProfile = myProfiles[0];

            // 2. 检查对方是否有档案
            // 尝试多种可能的userId
            const possibleTargetIds = [
                normalizedTargetQQ,
                `${session.platform}:${normalizedTargetQQ}`,
                targetQQ,
            ];
            let targetProfile: SoulProfile | null = null;
            for (const id of possibleTargetIds) {
                const p = await ctx.database.get("soul_profiles", { userId: id, platform: session.platform! });
                if (p.length > 0) {
                    targetProfile = p[0];
                    break;
                }
            }
            if (!targetProfile) return "❌ 找不到对方的档案";

            // 3. 检查双方是否已有情缘
            const myPartner = await ctx.database.get("soul_partners", {
                userA_id: [session.userId!, targetProfile.userId],
                userB_id: [session.userId!, targetProfile.userId],
            });

            // 检查数据库中是否已经存在以自己或对方为 A 或 B 的记录
            const existingRelationA = await ctx.database.get("soul_partners", {
                userA_id: session.userId!,
                platform: session.platform!
            });
            const existingRelationB = await ctx.database.get("soul_partners", {
                userB_id: session.userId!,
                platform: session.platform!
            });
            const targetRelationA = await ctx.database.get("soul_partners", {
                userA_id: targetProfile.userId,
                platform: session.platform!
            });
            const targetRelationB = await ctx.database.get("soul_partners", {
                userB_id: targetProfile.userId,
                platform: session.platform!
            });

            if (existingRelationA.length > 0 || existingRelationB.length > 0) {
                return "❌ 你已经有绑定的情缘了";
            }
            if (targetRelationA.length > 0 || targetRelationB.length > 0) {
                return "❌ 对方已经有绑定的情缘了";
            }

            // 4. 发送确认请求
            const requestKey = `${targetProfile.userId}-${session.platform}`;
            if (pendingBindRequests.has(requestKey)) {
                return "❌ 对方正在处理一个绑定请求，请稍后再试";
            }

            // 默认广播群组
            const defaultGroupId = "YOUR_GROUP_ID_1";

            pendingBindRequests.set(requestKey, {
                requesterId: session.userId!,
                requesterPlatform: session.platform!,
                targetUserId: targetProfile.userId,
                startTime: Date.now(),
                groupId: defaultGroupId
            });

            try {
                const targetPrivateChannel = `private:${targetProfile.userId}`;
                await session.bot?.sendMessage(targetPrivateChannel,
                    `💌 情缘绑定请求\n\n用户 ${normalizedSelfId} 请求与你绑定情缘！\n\n绑定后，双方档案将自动封存（退出匹配池）。\n\n请在5分钟内回复：\n✅ 回复 "我愿意" 确认绑定\n❌ 回复 "拒绝" 拒绝请求`
                );
                return "✅ 请求已发送，请等待对方在私聊中确认";
            } catch (e) {
                pendingBindRequests.delete(requestKey);
                return "❌ 发送请求失败，对方可能未添加机器人好友";
            }
        });

    // 解绑情缘
    ctx.command("解绑情缘")
        .alias("解除绑定")
        .alias("分手")
        .action(async ({ session }) => {
            if (!session) return;

            // 查找关系
            const relations = await ctx.database.get("soul_partners", {
                $or: [
                    { userA_id: session.userId!, platform: session.platform! },
                    { userB_id: session.userId!, platform: session.platform! }
                ]
            });

            if (relations.length === 0) {
                return "❌ 你还没有绑定的情缘";
            }

            const relation = relations[0];
            const partnerId = relation.userA_id === session.userId ? relation.userB_id : relation.userA_id;

            // 删除关系
            await ctx.database.remove("soul_partners", { id: relation.id });

            // 通知对方
            try {
                const partnerPrivateChannel = `private:${partnerId}`;
                await session.bot?.sendMessage(partnerPrivateChannel, "💔 对方已解除与你的情缘绑定关系。");
            } catch (e) {
                // ignore
            }

            return "✅ 已解除情缘绑定关系。档案仍处于封存状态，如需重新匹配请使用“解封档案”指令。";
        });

    // 私聊中间件处理绑定确认
    ctx.middleware(async (session, next) => {
        if (!session.isDirect || !session.content) return next();
        const content = session.content.trim();
        const userKey = `${session.userId}-${session.platform}`;

        // --- 处理公开确认逻辑 ---
        // 任何一方输入"公开"，我们都需要找到对应的 announcement 记录
        // 记录可能是以 userA 或 userB 的 key 存储的 (此处我们使用 composite key 或者遍历查找)
        // 简单方式：遍历pendingAnnouncements查找当前用户参与的

        let foundAnnouncementKey: string | null = null;
        let announcement: {
            userA_id: string;
            userB_id: string;
            groupId: string;
            platform: string;
            startTime: number;
            userA_agreed: boolean;
            userB_agreed: boolean;
        } | null = null;

        for (const [key, ann] of pendingAnnouncements.entries()) {
            if ((ann.userA_id === session.userId || ann.userB_id === session.userId) && ann.platform === session.platform) {
                if (Date.now() - ann.startTime > ANNOUNCE_TIMEOUT_MS) {
                    pendingAnnouncements.delete(key); // 清理过期
                } else {
                    foundAnnouncementKey = key;
                    announcement = ann;
                }
                break;
            }
        }

        if (announcement && content === "公开") {
            const isUserA = announcement.userA_id === session.userId;

            // 更新状态
            if (isUserA) announcement.userA_agreed = true;
            else announcement.userB_agreed = true;

            // 检查是否双方都同意
            if (announcement.userA_agreed && announcement.userB_agreed) {
                pendingAnnouncements.delete(foundAnnouncementKey!);
                // 发送群广播
                try {
                    await session.bot?.sendMessage(announcement.groupId,
                        `<at id="${announcement.userA_id}"/> <at id="${announcement.userB_id}"/> 恭喜两位老师！🎉`
                    );
                    await session.send("✅ 双方已确认，喜讯已发送到群内！");
                    // 通知另一方
                    const partnerId = isUserA ? announcement.userB_id : announcement.userA_id;
                    const partnerPrivate = `private:${partnerId}`;
                    await session.bot?.sendMessage(partnerPrivate, "✅ 双方已确认，喜讯已发送到群内！");
                } catch (e) {
                    await session.send("❌ 群祝福发送失败，可能机器人不在该群。");
                }
            } else {
                // 等待另一方
                await session.send("✅ 你已确认公开，等待对方确认...");
                // 通知另一方
                try {
                    const partnerId = isUserA ? announcement.userB_id : announcement.userA_id;
                    const partnerPrivate = `private:${partnerId}`;
                    await session.bot?.sendMessage(partnerPrivate, "💌 你的情缘希望在群里公开喜讯，如果你也愿意，请回复【公开】");
                } catch (e) { }
            }
            return;
        }

        // --- 处理绑定确认逻辑 ---
        const request = pendingBindRequests.get(userKey);

        if (!request) return next();

        if (Date.now() - request.startTime > REQUEST_TIMEOUT_MS) {
            pendingBindRequests.delete(userKey);
            return next();
        }

        if (content === "我愿意") {
            pendingBindRequests.delete(userKey);

            // 确保ID顺序 userA < userB
            const [userA, userB] = [request.requesterId, session.userId!].sort();

            // 创建关系
            await ctx.database.create("soul_partners", {
                userA_id: userA,
                userB_id: userB,
                platform: session.platform!,
                confirmed_at: Date.now(),
                created_at: Date.now()
            });

            // 封存档案... (省略重复代码逻辑，保持原有)
            const archiveReason = `与 ${request.requesterId === session.userId ? request.targetUserId : request.requesterId} 绑定情缘`;

            // Requester 封存
            const requesterProfile = (await ctx.database.get("soul_profiles", { userId: request.requesterId, platform: request.requesterPlatform }))[0];
            if (requesterProfile) {
                const archived = await ctx.database.get("soul_archived_profiles", { profileId: requesterProfile.id, unArchivedAt: null });
                if (archived.length === 0) {
                    await ctx.database.create("soul_archived_profiles", {
                        userId: requesterProfile.userId,
                        platform: requesterProfile.platform,
                        groupId: requesterProfile.groupId,
                        profileId: requesterProfile.id!,
                        archivedBy: "system",
                        archiveReason: archiveReason + " (Requester)",
                        archivedAt: Date.now()
                    });
                }
            }

            // Target 封存
            const targetProfile = (await ctx.database.get("soul_profiles", { userId: session.userId!, platform: session.platform! }))[0];
            if (targetProfile) {
                const archived = await ctx.database.get("soul_archived_profiles", { profileId: targetProfile.id, unArchivedAt: null });
                if (archived.length === 0) {
                    await ctx.database.create("soul_archived_profiles", {
                        userId: targetProfile.userId,
                        platform: targetProfile.platform,
                        groupId: targetProfile.groupId,
                        profileId: targetProfile.id!,
                        archivedBy: "system",
                        archiveReason: archiveReason + " (Target)",
                        archivedAt: Date.now()
                    });
                }
            }

            // 准备广播对象
            let askForPublic = false;
            if (request.groupId) {
                // 使用 unique key, 例如 userA_id + userB_id (已排序)
                // 或者直接存入 map (这里我们用简单的递增ID或者随机串作key，或者直接用 requesterId-userId 组合)
                const announceKey = `${userA}-${userB}-${session.platform}`;
                pendingAnnouncements.set(announceKey, {
                    userA_id: userA,
                    userB_id: userB,
                    groupId: request.groupId,
                    platform: session.platform!,
                    startTime: Date.now(),
                    userA_agreed: false,
                    userB_agreed: false
                });
                askForPublic = true;
            }

            // 通知 Requester
            try {
                const requesterPrivateChannel = `private:${request.requesterId}`;
                let msg = `🎉 对方已同意绑定！\n你们现在是正式绑定的情缘了。\n双向档案已自动封存。`;
                if (askForPublic) {
                    msg += `\n\n💡 是否在群里公开喜讯？\n请在3分钟内回复【公开】（需双方都确认）`;
                }
                await session.bot?.sendMessage(requesterPrivateChannel, msg);
            } catch (e) { }

            // 回复 Target (Session User)
            let replyMsg = "🎉 绑定成功！你们现在是正式绑定的情缘了。\n双向档案已自动封存。";
            if (askForPublic) {
                replyMsg += "\n\n💡 是否在群里公开喜讯？\n请在3分钟内回复【公开】（需双方都确认）";
            }
            return replyMsg;

        } else if (content === "拒绝") {
            pendingBindRequests.delete(userKey);
            // 通知Requester
            try {
                const requesterPrivateChannel = `private:${request.requesterId}`;
                await session.bot?.sendMessage(requesterPrivateChannel, `❌ 对方拒绝了你的绑定请求。`);
            } catch (e) { }
            return "✅ 已拒绝请求。";
        }

        return next();
    });
}
