import { Context } from "koishi";
import { SoulProfile } from "../types";
import axios from "axios";

// ModelScope 千问3.5 配置
const MODELSCOPE_URL = "https://api-inference.modelscope.cn/v1/chat/completions";
const MODELSCOPE_TOKEN = "YOUR_MODELSCOPE_TOKEN";
const MODELSCOPE_MODEL = "Qwen/Qwen3.5-397B-A17B";

const SCORE_COST = 100;

/**
 * 调用千问3.5评估档案
 */
async function evaluateProfile(profile: SoulProfile): Promise<string> {
  const prompt = `你是剑网3情缘匹配系统的档案顾问。请详细评估以下用户的情缘档案，给出评分和改进建议。

用户档案：
- 角色名：${profile.characterName}
- 服务器：${profile.servers}
- 角色类型：${profile.characterTypes}
- 主要玩法：${profile.gameplay}
- 真实性别：${profile.gender}
- 期待对方：${profile.preferGender}
- 跨服：${profile.crossServer}
- 涉三：${profile.realMeetup}
- 年龄：${profile.birthYear ? `${new Date().getFullYear() - profile.birthYear}岁` : "未填写"}
- IP属地：${profile.location || "未填写"}
- 个人期待：${profile.expectations}
- 自我介绍：${profile.introduction}

请从以下几个维度评分（每项满分20分），并给出改进建议：

1. 自我介绍（20分）：长度、内容丰富度、个性化程度
2. 期待描述（20分）：是否清晰、是否合理
3. 基础信息完整度（20分）：年龄、属地、角色类型等是否齐全
4. 吸引力（20分）：档案整体是否让人想匹配
5. 真诚度（20分）：档案是否给人真实可信的感觉

请按以下格式输出（直接输出文字）：

📊 档案总评：XX/100 分

📝 各项评分：
1️⃣ 自我介绍：XX/20 - 一句话点评
2️⃣ 期待描述：XX/20 - 一句话点评
3️⃣ 信息完整度：XX/20 - 一句话点评
4️⃣ 吸引力：XX/20 - 一句话点评
5️⃣ 真诚度：XX/20 - 一句话点评

💡 改进建议（列出2-3条最重要的具体建议）：
1. XXX
2. XXX
3. XXX

注意：评分要客观公正，建议要具体可操作。语言活泼友好，不要太严肃。`;

  try {
    const response = await axios.post(
      MODELSCOPE_URL,
      {
        model: MODELSCOPE_MODEL,
        messages: [
          { role: "user", content: prompt },
        ],
        max_tokens: 1000,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${MODELSCOPE_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 360000,
      }
    );

    return response.data.choices[0].message.content;
  } catch (error: any) {
    throw new Error(`AI评估失败: ${error.message}`);
  }
}

/**
 * 注册档案评分命令
 */
export function registerProfileScoreCommands(ctx: Context) {
  ctx
    .command("评估我的档案")
    .alias("档案评分")
    .alias("评估档案")
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
      const profile = profiles[0] as SoulProfile;

      // 检查咕咕币
      if (profile.coins < SCORE_COST) {
        return `❌ 咕咕币不足！评估档案需要 ${SCORE_COST} 咕咕币\n当前余额：${profile.coins} 咕咕币`;
      }

      // 扣除咕咕币
      await ctx.database.set(
        "soul_profiles",
        { userId: session.userId!, platform: session.platform! },
        { coins: profile.coins - SCORE_COST }
      );

      try {
        await session.send("📋 正在请 AI 顾问评估你的档案...");

        const evaluation = await evaluateProfile(profile);

        return `📋 ${profile.characterName} 的档案评估报告\n━━━━━━━━━━━━━━━━\n\n${evaluation}\n\n━━━━━━━━━━━━━━━━\n💰 消耗 ${SCORE_COST} 咕咕币，剩余 ${profile.coins - SCORE_COST}`;
      } catch (error: any) {
        // 评估失败，退还咕咕币
        await ctx.database.set(
          "soul_profiles",
          { userId: session.userId!, platform: session.platform! },
          { coins: profile.coins }
        );

        ctx.logger.error("档案评估失败:", error);
        return `❌ AI 顾问暂时不在线...请稍后再试\n（已退还 ${SCORE_COST} 咕咕币）`;
      }
    });
}
