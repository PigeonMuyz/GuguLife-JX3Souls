import { Context } from "koishi";
import { getTodayDateString } from "./universal";
import axios from "axios";

/**
 * 玄机子 - 算命助手系统提示词
 */
const FORTUNE_SYSTEM_PROMPT = `【角色设定】
你现在是一位名为"玄机子"的现代命理与心理学大师。你精通东方易经八字、风水、周易占卜，同时也了解西方塔罗牌和占星术。你不仅拥有深厚的玄学理论基础，更懂得运用心理学进行安抚与疏导。你的存在是为了给迷茫的人提供情绪价值、生活灵感和人生指引。

【排版与输出严格限制】
1. 纯文本输出：由于用户将在QQ上阅读你的消息，系统不支持任何Markdown语法。你绝对不能使用星号（*）、井号（#）等符号来进行加粗或做标题。
2. 视觉优化：请多使用空格、回车换行来区分段落。可以适度使用 Emoji（如 🔮、✨、🎐、📜）来代替标题符号，让文字看起来舒适整洁。

【沟通风格】
1. 语气：温和、从容、充满智慧与神秘感，如同看透世事但依然热爱生活的老者。
2. 语言特色：适度使用玄学词汇（如：流年、星象、气场、五行、因果、磁场），并善于将其转化为现代人能听懂的白话和心理学解释。
3. 态度：始终保持客观、中立且积极向上。你深信"命由天定，运由己造"。

【核心原则】
1. 不铁口直断：绝不给出"绝对发生"或"绝对不发生"的结论。多使用"近期气场偏向于…"、"从星象/牌面来看，可能会出现…"等模糊但有方向感的句式。
2. 红线规避：绝不提供具体的医疗诊断、生死预测、具体的股票/投资建议。如遇此类问题，必须温和提醒求测者寻求专业人士帮助。
3. 积极引导：无论算出的结果是好是坏，最终必须给出积极的建议，告诉用户如何通过自身努力、心态调整来"趋吉避凶"。

【工作流程】
当接收到用户的测算请求时，请按以下步骤生成回复：

🔮 第一步：破冰与安抚 (50字左右)
用一句充满哲理或温暖的话语开场，接纳用户的情绪，建立连接。

🎐 第二步：命理与气场解析 (150字左右)
运用玄学知识进行初步解读。指出他们目前面临的核心矛盾、性格特质或隐藏优势。

🧭 第三步：流年运势预测 (150字左右)
针对用户关心的问题给出近期发展趋势。给出具有时间节点的模糊范围（如"今年下半年"、"明年初"）。

📜 第四步：锦囊妙计 (提供2-3条建议)
用数字序号（1. 2. 3.）列出切实可行的生活、风水或心理建议。如推荐幸运色、生活方式调整等。

✨ 第五步：结语祈福 (30字左右)
用一句优美、有力量的祈福语结束对话。`;

/**
 * GuguAPI 配置（Anthropic 协议 - Claude Opus 4.6）
 */
const GUGU_API = {
    url: "http://YOUR_API_HOST:PORT/v1/messages",
    key: "YOUR_API_KEY",
};

/**
 * GuguAI002 配置（Google Beta 协议 - Gemini 3.1 Pro）
 */
const GUGU_AI002 = {
    url: "http://35.208.254.115:65530/v1beta/models/{modelsName}:generateContent",
    key: "YOUR_API_KEY",
};

/**
 * 检查用户今日是否已使用过指定模型（复用 soul_daily_model_usage 表）
 */
async function checkDailyModelLimit(
    ctx: Context,
    userId: string,
    platform: string,
    modelId: string
): Promise<boolean> {
    const today = getTodayDateString();
    const records = await ctx.database.get("soul_daily_model_usage", {
        userId,
        platform,
        modelId,
        usageDate: today,
    });
    return records.length > 0;
}

/**
 * 记录用户使用模型
 */
async function recordModelUsage(
    ctx: Context,
    userId: string,
    platform: string,
    modelId: string
): Promise<void> {
    const today = getTodayDateString();
    try {
        await ctx.database.create("soul_daily_model_usage", {
            userId,
            platform,
            modelId,
            usageDate: today,
            createdAt: Date.now(),
        });
    } catch (e) {
        // 唯一约束冲突，忽略
    }
}

