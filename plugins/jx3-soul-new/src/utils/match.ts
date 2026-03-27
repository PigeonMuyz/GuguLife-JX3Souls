import { Context } from "koishi";
import { characterTypePrompt, scoringRulesPrompt } from "../config";
import { aiConfig, AIRequestData, SoulProfile } from "../types";
import { AIProviders, formatProfileCompact, getTodayDateString } from "./universal";
import axios from "axios";

/**
 * 检查用户今日是否已使用过指定模型
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
 * 调用 Anthropic 流式 API
 */
async function callAnthropicStream(
  apiUrl: string,
  requestData: any,
  accessToken: string,
  timeout: number = 1200000
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
    // 处理 CRLF 和 LF 两种换行符
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      // 跳过空行和事件类型行
      if (!line || line.startsWith("event:")) continue;

      // 处理 SSE data 行
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        if (jsonStr && jsonStr !== "[DONE]") {
          try {
            const data = JSON.parse(jsonStr);
            // Anthropic 标准格式: content_block_delta
            if (data.type === "content_block_delta" && data.delta?.text) {
              result += data.delta.text;
            }
            // 兼容其他可能的格式
            else if (data.delta?.text) {
              result += data.delta.text;
            }
            // OpenAI 兼容格式
            else if (data.choices?.[0]?.delta?.content) {
              result += data.choices[0].delta.content;
            }
            // 直接 text 字段
            else if (data.text) {
              result += data.text;
            }
            // content_block_start 包含初始文本
            else if (data.type === "content_block_start" && data.content_block?.text) {
              result += data.content_block.text;
            }
          } catch (e) {
            // 忽略解析错误，继续处理
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
 * 根据权重随机选择一个模型
 * @param ctx Koishi上下文（用于检查每日限制）
 * @param userId 用户ID（用于检查每日限制）
 * @param platform 平台（用于检查每日限制）
 * @returns 选中的模型和供应商信息
 */
async function selectRandomModel(
  ctx?: Context,
  userId?: string,
  platform?: string,
  excludeModelIds?: string[]
): Promise<{
  provider: aiConfig["modelProvider"];
  model: aiConfig["models"][0];
} | null> {
  // 1. 筛选出有可用模型的供应商
  const availableProviders = AIProviders.filter((p) => {
    const hasWeight =
      p.modelProvider.modelProviderWeight &&
      p.modelProvider.modelProviderWeight > 0;
    const hasWeightedModels = p.models.some(
      (m) => m.modelWeight && m.modelWeight > 0 &&
        !(excludeModelIds && excludeModelIds.includes(m.id))
    );
    return hasWeight && hasWeightedModels;
  });

  if (availableProviders.length === 0) {
    return null; // 没有可用的供应商
  }

  // 2. 根据 modelProviderWeight 随机选择一个供应商
  const totalProviderWeight = availableProviders.reduce(
    (sum, p) => sum + p.modelProvider.modelProviderWeight!,
    0
  );
  let randomProviderWeight = Math.random() * totalProviderWeight;
  let selectedProvider: aiConfig | null = null;

  for (const provider of availableProviders) {
    randomProviderWeight -= provider.modelProvider.modelProviderWeight!;
    if (randomProviderWeight <= 0) {
      selectedProvider = provider;
      break;
    }
  }

  if (!selectedProvider) {
    selectedProvider = availableProviders[availableProviders.length - 1];
  }

  // 3. 从选定的供应商中，筛选出有权重的模型（排除已失败的模型）
  let weightedModels = selectedProvider.models.filter(
    (m) => m.modelWeight && m.modelWeight > 0 &&
      !(excludeModelIds && excludeModelIds.includes(m.id))
  );

  // 4. 如果有用户信息，过滤掉已达每日限制的模型（仅对 dailyLimit=true 的模型生效）
  if (ctx && userId && platform) {
    const filteredModels: typeof weightedModels = [];
    for (const model of weightedModels) {
      if (model.dailyLimit) {
        const used = await checkDailyModelLimit(ctx, userId, platform, model.id);
        if (!used) {
          filteredModels.push(model);
        }
      } else {
        filteredModels.push(model);
      }
    }
    weightedModels = filteredModels;
  }

  // This check is technically redundant because of the filter in step 1, but good for safety.
  if (weightedModels.length === 0) {
    return null;
  }

  // 5. 根据 modelWeight 随机选择一个模型
  const totalModelWeight = weightedModels.reduce(
    (sum, m) => sum + m.modelWeight!,
    0
  );
  let randomModelWeight = Math.random() * totalModelWeight;
  let selectedModel: aiConfig["models"][0] | null = null;

  for (const model of weightedModels) {
    randomModelWeight -= model.modelWeight!;
    if (randomModelWeight <= 0) {
      selectedModel = model;
      break;
    }
  }

  if (!selectedModel) {
    selectedModel = weightedModels[weightedModels.length - 1];
  }

  return {
    provider: selectedProvider.modelProvider,
    model: selectedModel,
  };
}

/**
 * 我想要情缘功能prompt（普通匹配）
 * @param candidates 筛选后的候选人档案
 * @param myProfile 用户档案
 */
function soulNormalPairPrompt(
  myProfile: SoulProfile,
  candidates: SoulProfile[]
): string {
  return `你是剑网3情缘匹配专家。请分析以下用户与候选人的匹配度。

${characterTypePrompt}

## 用户档案
${formatProfileCompact(myProfile)}

## 候选人档案
${candidates
      .map((c, i) => `### 候选人${i + 1}（编号从1开始）\n${formatProfileCompact(c)}`)
      .join("\n\n")}

${scoringRulesPrompt}

## 匹配规则
1. **优先级：服务器 > 玩法 > 门派体型 > 个性契合**
2. 基础分50分，根据各维度加减分计算最终得分
3. 最终分数限制在0-100范围内
4. 匹配分析需**双向考虑**：用户是否满足候选人的期待，候选人是否满足用户的期待
5. 请注意检测涉三态度矛盾（选是但介绍写不涉三）

### 玩法兼容性说明
- PVX（休闲玩家）与 PVP 或 PVE 都有重叠，应视为部分匹配（+8分）
- PVP 与 PVE 无重叠，但若双方没有明确排斥对方玩法则不扣分
- 若一方是高强度竞技玩家而另一方明确不喜欢，则扣分

请返回JSON格式：
{
  "matches": [
    {
      "candidateIndex": 1,
      "userId": "候选人的用户标识（必须填写，用于备用定位）",
      "score": 65,
      "analysis": "简洁的匹配分析理由（双向视角）",
      "highlights": ["主要优点"],
      "concerns": ["需注意的问题"]
    }
  ]
}

**输出要求**：
- 只返回得分>=55的匹配，按分数降序排列，最多返回2个
- candidateIndex 从1开始，对应候选人编号；userId 必须填写档案中的用户标识
- analysis中不要出现"候选人1"等编号，不要详细描述分数变化
- 直接描述匹配优势和潜在问题，需体现双方角度
- score分数必须在0-100范围内`;
}

/**
 * 我想要情缘（普通匹配）
 * @param myProfile 用户档案
 * @param candidates 筛选后的档案
 * @returns AI匹配结果
 */
/**
 * 获取模型智商等级
 * @param modelName 模型名称
 * @returns 模型智商等级描述
 */
function getModelGradeLabel(modelName: string): string {
  // 豆包1.6/1.6Lite/1.8、Gemini 3 系列和 GPT-5 系列是"聪明"的，其他都是"弱智"的
  if (
    modelName === "豆包 1.6" ||
    modelName === "豆包 1.6 Lite" ||
    modelName === "豆包 1.8" ||
    modelName.startsWith("Gemini 3") ||
    modelName.startsWith("GPT-5")
  ) {
    return "🤔 聪明";
  }
  return "🤪 弱智";
}

async function callNormalPair(
  myProfile: SoulProfile,
  candidates: SoulProfile[],
  ctx: Context,
  userId?: string,
  platform?: string
): Promise<{ response: any; modelName: string; modelGrade: string } | null> {
  const MAX_RETRIES = 3;
  const failedModelIds: string[] = []; // 记录失败的模型ID，避免重复选择

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const selected = await selectRandomModel(ctx, userId, platform, failedModelIds);
    if (!selected) {
      return null;
    }

    const { provider, model } = selected;
    ctx.logger.info(`当前使用的模型供应商：${provider.name}`);
    ctx.logger.info(`当前使用的模型：${model.name}(${model.id})${attempt > 0 ? `（第${attempt + 1}次尝试）` : ''}\n`);

    // 记录每日模型使用（仅对有每日限制的模型）
    if (model.dailyLimit && userId && platform) {
      await recordModelUsage(ctx, userId, platform, model.id);
    }

    try {
      const result = await executeNormalPairRequest(provider, model, myProfile, candidates, ctx);
      return result;
    } catch (error) {
      ctx.logger.error(`模型 ${model.name}(${model.id}) 调用失败: ${error.message}`);

      // 只对 ModelScope 供应商进行重试
      if (provider.name === "ModelScope" && attempt < MAX_RETRIES - 1) {
        failedModelIds.push(model.id);
        ctx.logger.info(`[重试] ModelScope 模型失败，将重新选择模型（已排除: ${failedModelIds.join(', ')}）`);
        continue;
      }
      throw error;
    }
  }
  return null;
}

/**
 * 执行普通匹配的 API 请求（内部函数）
 */
async function executeNormalPairRequest(
  provider: aiConfig["modelProvider"],
  model: aiConfig["models"][0],
  myProfile: SoulProfile,
  candidates: SoulProfile[],
  ctx: Context
): Promise<{ response: any; modelName: string; modelGrade: string }> {
  let requestData: AIRequestData = {
    model: model.id,
    messages: [
      {
        role: "system",
        content: "你是专业的游戏情缘匹配分析师，需要根据用户档案进行精准匹配。",
      },
      {
        role: "user",
        content: soulNormalPairPrompt(myProfile, candidates),
      },
    ],
    temperature: 0.6,
    max_tokens: 4000,
  };

  if (model.supportThinking) {
    requestData.thinking = { type: "enabled" };
  }
  if (model.supportEffort && model.supportEffort !== "none") {
    requestData.reasoning_effort = model.supportEffort;
  }

  // Handle Anthropic streaming API
  if (provider.responseType === "anthropic" && model.stream) {
    // Anthropic 要求 system 作为顶级参数，不能放在 messages 中
    const systemMsg = requestData.messages.find(m => m.role === "system");
    const nonSystemMessages = requestData.messages.filter(m => m.role !== "system");
    const anthropicRequestData: any = {
      model: requestData.model,
      messages: nonSystemMessages,
      max_tokens: requestData.max_tokens,
    };
    if (systemMsg) {
      anthropicRequestData.system = systemMsg.content;
    }
    if (requestData.thinking) {
      anthropicRequestData.thinking = requestData.thinking;
    }

    const aiResponse = await callAnthropicStream(
      provider.url,
      anthropicRequestData,
      provider.accessToken
    );
    return {
      response: aiResponse,
      modelName: model.name,
      modelGrade: getModelGradeLabel(model.name),
    };
  }

  // Handle OpenAI Responses API format
  if (provider.responseType === "openai-responses") {
    const systemMsg = requestData.messages.find(m => m.role === "system");
    const userMessages = requestData.messages.filter(m => m.role !== "system");
    const responsesRequestData: any = {
      model: model.id,
      input: userMessages.map(m => ({ role: m.role, content: m.content })),
      temperature: requestData.temperature,
      max_output_tokens: requestData.max_tokens,
    };
    if (systemMsg) {
      responsesRequestData.instructions = systemMsg.content;
    }

    const response = await axios.post(provider.url, responsesRequestData, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.accessToken}`,
      },
      timeout: 1200000,
    });

    // Responses API: 从 output 数组中提取文本
    const outputMsg = response.data.output?.find((o: any) => o.type === "message");
    const aiResponse = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text
      || response.data.output_text
      || JSON.stringify(response.data.output);
    return {
      response: aiResponse,
      modelName: model.name,
      modelGrade: getModelGradeLabel(model.name),
    };
  }

  // Handle Google Gemini API URL replacement
  let apiUrl = provider.url;
  if (provider.responseType === "google-beta") {
    apiUrl = apiUrl.replace("{modelsName}", model.id);
  }

  // Prepare headers based on provider type
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Google Gemini uses x-goog-api-key instead of Authorization: Bearer
  if (provider.responseType === "google-beta") {
    headers["x-goog-api-key"] = provider.accessToken;
  } else {
    headers["Authorization"] = `Bearer ${provider.accessToken}`;
  }

  // Convert to Google Gemini format if needed
  let geminiRequestData = requestData;
  if (provider.responseType === "google-beta") {
    // 分离 system 消息和其他消息
    const systemMsg = requestData.messages.find(m => m.role === "system");
    const nonSystemMessages = requestData.messages.filter(m => m.role !== "system");

    // Map messages to Gemini contents format (必须包含 role 字段)
    const geminiContents = nonSystemMessages.map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));

    // Create Gemini-specific request data
    const geminiData: any = {
      contents: geminiContents,
      generationConfig: {
        temperature: requestData.temperature,
        maxOutputTokens: requestData.max_tokens,
      }
    };
    // system 消息使用 systemInstruction
    if (systemMsg) {
      geminiData.systemInstruction = {
        parts: [{ text: systemMsg.content }]
      };
    }
    geminiRequestData = geminiData as any;
  }

  const response = await axios.post(apiUrl, geminiRequestData, {
    headers,
    timeout: 1200000, // 20分钟超时
  });

  // Handle different response formats based on provider type
  let aiResponse;
  if (provider.responseType === "google-beta") {
    // Google Gemini response format
    aiResponse = response.data.candidates[0].content.parts[0].text;
  } else {
    // OpenAI/Anthropic format
    aiResponse = response.data.choices[0].message.content;
  }

  // 清理 <think>...</think> 推理标签（部分模型如 MiniMax M2.1 会输出）
  if (typeof aiResponse === "string" && aiResponse.includes("<think>")) {
    aiResponse = aiResponse.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  }

  return {
    response: aiResponse,
    modelName: model.name,
    modelGrade: getModelGradeLabel(model.name),
  };
}

