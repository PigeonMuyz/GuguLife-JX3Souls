import { Context } from "koishi";
import { SoulProfile } from "../types";
import axios from "axios";

// ===== 配置 =====

// AI 模型配置（Anthropic 协议代理）
const AI_CONFIG = {
    url: "http://35.208.254.115:65530/v1/messages",
    apiKey: "YOUR_API_KEY",
    model: "gemini-3.1-pro-high",
};

// MCP 服务配置
const MCP_CONFIGS = {
    railway: {
        url: "https://mcp.api-inference.modelscope.net/1d7d2c920fb148/mcp",
    },
    amap: {
        httpUrl: "https://mcp.api-inference.modelscope.net/86d42ce6fe7b44/mcp", // 优先尝试 HTTP
        sseUrl: "https://mcp.api-inference.modelscope.net/86d42ce6fe7b44/sse",  // 备选 SSE
    },
};

// 费用配置
const COST_CONFIG = {
    queryCost: 200,           // 每次 AI 查询费用
    tokenThreshold: 300000,   // 30w tokens 阈值
    tokenCostRate: 10000,     // 每1w tokens 额外费用
};

// 会话超时
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5分钟

// System Prompt
const SYSTEM_PROMPT = `# Role (角色设定)
你是一个专业的智能行程规划助手，拥有实时铁路数据（12306）和高精度地图数据（LBS）的访问权限。
你的核心能力不仅是查询现有车票，还包括基于常态化排班规律，为用户预测未来的行程规划。

# Core Capabilities (核心能力)
1. 时间锚定与推演：能够区分"可购票日期"和"远期规划日期"，并能进行日期映射。
2. 多模态决策：结合火车（长途）与市内交通（接驳）进行综合考量。
3. 智能中转：在直达不可用时，利用地理数据计算异站换乘的可行性。

# Decision Logic & Workflow (决策逻辑与工作流)

## 第一步：时间锚定与策略选择
1. 必须首先调用 get-current-date 获取"当前日期" (CurrentDate)。
2. 解析用户想要的"目标日期" (TargetDate)。
3. 计算时间差 (Delta Days)：
   - 情况 A：实时购票模式 (TargetDate <= CurrentDate + 14天)
     直接使用 TargetDate 进行后续的所有 API 查询。输出时强调这是"实时余票信息"。
   - 情况 B：排班预测模式 (TargetDate > CurrentDate + 14天)
     启动"影子日期策略"：寻找一个在未来 3-10 天内，且与 TargetDate "星期属性相同" 的日期作为 ProxyDate。
     逻辑：铁路排班通常按周循环。如果用户查"下个月的某个周五"，请查询"本周五或下周五"的数据作为参考。
     使用 ProxyDate 调用 get-tickets 或 get-interline-tickets。
     警告：在输出结果时，必须明确标注："当前未开售，以下方案基于常态化排班预测，具体以开售时为准。"

## 第二步：地理编码与站点匹配
- 识别起点和终点城市。
- 调用 get-stations-code-in-city 获取精确的车站代码。

## 第三步：方案搜索与性价比分析
1. 获取数据：根据第一步确定的日期（TargetDate 或 ProxyDate）调用接口。
2. 直达 vs 中转：优先直达。若需中转，优先推荐"同站换乘"。
3. 异站换乘风控：
   若出现异站换乘（如：A站到达 -> B站出发），必须调用 maps_direction_transit_integrated 或 maps_distance。
   可行性公式：中间预留时间 - 路程耗时 > 90分钟。若小于此值，视为高风险方案，尽量不推荐或红字警告。

## 第四步：环境与最后一公里
- 若处于"排班预测模式"，天气数据参考价值较低，可以仅提供目的地的历史气候概况或不调用。
- 若处于"实时购票模式"，调用 maps_weather 提供具体天气建议。

# Output Format Guidelines (输出规范)

重要：你的输出将在QQ聊天中显示，不支持 Markdown 格式。请严格使用纯文本格式，禁止使用任何 Markdown 语法（包括 #、*、**、- 列表、\`代码\` 等）。
使用 emoji 和中文符号（如：━、│、→）来美化排版。

请根据时间模式调整输出口吻：

如果是预测模式（目标日期在14天后）：
⚠️ 温馨提示：您计划的日期尚未开售。以下方案基于历史排班数据（周X时刻表）为您估算，车次和价格通常稳定，但请在出发前15天再次确认。

如果是实时模式（目标日期在14天内）：
✅ 实时数据：以下是为您查询到的实时余票和价格信息。

方案内容要求：
1. 🚀 综合推荐
2. 💰 性价比之选（需计算：票价 + 潜在换乘打车费）
3. ⚡ 最快到达
每条方案需包含：车次、精确时间、预估总价、中转详情（如同站/异站、换乘耗时）。

总字数控制在 600 字以内。

# Constraints (约束)
- 对于预测模式，严禁谎称"有票"，必须使用"预计"、"参考"等词汇。
- 严禁在没有调用站点查询工具的情况下猜测车站代码。
- 禁止输出 Markdown 格式。`;

