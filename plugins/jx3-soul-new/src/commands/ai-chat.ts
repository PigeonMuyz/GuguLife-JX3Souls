import { Context, Session } from "koishi";
import { SoulProfile, AIRequestData } from "../types";
import { safeSendMessage } from "../utils/universal";
import axios from "axios";

// 常量配置
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5分钟无活动超时
const ADMIN_ID = "YOUR_ADMIN_QQ_1"; // 违规通知的管理员

const MAX_TURNS = 15; // 每 15 轮总结
const MAX_TOKENS_THRESHOLD = 100000; // 100K Token 时总结

// 模型配置
const MODELS = {
    "1": {
        id: "claude-opus-4-6-thinking",
        name: "Claude Opus 4.6",
        provider: "GuguAPI",
        url: "http://35.208.254.115:65530/v1/messages",
        key: "YOUR_API_KEY",
        costPerM: 200, // 200 咕咕币 / 1M Tokens
    },
    "2": {
        id: "gemini-3.1-pro-high",
        name: "Gemini 3.1 Pro",
        provider: "GuguAPI",
        url: "http://35.208.254.115:65530/v1/messages",
        key: "YOUR_API_KEY",
        costPerM: 100, // 100 咕咕币 / 1M Tokens
    },
};

// 系统预设 Prompt（要求模型自行拒答 NSFW 且回复特定前缀）
const SYSTEM_PROMPT = `你是一个博学、幽默且友好的 AI 助手，负责与用户进行畅快的交流。
【严格约束规则】：
1. 你的回答直接展示给用户，绝对禁止使用 Markdown 语法（包括粗体、斜体、列表、代码块等），请使用换行、空格和 emoji 符号（如 ✨、💡）来排版。
2. 你必须严格遵循内容安全底线。如果用户的输入含有或试图引导你输出：色情、裸露、性暗示、血腥暴力、自残、违法犯罪、政治敏感等不当内容，你必须立即停止正常的对话回复。
3. 当且仅当触发上一条的安全底线时，你的回复必须且只能以大写的【NSFW拦截】开头，后接你拒绝回答的简短原因。其余任何情况下，正常回答，绝对不要包含这个前缀。`;

// 估算输入 Token (简单字符数 / 1.5 + 上下文)
function estimateTokens(text: string, contextTokens: number): number {
    return Math.ceil(text.length / 1.5) + contextTokens + 500; // 预留 500 个输出 Token
}

// 向上取整的计费（不足 1 咕咕币按 1 算）
function calculateCost(tokens: number, costPerM: number): number {
    if (tokens <= 0) return 0;
    const cost = (tokens / 1_000_000) * costPerM;
    return Math.max(1, Math.ceil(cost));
}

// 缓存免计费的换算
function calculateActualBilledTokens(usage: any): { billed: number; total: number; cached: number } {
    if (!usage) return { billed: 1000, total: 1000, cached: 0 };

    // Anthropic: input_tokens, output_tokens. cache_creation_input_tokens, cache_read_input_tokens
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cached = usage.cache_read_input_tokens || 0;
    const total = inputTokens + outputTokens + cached;

    // billed tokens 是总消耗减去命中的缓存消耗
    const billed = Math.max(0, total - cached);
    return { billed, total, cached };
}

// 会话接口
interface AiChatSession {
    userId: string;
    platform: string;
    messages: { role: string; content: string }[];
    modelKey: "1" | "2";
    state: "SELECT_MODEL" | "CHATTING";
    totalBilledTokens: number;
    totalCachedTokens: number;
    totalCost: number;
    turns: number;
    latestContextTokens: number;  // 记录最近一轮计算后的累计预估token
    lastActivity: number;
    timeoutTimer?: NodeJS.Timeout;
    isReplying?: boolean; // 正在回复标记，防打断冲突
    customPrompt?: string; // 临时记录当次对话使用的人设
}

const activeAiSessions = new Map<string, AiChatSession>();

/**
 * Anthropic 流式调用改造（支持多轮对话）
 */