/**
 * 我真的想要情缘功能prompt（深度匹配）
 * @param candidates 筛选后的候选人档案
 * @param myProfile 用户档案
 */
function soulAdvancedPairPrompt(
  myProfile: SoulProfile,
  candidates: SoulProfile[]
): string {
  return `你是剑网3情缘匹配专家。请对以下用户与候选人进行深度匹配分析。

${characterTypePrompt}

## 用户档案
${formatProfileCompact(myProfile)}

## 候选人档案
${candidates
      .map((c, i) => `### 候选人${i + 1}（编号从1开始）\n${formatProfileCompact(c)}`)
      .join("\n\n")}

${scoringRulesPrompt}

## 深度匹配规则
1. **优先级：服务器 > 玩法 > 门派体型 > 个性契合**
2. 基础分50分，根据各维度加减分计算最终得分
3. 最终分数限制在0-100范围内
4. 匹配分析需**双向考虑**：用户是否满足候选人的期待，候选人是否满足用户的期待
5. **年龄规则**：如果用户明确要求年龄范围，作为重要判断依据
6. **地理规则**：仅当双方涉三=是时，地理位置才影响评分
7. 请注意检测涉三态度矛盾（选是但介绍写不涉三）

### 玩法兼容性说明
- PVX（休闲玩家）与 PVP 或 PVE 都有重叠，应视为部分匹配（+8分）
- PVP 与 PVE 无重叠，但若双方没有明确排斥对方玩法则不扣分
- 若一方是高强度竞技玩家而另一方明确不喜欢，则扣分