// ===== MCP HTTP 客户端（/mcp 端点） =====

class MCPHttpClient {
    private url: string;
    private sessionId: string | null = null;

    constructor(url: string) {
        this.url = url;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        };
        if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
        return headers;
    }

    async initialize(): Promise<void> {
        const response = await axios.post(
            this.url,
            {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "GuguLite-TravelAssistant", version: "1.0.0" },
                },
            },
            { headers: this.getHeaders(), timeout: 30000 }
        );
        this.sessionId = response.headers["mcp-session-id"] || null;

        // MCP 协议要求：initialize 后必须发送 notifications/initialized
        await axios.post(
            this.url,
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            { headers: this.getHeaders(), timeout: 10000 }
        ).catch(() => { }); // notification 无需响应，忽略错误
    }

    async listTools(): Promise<any[]> {
        if (!this.sessionId) await this.initialize();
        const response = await axios.post(
            this.url,
            { jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} },
            { headers: this.getHeaders(), timeout: 30000 }
        );
        return response.data?.result?.tools || [];
    }

    async callTool(name: string, args: Record<string, any>): Promise<any> {
        if (!this.sessionId) await this.initialize();
        const response = await axios.post(
            this.url,
            { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
            { headers: this.getHeaders(), timeout: 60000 }
        );
        if (response.data?.error) throw new Error(response.data.error.message);
        return response.data?.result || response.data;
    }

    reset() {
        this.sessionId = null;
    }
}

// ===== MCP SSE 客户端（/sse 端点） =====

class MCPSSEClient {
    private sseUrl: string;
    private messageEndpoint: string | null = null;
    private cancelSource: any = null;
    private connected = false;
    private initialized = false;
    private pendingRequests = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
    private buffer = "";

    constructor(url: string) {
        this.sseUrl = url;
    }

    async connect(): Promise<void> {
        if (this.connected && this.messageEndpoint) return;
        this.close();

        // 使用 axios stream 替代原生 https.get，避免连接被 abort
        this.cancelSource = axios.CancelToken.source();

        const response = await axios.get(this.sseUrl, {
            headers: { "Accept": "text/event-stream" },
            responseType: "stream",
            timeout: 0, // SSE 无超时
            cancelToken: this.cancelSource.token,
        });

        const stream = response.data;
        this.buffer = "";

        return new Promise<void>((resolve, reject) => {
            const connectTimeout = setTimeout(() => {
                if (!this.connected) {
                    this.close();
                    reject(new Error("SSE connection timeout (30s)"));
                }
            }, 30000);

            stream.on("data", (chunk: Buffer) => {
                const chunkStr = chunk.toString();
                this.buffer += chunkStr;
                // 调试：报告收到的原始 SSE 数据
                if (!this.connected) {
                    console.log(`[旅行助手] SSE 收到数据 (${chunkStr.length}B): ${chunkStr.substring(0, 200)}`);
                }
                this.processSSEBuffer();
                if (this.messageEndpoint && !this.connected) {
                    this.connected = true;
                    clearTimeout(connectTimeout);
                    resolve();
                }
            });

            stream.on("end", () => {
                this.connected = false;
                this.initialized = false;
                clearTimeout(connectTimeout);
                this.rejectAllPending("SSE connection closed");
            });

            stream.on("error", (err: Error) => {
                this.connected = false;
                this.initialized = false;
                clearTimeout(connectTimeout);
                this.rejectAllPending(err.message);
                reject(err);
            });
        });
    }

