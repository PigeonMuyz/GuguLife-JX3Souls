import { Context } from "koishi";
import { SoulProfile, SoulArchivedProfile, SoulMatchStats } from "../types";
import {
  getArchivedProfileIds,
  getMatchSuggestion,
  isAdminUserId,
  filterMatchableCandidates,
  getLockedUserIds,
} from "../utils/universal";
import { callAdvancedPair, callNormalPair, callGeminiPair, repairJsonWithGemini, rankCandidatesByEmbedding, generateProfileEmbedding, checkDailyModelLimit, recordModelUsage } from "../utils/match";
import { ongoingMatches, pendingContactRequests } from "..";

// 注册情缘匹配命令
export function registerMatchCommands(ctx: Context) {
  // 使用ctx.logger记录日志
  const logger = ctx.logger;

  // 监听群消息，检查是否解除保底限制
  ctx.on("message", async (session) => {
    // 只处理群消息
    if (
      !session.isDirect &&
      session.content &&
      session.userId &&
      session.channelId &&
      session.platform
    ) {
      // 检查是否有保底限制
      const restrictions = await ctx.database.get("soul_bonus_restrictions", {
        userId: session.userId,
        groupId: session.channelId,
        platform: session.platform,
      });

      if (restrictions && restrictions.length > 0) {
        const restriction = restrictions[0];

        // 检查消息中是否@了目标用户
        if (session.content.includes(`<at id="${restriction.targetUserId}"`)) {
          // 解除限制
          await ctx.database.remove("soul_bonus_restrictions", {
            userId: session.userId,
            groupId: session.channelId,
            platform: session.platform,
          });

          // 发送解除通知
          try {
            await session.send(
              `<at id="${session.userId}" /> ✅ 保底限制已解除，你可以重新开始匹配了！`
            );
            logger.info(`保底解除 - 用户: ${session.userId}, 已解除限制`);
          } catch (error) {
            logger.error(`保底解除消息发送失败:`, error);
          }
        }
      }
    }
  });

  // 查看匹配统计命令
  ctx
    .command("匹配统计")
    .alias("我的匹配统计")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return;

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      if (profiles.length === 0) {
        return "❌ 你还没有创建情缘档案";
      }

      // 获取匹配统计
      const stats = await ctx.database.get("soul_match_stats", {
        userId: session.userId,
        platform: session.platform,
      });

      if (stats.length === 0) {
        return `📊 匹配统计\n━━━━━━━━━━━\n发起匹配: 0 次\n被他人匹配: 0 次`;
      }

      const stat = stats[0] as any;
      const totalMatchCount = stat.totalMatchCount || 0;
      const matchedByCount = stat.matchedByCount || 0;
      const lastMatchTime = stat.lastMatchAt
        ? new Date(stat.lastMatchAt).toLocaleString('zh-CN')
        : '从未';

      return `📊 匹配统计\n━━━━━━━━━━━\n发起匹配: ${totalMatchCount} 次\n被他人匹配: ${matchedByCount} 次\n上次匹配: ${lastMatchTime}`;
    });

  // 档案统计命令
  ctx
    .command("档案统计")
    .alias("池子统计")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return;

      // 获取所有有效档案
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);

      // 过滤有效档案（排除已封存）
      const validProfiles = allProfiles.filter(
        (p) => !archivedProfileIds.includes(p.id!)
      );

      // 统计性别
      let maleCount = 0;
      let femaleCount = 0;
      let otherCount = 0;

      for (const p of validProfiles) {
        if (p.gender === "男") maleCount++;
        else if (p.gender === "女") femaleCount++;
        else otherCount++;
      }

      // 获取用户档案，计算可匹配数量
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      let matchableCount = 0;
      let myProfileInfo = "";

      if (profiles.length > 0) {
        const myProfile = profiles[0] as SoulProfile;

        // 获取排除列表（双向）
        const exclusions = await ctx.database.get("soul_exclusions", {
          userId: session.userId!,
          platform: session.platform!,
        });
        const reverseExclusions = await ctx.database.get("soul_exclusions", {
          excludedUserId: session.userId!,
        });
        const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
        const excludedUserIds = [
          ...exclusions.map((e) => e.excludedUserId),
          ...reverseExclusions.map((e) => e.userId),
          ...lockedUserIds,
        ];

        // 计算可匹配档案数量
        matchableCount = filterMatchableCandidates(
          myProfile,
          validProfiles,
          excludedUserIds,
          []
        ).length;

        myProfileInfo = `\n━━━━━━━━━━━\n你的可匹配池: ${matchableCount} 人`;
      }

      return `📊 档案统计\n━━━━━━━━━━━\n总档案数: ${validProfiles.length}\n男生: ${maleCount} | 女生: ${femaleCount}${otherCount > 0 ? ` | 其他: ${otherCount}` : ""}${myProfileInfo}`;
    });

  // 解除保底限制命令（消耗100金币）
  ctx
    .command("解除保底限制")
    .alias("解除保底")
    .action(async ({ session }) => {
      if (!session) return;
      const DEDUCT_COINS = 100;

      // 检查是否有保底限制
      const restrictions = await ctx.database.get("soul_bonus_restrictions", {
        userId: session.userId!,
        groupId: session.channelId!,
        platform: session.platform!,
      });

      if (!restrictions || restrictions.length === 0) {
        return `<at id="${session.userId}" /> ❌ 你当前没有保底限制需要解除！`;
      }

      // 获取用户档案
      const profile = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (!profile || profile.length === 0) {
        return `<at id="${session.userId}" /> ❌ 你还没有创建档案！`;
      }

      const userProfile = profile[0];

      // 检查金币是否足够
      if (userProfile.coins < DEDUCT_COINS) {
        return `<at id="${session.userId}" /> ❌ 解除保底限制需要消耗${DEDUCT_COINS}咕咕币，你当前只有${userProfile.coins}咕咕币！`;
      }

      try {
        // 扣除金币
        await ctx.database.set(
          "soul_profiles",
          { userId: session.userId!, platform: session.platform! },
          { coins: userProfile.coins - DEDUCT_COINS, updatedAt: Date.now() }
        );

        // 解除限制
        await ctx.database.remove("soul_bonus_restrictions", {
          userId: session.userId!,
          groupId: session.channelId!,
          platform: session.platform!,
        });

        return `<at id="${session.userId
          }" /> ✅ 已成功解除保底限制，消耗了${DEDUCT_COINS}咕咕币，你当前剩余${userProfile.coins - DEDUCT_COINS
          }咕咕币，可以重新开始匹配了！`;
      } catch (error) {
        logger.error(`解除保底限制失败:`, error);
        return `<at id="${session.userId}" /> ❌ 解除保底限制失败，请稍后重试！`;
      }
    });

  // [测试] Gemini 流式匹配命令 - 专门测试 GuguAPI Gemini
  ctx
    .command("gemini情缘 [model]")
    .alias("测试gemini匹配")
    .action(async ({ session }, model) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }

      // 可用模型列表
      const validModels = ["flash", "pro", "2.5pro", "2.5flash"];
      const modelMap: { [key: string]: string } = {
        "flash": "gemini-3-flash-preview",
        "pro": "gemini-3-pro-preview",
        "2.5pro": "gemini-2.5-pro",
        "2.5flash": "gemini-2.5-flash",
      };

      // 默认使用 flash
      let modelId = "gemini-3-flash-preview";
      if (model) {
        if (modelMap[model.toLowerCase()]) {
          modelId = modelMap[model.toLowerCase()];
        } else {
          return `❌ 无效模型参数\n可用: ${validModels.join(", ")}\n示例: gemini情缘 pro`;
        }
      }
      const MATCH_COST = 0; // 测试不扣费

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        return `<at id="${session.userId}"/> 没有档案还在这匹配情缘🫵`;
      }
      const myProfile = profiles[0] as SoulProfile;

      // 获取所有未封存的档案
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);
      const exclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const reverseExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });
      const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
      const excludedUserIds = [
        ...exclusions.map((e) => e.excludedUserId),
        ...reverseExclusions.map((e) => e.userId),
        ...lockedUserIds,
      ];

      // 筛选可匹配的档案
      const validProfiles = filterMatchableCandidates(
        myProfile,
        allProfiles,
        excludedUserIds,
        archivedProfileIds
      );

      if (validProfiles.length === 0) {
        return `<at id="${session.userId}"/> 你的情缘池子干了，抽不了了😢`;
      }

      await session.send(
        `<at id="${session.userId}" /> [Gemini测试] 正在为你匹配情缘，请稍候...\n💡 使用模型: ${modelId}`
      );

      try {
        logger.info(`[Gemini测试] 当前正在匹配的用户：${session.userId}`);

        // 调用 Gemini 专用匹配函数，传入指定的模型
        const matchResult = await callGeminiPair(myProfile, validProfiles, ctx, modelId);
        if (!matchResult) {
          throw new Error("Gemini 模型调用失败");
        }
        const { response, modelName, modelGrade } = matchResult;
        let responseContent =
          typeof response === "string" ? response : JSON.stringify(response);

        // AI返回结果解析 - 移除 markdown 代码块
        let cleanContent = responseContent.replace(
          /[\u0000-\u001F\u007F-\u009F]/g,
          ""
        );
        logger.info(`[Gemini测试] AI响应总长度: ${cleanContent.length}`);
        logger.info(`[Gemini测试] AI完整响应:\n${cleanContent}`);
        // 移除 ```json 和 ``` 标记
        cleanContent = cleanContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.error(`[Gemini测试] 无法从响应中提取JSON`);
          return `❌ AI返回格式错误\n模型: ${modelName}\n响应总长度: ${cleanContent.length}\n完整响应:\n${cleanContent}`;
        }

        let result = JSON.parse(jsonMatch[0]);
        if (!result.matches || result.matches.length === 0) {
          return `<at id="${session.userId}" /> [Gemini测试] 😔 经过深度分析，暂时没有找到合适的匹配\n模型: ${modelName} (${modelGrade})`;
        }

        // 私聊发送结果
        const privateChannelId = `private:${session.userId}`;

        await session.bot?.sendMessage(
          privateChannelId,
          `🎉 [Gemini测试] 为您找到 ${result.matches.length} 个匹配！\n💡 本次使用模型：${modelName}（${modelGrade}）`
        );

        // 发送匹配结果
        for (let i = 0; i < Math.min(result.matches.length, 3); i++) {
          const match = result.matches[i];
          let candidate: SoulProfile | undefined = validProfiles[match.candidateIndex - 1];
          if (!candidate && match.userId) {
            candidate = validProfiles.find((p: SoulProfile) => p.userId === match.userId);
          }
          if (!candidate) continue;

          await new Promise((resolve) => setTimeout(resolve, 1000));
          let matchMessage = `\n━━━ 匹配 ${i + 1} ━━━\n`;
          matchMessage += `💕 匹配度：${Math.min(match.score, 100)}分\n`;
          matchMessage += `角色名：${candidate.characterName}\n`;
          matchMessage += `服务器：${candidate.servers}\n`;
          matchMessage += `门派体型：${candidate.characterTypes}\n`;
          matchMessage += `自我介绍：${candidate.introduction}\n`;
          matchMessage += `匹配理由：${match.analysis}\n`;
          if (match.concerns && match.concerns.length > 0) {
            matchMessage += `⚠️ 注意：${match.concerns.join("、")}\n`;
          }
          matchMessage += `QQ号：${candidate.userId}\n`;
          await session.bot?.sendMessage(privateChannelId, matchMessage);
        }

        return `<at id="${session.userId}"/> [Gemini测试] 匹配成功！快去小窗查看~\n模型: ${modelName} (${modelGrade})`;
      } catch (error) {
        logger.error("[Gemini测试] 错误:", error);
        return `<at id="${session.userId}"/> [Gemini测试] 出错啦：${error.message?.substring(0, 100) || error}`;
      }
    });

  // [测试] 向量化预筛匹配命令 - 先用 Embedding 语义排序，再 AI 打分
  ctx
    .command("向量匹配 [topk]")
    .alias("测试向量匹配")
    .action(async ({ session }, topk) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }

      const TOP_K = Math.min(Math.max(parseInt(topk) || 10, 2), 15);

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        return `<at id="${session.userId}"/> 没有档案还在这匹配情缘🫵`;
      }
      const myProfile = profiles[0] as SoulProfile;

      // 获取所有未封存的档案
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);
      const exclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const reverseExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });
      const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
      const excludedUserIds = [
        ...exclusions.map((e) => e.excludedUserId),
        ...reverseExclusions.map((e) => e.userId),
        ...lockedUserIds,
      ];

      // 规则筛选
      const validProfiles = filterMatchableCandidates(
        myProfile,
        allProfiles,
        excludedUserIds,
        archivedProfileIds
      );

      if (validProfiles.length === 0) {
        return `<at id="${session.userId}"/> 你的情缘池子干了，抽不了了😢`;
      }

      await session.send(
        `<at id="${session.userId}" /> [向量匹配] 正在进行语义预筛...\n💡 候选人: ${validProfiles.length} → Top-${TOP_K}`
      );

      try {
        // ===== 1. 向量化预筛 =====
        const startTime = Date.now();
        const ranked = await rankCandidatesByEmbedding(
          myProfile,
          validProfiles,
          TOP_K,
          ctx
        );
        const embeddingTime = Date.now() - startTime;

        // 提取 Top-K 候选人
        const topCandidates = ranked.map(r => r.profile);

        // 在群里发一下向量排序结果
        let rankMsg = `📊 [向量匹配] 语义预筛完成 (${embeddingTime}ms)\n`;
        rankMsg += `总候选: ${validProfiles.length} → Top-${ranked.length}\n`;
        rankMsg += `━━━━━━━━━━━\n`;
        ranked.forEach((r, i) => {
          rankMsg += `${i + 1}. ${r.profile.characterName} - 相似度: ${(r.similarity * 100).toFixed(1)}%\n`;
        });
        rankMsg += `\n正在调用 AI 对 Top-${ranked.length} 精细打分...`;
        await session.send(rankMsg);

        // ===== 2. 只对 Top-K 调用 AI =====
        const aiStartTime = Date.now();
        const matchResult = await callNormalPair(myProfile, topCandidates, ctx, session.userId, session.platform);
        const aiTime = Date.now() - aiStartTime;

        if (!matchResult) {
          throw new Error("AI模型调用失败");
        }
        const { response, modelName, modelGrade } = matchResult;
        let responseContent =
          typeof response === "string" ? response : JSON.stringify(response);

        // 解析 AI 结果
        let cleanContent = responseContent.replace(
          /[\u0000-\u001F\u007F-\u009F]/g,
          ""
        );
        cleanContent = cleanContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.error(`[向量匹配] 无法从响应中提取JSON`);
          return `❌ AI返回格式错误\n模型: ${modelName}`;
        }

        let result;
        try {
          result = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          const repaired = await repairJsonWithGemini(jsonMatch[0], ctx as Context);
          if (!repaired) throw new Error("AI返回格式错误");
          result = repaired;
        }

        if (!result.matches || result.matches.length === 0) {
          return `<at id="${session.userId}" /> [向量匹配] 😔 AI 认为 Top-${TOP_K} 中没有合适的匹配\n⏱️ 预筛: ${embeddingTime}ms | AI: ${aiTime}ms | 模型: ${modelName}`;
        }

        // ===== 3. 私聊发送结果 =====
        const privateChannelId = `private:${session.userId}`;

        await session.bot?.sendMessage(
          privateChannelId,
          `🎉 [向量匹配] 为您找到 ${result.matches.length} 个匹配！\n` +
          `💡 模型：${modelName}（${modelGrade}）\n` +
          `📊 流程：${validProfiles.length} 候选 → 向量预筛 Top-${TOP_K} → AI 精细打分\n` +
          `⏱️ 预筛: ${embeddingTime}ms | AI: ${aiTime}ms`
        );

        for (let i = 0; i < Math.min(result.matches.length, 3); i++) {
          const match = result.matches[i];
          let candidate: SoulProfile | undefined = topCandidates[match.candidateIndex - 1];
          if (!candidate && match.userId) {
            candidate = topCandidates.find((p: SoulProfile) => p.userId === match.userId);
          }
          if (!candidate) continue;

          // 找到该候选人在向量排名中的位置
          const embRank = ranked.findIndex(r => r.profile.userId === candidate!.userId);
          const embSim = embRank >= 0 ? ranked[embRank].similarity : 0;

          await new Promise((resolve) => setTimeout(resolve, 1000));
          let matchMessage = `\n━━━ 匹配 ${i + 1} ━━━\n`;
          matchMessage += `💕 AI匹配度：${Math.min(match.score, 100)}分\n`;
          matchMessage += `📊 向量排名：#${embRank + 1} (相似度: ${(embSim * 100).toFixed(1)}%)\n`;
          matchMessage += `角色名：${candidate.characterName}\n`;
          matchMessage += `服务器：${candidate.servers}\n`;
          matchMessage += `门派体型：${candidate.characterTypes}\n`;
          matchMessage += `自我介绍：${candidate.introduction}\n`;
          matchMessage += `匹配理由：${match.analysis}\n`;
          if (match.concerns && match.concerns.length > 0) {
            matchMessage += `⚠️ 注意：${match.concerns.join("、")}\n`;
          }
          matchMessage += `QQ号：${candidate.userId}\n`;
          await session.bot?.sendMessage(privateChannelId, matchMessage);
        }

        return (
          `<at id="${session.userId}"/> [向量匹配] 匹配成功！快去小窗看看~\n` +
          `⏱️ 预筛: ${embeddingTime}ms | AI: ${aiTime}ms | 模型: ${modelName}`
        );
      } catch (error) {
        logger.error("[向量匹配] 错误:", error);
        return `<at id="${session.userId}"/> [向量匹配] 出错啦：${error.message?.substring(0, 100) || error}`;
      }
    });

  // 谁跟我最搭 - 纯向量相似度，不需要 AI，结果私聊发送
  ctx
    .command("谁跟我最搭")
    .alias("最搭情缘")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        return `<at id="${session.userId}"/> 没有档案还想看谁跟你最搭？🫵\n📝 请先使用「登记档案」命令填写档案`;
      }
      const myProfile = profiles[0] as SoulProfile;

      // 检查咕咕币
      const COST = 100;
      if (myProfile.coins < COST) {
        return `<at id="${session.userId}"/> 咕咕币不够啦！查看最搭情缘需要 ${COST} 咕咕币\n当前余额：${myProfile.coins}`;
      }

      // 扣除咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins - COST, updatedAt: Date.now() }
      );

      // 检查用户是否有 embedding
      if (!myProfile.embedding || (myProfile.embedding as any[]).length === 0) {
        return `<at id="${session.userId}"/> 你的档案还没有生成向量数据，请联系管理员`;
      }

      // 获取所有有 embedding 的档案（排除自己和封存的）
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);

      // 获取双向排除列表
      const myExclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const reverseExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });
      const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
      const allExcludedUserIds = new Set([
        ...myExclusions.map((e) => e.excludedUserId),
        ...reverseExclusions.map((e) => e.userId),
        ...lockedUserIds,
      ]);

      const candidates = allProfiles.filter(
        (p) =>
          p.userId !== session.userId &&
          p.embedding &&
          (p.embedding as any[]).length > 0 &&
          !archivedProfileIds.includes(p.id!) &&
          !allExcludedUserIds.has(p.userId) &&
          // 性别偏好双向检查
          (myProfile.preferGender === "不限" || p.gender === myProfile.preferGender) &&
          (p.preferGender === "不限" || myProfile.gender === p.preferGender)
      );

      // 单相思模式：只保留白名单目标
      const whitelistEntries = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
        defaultExclude: true,
      });
      const isWhitelistMode = whitelistEntries.length > 0;
      const filteredCandidates = isWhitelistMode
        ? candidates.filter((p) => p.userId === whitelistEntries[0].whitelistedUserId)
        : candidates;

      if (filteredCandidates.length === 0) {
        if (isWhitelistMode) {
          return `<at id="${session.userId}"/> 你的单相思目标暂时没有可比较的向量数据`;
        }
        return `<at id="${session.userId}"/> 暂时没有可比较的档案`;
      }

      // 纯向量计算 Top-5
      const myEmbedding = myProfile.embedding as number[];
      const scored = filteredCandidates.map((p) => ({
        profile: p,
        similarity: (() => {
          const b = p.embedding as number[];
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < myEmbedding.length; i++) {
            dot += myEmbedding[i] * b[i];
            normA += myEmbedding[i] * myEmbedding[i];
            normB += b[i] * b[i];
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        })(),
      }));

      scored.sort((a, b) => b.similarity - a.similarity);
      const top5 = scored.slice(0, 5);

      // 私聊发送结果
      const privateChannelId = `private:${session.userId}`;
      try {
        let msg = `📊 与你最搭的 Top 5 情缘候选：\n`;
        msg += `━━━━━━━━━━━\n`;
        top5.forEach((s, i) => {
          msg += `${i + 1}. ${s.profile.characterName}\n`;
          msg += `   🏷️ 区服：${s.profile.servers}\n`;
          msg += `   📊 契合度：${(s.similarity * 100).toFixed(1)}%\n`;
          msg += `   🔑 QQ：${s.profile.userId}\n\n`;
        });
        msg += `💡 以上基于档案语义相似度计算，仅供参考`;

        await session.bot?.sendMessage(privateChannelId, msg);
      } catch (error) {
        logger.warn(`[谁跟我最搭] 私聊发送失败: ${error}`);
        return `<at id="${session.userId}"/> 私聊发送失败，请确认已添加机器人好友`;
      }

      return `<at id="${session.userId}"/> 已私聊发送你的 Top 5 最搭情缘~`;
    });

  // [管理员] 批量生成所有档案的向量数据
  ctx
    .command("生成所有向量数据")
    .alias("批量生成向量")
    .action(async ({ session }) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }

      // 获取所有档案
      const allProfiles = await ctx.database.get("soul_profiles", {});

      // 筛选无 embedding 的档案
      const needGenerate = allProfiles.filter(
        (p) => !p.embedding || (p.embedding as any[]).length === 0
      );

      if (needGenerate.length === 0) {
        return `✅ 所有 ${allProfiles.length} 个档案已有向量数据，无需生成`;
      }

      await session.send(
        `📦 开始批量生成向量数据...\n总档案: ${allProfiles.length} | 已有向量: ${allProfiles.length - needGenerate.length} | 待生成: ${needGenerate.length}`
      );

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < needGenerate.length; i++) {
        const profile = needGenerate[i] as SoulProfile;

        // 429 重试逻辑（最多 3 次，指数退避）
        let retries = 0;
        let done = false;
        while (!done && retries < 3) {
          try {
            const embedding = await generateProfileEmbedding(profile, ctx);
            if (embedding) {
              await ctx.database.set("soul_profiles", { id: profile.id }, { embedding });
              successCount++;
            } else {
              failCount++;
            }
            done = true;
          } catch (error: any) {
            if (error?.response?.status === 429 && retries < 2) {
              retries++;
              const backoff = retries * 5000; // 5s, 10s
              logger.warn(`[批量向量] ${profile.characterName} 限流，${backoff / 1000}s 后重试 (${retries}/3)`);
              await new Promise(r => setTimeout(r, backoff));
            } else {
              failCount++;
              logger.error(`[批量向量] ${profile.characterName} 失败:`, error);
              done = true;
            }
          }
        }

        // 每 10 个报告一次进度
        if ((i + 1) % 10 === 0) {
          await session.send(`⏳ 进度: ${i + 1}/${needGenerate.length} (✅${successCount} ❌${failCount})`);
        }

        // 免费 API 限流：每个请求间隔 2 秒
        await new Promise(r => setTimeout(r, 2000));
      }

      return `✅ 批量生成完成\n总计: ${needGenerate.length} | 成功: ${successCount} | 失败: ${failCount}`;
    });

  // 我想要情缘命令
  ctx
    .command("我想要情缘")
    .alias("匹配情缘")
    .action(async ({ session }) => {
      if (!session) return;
      const MATCH_COST = 1;

      // 检查用户是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        // 无档案用户：随机分配一个群成员
        try {
          const GROUP_ID = "YOUR_GROUP_ID_1";
          const bot = ctx.bots.find(b => b.platform === "onebot");
          if (bot) {
            const members = await bot.internal.getGroupMemberList(GROUP_ID);
            if (members && Array.isArray(members) && members.length > 0) {
              // 排除自己和机器人
              const otherMembers = members.filter(
                (m: any) => m.user_id?.toString() !== session.userId && m.user_id?.toString() !== session.selfId
              );
              if (otherMembers.length > 0) {
                const randomMember = otherMembers[Math.floor(Math.random() * otherMembers.length)];
                const memberId = randomMember.user_id?.toString();
                const memberNick = randomMember.card || randomMember.nickname || memberId;
                return `<at id="${session.userId}"/> 没有档案还想匹配情缘？🫵\n那就随机给你分配一个吧：<at id="${memberId}"/> (${memberNick})\n\n📝 想要认真匹配请先使用「登记档案」命令填写档案哦~`;
              }
            }
          }
        } catch (e) {
          logger.warn(`随机分配群成员失败: ${e}`);
        }
        return `<at id="${session.userId}"/> 没有档案还在这匹配情缘🫵\n📝 请先使用「登记档案」命令填写档案`;
      }
      const myProfile = profiles[0] as SoulProfile;

      // 检查档案是否被封存
      const archivedProfiles = await ctx.database.get(
        "soul_archived_profiles",
        {
          profileId: myProfile.id!,
          unArchivedAt: null,
        }
      );
      if (archivedProfiles.length > 0) {
        const archivedProfile = archivedProfiles[0] as SoulArchivedProfile;
        const archiveTime = new Date(
          archivedProfile.archivedAt
        ).toLocaleString();
        const archivedBy =
          archivedProfile.archivedBy === session.userId ? "自己" : "管理员";
        return `❌ 您的档案已被封存，无法参与匹配\n封存时间：${archiveTime}\n封存者：${archivedBy}\n封存原因：${archivedProfile.archiveReason}\n\n💡 使用"解封档案"命令可自行解封`;
      }

      // 检查是否有正在进行的匹配
      const matchKey = `${session.userId}-${session.platform}`;
      if (ongoingMatches.has(matchKey)) {
        const startTime = ongoingMatches.get(matchKey)!;
        const elapsed = Date.now() - startTime;
        if (elapsed > 10 * 60 * 1000) {
          ongoingMatches.delete(matchKey);
        } else {
          return "您的上一次匹配正在进行中，请稍等片刻...\n（如果长时间没有响应，请联系管理员）";
        }
      }

      // 检查是否有未解除的保底限制
      const restrictions = await ctx.database.get("soul_bonus_restrictions", {
        userId: session.userId!,
        groupId: session.channelId!,
        platform: session.platform!,
      });
      if (restrictions && restrictions.length > 0) {
        const restriction = restrictions[0];
        return `你上一个保底的人都没主动打招呼就想匹配下一个啊！\n请先在群里@对方并说点什么（比如：<at id="${restriction.targetUserId}" /> 老师你好！）`;
      }

      // 检查是否有等待确认的联系请求
      const requestKey = `${session.userId}-${session.platform}`;
      if (pendingContactRequests.has(requestKey)) {
        return '❓ 你还有一个联系确认等待回复中，请先在私聊中回复"是"或"不是"再开始新的匹配~';
      }

      // 检查coin是否足够
      if (myProfile.coins < MATCH_COST) {
        return `<at id="${session.userId}"/> 咕咕币不够了！需要${MATCH_COST}个咕咕币才能匹配情缘\n当前咕咕币：${myProfile.coins}`;
      }

      // 扣除coin
      await ctx.database.set(
        "soul_profiles",
        {
          id: myProfile.id,
        },
        {
          coins: myProfile.coins - MATCH_COST,
          updatedAt: Date.now(),
        }
      );

      logger.info(
        `用户 ${session.userId} 扣除了 ${MATCH_COST} 个咕咕币，当前剩余：${myProfile.coins - MATCH_COST
        }个咕咕币`
      );

      // 获取所有未封存的档案
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);
      const exclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const reverseExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });
      const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
      const excludedUserIds = [
        ...exclusions.map((e) => e.excludedUserId),
        ...reverseExclusions.map((e) => e.userId),
        ...lockedUserIds,
      ];
      // 查询白名单（单相思模式）
      const whitelistEntries = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
        defaultExclude: true,
      });
      const isWhitelistMode = whitelistEntries.length > 0;
      const whitelistUserIds = isWhitelistMode
        ? whitelistEntries.map((w) => w.whitelistedUserId)
        : undefined;

      // 筛选可匹配的档案
      const validProfiles = filterMatchableCandidates(
        myProfile,
        allProfiles,
        excludedUserIds,
        archivedProfileIds,
        whitelistUserIds
      );

      // 检查匹配建议（白名单模式下跳过）
      if (!isWhitelistMode) {
        const suggestion = getMatchSuggestion(
          myProfile,
          allProfiles,
          validProfiles,
          excludedUserIds,
          archivedProfileIds,
          session.userId!,
          exclusions
        );
        if (suggestion) {
          // 返还咕咕币
          await ctx.database.set(
            "soul_profiles",
            { id: myProfile.id },
            { coins: myProfile.coins, updatedAt: Date.now() }
          );
          return suggestion;
        }
      }

      if (validProfiles.length === 0) {
        // 返还咕咕币
        await ctx.database.set(
          "soul_profiles",
          { id: myProfile.id },
          { coins: myProfile.coins, updatedAt: Date.now() }
        );
        return `<at id="${session.userId}"/> 你的情缘池子干了，抽不了了😢`;
      }

      // 发送匹配开始消息
      await session.send(
        `<at id="${session.userId}" /> 正在为你匹配今日份推荐情缘，请稍候...\n💡 Tips: 匹配需要一定时间`
      );

      // 标记开始匹配
      ongoingMatches.set(matchKey, Date.now());
      try {
        ctx.logger.info(`当前正在匹配的用户：${session.userId}`);

        // 获取匹配统计
        const matchStatsKey = {
          userId: session.userId!,
          platform: session.platform!,
        };

        const matchStats = await ctx.database.get(
          "soul_match_stats",
          matchStatsKey
        );
        let currentMatchCount =
          matchStats.length > 0 ? matchStats[0].matchCount + 1 : 1;

        // 计算保底概率（无论是否有匹配结果都要计算）
        let originalBonusProbability = 0;
        if (currentMatchCount === 2) {
          // 第二次：初始概率1-10%
          originalBonusProbability = 1 + Math.random() * 9;
          originalBonusProbability =
            Math.round(originalBonusProbability * 100) / 100; // 保留两位小数
        } else if (currentMatchCount > 2) {
          // 第三次及以后：基于上次的概率随机增加0-10%
          const lastProbability =
            matchStats.length > 0
              ? (matchStats[0] as any).bonusProbability || 0
              : 0;
          const increment = 1 + Math.random() * 9; // 1-10%的随机增量
          originalBonusProbability = Math.min(lastProbability + increment, 100);
          originalBonusProbability =
            Math.round(originalBonusProbability * 100) / 100; // 保留两位小数
        }

        // ===== 向量化预筛 =====
        let topCandidates: SoulProfile[] = validProfiles;
        try {
          const ranked = await rankCandidatesByEmbedding(
            myProfile,
            validProfiles,
            10,
            ctx
          );
          topCandidates = ranked.map(r => r.profile);
          ctx.logger.info(`[匹配] 向量预筛: ${validProfiles.length} → ${topCandidates.length}`);
        } catch (embError: any) {
          // 向量预筛失败不影响正常流程，回退到全量候选
          ctx.logger.warn(`[匹配] 向量预筛失败，使用全量候选: ${embError.message}`);
        }

        // 结果处理
        const matchResult = await callNormalPair(myProfile, topCandidates, ctx, session.userId, session.platform);
        if (!matchResult) {
          throw new Error("AI模型调用失败");
        }
        const { response, modelName, modelGrade } = matchResult;
        let responseContent =
          typeof response === "string" ? response : JSON.stringify(response);

        // AI返回结果解析 - 移除 markdown 代码块
        let cleanContent = responseContent.replace(
          /[\u0000-\u001F\u007F-\u009F]/g,
          ""
        );
        // 移除 ```json 和 ``` 标记
        cleanContent = cleanContent.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        let result;
        if (!jsonMatch) {
          // JSON 提取失败，尝试用 Gemini 修复
          logger.warn(`无法提取JSON，尝试使用 Gemini 修复。响应内容: ${cleanContent.substring(0, 300)}`);
          const repaired = await repairJsonWithGemini(cleanContent, ctx as Context);
          if (!repaired) {
            logger.error(`JSON 修复失败，响应内容: ${cleanContent.substring(0, 500)}`);
            throw new Error("AI返回格式错误");
          }
          result = repaired;
        } else {
          try {
            result = JSON.parse(jsonMatch[0]);
          } catch (parseError) {
            // JSON 解析失败（截断），尝试用 Gemini 修复
            logger.warn(`JSON 解析失败，尝试使用 Gemini 修复。截断内容: ${jsonMatch[0].substring(jsonMatch[0].length - 100)}`);
            const repaired = await repairJsonWithGemini(jsonMatch[0], ctx as Context);
            if (!repaired) {
              throw new Error("AI返回格式错误");
            }
            result = repaired;
          }
        }

        if (!result.matches || result.matches.length === 0) {
          // 没有匹配结果时，仍要更新统计（保留保底概率）
          await updateMatchStats(
            ctx,
            matchStatsKey,
            currentMatchCount,
            originalBonusProbability
          );
          return `<at id="${session.userId}" /> 😔 经过深度分析，暂时没有找到合适的匹配`;
        }

        // 计算保底概率触发
        let bonusProbability = originalBonusProbability;
        let autoNotified = false;
        let bonusTarget: SoulProfile | null = null;
        let bonusMatchReason = "";

        // 判断是否触发保底
        if (bonusProbability > 0) {
          const randomRoll = Math.random() * 100;
          if (randomRoll < bonusProbability) {
            // 触发保底！选择最高分的候选人
            const bestMatch = result.matches[0];
            bonusTarget = topCandidates[bestMatch.candidateIndex - 1];
            bonusMatchReason = bestMatch.analysis;
            autoNotified = true;

            // 记录保底限制
            await ctx.database.create("soul_bonus_restrictions", {
              userId: session.userId!,
              groupId: session.channelId!,
              platform: session.platform!,
              targetUserId: bonusTarget.userId,
              createdAt: Date.now(),
            });

            // 重置概率为0（但不在这里重置次数，要等显示完消息后再重置）
            bonusProbability = 0;
          }
        }

        const privateChannelId = `private:${session.userId}`;

        // 保存显示用的匹配次数
        const displayMatchCount = currentMatchCount;

        // 如果触发了保底，更新统计时重置为0
        if (autoNotified && bonusTarget) {
          currentMatchCount = 0; // 触发保底后重置
        }

        // 更新匹配统计
        await updateMatchStats(
          ctx,
          matchStatsKey,
          currentMatchCount,
          bonusProbability
        );

        // 处理保底情况
        if (autoNotified && bonusTarget) {
          // 私聊通知用户
          try {
            await session.bot?.sendMessage(
              privateChannelId,
              `🎉 保底触发！已经帮你锁定了最合适的对象：\n\n` +
              `角色名：${bonusTarget.characterName}\n` +
              `服务器：${bonusTarget.servers}\n` +
              `门派体型：${bonusTarget.characterTypes}\n` +
              `自我介绍：${bonusTarget.introduction}\n` +
              `匹配理由：${bonusMatchReason}\n` +
              `QQ号：${bonusTarget.userId}\n\n` +
              `⚠️ 请在群里@对方并说点什么，否则无法进行下次匹配！\n` +
              `（比如：@${bonusTarget.userId} 老师我可以获得你的好友位吗！）`
            );

            // 如果保底对象有名片，发送名片图片
            if (bonusTarget.characterImageUrl && bonusTarget.characterImageUrl.length > 0) {
              const latestCard = bonusTarget.characterImageUrl[bonusTarget.characterImageUrl.length - 1];
              try {
                await session.bot?.sendMessage(privateChannelId, `<image url="${latestCard}" />`);
              } catch (e) {
                logger.warn(`发送保底名片图片失败: ${e}`);
              }
            }

            // 更新被匹配者的统计
            await updateMatchedByCount(ctx, bonusTarget.userId, bonusTarget.platform);
            // 记录匹配历史
            await recordMatchHistory(ctx, session.userId!, session.platform!, bonusTarget.userId, bonusTarget.platform, "bonus");
          } catch (error) {
            logger.warn(
              `无法私聊通知用户 ${session.userId}: ${error.message.substring(
                0,
                60
              )}`
            );
          }

          // 群里发送提示
          const triggerProbability = originalBonusProbability;
          return (
            `<at id="${session.userId}" /> 恭喜触发保底！\n` +
            `第${displayMatchCount}次匹配 | 触发时概率：${triggerProbability.toFixed(
              2
            )}%\n` +
            `匹配结果已私聊发送，请查看私信并按要求操作~`
          );
        }

        // 正常匹配情况
        // 发送开头信息
        await session.bot?.sendMessage(
          privateChannelId,
          isWhitelistMode
            ? `🎉 为您找到匹配！\n💡 本次使用模型：${modelName}（${modelGrade}）`
            : `🎉 为您找到 ${result.matches.length} 个匹配！\n💡 本次使用模型：${modelName}（${modelGrade}）`
        );

        // 分批发送匹配结果
        for (let i = 0; i < Math.min(result.matches.length, 3); i++) {
          const match = result.matches[i];

          // 尝试通过 candidateIndex 获取候选人
          let candidate: SoulProfile | undefined = topCandidates[match.candidateIndex - 1];

          // 如果 candidateIndex 无效，尝试通过 userId 匹配
          if (!candidate && match.userId) {
            candidate = topCandidates.find((p: SoulProfile) => p.userId === match.userId);
            logger.warn(`candidateIndex ${match.candidateIndex} 无效，通过 userId ${match.userId} 回退匹配`);
          }

          if (!candidate) {
            logger.error(`匹配结果 ${i + 1} 无法找到候选人: candidateIndex=${match.candidateIndex}, validProfiles.length=${validProfiles.length}`);
            continue;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          let matchMessage = `\n━━━ 匹配 ${i + 1} ━━━\n`;
          matchMessage += `💕 匹配度：${Math.min(match.score, 100)}分\n`;
          matchMessage += `角色名：${candidate.characterName}\n`;
          matchMessage += `服务器：${candidate.servers}\n`;
          matchMessage += `门派体型：${candidate.characterTypes}\n`;
          matchMessage += `自我介绍：${candidate.introduction}\n`;
          matchMessage += `匹配理由：${match.analysis}\n`;
          if (match.concerns && match.concerns.length > 0) {
            matchMessage += `⚠️ 注意：${match.concerns.join("、")}\n`;
          }
          matchMessage += `QQ号：${candidate.userId}\n`;
          await session.bot?.sendMessage(privateChannelId, matchMessage);

          // 如果候选人有名片，发送名片图片
          if (candidate.characterImageUrl && candidate.characterImageUrl.length > 0) {
            const latestCard = candidate.characterImageUrl[candidate.characterImageUrl.length - 1];
            try {
              await session.bot?.sendMessage(privateChannelId, `<image url="${latestCard}" />`);
            } catch (e) {
              logger.warn(`发送名片图片失败: ${e}`);
            }
          }

          // 更新被匹配者的统计
          await updateMatchedByCount(ctx, candidate.userId, candidate.platform);
          // 记录匹配历史
          await recordMatchHistory(ctx, session.userId!, session.platform!, candidate.userId, candidate.platform, "normal");
        }
        // 根据私聊决定最后一条发送内容
        let reminder = "";
        if (!myProfile.birthYear || !myProfile.location) {
          reminder = `\n\n💡 您的档案资料不完整（缺少年龄/属地），补充后可获得更精准的匹配！请使用"更新情缘档案"命令补充。`;
        }

        if (session.isDirect) {
          return `💡Tips: 感兴趣的话快去聊聊吧！说不定密上去就成功辣！\n💌 如需修改自己的档案，请使用"更新情缘档案"${reminder}`;
        } else {
          await session.bot?.sendMessage(
            privateChannelId,
            `\n💌 如需修改自己的档案，请使用"更新情缘档案"${reminder}`
          );
        }
      } catch (error) {
        logger.error("发送匹配结果失败:", error.message.substring(0, 60));
        await ctx.database.set(
          "soul_profiles",
          {
            id: myProfile.id,
          },
          {
            coins: myProfile.coins + MATCH_COST * 2,
            updatedAt: Date.now(),
          }
        );
        ongoingMatches.delete(matchKey);
        return `<at id="${session.userId}"/> 出错啦！花费的咕咕币双倍已经返回给你啦！`;
      } finally {
        ongoingMatches.delete(matchKey);
      }
      // 返回匹配结果
      return `<at id="${session.userId}"/> 匹配成功辣！快去小窗看看吧！`;
    });

  // 我真的想要情缘命令
  ctx.command("我真的想要情缘").action(async ({ session }) => {
    if (!session) return;

    // 临时禁用：GPT额度已用完，恢复后删除此段
    return `<at id="${session.userId}" /> ❗ 深度匹配功能暂时维护中，请稍后再试~`;

    const MATCH_COST = 20;

    // 检查每日使用限制（每人每天只能使用一次）
    const alreadyUsed = await checkDailyModelLimit(ctx, session.userId!, session.platform!, "deep_match");
    if (alreadyUsed) {
      return `<at id="${session.userId}" /> ❗ 深度匹配每天只能使用一次，明天再来吧~`;
    }

    // 检查用户是否有档案
    const profiles = await ctx.database.get("soul_profiles", {
      userId: session.userId,
      platform: session.platform,
    });
    if (!profiles || profiles.length === 0) {
      return `${session.isDirect ? "" : ""}<at id="${session.userId
        }"/> 没有档案还在这匹配情缘🫵\n请先使用"登记档案"创建档案后再尝试~`;
    }
    const myProfile = profiles[0] as SoulProfile;

    // 检查档案是否被封存
    const archivedProfiles = await ctx.database.get("soul_archived_profiles", {
      profileId: myProfile.id!,
      unArchivedAt: null,
    });
    if (archivedProfiles.length > 0) {
      const archivedProfile = archivedProfiles[0] as SoulArchivedProfile;
      const archiveTime = new Date(archivedProfile.archivedAt).toLocaleString();
      const archivedBy =
        archivedProfile.archivedBy === session.userId ? "自己" : "管理员";
      return `❌ 您的档案已被封存，无法参与匹配\n封存时间：${archiveTime}\n封存者：${archivedBy}\n封存原因：${archivedProfile.archiveReason}\n\n💡 使用"解封档案"命令可自行解封`;
    }

    // 检查是否有正在进行的匹配
    const matchKey = `${session.userId}-${session.platform}`;
    if (ongoingMatches.has(matchKey)) {
      const startTime = ongoingMatches.get(matchKey)!;
      const elapsed = Date.now() - startTime;
      if (elapsed > 10 * 60 * 1000) {
        ongoingMatches.delete(matchKey);
      } else {
        return "您的上一次匹配正在进行中，请稍等片刻...\n（如果长时间没有响应，请联系管理员）";
      }
    }

    // 检查是否有未解除的保底限制
    const restrictions = await ctx.database.get("soul_bonus_restrictions", {
      userId: session.userId!,
      groupId: session.channelId!,
      platform: session.platform!,
    });
    if (restrictions && restrictions.length > 0) {
      const restriction = restrictions[0];
      return `你上一个保底的人都没主动打招呼就想匹配下一个啊！\n请先在群里@对方并说点什么（比如：<at id="${restriction.targetUserId}" /> 老师你好！）`;
    }

    // 检查coin是否足够
    if (myProfile.coins < MATCH_COST) {
      return `<at id="${session.userId}"/> 咕咕币不够了！需要${MATCH_COST}个咕咕币才能匹配情缘\n当前咕咕币：${myProfile.coins}`;
    }

    // 扣除coin
    await ctx.database.set(
      "soul_profiles",
      {
        id: myProfile.id,
      },
      {
        coins: myProfile.coins - MATCH_COST,
        updatedAt: Date.now(),
      }
    );

    logger.info(
      `用户 ${session.userId} 扣除了 ${MATCH_COST} 个咕咕币，当前剩余：${myProfile.coins - MATCH_COST
      }个咕咕币`
    );

    // 获取所有未封存的档案 + 筛选有效匹配
    const allProfiles = await ctx.database.get("soul_profiles", {});
    const archivedProfileIds = await getArchivedProfileIds(ctx as any);
    const exclusions = await ctx.database.get("soul_exclusions", {
      userId: session.userId!,
      platform: session.platform!,
    });
    const reverseExclusions = await ctx.database.get("soul_exclusions", {
      excludedUserId: session.userId!,
    });
    const lockedUserIds = await getLockedUserIds(ctx, session.userId!);
    const excludedUserIds = [
      ...exclusions.map((e) => e.excludedUserId),
      ...reverseExclusions.map((e) => e.userId),
      ...lockedUserIds,
    ];

    // 查询白名单（单相思模式）
    const whitelistEntries = await ctx.database.get("soul_match_whitelist", {
      userId: session.userId!,
      platform: session.platform!,
      defaultExclude: true,
    });
    const isWhitelistMode = whitelistEntries.length > 0;
    const whitelistUserIds = isWhitelistMode
      ? whitelistEntries.map((w) => w.whitelistedUserId)
      : undefined;

    // 筛选可匹配的档案
    const validProfiles = filterMatchableCandidates(
      myProfile,
      allProfiles,
      excludedUserIds,
      archivedProfileIds,
      whitelistUserIds
    );

    // 检查匹配建议（白名单模式下跳过）
    if (!isWhitelistMode) {
      const suggestion = getMatchSuggestion(
        myProfile,
        allProfiles,
        validProfiles,
        excludedUserIds,
        archivedProfileIds,
        session.userId!,
        exclusions
      );
      if (suggestion) {
        // 返还咕咕币
        await ctx.database.set(
          "soul_profiles",
          { id: myProfile.id },
          { coins: myProfile.coins, updatedAt: Date.now() }
        );
        return suggestion;
      }
    }

    if (validProfiles.length === 0) {
      // 返还咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins, updatedAt: Date.now() }
      );
      return `<at id="${session.userId}"/> 你的情缘池子干了，抽不了了😢`;
    }

    // 发送匹配开始消息
    await session.send(
      `<at id="${session.userId}" /> 正在快马加鞭匹配中...\n💡 Tips: 匹配需要一定时间`
    );

    // 标记开始匹配
    ongoingMatches.set(matchKey, Date.now());
    try {
      ctx.logger.info(`当前正在深度思考匹配的用户：${session.userId}`);

      // 调用高级匹配（全量候选）
      const responseContent = await callAdvancedPair(
        myProfile,
        validProfiles,
        ctx
      );

      // 解析匹配结果（保持JSON解析逻辑不变）
      let aiMatches;
      try {
        const jsonMatch = responseContent.match(/\{[\s\S]*\}/g);
        if (!jsonMatch) {
          // 尝试 Gemini 修复
          ctx.logger.warn(`[深度匹配] 未找到 JSON，尝试 Gemini 修复`);
          const repaired = await repairJsonWithGemini(responseContent, ctx);
          if (!repaired) throw new Error("未找到JSON格式响应");
          aiMatches = repaired.matches || [];
        } else {
          try {
            const parsedResponse = JSON.parse(jsonMatch[jsonMatch.length - 1]);
            aiMatches = parsedResponse.matches || [];
          } catch (parseError) {
            // JSON 截断，尝试 Gemini 修复
            ctx.logger.warn(`[深度匹配] JSON 解析失败，尝试 Gemini 修复`);
            const repaired = await repairJsonWithGemini(jsonMatch[jsonMatch.length - 1], ctx);
            if (!repaired) throw new Error("JSON解析失败");
            aiMatches = repaired.matches || [];
          }
        }
      } catch (error) {
        // 解析失败返还咕咕币
        await ctx.database.set(
          "soul_profiles",
          { id: myProfile.id },
          { coins: myProfile.coins, updatedAt: Date.now() }
        );
        return `<at id="${session.userId}"/> ❌ 匹配结果解析失败，再试一次吧！`;
      }

      if (!aiMatches || aiMatches.length === 0) {
        // 无匹配结果返还咕咕币
        await ctx.database.set(
          "soul_profiles",
          { id: myProfile.id },
          { coins: myProfile.coins, updatedAt: Date.now() }
        );
        return `<at id="${session.userId}"/> ❌ 没有找到合适的匹配，请调整期望或稍后再试~`;
      }

      // 筛选最高分最佳匹配
      const bestMatch = aiMatches.reduce((best: any, current: any) => {
        const bestScore = Math.min(best.score, 100);
        const currentScore = Math.min(current.score, 100);
        return currentScore > bestScore ? current : best;
      });

      // 找到目标候选人
      const targetProfile = validProfiles[bestMatch.candidateIndex - 1];
      if (!targetProfile) {
        await ctx.database.set(
          "soul_profiles",
          { id: myProfile.id },
          { coins: myProfile.coins, updatedAt: Date.now() }
        );
        return `<at id="${session.userId}"/> ❌ 匹配候选人不存在，请重试！`;
      }

      // 构造匹配结果消息（移除MBTI+取消回复"是"的联系逻辑）
      const matchResultMessage = `情缘匹配完成！
最佳匹配
用户ID: ${targetProfile.userId}
角色名: ${targetProfile.characterName}
匹配度: ${Math.min(bestMatch.score, 100)}%
推荐理由: ${bestMatch.analysis || "基于高级匹配算法的综合分析"}
建议互动:
${bestMatch.highlights
          ? bestMatch.highlights
            .map((h: string, i: number) => `${i + 1}. ${h}`)
            .join(";\n")
          : "建议主动分享兴趣爱好，开启轻松交流~"
        }

💡 匹配结果仅作参考，可自行联系对方进一步了解`;

      // 检查资料完整性
      let reminder = "";
      if (!myProfile.birthYear || !myProfile.location) {
        reminder = `\n\n💡 您的档案资料不完整（缺少年龄/属地），补充后可获得更精准的匹配！请使用"更新情缘档案"命令补充。`;
      }

      // 发送私聊结果（移除重试后的数据存储逻辑）
      const privateChannelId = `private:${session.userId}`;
      try {
        await session.bot?.sendMessage(privateChannelId, matchResultMessage);

        // 如果匹配对象有名片，发送名片图片
        if (targetProfile.characterImageUrl && targetProfile.characterImageUrl.length > 0) {
          const latestCard = targetProfile.characterImageUrl[targetProfile.characterImageUrl.length - 1];
          try {
            await session.bot?.sendMessage(privateChannelId, `<image url="${latestCard}" />`);
          } catch (e) {
            ctx.logger.warn(`发送高级匹配名片图片失败: ${e}`);
          }
        }

        // 记录每日使用
        await recordModelUsage(ctx, session.userId!, session.platform!, "deep_match");

        // 更新被匹配者的统计
        await updateMatchedByCount(ctx, targetProfile.userId, targetProfile.platform);
        // 记录匹配历史
        await recordMatchHistory(ctx, session.userId!, session.platform!, targetProfile.userId, targetProfile.platform, "advanced");

        // 群内发送成功提示
        await session.send(
          `<at id="${session.userId}" /> 情缘匹配结果已私聊发送给你！\n查看私信了解匹配详情，祝早日找到心仪情缘~${reminder}`
        );
      } catch (privateError) {
        ctx.logger.warn(`匹配私聊发送失败: ${privateError}`);
        // 2秒后重试
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          await session.bot?.sendMessage(privateChannelId, matchResultMessage);
          await session.send(
            `<at id="${session.userId}" /> 情缘匹配结果已私聊发送给你！\n查看私信了解匹配详情，祝早日找到心仪情缘~${reminder}`
          );
        } catch (retryError) {
          ctx.logger.error(`重试发送私聊失败: ${retryError}`);
          // 重试失败返还咕咕币
          await ctx.database.set(
            "soul_profiles",
            { id: myProfile.id },
            { coins: myProfile.coins, updatedAt: Date.now() }
          );
          return `<at id="${session.userId}" /> ❌ 匹配结果发送失败，请联系管理员处理~`;
        }
      }
    } catch (error) {
      logger.error("匹配核心逻辑失败:", error);
      // 异常返还咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins + 5, updatedAt: Date.now() }
      );
      return `<at id="${session.userId}"/> 出错啦！花费的咕咕币已经返回给你啦！（附带额外补偿5个）`;
    } finally {
      ongoingMatches.delete(matchKey);
    }
  });
  // 排除匹配命令
  ctx
    .command("排除匹配 <userId:string> [reason:string]")
    .action(async ({ session }, userId, reasonInput) => {
      if (!session || !userId) {
        return "请提供要排除的用户QQ号";
      }

      // 检查是否为私聊
      if (!session.isDirect) {
        return "排除匹配功能仅限私聊使用，请私信机器人操作";
      }

      // 获取用户档案
      const userProfiles = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });
      if (!userProfiles || userProfiles.length === 0) {
        return "你还没有创建情缘档案";
      }
      const myProfile = userProfiles[0] as SoulProfile;

      // 检查目标用户是否存在
      const targetProfiles = await ctx.database.get("soul_profiles", {
        userId,
      });
      if (!targetProfiles || targetProfiles.length === 0) {
        return "该用户尚未创建情缘档案";
      }

      // 检查是否已经排除
      const existing = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
        excludedUserId: userId,
      });

      if (existing && existing.length > 0) {
        return "该用户已在您的排除列表中";
      }

      // 计算免费排除额度
      const EXCLUSION_COST = 50; // 超出免费额度后每次50咕咕币
      const FREE_QUOTA_RATIO = 0.2; // 20%免费额度

      // 获取所有有效候选人数量（排除自己和已封存档案）
      const allProfiles = await ctx.database.get("soul_profiles", {});
      const archivedProfileIds = await getArchivedProfileIds(ctx as any);

      // 计算可匹配候选人数量（应用性别、跨服等过滤条件）
      const matchableCandidates = filterMatchableCandidates(
        myProfile,
        allProfiles,
        [],
        archivedProfileIds
      );
      const matchableCandidatesCount = matchableCandidates.length;

      // 获取当前排除列表人数
      const currentExclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const currentExclusionCount = currentExclusions.length;

      // 计算免费额度
      const freeQuota = Math.floor(matchableCandidatesCount * FREE_QUOTA_RATIO);
      const usedFreeQuota = Math.min(currentExclusionCount, freeQuota);
      const remainingFreeQuota = Math.max(0, freeQuota - currentExclusionCount);

      // 判断是否需要付费
      let needPayment = remainingFreeQuota <= 0;
      let deductedCoins = 0;

      if (needPayment) {
        // 检查咕咕币是否足够
        if (myProfile.coins < EXCLUSION_COST) {
          return `❌ 免费排除额度已用完（${freeQuota}/${freeQuota}）\n` +
            `继续排除需要 ${EXCLUSION_COST} 咕咕币，你当前只有 ${myProfile.coins} 咕咕币\n` +
            `💡 提示：使用「重置排除列表」可重新获得免费额度`;
        }

        // 扣除咕咕币
        await ctx.database.set(
          "soul_profiles",
          { userId: session.userId!, platform: session.platform! },
          { coins: myProfile.coins - EXCLUSION_COST, updatedAt: Date.now() }
        );
        deductedCoins = EXCLUSION_COST;
      }

      // 解析理由
      const reasonsMap: Record<string | number, string> = {
        1: "被拒绝",
        2: "拒绝",
        3: "不合适",
        被拒绝: "被拒绝",
        拒绝: "拒绝",
        不合适: "不合适",
      };

      let reason = "";
      if (reasonInput !== undefined) {
        let reasonKey: string | number = reasonInput;
        // 如果传进来的是字符串并且看起来是数字，尝试转换成数字
        if (typeof reasonInput === "string") {
          const trimmed = reasonInput.trim();
          const asNum = Number(trimmed);
          if (!Number.isNaN(asNum) && Number.isInteger(asNum)) {
            reasonKey = asNum;
          }
        }
        reason = reasonsMap[reasonKey as any] || reasonInput;
      }

      // 添加排除记录
      await ctx.database.create("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
        excludedUserId: userId,
        reason: reason,
        createdAt: Date.now(),
      });

      // 构建响应消息
      const newExclusionCount = currentExclusionCount + 1;
      const newRemainingFree = Math.max(0, freeQuota - newExclusionCount);

      if (needPayment) {
        return `✅ 已将用户 ${userId} 加入排除列表\n` +
          `原因：${reason || "未提供理由"}\n` +
          `💰 消耗 ${deductedCoins} 咕咕币，剩余 ${myProfile.coins - deductedCoins} 咕咕币\n` +
          `📊 排除额度：${newExclusionCount} 人（免费额度已用完）`;
      } else {
        return `✅ 已将用户 ${userId} 加入排除列表（免费）\n` +
          `原因：${reason || "未提供理由"}\n` +
          `📊 免费额度：${newExclusionCount}/${freeQuota}（剩余 ${newRemainingFree} 次免费）`;
      }
    });

  // 取消排除命令
  ctx
    .command("取消排除 <userId:string>")
    .alias("取消拉黑")
    .action(async ({ session }, userId) => {
      if (!session || !userId) {
        return "请提供要取消排除的用户QQ号";
      }

      // 检查是否为私聊
      if (!session.isDirect) {
        return "排除匹配功能仅限私聊使用，请私信机器人操作";
      }

      // 删除排除记录
      const result = await ctx.database.remove("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
        excludedUserId: userId,
      });

      if (result) {
        return `✅ 已将用户 ${userId} 从排除列表中移除`;
      } else {
        return "该用户不在您的排除列表中";
      }
    });

  // 查看排除列表命令
  ctx
    .command("查看排除列表")
    .alias("我的黑名单")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查是否为私聊
      if (!session.isDirect) {
        return "排除匹配功能仅限私聊使用，请私信机器人操作";
      }

      const exclusions = await ctx.database.get("soul_exclusions", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (!exclusions || exclusions.length === 0) {
        return "您的排除列表为空";
      }

      let message = "📋 您的排除列表：\n";
      for (const exclusion of exclusions) {
        message += `用户ID： ${exclusion.excludedUserId}`;
        if (exclusion.reason) {
          message += ` - ${exclusion.reason}`;
        }
        message += "\n============\n";
      }
      message += `\n共 ${exclusions.length} 人`;

      return message;
    });

  // 谁排除了我 - 查看谁把我加入了排除列表
  ctx
    .command("谁排除了我")
    .alias("谁拉黑了我")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查是否为私聊
      if (!session.isDirect) {
        return "此命令仅限私聊使用，请私信机器人操作";
      }

      const reverseExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: session.userId!,
      });

      if (!reverseExclusions || reverseExclusions.length === 0) {
        return "✅ 目前没有人将你加入排除列表";
      }

      let message = "📋 以下用户将你加入了排除列表：\n";
      for (const exclusion of reverseExclusions) {
        message += `用户ID：${exclusion.userId}\n`;
      }
      message += `\n共 ${reverseExclusions.length} 人`;
      message += `\n\n💡 被排除后，对方无法匹配到你，你也无法匹配到对方`;

      return message;
    });

  // 管理员查看指定用户的排除列表（双向）
  ctx
    .command("查看用户排除列表 <userId:string>")
    .action(async ({ session }, userId) => {
      if (!session) return;
      if (!isAdminUserId(session.userId!)) {
        return "❌ 此命令仅管理员可用";
      }
      if (!userId) {
        return "请提供要查询的用户QQ号，例如：查看用户排除列表 123456";
      }

      // 查询该用户主动排除了谁
      const activeExclusions = await ctx.database.get("soul_exclusions", {
        userId,
      });

      // 查询谁排除了该用户
      const passiveExclusions = await ctx.database.get("soul_exclusions", {
        excludedUserId: userId,
      });

      if (activeExclusions.length === 0 && passiveExclusions.length === 0) {
        return `用户 ${userId} 没有任何排除记录`;
      }

      let message = `📋 用户 ${userId} 的排除列表：\n`;

      if (activeExclusions.length > 0) {
        message += `\n━━━ 主动排除（${activeExclusions.length}人）━━━\n`;
        for (const e of activeExclusions) {
          message += `→ ${e.excludedUserId}`;
          if (e.reason) message += ` | 原因：${e.reason}`;
          message += `\n`;
        }
      }

      if (passiveExclusions.length > 0) {
        message += `\n━━━ 被排除（${passiveExclusions.length}人）━━━\n`;
        for (const e of passiveExclusions) {
          message += `← ${e.userId}`;
          if (e.reason) message += ` | 原因：${e.reason}`;
          message += `\n`;
        }
      }

      message += `\n📊 总计：主动排除 ${activeExclusions.length} 人，被排除 ${passiveExclusions.length} 人`;

      // 查询单相思状态
      const userWhitelist = await ctx.database.get("soul_match_whitelist", {
        userId,
        defaultExclude: true,
      });
      if (userWhitelist.length > 0) {
        const target = userWhitelist[0].whitelistedUserId;
        const setTime = new Date(userWhitelist[0].createdAt).toLocaleString();
        message += `\n\n💘 单相思状态：已开启\n目标：${target}\n设置时间：${setTime}`;
      } else {
        message += `\n\n💘 单相思状态：未开启`;
      }

      return message;
    });

  // 单相思 - 锁定匹配目标，只能匹配到指定的人
  ctx
    .command("单相思 <targetUserId:string>")
    .alias("锁定匹配")
    .action(async ({ session }, targetUserId) => {
      if (!session) return;
      if (!session.isDirect) {
        return "此命令仅限私聊使用，请私信机器人操作";
      }
      if (!targetUserId) {
        return "请提供目标用户QQ号，例如：单相思 123456";
      }

      const COST = 500;

      // 检查自己是否有档案
      const myProfiles = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });
      if (!myProfiles || myProfiles.length === 0) {
        return "❌ 你还没有创建情缘档案";
      }
      const myProfile = myProfiles[0] as SoulProfile;

      // 不能单相思自己
      if (targetUserId === session.userId) {
        return "❌ 不能对自己单相思哦";
      }

      // 检查目标用户是否有档案
      const targetProfiles = await ctx.database.get("soul_profiles", {
        userId: targetUserId,
      });
      if (!targetProfiles || targetProfiles.length === 0) {
        return "❌ 目标用户还没有创建情缘档案";
      }
      const targetProfile = targetProfiles[0] as SoulProfile;

      // 基础匹配规则校验（防止恶意/无效单相思）
      // 性别双向检查
      if (
        myProfile.preferGender !== "不限" &&
        myProfile.preferGender !== "都可以" &&
        targetProfile.gender !== myProfile.preferGender
      ) {
        return `❌ 无法单相思：你期待的性别是「${myProfile.preferGender}」，但对方是「${targetProfile.gender}」`;
      }
      if (
        targetProfile.preferGender !== "不限" &&
        targetProfile.preferGender !== "都可以" &&
        myProfile.gender !== targetProfile.preferGender
      ) {
        return `❌ 无法单相思：对方期待的性别是「${targetProfile.preferGender}」，但你是「${myProfile.gender}」`;
      }

      // 涉三态度一致性检查
      if (myProfile.realMeetup !== targetProfile.realMeetup) {
        return `❌ 无法单相思：你的涉三态度是「${myProfile.realMeetup}」，对方是「${targetProfile.realMeetup}」`;
      }

      // 服务器/跨服检查
      const myServers = myProfile.servers.split(/\s+/);
      const targetServers = targetProfile.servers.split(/\s+/);
      const sameServer = myServers.some((s) => targetServers.includes(s));
      if (!sameServer) {
        if (myProfile.crossServer === "否" || targetProfile.crossServer === "否") {
          return `❌ 无法单相思：不同服且${myProfile.crossServer === "否" ? "你" : "对方"}不接受跨服`;
        }
      }

      // 检查是否已经设置了单相思
      const existing = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
      });
      if (existing.length > 0) {
        const existingTarget = existing[0].whitelistedUserId;
        if (existingTarget === targetUserId) {
          return `你已经在单相思 ${targetUserId} 了`;
        }
        return `你当前已在单相思 ${existingTarget}，请先使用「取消单相思」后再设置新目标`;
      }

      // 检查咕咕币
      if (myProfile.coins < COST) {
        return `❌ 开启单相思需要 ${COST} 咕咕币\n当前余额：${myProfile.coins} 咕咕币`;
      }

      // 扣除咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins - COST, updatedAt: Date.now() }
      );

      // 创建白名单记录
      await ctx.database.create("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
        whitelistedUserId: targetUserId,
        defaultExclude: true,
        createdAt: Date.now(),
      });

      const targetName = targetProfiles[0].characterName || targetUserId;
      return `💘 单相思模式已开启！\n` +
        `目标：${targetName}（${targetUserId}）\n` +
        `💰 消耗 ${COST} 咕咕币，剩余 ${myProfile.coins - COST}\n\n` +
        `📌 效果：匹配时只会匹配到 TA\n` +
        `💡 使用「取消单相思」可解除`;
    });

  // 取消单相思
  ctx
    .command("取消单相思")
    .alias("解除锁定匹配")
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) {
        return "此命令仅限私聊使用，请私信机器人操作";
      }

      const existing = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (existing.length === 0) {
        return "你当前没有开启单相思模式";
      }

      const targetUserId = existing[0].whitelistedUserId;

      // 删除白名单记录
      await ctx.database.remove("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
      });

      return `✅ 已取消单相思 ${targetUserId}\n匹配已恢复正常模式`;
    });

  // 我的单相思 - 查询当前单相思状态
  ctx
    .command("我的单相思")
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) {
        return "此命令仅限私聊使用，请私信机器人操作";
      }

      const whitelist = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (whitelist.length === 0) {
        return "💔 你当前没有开启单相思模式";
      }

      const entry = whitelist[0];
      const targetProfiles = await ctx.database.get("soul_profiles", {
        userId: entry.whitelistedUserId,
      });
      const targetName = targetProfiles.length > 0
        ? targetProfiles[0].characterName || entry.whitelistedUserId
        : entry.whitelistedUserId;
      const setTime = new Date(entry.createdAt).toLocaleString();

      return `💘 单相思状态\n` +
        `目标：${targetName}（${entry.whitelistedUserId}）\n` +
        `设置时间：${setTime}\n\n` +
        `📌 效果：匹配时只会匹配到 TA\n` +
        `💡 使用「取消单相思」可解除`;
    });

  // 谁匹配到了我（单次查询 50咕咕币）
  ctx
    .command("谁匹配到了我")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查是否为私聊
      if (!session.isDirect) {
        return "❌ 此命令仅限私聊使用，请私信机器人操作";
      }

      // 获取用户档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        return "❌ 你还没有创建情缘档案";
      }
      const myProfile = profiles[0] as SoulProfile;

      const QUERY_COST = 50;

      // 检查咕咕币是否足够
      if (myProfile.coins < QUERY_COST) {
        return `❌ 咕咕币不足！查询一条记录需要${QUERY_COST}咕咕币\n当前余额：${myProfile.coins}咕咕币`;
      }

      // 查询匹配历史
      const history = await ctx.database
        .select("soul_match_history")
        .where({ matchedId: session.userId!, matchedPlatform: session.platform! })
        .orderBy("createdAt", "desc")
        .limit(1)
        .execute();

      if (history.length === 0) {
        return "🔍 暂时还没有人匹配到过你~\n（咕咕币未扣除）";
      }

      // 扣除咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins - QUERY_COST, updatedAt: Date.now() }
      );

      // 查询匹配者的档案
      const record = history[0];
      const matcherProfiles = await ctx.database.get("soul_profiles", {
        userId: record.matcherId,
        platform: record.matcherPlatform,
      });

      const matchTime = new Date(record.createdAt).toLocaleString("zh-CN");

      if (matcherProfiles.length > 0) {
        const matcher = matcherProfiles[0];
        return (
          `🔍 查询到1条匹配记录（消耗${QUERY_COST}咕咕币）\n` +
          `━━━━━━━━━━━\n` +
          `👤 ${matcher.characterName}\n` +
          `🆔 ${matcher.userId}\n` +
          `⏰ ${matchTime}\n` +
          `━━━━━━━━━━━\n` +
          `💰 剩余咕咕币：${myProfile.coins - QUERY_COST}`
        );
      } else {
        return (
          `🔍 查询到1条匹配记录（消耗${QUERY_COST}咕咕币）\n` +
          `━━━━━━━━━━━\n` +
          `❌ 用户 ${record.matcherId} (已离开)\n` +
          `⏰ ${matchTime}\n` +
          `━━━━━━━━━━━\n` +
          `💰 剩余咕咕币：${myProfile.coins - QUERY_COST}`
        );
      }
    });

  // 谁匹配到了我.特惠（5次查询 200咕咕币）
  ctx
    .command("谁匹配到了我.特惠")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查是否为私聊
      if (!session.isDirect) {
        return "❌ 此命令仅限私聊使用，请私信机器人操作";
      }

      // 获取用户档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });
      if (!profiles || profiles.length === 0) {
        return "❌ 你还没有创建情缘档案";
      }
      const myProfile = profiles[0] as SoulProfile;

      const QUERY_COST = 200;

      // 检查咕咕币是否足够
      if (myProfile.coins < QUERY_COST) {
        return `❌ 咕咕币不足！特惠查询5条记录需要${QUERY_COST}咕咕币\n当前余额：${myProfile.coins}咕咕币\n💡 使用"谁匹配到了我"可查询1条（50咕咕币）`;
      }

      // 查询最近5条匹配历史
      const history = await ctx.database
        .select("soul_match_history")
        .where({ matchedId: session.userId!, matchedPlatform: session.platform! })
        .orderBy("createdAt", "desc")
        .limit(5)
        .execute();

      if (history.length === 0) {
        return "🔍 暂时还没有人匹配到过你~\n（咕咕币未扣除）";
      }

      // 扣除咕咕币
      await ctx.database.set(
        "soul_profiles",
        { id: myProfile.id },
        { coins: myProfile.coins - QUERY_COST, updatedAt: Date.now() }
      );

      // 合并重复用户
      const userMap = new Map<string, { profile: SoulProfile | null; times: string[]; count: number }>();

      for (const record of history) {
        const key = `${record.matcherId}-${record.matcherPlatform}`;
        const matchTime = new Date(record.createdAt).toLocaleString("zh-CN");

        if (userMap.has(key)) {
          const entry = userMap.get(key)!;
          entry.times.push(matchTime);
          entry.count++;
        } else {
          // 查询匹配者档案
          const matcherProfiles = await ctx.database.get("soul_profiles", {
            userId: record.matcherId,
            platform: record.matcherPlatform,
          });
          userMap.set(key, {
            profile: matcherProfiles.length > 0 ? matcherProfiles[0] : null,
            times: [matchTime],
            count: 1,
          });
        }
      }

      // 构造返回消息
      let message = `🔍 查询到${history.length}条匹配记录（消耗${QUERY_COST}咕咕币）\n`;
      message += `👥 来自${userMap.size}位用户：\n`;
      message += `━━━━━━━━━━━\n`;

      for (const [key, data] of userMap.entries()) {
        const userId = key.split("-")[0];
        if (data.profile) {
          message += `👤 ${data.profile.characterName}`;
        } else {
          message += `❌ 用户 ${userId} (已离开)`;
        }
        if (data.count > 1) {
          message += ` × ${data.count}次`;
        }
        message += `\n`;
        message += `🆔 ${userId}\n`;
        message += `⏰ ${data.times[0]}`;
        if (data.times.length > 1) {
          message += ` 等`;
        }
        message += `\n━━━━━━━━━━━\n`;
      }

      message += `💰 剩余咕咕币：${myProfile.coins - QUERY_COST}`;

      return message;
    });

  logger.info("情缘匹配组件已经加载成功");
}