## 深度分析要求
- **双向视角**：不仅分析候选人是否适合用户，也分析用户是否满足候选人期待
- **性格互补分析**：根据双方自我介绍中体现的性格特点，分析互补性或契合度
- **具体互动建议**：提供可直接使用的开场白、推荐的共同话题、需避免的忌讳行为
- **共同话题挖掘**：从双方爱好、玩法、门派等信息中发掘潜在共同话题

请返回JSON格式：
{
  "matches": [
    {
      "candidateIndex": 1,
      "userId": "候选人的用户标识（必须填写，用于备用定位）",
      "score": 65,
      "analysis": "详细的匹配分析（双向视角，逐项分析各维度，但不要说具体分数）",
      "highlights": ["可直接使用的开场白", "推荐的共同话题", "互动技巧建议", "需要避免的忌讳行为"],
      "concerns": ["需要注意的问题"]
    }
  ]
}

**输出要求**：
- 只返回得分>=50的匹配，按分数降序排列，**只返回1个最佳匹配**
- candidateIndex 从1开始，对应候选人编号；userId 必须填写档案中的用户标识
- analysis需要详细分析，但不要出现"候选人1"等编号，需体现双方角度
- highlights字段需要提供3-5个具体可执行的互动建议（包含开场白、话题、技巧）
- score分数必须在0-100范围内`;
}

/**
 * 我真的想要情缘（高级匹配）
 * 使用 api.268526.eu.cc 提供的高级模型进行深度匹配
 * 主模型: claude-sonnet-4-6 → 降级: gpt-5.3-codex
 * @param myProfile 用户档案
 * @param candidates 筛选后的档案
 * @returns AI匹配结果（JSON 字符串）
 */
async function callAdvancedPair(
  myProfile: SoulProfile,
  candidates: SoulProfile[],
  ctx: Context
): Promise<any> {
  const API_BASE = "https://api.268526.eu.cc/v1/chat/completions";

  const MODELS = [
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      apiKey: "YOUR_API_KEY_1",
      extraBody: {},
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT 5.3 Codex",
      apiKey: "YOUR_API_KEY_2",
      extraBody: { group: "codex" },
    },
  ];

  const promptContent = soulAdvancedPairPrompt(myProfile, candidates);

  for (const model of MODELS) {
    try {
      ctx.logger.info(`[深度匹配] 当前使用的模型：${model.name}`);
      const requestBody = {
        model: model.id,
        messages: [
          {
            role: "system" as const,
            content: "你是专业的游戏情缘匹配分析师，需要根据用户档案进行精准匹配。直接返回JSON，不要使用代码块包裹。",
          },
          {
            role: "user" as const,
            content: promptContent,
          },
        ],
        max_tokens: 16000,
        temperature: 0.7,
        ...model.extraBody,
      };

      const response = await axios.post(API_BASE, requestBody, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${model.apiKey}`,
        },
        timeout: 600000, // 10 分钟超时
      });

      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("API 返回空内容");
      }

      ctx.logger.info(`[深度匹配] ${model.name} 调用成功，响应长度: ${content.length}`);
      return content;
    } catch (error: any) {
      const detail = error.response?.data
        ? JSON.stringify(error.response.data).substring(0, 200)
        : error.message;
      ctx.logger.error(`[深度匹配] ${model.name} 调用失败: ${detail}`);
    }
  }

  throw new Error("[深度匹配] 所有可用模型均调用失败");
}