    private processSSEBuffer() {
        const parts = this.buffer.split("\n\n");
        this.buffer = parts.pop() || "";

        for (const part of parts) {
            if (!part.trim()) continue;
            let eventType = "";
            let data = "";
            for (const line of part.split("\n")) {
                if (line.startsWith("event:")) eventType = line.slice(6).trim();
                else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
            }

            if (eventType === "endpoint" && data) {
                const base = new URL(this.sseUrl);
                this.messageEndpoint = new URL(data, base.origin).toString();
                console.log(`[旅行助手] SSE endpoint: ${this.messageEndpoint}`);
            } else if (eventType === "message" && data) {
                try {
                    const response = JSON.parse(data);
                    if (response.id !== undefined) {
                        const handler = this.pendingRequests.get(response.id);
                        if (handler) {
                            clearTimeout(handler.timer);
                            handler.resolve(response);
                            this.pendingRequests.delete(response.id);
                        }
                    }
                } catch { }
            }
        }
    }

    private rejectAllPending(reason: string) {
        for (const [, handler] of this.pendingRequests) {
            clearTimeout(handler.timer);
            handler.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    async sendRequest(method: string, params: any): Promise<any> {
        if (!this.connected || !this.messageEndpoint) await this.connect();

        const id = Math.floor(Math.random() * 1000000);
        const responsePromise = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error("MCP request timeout (60s)"));
            }, 60000);
            this.pendingRequests.set(id, { resolve, reject, timer });
        });

        const postResponse = await axios.post(
            this.messageEndpoint!,
            { jsonrpc: "2.0", id, method, params },
            { headers: { "Content-Type": "application/json" }, timeout: 60000, validateStatus: () => true }
        );

        // 如果响应直接在 HTTP body 中返回（200 + JSON-RPC）
        if (postResponse.status === 200 && postResponse.data?.jsonrpc) {
            const handler = this.pendingRequests.get(id);
            if (handler) {
                clearTimeout(handler.timer);
                this.pendingRequests.delete(id);
            }
            return postResponse.data;
        }

        // 否则等待 SSE 流中的响应
        return responsePromise;
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.connected || !this.messageEndpoint) await this.connect();
        if (this.initialized) return;

        await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "GuguLite-TravelAssistant", version: "1.0.0" },
        });

        // MCP 协议要求：initialize 后发送 notifications/initialized
        await axios.post(
            this.messageEndpoint!,
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            { headers: { "Content-Type": "application/json" }, timeout: 10000 }
        ).catch(() => { });

        this.initialized = true;
    }

    async listTools(): Promise<any[]> {
        await this.ensureInitialized();
        const response = await this.sendRequest("tools/list", {});
        return response?.result?.tools || [];
    }

    async callTool(name: string, args: Record<string, any>): Promise<any> {
        await this.ensureInitialized();
        const response = await this.sendRequest("tools/call", { name, arguments: args });
        if (response?.error) throw new Error(response.error.message);
        return response?.result || response;
    }

    close() {
        try { this.cancelSource?.cancel("Client closed"); } catch { }
        this.cancelSource = null;
        this.connected = false;
        this.initialized = false;
        this.messageEndpoint = null;
        this.rejectAllPending("Client closed");
    }
}

// ===== 工具注册表 =====

interface ToolEntry {
    name: string;
    client: MCPHttpClient | MCPSSEClient;
    anthropicDef: any; // Anthropic tool format
}

let toolRegistry: ToolEntry[] = [];
let toolsInitialized = false;

const railwayClient = new MCPHttpClient(MCP_CONFIGS.railway.url);
// 高德：优先 HTTP，备选 SSE
const amapHttpClient = new MCPHttpClient(MCP_CONFIGS.amap.httpUrl);
const amapSseClient = new MCPSSEClient(MCP_CONFIGS.amap.sseUrl);
let amapClient: MCPHttpClient | MCPSSEClient = amapHttpClient;