/**
 * 更新匹配统计信息
 * @param ctx 上下文
 * @param matchStatsKey 用户标识
 * @param currentMatchCount 当前匹配次数（用于保底计算，可被重置）
 * @param bonusProbability 保底概率
 */
async function updateMatchStats(
  ctx: Context,
  matchStatsKey: { userId: string; platform: string },
  currentMatchCount: number,
  bonusProbability: number = 0
) {
  const existingStats = await ctx.database.get(
    "soul_match_stats",
    matchStatsKey
  );

  if (existingStats.length > 0) {
    const current = existingStats[0] as any;
    await ctx.database.set("soul_match_stats", matchStatsKey, {
      matchCount: currentMatchCount,
      totalMatchCount: (current.totalMatchCount || 0) + 1, // 永久统计，始终+1
      lastMatchAt: Date.now(),
      bonusProbability: bonusProbability,
    });
  } else {
    await ctx.database.create("soul_match_stats", {
      ...matchStatsKey,
      matchCount: currentMatchCount,
      totalMatchCount: 1, // 首次匹配
      matchedByCount: 0,
      lastMatchAt: Date.now(),
      bonusProbability: bonusProbability,
    });
  }
}

// 更新被匹配者的统计
async function updateMatchedByCount(
  ctx: Context,
  targetUserId: string,
  targetPlatform: string
) {
  const targetStatsKey = { userId: targetUserId, platform: targetPlatform };
  const existingStats = await ctx.database.get("soul_match_stats", targetStatsKey);

  if (existingStats.length > 0) {
    const current = existingStats[0] as any;
    await ctx.database.set("soul_match_stats", targetStatsKey, {
      matchedByCount: (current.matchedByCount || 0) + 1,
    });
  } else {
    await ctx.database.create("soul_match_stats", {
      ...targetStatsKey,
      matchCount: 0,
      matchedByCount: 1,
      lastMatchAt: 0,
      bonusProbability: 0,
    });
  }
}

// 记录匹配历史（谁匹配到了谁）
async function recordMatchHistory(
  ctx: Context,
  matcherId: string,
  matcherPlatform: string,
  matchedId: string,
  matchedPlatform: string,
  matchType: "normal" | "advanced" | "bonus" | "directed"
) {
  try {
    await ctx.database.create("soul_match_history", {
      matcherId,
      matchedId,
      matcherPlatform,
      matchedPlatform,
      matchType,
      createdAt: Date.now(),
    });
    ctx.logger.info(`匹配历史已记录: ${matcherId} -> ${matchedId} (${matchType})`);
  } catch (error) {
    ctx.logger.warn(`记录匹配历史失败: ${error}`);
  }
}