/**
 * 调用 Gemini 流式 API（专用于测试）
 * 直接使用 GuguAPI 的 Gemini 模型
 * @param modelId 模型ID，可选: gemini-3-flash-preview (默认), gemini-3-pro-preview, gemini-2.5-pro, gemini-2.5-flash
 */
async function callGeminiPair(
  myProfile: SoulProfile,
  candidates: SoulProfile[],
  ctx: Context,
  modelId: string = "gemini-3-flash-preview"
): Promise<{ response: any; modelName: string; modelGrade: string } | null> {
  const API_URL = "http://YOUR_API_HOST:PORT/v1/messages";
  const API_KEY = "YOUR_API_KEY";

  // 模型名称映射
  const modelNames: { [key: string]: string } = {
    "gemini-3-flash-preview": "Gemini 3 Flash",
    "gemini-3-pro-preview": "Gemini 3 Pro",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
  };
  const MODEL_NAME = modelNames[modelId] || modelId;

  ctx.logger.info(`[Gemini测试] 当前使用的模型供应商：GuguAPI`);
  ctx.logger.info(`[Gemini测试] 当前使用的模型：${MODEL_NAME}(${modelId})\n`);

  const requestData: AIRequestData = {
    model: modelId,
    messages: [
      {
        role: "system",
        content: "你是专业的游戏情缘匹配分析师，需要根据用户档案进行精准匹配。直接返回JSON，不要使用代码块包裹。",
      },
      {
        role: "user",
        content: soulNormalPairPrompt(myProfile, candidates),
      },
    ],
    temperature: 0.6,
    max_tokens: 4000,
  };

  // 添加思考模式
  requestData.thinking = { type: "enabled" };

  try {
    const aiResponse = await callAnthropicStream(
      API_URL,
      requestData,
      API_KEY
    );
    return {
      response: aiResponse,
      modelName: MODEL_NAME,
      modelGrade: getModelGradeLabel(MODEL_NAME),
    };
  } catch (error) {
    ctx.logger.error(`[Gemini测试] 调用失败: ${error.message}`);
    throw error;
  }
}