async function callAnthropicMessages(
    apiUrl: string,
    apiKey: string,
    modelId: string,
    messages: any[],
    customPrompt: string = ""
): Promise<{ text: string; usage: any }> {
    const finalSystemPrompt = SYSTEM_PROMPT + (customPrompt ? `\n\n【当前应用人设】：\n${customPrompt}` : "");
    const requestData = {
        model: modelId,
        system: finalSystemPrompt,
        messages: messages,
        max_tokens: 4000,
        stream: true,
    };

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestData),
        signal: AbortSignal.timeout(180000), // 3分钟超时
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API Error: ${response.status} - ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    let usageData: any = {};

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith("event:")) continue;

            if (line.startsWith("data:")) {
                const jsonStr = line.slice(5).trim();
                if (jsonStr && jsonStr !== "[DONE]") {
                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.type === "content_block_delta" && data.delta?.text) {
                            result += data.delta.text;
                        } else if (data.delta?.text) {
                            result += data.delta.text;
                        } else if (data.choices?.[0]?.delta?.content) {
                            result += data.choices[0].delta.content;
                        } else if (data.text) {
                            result += data.text;
                        } else if (data.type === "message_start") {
                            usageData = data.message?.usage || {};
                        } else if (data.type === "message_delta" && data.usage) {
                            usageData.output_tokens = data.usage.output_tokens;
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }
        }
    }

    return { text: result.trim(), usage: usageData };
}

/**
 * 一次性总结对话，用于压缩上下文
 */
async function summarizeContext(
    modelConfig: any,
    messages: any[],
    customPrompt: string = ""
): Promise<{ text: string; usage: any }> {
    const summaryPrompt = `请仔细总结以下对话的核心内容，以备我在此基础上继续讨论。你需要保留关键的上下文信息、我们达成的一致、我提到的重要偏好等。总结请尽可能精炼。
对话记录如下：\n` + messages.map(m => `[${m.role}]: ${m.content}`).join("\n");

    const sumMsg = [{ role: "user", content: summaryPrompt }];

    return await callAnthropicMessages(modelConfig.url, modelConfig.key, modelConfig.id, sumMsg, customPrompt);
}