async function initializeToolRegistry(): Promise<void> {
    if (toolsInitialized) return;

    const errors: string[] = [];

    // 12306 工具
    try {
        const railwayTools = await railwayClient.listTools();
        for (const tool of railwayTools) {
            toolRegistry.push({
                name: tool.name,
                client: railwayClient,
                anthropicDef: {
                    name: tool.name,
                    description: tool.description || "",
                    input_schema: tool.inputSchema || { type: "object", properties: {} },
                },
            });
        }
        console.log(`[旅行助手] 12306 MCP 加载 ${railwayTools.length} 个工具`);
    } catch (e: any) {
        errors.push(`12306: ${e.message}`);
        console.error("[旅行助手] 12306 MCP 连接失败:", e.message);
    }

    // 高德地图工具（优先尝试 HTTP，失败则尝试 SSE）
    try {
        console.log("[旅行助手] 高德 MCP 尝试 HTTP 传输...");
        const amapTools = await amapHttpClient.listTools();
        amapClient = amapHttpClient;
        for (const tool of amapTools) {
            toolRegistry.push({
                name: tool.name,
                client: amapClient,
                anthropicDef: {
                    name: tool.name,
                    description: tool.description || "",
                    input_schema: tool.inputSchema || { type: "object", properties: {} },
                },
            });
        }
        console.log(`[旅行助手] 高德 MCP (HTTP) 加载 ${amapTools.length} 个工具`);
    } catch (httpErr: any) {
        console.warn(`[旅行助手] 高德 MCP HTTP 失败: ${httpErr.message}，尝试 SSE...`);
        try {
            const amapTools = await amapSseClient.listTools();
            amapClient = amapSseClient;
            for (const tool of amapTools) {
                toolRegistry.push({
                    name: tool.name,
                    client: amapClient,
                    anthropicDef: {
                        name: tool.name,
                        description: tool.description || "",
                        input_schema: tool.inputSchema || { type: "object", properties: {} },
                    },
                });
            }
            console.log(`[旅行助手] 高德 MCP (SSE) 加载 ${amapTools.length} 个工具`);
        } catch (sseErr: any) {
            errors.push(`高德: HTTP(${httpErr.message}), SSE(${sseErr.message})`);
            console.error("[旅行助手] 高德 MCP 连接失败 (两种传输均失败)");
        }
    }

    if (toolRegistry.length > 0) {
        toolsInitialized = true;
    }

    if (errors.length > 0 && toolRegistry.length === 0) {
        throw new Error(`所有 MCP 服务连接失败: ${errors.join("; ")}`);
    }
}

async function callToolByName(name: string, args: Record<string, any>): Promise<any> {
    const entry = toolRegistry.find((t) => t.name === name);
    if (!entry) throw new Error(`未知工具: ${name}`);
    return entry.client.callTool(name, args);
}

function getAnthropicToolDefs(): any[] {
    return toolRegistry.map((t) => t.anthropicDef);
}

// ===== 旅行助手会话 =====

interface TravelSession {
    userId: string;
    platform: string;
    messages: any[]; // Anthropic messages 格式
    totalTokens: number;
    totalCost: number;
    queryCount: number;
    lastActivity: number;
}

const activeSessions = new Map<string, TravelSession>();

// ===== AI Agent 循环 =====