/**
 * 使用 Gemini 3 Flash 修复截断的 JSON
 * 当 AI 返回的 JSON 被截断无法解析时，调用 Gemini 修复
 * @param brokenJson 截断的 JSON 字符串
 * @param ctx Koishi 上下文
 * @returns 修复后的 JSON 对象，失败返回 null
 */
async function repairJsonWithGemini(
  brokenJson: string,
  ctx: Context
): Promise<any | null> {
  // GuguAPI 已禁用，JSON 修复功能暂不可用
  ctx.logger.info(`[JSON修复] GuguAPI 已禁用，跳过 JSON 修复`);
  return null;

  const requestData = {
    model: MODEL_ID,
    system: "你是 JSON 修复专家。用户会给你一段被截断的 JSON，请修复它使其成为合法的 JSON。只返回修复后的纯 JSON，不要添加任何解释或代码块标记。",
    messages: [
      {
        role: "user" as const,
        content: `以下 JSON 被截断了，请修复它。如果数据不完整，请合理补全缺失的部分（如闭合括号、补全截断的字符串）。只返回修复后的纯 JSON：\n\n${brokenJson}`,
      },
    ],
    max_tokens: 4000,
  };

  try {
    const response = await callAnthropicStream(API_URL, requestData, API_KEY, 60000);
    // 清理响应
    let cleaned = response
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "");
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      ctx.logger.error(`[JSON修复] Gemini 返回了非 JSON 内容`);
      return null;
    }
    const result = JSON.parse(jsonMatch[0]);
    ctx.logger.info(`[JSON修复] 修复成功`);
    return result;
  } catch (error) {
    ctx.logger.error(`[JSON修复] 修复失败: ${error.message}`);
    return null;
  }
}