export function registerAiChatCommands(ctx: Context) {
    // 处理结束会话的方法
    async function endSession(sessionKey: string, botSession: Session, summaryTitle: string = "👋 AI 对话结束") {
        const sess = activeAiSessions.get(sessionKey);
        if (!sess) return;

        clearTimeout(sess.timeoutTimer);
        activeAiSessions.delete(sessionKey);

        // 如果在对话中且有历史记录，则自动总结上下文留下记忆
        if (sess.state === "CHATTING" && sess.messages.length > 0) {
            try {
                const modelConfig = MODELS[sess.modelKey];
                const sumResult = await summarizeContext(modelConfig, sess.messages, sess.customPrompt);

                // 将总结写入数据库档案
                const profiles = await ctx.database.get("soul_profiles", { userId: sess.userId, platform: sess.platform });
                if (profiles?.length) {
                    await ctx.database.set("soul_profiles", { id: profiles[0].id }, {
                        aiSummary: sumResult.text,
                        updatedAt: Date.now()
                    });
                }
            } catch (sumErr) {
                ctx.logger.warn(`退出时背景上下文总结失败: ${sumErr}`);
            }
        }

        let summary = `${summaryTitle}\n━━━━━━━━━━━\n`;
        summary += `对话轮次：${sess.turns}\n`;
        summary += `总计 Token：${(sess.totalBilledTokens + sess.totalCachedTokens).toLocaleString()}\n`;
        if (sess.totalCachedTokens > 0) {
            summary += `命中缓存：${sess.totalCachedTokens.toLocaleString()} (免费)\n`;
        }
        summary += `扣费 Token：${sess.totalBilledTokens.toLocaleString()}\n`;
        summary += `总计消费：${sess.totalCost} 咕咕币`;

        try {
            await safeSendMessage(ctx, `private:${sess.userId}`, summary);
        } catch (e) {
            ctx.logger.warn(`发送 AI 对话结束统计失败: ${e}`);
        }
    }

    ctx.command("/连续对话白名单 <targetId:string>")
        .usage("管理AI连续对话的免费体验白名单，格式: /连续对话白名单 添加/删除/查看 [QQ号]")
        .action(async ({ session }, targetId) => {
            if (!session) return;
            const isAdmin = ADMIN_ID === session.userId;
            if (!isAdmin) return "❌ 你没有权限执行此操作。";

            const parts = session.content?.split(/\s+/).slice(1) || [];
            if (parts.length === 0) return "格式错误，支持：添加/删除/查看 [QQ号]";

            const action = parts[0];
            const qTargetId = parts[1] || targetId;

            if (action === "查看") {
                const list = await ctx.database.get("soul_ai_whitelist", {});
                if (!list.length) return "📜 当前白名单为空。";
                return `📜 当前白名单列表（共${list.length}人）：\n` + list.map(v => `- ${v.userId}`).join("\n");
            }

            if (!qTargetId) return "❌ 请求缺少目标QQ号。";

            if (action === "添加") {
                const exist = await ctx.database.get("soul_ai_whitelist", { userId: qTargetId, platform: session.platform });
                if (exist.length) return `⚠️ ${qTargetId} 已经在白名单中了。`;
                await ctx.database.create("soul_ai_whitelist", {
                    userId: qTargetId,
                    platform: session.platform,
                    createdAt: Date.now()
                });
                return `✅ 已将 ${qTargetId} 添加至AI连续对话免流白名单！`;
            } else if (action === "删除") {
                const exist = await ctx.database.get("soul_ai_whitelist", { userId: qTargetId, platform: session.platform });
                if (!exist.length) return `⚠️ ${qTargetId} 不在白名单中。`;
                await ctx.database.remove("soul_ai_whitelist", { id: exist[0].id });
                return `✅ 已将 ${qTargetId} 从白名单中移除！`;
            }

            return "❌ 未知操作，请使用 添加/删除/查看 [QQ号]";
        });

    ctx.command("/设定 [prompt:text]")
        .alias("/提示词")
        .usage("直接设置您的专属 AI 人设提示词，用于连续对话中。")
        .action(async ({ session }, prompt) => {
            if (!session) return;
            const profiles = await ctx.database.get("soul_profiles", { userId: session.userId, platform: session.platform });
            if (!profiles?.length) return "❌ 你还没有创建情缘档案，无法设置人设。";

            const myProfile = profiles[0] as SoulProfile;

            if (!prompt) {
                return myProfile.aiPrompt ? `📜 你当前的专属 AI 人设为：\n${myProfile.aiPrompt}` : "⚠️ 你当前没有设定任何专门的 AI 人设。你可以发送 `/设定 [内容]` 来进行设定哦！";
            }

            if (prompt === "空" || prompt === "清除") {
                await ctx.database.set("soul_profiles", { id: myProfile.id }, { aiPrompt: "", updatedAt: Date.now() });
                return "✅ 已清理你的 AI 人设！下次对话将恢复默认助手性格。";
            }

            await ctx.database.set("soul_profiles", { id: myProfile.id }, { aiPrompt: prompt, updatedAt: Date.now() });

            let reply = `✅ 专属 AI 人设保存成功！`;
            const sessionKey = `${session.userId}-${session.platform}`;
            const activeSess = activeAiSessions.get(sessionKey);
            if (activeSess) {
                reply += `\n⚠️ 检测到你当前正在进行 AI 对话，如果要立即启用新人设，请发送「/新话题」哦！`;
            } else {
                reply += `\n此设定会在你下次发送「/AI对话」时自动生效。`;
            }
            return reply;
        });

    ctx
        .command("/AI对话")
        .alias("/ai对话")
        .usage("开启与大模型的连续对话")
        .action(async ({ session }) => {
            if (!session) return;
            if (!session.isDirect) return "❌ AI 对话功能仅支持私聊使用。";

            const sessionKey = `${session.userId}-${session.platform}`;
            if (activeAiSessions.has(sessionKey)) {
                return "❌ 你已经有一个正在进行的 AI 对话了，发送 /退出 可结束当前对话。";
            }

            // 检查余额与白名单特权
            const profiles = await ctx.database.get("soul_profiles", { userId: session.userId, platform: session.platform });
            if (!profiles?.length) return "❌ 你还没有创建情缘档案。";
            const myProfile = profiles[0] as SoulProfile;

            const isWhitelist = await ctx.database.get("soul_ai_whitelist", { userId: session.userId, platform: session.platform });
            const hasPrivilege = isWhitelist && isWhitelist.length > 0;

            if (!hasPrivilege && myProfile.coins < 50) return `❌ 你的余额不足 50 咕咕币，无法开启 AI 对话。当前：${myProfile.coins}`;

            const aiSession: AiChatSession = {
                userId: session.userId!,
                platform: session.platform!,
                messages: [],
                modelKey: "1", // 暂时占位
                state: "SELECT_MODEL",
                totalBilledTokens: 0,
                totalCachedTokens: 0,
                totalCost: 0,
                turns: 0,
                latestContextTokens: 0,
                lastActivity: Date.now(),
                customPrompt: myProfile.aiPrompt || "",
            };

            aiSession.timeoutTimer = setTimeout(() => {
                endSession(sessionKey, session, "⏰ 5分钟无活动，对话已超时自动总结结束！");
            }, SESSION_TIMEOUT);

            activeAiSessions.set(sessionKey, aiSession);

            let greet = `🤖 欢迎来到 AI 连续对话空间！\n`;
            if (hasPrivilege) greet += `✨ 【白名单特权】：您享有免付费畅聊！\n`;
            if (myProfile.aiPrompt) greet += `🎭 【内置人设已加载】：已注入您设定的个人专属Prompt。\n`;

            greet += `\n请回复数字选择你想使用的模型：\n[1] Claude Opus (200币/1M Tokens)\n[2] Gemini 3.1 Pro (100币/1M Tokens)\n\n(发送 /exit 随时退隐后台记录记忆并结束对话)`;
            return greet;
        });

    // 监听机器人发送的私聊消息，用以判断外部消息被动打断
    ctx.on("before-send", (session) => {
        if (!session.isDirect) return;
        const sessionKey = `${session.userId}-${session.platform}`;
        const aiSession = activeAiSessions.get(sessionKey);

        // 如果处于活跃对话中，且当前系统没有声明“这是我自己内部发出来的回复” (isReplying为false)
        if (aiSession && aiSession.state === "CHATTING" && !aiSession.isReplying) {
            // 触发自动打断并结束会话存盘
            endSession(sessionKey, session, "⚠️【AI 连接中断】\n由于系统后台发送了其他通知/业务消息，您的 AI 连续沉浸对话已被动跳出并进行结算。");
        }
    });

    // 中间件处理对话状态
    ctx.middleware(async (session, next) => {
        if (!session.isDirect || !session.content) return next();

        const sessionKey = `${session.userId}-${session.platform}`;
        const aiSession = activeAiSessions.get(sessionKey);
        if (!aiSession) return next();

        const content = session.content.trim();
        // 如果是系统预设之外的手动指令打头，一律放行走正常 Koishi 命令路由，不喂给AI
        const isSlashCommand = content.startsWith("/") || content.startsWith("\\");

        if (content === "退出" || content === "结束" || content === "/exit" || content === "/退出") {
            await endSession(sessionKey, session);
            return;
        }

        if (content === "/新话题" || content === "/new" || content === "/clear") {
            aiSession.messages = [];
            aiSession.turns = 0;
            aiSession.latestContextTokens = 0;
            await session.send("✅ 已清空当前会话的上下文缓存，开启新话题。");
            return;
        }

        if (content === "/总结") {
            if (aiSession.state !== "CHATTING") {
                await session.send("❌ 当前尚未进入对话阶段，无法总结。");
                return;
            }
            if (aiSession.messages.length === 0) {
                await session.send("❌ 当前上下文为空，无需总结。");
                return;
            }
            await session.send("♻️ 正在后台提取并总结上下文，请稍候...");
            try {
                const modelConfig = MODELS[aiSession.modelKey];
                const sumResult = await summarizeContext(modelConfig, aiSession.messages);
                const summaryText = sumResult.text;
                aiSession.messages = [
                    { role: "assistant", content: `这是过去对话的核心记忆总结：${summaryText}` }
                ];
                aiSession.latestContextTokens = 0;
                await session.send("✅ 上下文总结完成！已无缝衔接至最新语境。");
            } catch (sumErr) {
                ctx.logger.warn(`背景上下文手动总结失败: ${sumErr}`);
                await session.send(`❌ 手动总结失败: ${sumErr}`);
            }
            return;
        }

        clearTimeout(aiSession.timeoutTimer);
        aiSession.lastActivity = Date.now();
        aiSession.timeoutTimer = setTimeout(() => {
            endSession(sessionKey, session, "⏰ 5分钟无活动，对话已超时自动结束！");
        }, SESSION_TIMEOUT);

        // 如果是未注册直接在会话中的斜杠指令，我们也要放过去以便执行其他内置指令！
        if (isSlashCommand) return next();

        // 模型选择阶段
        if (aiSession.state === "SELECT_MODEL") {
            if (content === "1" || content === "2") {
                aiSession.modelKey = content;
                aiSession.state = "CHATTING";
                const modelName = MODELS[content].name;

                let intro = `✅ 已选择 ${modelName}`;
                // 读取记忆
                const profiles = await ctx.database.get("soul_profiles", { userId: session.userId, platform: session.platform });
                const aiSummary = profiles?.[0]?.aiSummary;
                if (aiSummary) {
                    aiSession.messages = [
                        { role: "assistant", content: `这是过去对话的核心记忆总结：${aiSummary}` }
                    ];
                    intro += `\n📦 已从旧档案中寻回前情记忆！`;
                }

                intro += `\n现在可以直接向我提问啦！`;
                await session.send(intro);
            } else {
                await session.send("❌ 选择无效，请回复 1 (Claude Opus) 或 2 (Gemini 3.1 Pro)。发送 /exit 关闭。");
            }
            return;
        }

        // 对话阶段
        if (aiSession.state === "CHATTING") {
            const profiles = await ctx.database.get("soul_profiles", { userId: session.userId, platform: session.platform });
            if (!profiles?.length) {
                await endSession(sessionKey, session, "❌ 找不到档案信息。");
                return;
            }
            const myProfile = profiles[0] as SoulProfile;

            // 根据上下文量进行预估，拦截余额不足
            const estimatedTokens = estimateTokens(content, aiSession.latestContextTokens);
            const estimatedCost = calculateCost(estimatedTokens, MODELS[aiSession.modelKey].costPerM);
            const isWhitelist = await ctx.database.get("soul_ai_whitelist", { userId: session.userId, platform: session.platform });
            const hasPrivilege = isWhitelist && isWhitelist.length > 0;

            if (!hasPrivilege && myProfile.coins < estimatedCost) {
                await endSession(sessionKey, session, `❌ 余额不足！本次对话预估需要至少 ${estimatedCost} 咕咕币，当前余额仅有 ${myProfile.coins}。对话已结束。`);
                return;
            }

            // 用户消息推入记录
            aiSession.messages.push({ role: "user", content });
            const modelConfig = MODELS[aiSession.modelKey];
            aiSession.isReplying = true;

            try {
                const aiResult = await callAnthropicMessages(modelConfig.url, modelConfig.key, modelConfig.id, aiSession.messages, aiSession.customPrompt);
                const { text: aiText, usage } = aiResult;

                // NSFW 拦截处理
                if (aiText.startsWith("【NSFW拦截】")) {
                    const reason = aiText.substring("【NSFW拦截】".length).trim();
                    await session.send(`🚨 ${reason} \n\n⚠️ 系统侦测到违反内容安全规范，本次会话被强制终止并已通知管理员。`);

                    // 通知管理员
                    const bot = ctx.bots.find(b => b.platform === "onebot" || b.platform === "onebot11");
                    if (bot) {
                        try {
                            await bot.sendPrivateMessage(ADMIN_ID, `🚫 AI 对话拦截警报\n用户ID: ${session.userId} \n模型: ${modelConfig.name} \n触发内容: ${content} \nAI拦截详情: ${reason} `);
                        } catch (e) {
                            ctx.logger.error("发送拦截警报给管理员失败: " + e);
                        }
                    }

                    // 立刻终止会话
                    activeAiSessions.delete(sessionKey);
                    return;
                }

                aiSession.messages.push({ role: "assistant", content: aiText });
                aiSession.turns += 1;

                // 账单计算
                const { billed, total, cached } = calculateActualBilledTokens(usage);
                const actualCost = calculateCost(billed, modelConfig.costPerM);

                aiSession.totalBilledTokens += billed;
                aiSession.totalCachedTokens += cached;
                aiSession.totalCost += actualCost;
                aiSession.latestContextTokens = total;

                // 扣费
                if (!hasPrivilege) {
                    let newCoins = myProfile.coins - actualCost;
                    if (newCoins < 0) newCoins = 0; // 保底，防止破产倒扣到底
                    await ctx.database.set("soul_profiles", { id: myProfile.id }, { coins: newCoins, updatedAt: Date.now() });
                }

                // 在结尾追加计费明细
                let reply = aiText + `\n\n━━━━━━━━━━━\n耗时: [${hasPrivilege ? '0 (白名单免单)' : actualCost} 币] | Token: ${billed.toLocaleString()} | 缓存: ${cached.toLocaleString()}`;

                // 定期总结压缩上下文
                if (aiSession.turns % MAX_TURNS === 0 || aiSession.latestContextTokens > MAX_TOKENS_THRESHOLD) {
                    reply += `\n♻️ 上下文触达阈值，已由后台自动发起总结并无缝衔接至最新语境。`;
                    await session.send(reply); // 先将此轮回复给用户

                    try {
                        const sumResult = await summarizeContext(modelConfig, aiSession.messages);
                        const summaryText = sumResult.text;
                        // 用一轮对话包裹总结内容替代之前的长度
                        aiSession.messages = [
                            { role: "assistant", content: `这是过去对话的核心记忆总结：${summaryText} ` }
                        ];
                        aiSession.latestContextTokens = 0; // 重置
                    } catch (sumErr) {
                        ctx.logger.warn(`背景上下文总结失败: ${sumErr} `);
                    }
                } else {
                    await session.send(reply);
                }

            } catch (err: any) {
                ctx.logger.error("AI 连续对话请求失败: " + err.message);
                aiSession.messages.pop(); // 发生异常时弹出用户输入
                await session.send(`❌ 请求模型失败，已撤回该条记录，请重发。(${err.message})`);
            } finally {
                aiSession.isReplying = false;
            }
        }
    });
}