async function processUserMessage(
    travelSession: TravelSession,
    userMessage: string
): Promise<{ content: string; tokens: number }> {
    // 添加用户消息到历史
    travelSession.messages.push({ role: "user", content: userMessage });

    let totalTokens = 0;
    const maxIterations = 30; // 安全上限，防止死循环

    for (let i = 0; i < maxIterations; i++) {
        try {
            const response = await axios.post(
                AI_CONFIG.url,
                {
                    model: AI_CONFIG.model,
                    max_tokens: 8192,
                    system: SYSTEM_PROMPT,
                    messages: travelSession.messages,
                    tools: getAnthropicToolDefs(),
                },
                {
                    headers: {
                        "x-api-key": AI_CONFIG.apiKey,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    timeout: 120000,
                }
            );

            const data = response.data;
            const usage = data?.usage || {};
            totalTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);

            const content = data?.content;
            if (!content || !Array.isArray(content)) {
                return { content: "AI 响应异常，请稍后重试", tokens: totalTokens };
            }

            // 检查是否有工具调用
            const toolUses = content.filter((c: any) => c.type === "tool_use");
            const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);

            if (toolUses.length > 0) {
                // 将 assistant 的完整回复加入历史
                travelSession.messages.push({ role: "assistant", content });

                // 调用所有工具并收集结果
                const toolResults: any[] = [];
                for (const toolUse of toolUses) {
                    console.log(`[旅行助手] 调用工具: ${toolUse.name}`, JSON.stringify(toolUse.input));
                    let result: any;
                    try {
                        result = await callToolByName(toolUse.name, toolUse.input || {});
                    } catch (e: any) {
                        result = { error: e.message };
                        console.error(`[旅行助手] 工具调用失败: ${toolUse.name}`, e.message);
                    }

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: typeof result === "string" ? result : JSON.stringify(result),
                    });
                }

                // 将工具结果加入历史
                travelSession.messages.push({ role: "user", content: toolResults });
                continue; // 继续循环让 AI 处理工具结果
            }

            // 没有工具调用，返回文本响应
            const finalText = textParts.join("\n") || "查询完成，未返回结果";

            // 将最终回复加入历史（为了连续对话）
            travelSession.messages.push({ role: "assistant", content });

            return { content: stripMarkdown(finalText), tokens: totalTokens };
        } catch (e: any) {
            console.error("[旅行助手] AI 调用失败:", e.response?.data || e.message);
            return { content: `查询失败: ${e.message}`, tokens: totalTokens };
        }
    }

    return { content: "查询轮次过多，请尝试简化问题", tokens: totalTokens };
}

/**
 * 去除 Markdown 格式符号
 */