/**
 * ModelScope Embedding 配置
 */
const EMBEDDING_CONFIG = {
  url: "https://api-inference.modelscope.cn/v1/embeddings",
  model: "Qwen/Qwen3-Embedding-8B",
  accessToken: "YOUR_MODELSCOPE_TOKEN",
};

/**
 * 调用 ModelScope Embedding API
 * @param input 单条或多条文本
 * @returns 每条文本对应的 embedding 向量
 */
async function getEmbeddings(input: string | string[]): Promise<number[][]> {
  const response = await axios.post(
    EMBEDDING_CONFIG.url,
    {
      model: EMBEDDING_CONFIG.model,
      input,
      encoding_format: "float",
    },
    {
      headers: {
        Authorization: `Bearer ${EMBEDDING_CONFIG.accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  // 按 index 排序，确保顺序与输入一致
  const sorted = response.data.data.sort((a: any, b: any) => a.index - b.index);
  return sorted.map((d: any) => d.embedding);
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 清理文本中的 HTML 标签、QQ 表情等噪音
 */
function cleanTextForEmbedding(text: string): string {
  return text
    // 移除 HTML/XML 标签（QQ 表情 <face>、<img> 等）
    .replace(/<[^>]+>/g, "")
    // 移除多余空白
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 将档案中与匹配相关的语义字段拼接为一段文本，用于生成 embedding
 * 会清理 HTML 标签并截断过长文本
 */
function getProfileEmbeddingText(profile: SoulProfile): string {
  // 截断单个字段，避免过长
  const truncate = (s: string, max: number) =>
    s && s.length > max ? s.substring(0, max) + "..." : (s || "");

  const parts = [
    `门派体型：${profile.characterTypes}`,
    `玩法：${profile.gameplay}`,
    `期待：${truncate(profile.expectations, 150)}`,
    `介绍：${truncate(profile.introduction, 200)}`,
  ];
  if (profile.location) {
    parts.push(`属地：${profile.location}`);
  }
  const raw = parts.join("；");
  // 清理 HTML 并限制总长度
  return cleanTextForEmbedding(raw).substring(0, 500);
}

/**
 * 为单个档案生成 embedding 并返回向量
 * 用于档案创建/更新时自动生成并存入 DB
 * @param profile 档案对象
 * @param ctx 可选，用于日志
 * @returns embedding 向量 (number[])，失败返回 null
 */
async function generateProfileEmbedding(
  profile: SoulProfile,
  ctx?: Context
): Promise<number[] | null> {
  try {
    const text = getProfileEmbeddingText(profile);
    const embeddings = await getEmbeddings(text);
    if (ctx) {
      ctx.logger.info(`[Embedding] 已生成向量: ${profile.characterName} (${profile.userId})`);
    }
    return embeddings[0];
  } catch (error: any) {
    if (ctx) {
      ctx.logger.error(`[Embedding] 生成失败: ${profile.characterName} - ${error.message}`);
    }
    return null;
  }
}

/**
 * 使用 Embedding 对候选人按语义相似度排序，返回 Top-K
 * 优先使用 DB 中缓存的向量，无缓存的实时生成
 * @param myProfile 用户档案
 * @param candidates 规则筛选后的候选人列表
 * @param topK 返回的候选人数量
 * @param ctx 可选，用于日志
 * @returns 排序后的前 topK 名候选人及其相似度分数
 */
async function rankCandidatesByEmbedding(
  myProfile: SoulProfile,
  candidates: SoulProfile[],
  topK: number = 8,
  ctx?: Context
): Promise<{ profile: SoulProfile; similarity: number }[]> {
  // 1. 获取用户自己的 embedding（优先缓存）
  let myEmbedding: number[];
  if (myProfile.embedding && myProfile.embedding.length > 0) {
    myEmbedding = myProfile.embedding;
    if (ctx) ctx.logger.info(`[向量匹配] 用户 embedding 来自缓存`);
  } else {
    const text = getProfileEmbeddingText(myProfile);
    const embs = await getEmbeddings(text);
    myEmbedding = embs[0];
    if (ctx) ctx.logger.info(`[向量匹配] 用户 embedding 实时生成`);
  }

  // 2. 获取候选人的 embedding（优先缓存，无缓存的批量生成）
  const candidateEmbeddings: number[][] = [];
  const needGenerate: { index: number; text: string }[] = [];
  let cachedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].embedding && candidates[i].embedding!.length > 0) {
      candidateEmbeddings[i] = candidates[i].embedding!;
      cachedCount++;
    } else {
      candidateEmbeddings[i] = []; // 占位
      needGenerate.push({ index: i, text: getProfileEmbeddingText(candidates[i]) });
    }
  }

  if (ctx) {
    ctx.logger.info(`[向量匹配] 候选人: ${candidates.length} 总, ${cachedCount} 缓存, ${needGenerate.length} 需生成`);
  }

  // 3. 批量生成缺失的 embedding
  if (needGenerate.length > 0) {
    const BATCH_SIZE = 8;
    for (let i = 0; i < needGenerate.length; i += BATCH_SIZE) {
      const batch = needGenerate.slice(i, i + BATCH_SIZE);
      try {
        const batchEmbeddings = await getEmbeddings(batch.map(b => b.text));
        for (let j = 0; j < batch.length; j++) {
          candidateEmbeddings[batch[j].index] = batchEmbeddings[j];
        }
      } catch (error: any) {
        if (ctx) {
          const detail = error.response?.data
            ? JSON.stringify(error.response.data).substring(0, 200)
            : error.message;
          ctx.logger.error(`[向量匹配] Embedding 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败: ${detail}`);
        }
        throw error;
      }
    }
  }

  // 4. 计算相似度并排序
  const scored = candidates.map((profile, i) => ({
    profile,
    similarity: cosineSimilarity(myEmbedding, candidateEmbeddings[i]),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  if (ctx) {
    ctx.logger.info(`[向量匹配] 候选人总数: ${candidates.length}, 取 Top-${topK}`);
    scored.slice(0, topK).forEach((s, i) => {
      ctx.logger.info(`  Top ${i + 1}: ${s.profile.characterName} (${s.profile.userId}) - 相似度: ${s.similarity.toFixed(4)}`);
    });
  }

  return scored.slice(0, topK);
}


export {
  callNormalPair,
  callAdvancedPair,
  callGeminiPair,
  callAnthropicStream,
  repairJsonWithGemini,
  getEmbeddings,
  cosineSimilarity,
  rankCandidatesByEmbedding,
  generateProfileEmbedding,
  getProfileEmbeddingText,
  checkDailyModelLimit,
  recordModelUsage,
};

