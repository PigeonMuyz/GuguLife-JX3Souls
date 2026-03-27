import { Context } from "koishi";
import { SoulProfile } from "../types";
import axios from "axios";

// ModelScope 千问3.5 配置
const MODELSCOPE_URL = "https://api-inference.modelscope.cn/v1/chat/completions";
const MODELSCOPE_TOKEN = "YOUR_MODELSCOPE_TOKEN";
const MODELSCOPE_MODEL = "Qwen/Qwen3.5-397B-A17B";

const FORTUNE_COST = 30;

// 每日限制追踪（内存Map）
const dailyFortuneMap = new Map<string, string>(); // userId -> dateString

function getTodayStr(): string {
    return new Date().toISOString().split("T")[0];
}

/**
 * 调用千问3.5生成缘分签
 */
async function generateFortune(profile: SoulProfile): Promise<string> {
    const prompt = `你是剑网3情缘匹配系统的"月老"。请为以下用户生成一个有趣的今日缘分签。

用户信息：
- 角色名：${profile.characterName}
- 服务器：${profile.servers}
- 角色类型：${profile.characterTypes}
- 玩法：${profile.gameplay}
- 性别：${profile.gender}

请生成以下内容（直接输出文字，不要用JSON）：
1. 运势等级：从「大吉、吉、中吉、小吉、末吉、凶」中选一个
2. 缘分寄语：一句富有诗意或趣味的话（和剑网3或情缘相关）
3. 今日建议：一条具体的匹配/社交建议
4. 幸运数字：1-99之间的一个数字
5. 幸运心法/门派：从以下门派中随机选一个：天策、七秀、藏剑、纯阳、少林、五毒、霸刀、刀宗、北天药宗、蓬莱、段氏、衍天宗、万灵、凌雪阁、长歌、苍云、明教、丐帮、唐门、万花

格式如下：
🔮 运势：XXX
📜 寄语：XXX
💡 建议：XXX
🔢 幸运数字：XX
⚔️ 幸运心法：XXX

注意：内容要有趣、活泼，带点调皮，符合游戏社交场景。不要太严肃。
严禁在生成内容中直接或间接提及、引用用户的个人期待或择偶偏好。`;

    try {
        const response = await axios.post(
            MODELSCOPE_URL,
            {
                model: MODELSCOPE_MODEL,
                messages: [
                    { role: "user", content: prompt },
                ],
                max_tokens: 500,
                temperature: 1.0,
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
        throw new Error(`AI生成失败: ${error.message}`);
    }
}

/**
 * 注册缘分签命令
 */
export function registerFortuneCommands(ctx: Context) {
    ctx
        .command("抽缘分签")
        .alias("今日运势")
        .alias("缘分签")
        .action(async ({ session }) => {
            if (!session) return;

            // 检查档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId!,
                platform: session.platform!,
            });
            if (!profiles || profiles.length === 0) {
                return '❌ 你还没有档案，请先使用"登记档案"创建';
            }
            const profile = profiles[0] as SoulProfile;

            // 检查每日限制
            const userKey = `${session.userId}-${session.platform}`;
            const today = getTodayStr();
            if (dailyFortuneMap.get(userKey) === today) {
                return "🔮 今天已经抽过缘分签了，明天再来吧~";
            }

            // 检查咕咕币
            if (profile.coins < FORTUNE_COST) {
                return `❌ 咕咕币不足！抽缘分签需要 ${FORTUNE_COST} 咕咕币\n当前余额：${profile.coins} 咕咕币`;
            }

            // 扣除咕咕币
            await ctx.database.set(
                "soul_profiles",
                { userId: session.userId!, platform: session.platform! },
                { coins: profile.coins - FORTUNE_COST }
            );

            // 标记今日已抽
            dailyFortuneMap.set(userKey, today);

            try {
                await session.send("正在生成你的今日缘分签...");

                const fortune = await generateFortune(profile);

                return `🎋 ${profile.characterName} 的今日缘分签\n━━━━━━━━━━━━━━━━\n\n${fortune}\n\n━━━━━━━━━━━━━━━━\n💰 消耗 ${FORTUNE_COST} 咕咕币，剩余 ${profile.coins - FORTUNE_COST}`;
            } catch (error: any) {
                // 生成失败，退还咕咕币和每日限制
                await ctx.database.set(
                    "soul_profiles",
                    { userId: session.userId!, platform: session.platform! },
                    { coins: profile.coins }
                );
                dailyFortuneMap.delete(userKey);

                ctx.logger.error("缘分签生成失败:", error);
                return `❌ 出错了...请稍后再试\n（已退还 ${FORTUNE_COST} 咕咕币）`;
            }
        });
}