function stripMarkdown(text: string): string {
    return text
        .replace(/#{1,6}\s+/g, "")    // 标题
        .replace(/\*\*(.+?)\*\*/g, "$1")  // 加粗
        .replace(/\*(.+?)\*/g, "$1")      // 斜体
        .replace(/`(.+?)`/g, "$1")        // 行内代码
        .replace(/```[\s\S]*?```/g, "")   // 代码块
        .replace(/^\s*[-*]\s+/gm, "• ")   // 列表
        .replace(/^\s*\d+\.\s+/gm, (match) => match.replace(/\s+$/, " ")); // 有序列表保留
}

/**
 * 计算 token 额外费用
 */
function calculateTokenCost(totalTokens: number): number {
    if (totalTokens < COST_CONFIG.tokenThreshold) return 0;
    return Math.ceil((totalTokens - COST_CONFIG.tokenThreshold) / COST_CONFIG.tokenCostRate);
}

// ===== 命令注册 =====

export function registerTravelAssistantCommands(ctx: Context) {
    // 延迟初始化工具（避免阻塞插件加载）
    let initPromise: Promise<void> | null = null;
    function ensureTools(): Promise<void> {
        if (toolsInitialized) return Promise.resolve();
        if (!initPromise) {
            initPromise = initializeToolRegistry().catch((e) => {
                initPromise = null;
                throw e;
            });
        }
        return initPromise;
    }

    // 清理超时会话
    setInterval(() => {
        const now = Date.now();
        for (const [key, sess] of activeSessions) {
            if (now - sess.lastActivity > SESSION_TIMEOUT) {
                activeSessions.delete(key);
            }
        }
    }, 60000);

    // ===== 旅行助手命令 =====
    ctx
        .command("旅行助手")
        .alias("查火车票")
        .alias("火车票查询")
        .usage("智能行程规划助手（仅限私聊）\n支持连续对话，可追问修改方案")
        .action(async ({ session }) => {
            if (!session) return;

            // 仅限私聊
            if (!session.isDirect) {
                return "❌ 旅行助手仅限私聊使用，请私聊我发送「旅行助手」";
            }

            const sessionKey = `${session.userId}-${session.platform}`;

            // 检查是否已有会话
            if (activeSessions.has(sessionKey)) {
                return "❌ 你已有一个进行中的旅行助手会话\n发送「退出」可结束当前会话";
            }

            // 获取用户档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (!profiles?.length) {
                return "❌ 你还没有创建情缘档案，无法使用此功能";
            }

            const myProfile = profiles[0] as SoulProfile;

            // 检查余额
            if (myProfile.coins < COST_CONFIG.queryCost) {
                return `❌ 咕咕币不足（需 ${COST_CONFIG.queryCost}，当前 ${myProfile.coins}）`;
            }

            // 尝试初始化工具
            try {
                await ensureTools();
            } catch (e: any) {
                return `❌ MCP 服务连接失败，暂时不可用: ${e.message}`;
            }

            // 创建会话
            const travelSession: TravelSession = {
                userId: session.userId!,
                platform: session.platform!,
                messages: [],
                totalTokens: 0,
                totalCost: 0,
                queryCount: 0,
                lastActivity: Date.now(),
            };
            activeSessions.set(sessionKey, travelSession);

            return `🚄 旅行助手已启动！

💰 余额：${myProfile.coins} 咕咕币
💸 每次查询消费 ${COST_CONFIG.queryCost} 咕咕币

请直接输入你的出行需求，例如：
「从北京到上海，明天」
「广州到深圳，3月15号，最便宜的」
「成都到重庆，后天下午出发」

━━━━━━━━━━━━━━━
发送「退出」结束会话`;
        });

    // ===== 消息监听（处理连续对话） =====
    ctx.on("message", async (session) => {
        const sessionKey = `${session.userId}-${session.platform}`;
        const travelSession = activeSessions.get(sessionKey);

        // 不在会话中或不是私聊，忽略
        if (!travelSession || !session.isDirect) return;

        const input = session.content?.trim();
        if (!input) return;

        // 更新活动时间
        travelSession.lastActivity = Date.now();

        // 退出命令
        if (input === "退出" || input === "exit" || input === "结束") {
            activeSessions.delete(sessionKey);

            let summary = `👋 旅行助手已退出\n━━━━━━━━━━━━━━━\n`;
            summary += `📊 本次会话统计：\n`;
            summary += `   查询次数：${travelSession.queryCount}\n`;
            summary += `   消耗 Tokens：${travelSession.totalTokens.toLocaleString()}\n`;
            summary += `   总消费：${travelSession.totalCost} 咕咕币`;

            await session.send(summary);
            return;
        }

        // 检查余额
        const profiles = await ctx.database.get("soul_profiles", {
            userId: session.userId,
            platform: session.platform,
        });

        if (!profiles?.length) {
            activeSessions.delete(sessionKey);
            await session.send("❌ 档案异常，会话已结束");
            return;
        }

        const myProfile = profiles[0] as SoulProfile;

        if (myProfile.coins < COST_CONFIG.queryCost) {
            activeSessions.delete(sessionKey);
            await session.send(
                `❌ 咕咕币不足（需 ${COST_CONFIG.queryCost}，当前 ${myProfile.coins}）\n会话已结束`
            );
            return;
        }

        // 发送查询中提示
        await session.send(`🔍 正在规划中...`);

        // 扣除基础费用
        let newCoins = myProfile.coins - COST_CONFIG.queryCost;
        await ctx.database.set("soul_profiles", { id: myProfile.id }, { coins: newCoins, updatedAt: Date.now() });

        // AI 查询
        const { content, tokens } = await processUserMessage(travelSession, input);

        // 更新统计
        travelSession.totalTokens += tokens;
        travelSession.queryCount++;

        // 计算额外 token 费用
        const tokenCost = calculateTokenCost(tokens);
        if (tokenCost > 0) {
            newCoins -= tokenCost;
            await ctx.database.set("soul_profiles", { id: myProfile.id }, { coins: newCoins, updatedAt: Date.now() });
        }

        const totalCost = COST_CONFIG.queryCost + tokenCost;
        travelSession.totalCost += totalCost;

        // 构建响应
        let response = content;
        response += `\n\n━━━━━━━━━━━━━━━`;
        response += `\n📊 Tokens: ${tokens.toLocaleString()}`;
        response += `\n💰 消费: ${totalCost}${tokenCost > 0 ? `（基础${COST_CONFIG.queryCost}+超额${tokenCost}）` : ""}`;
        response += `\n💳 余额: ${newCoins}`;
        response += `\n💡 可继续追问或发送「退出」结束`;

        await session.send(response);
    });

    ctx.logger.info("旅行助手命令已加载");
}