/**
 * 调用 Anthropic 流式 API（Claude）
 */
async function callAnthropicStream(
    apiUrl: string,
    requestData: any,
    accessToken: string,
    timeout: number = 300000
): Promise<string> {
    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": accessToken,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...requestData, stream: true }),
        signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";

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
                        } else if (data.type === "content_block_start" && data.content_block?.text) {
                            result += data.content_block.text;
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    }

    // 处理缓冲区中剩余的内容
    const remainingLine = buffer.trim();
    if (remainingLine.startsWith("data:")) {
        const jsonStr = remainingLine.slice(5).trim();
        if (jsonStr && jsonStr !== "[DONE]") {
            try {
                const data = JSON.parse(jsonStr);
                if (data.type === "content_block_delta" && data.delta?.text) {
                    result += data.delta.text;
                } else if (data.delta?.text) {
                    result += data.delta.text;
                } else if (data.choices?.[0]?.delta?.content) {
                    result += data.choices[0].delta.content;
                }
            } catch (e) {
                // 忽略
            }
        }
    }

    if (!result) {
        throw new Error("Anthropic streaming returned empty result");
    }

    return result;
}

/**
 * 调用 Gemini 3.1 Pro（Google Beta 协议）
 */
async function callGemini(
    userMessage: string,
    timeout: number = 300000
): Promise<string> {
    const apiUrl = GUGU_AI002.url.replace("{modelsName}", "gemini-3.1-pro-high");

    const requestData = {
        contents: [
            {
                role: "user",
                parts: [{ text: userMessage }],
            },
        ],
        systemInstruction: {
            parts: [{ text: FORTUNE_SYSTEM_PROMPT }],
        },
        generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 4000,
        },
    };

    const response = await axios.post(apiUrl, requestData, {
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GUGU_AI002.key,
        },
        timeout,
    });

    const aiResponse = response.data.candidates[0].content.parts[0].text;
    if (!aiResponse) {
        throw new Error("Gemini returned empty result");
    }
    return aiResponse;
}

/**
 * 调用 Claude Opus 4.6（Anthropic 流式协议）
 */
async function callOpus(
    userMessage: string,
    timeout: number = 300000
): Promise<string> {
    const requestData = {
        model: "claude-opus-4-6-thinking",
        system: FORTUNE_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: userMessage,
            },
        ],
        max_tokens: 4000,
        thinking: { type: "enabled" },
    };

    return await callAnthropicStream(GUGU_API.url, requestData, GUGU_API.key, timeout);
}

/**
 * 算命 AI 调用核心函数
 * 优先使用 Opus 4.6（每日限1次），降级使用 Gemini 3.1 Pro
 */
async function callFortune(
    ctx: Context,
    userId: string,
    platform: string,
    userMessage: string
): Promise<{ response: string; modelName: string }> {
    const OPUS_MODEL_ID = "claude-opus-4-6-thinking";
    const opusUsed = await checkDailyModelLimit(ctx, userId, platform, OPUS_MODEL_ID);

    if (!opusUsed) {
        // 优先使用 Opus 4.6
        try {
            ctx.logger.info(`[算命] 用户 ${userId} 使用 Claude Opus 4.6`);
            await recordModelUsage(ctx, userId, platform, OPUS_MODEL_ID);
            const response = await callOpus(userMessage);
            return { response, modelName: "Claude Opus 4.6" };
        } catch (error) {
            ctx.logger.error(`[算命] Claude Opus 4.6 调用失败: ${error.message}`);
            // 降级到 Gemini
        }
    } else {
        ctx.logger.info(`[算命] 用户 ${userId} 今日已使用 Opus，降级到 Gemini 3.1 Pro`);
    }

    // 降级到 Gemini 3.1 Pro
    try {
        ctx.logger.info(`[算命] 用户 ${userId} 使用 Gemini 3.1 Pro`);
        const response = await callGemini(userMessage);
        return { response, modelName: "Gemini 3.1 Pro" };
    } catch (error) {
        ctx.logger.error(`[算命] Gemini 3.1 Pro 调用失败: ${error.message}`);
        throw new Error("所有算命模型均调用失败，请稍后再试");
    }
}

export { callFortune, FORTUNE_SYSTEM_PROMPT };
