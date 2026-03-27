import { Context } from "koishi";
import { SoulProfile, SoulArchivedProfile, AIRequestData } from "../types";
import { ADMIN_IDS } from "../config";
import {
  AIProviders,
  normalizeMultipleServers,
  isAdminUserId,
} from "../utils/universal";
import { generateProfileEmbedding } from "../utils/match";
import axios from "axios";

// 问卷选项
const QUESTIONNAIRE_OPTIONS = [
  "很不符合我",
  "不太符合我",
  "一般",
  "比较符合我",
  "很符合我",
];

// 三观类问卷题目 - 合并整理版
// 筛选逻辑：标记出与“大众良性三观”背道而驰的回答
const QUESTIONNAIRE_VALUES_QUESTIONS = [
  {
    id: 1,
    question: "面对关系中的难题，我会优先坚持原则与对错，即使短期有点尴尬。",
    reverse: false, // 正向：坚持原则
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 2,
    question: "为了让另一半开心,我偶尔会牺牲自己的原则。",
    reverse: true, // 反向：缺乏底线/讨好型
    warning: ["比较符合我", "很符合我"],
  },
  {
    id: 3,
    question: "与另一半三观不同问题不大，只要互相包容就行。",
    reverse: false, // 正向：包容性 (原数据reverse为true，但大众三观通常认为包容是好事，此处修正为False，若你认为三观必须一致则改回True)
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 4,
    question: "如果另一半说的话让我觉得不舒服，我会直接指出来。",
    reverse: false, // 正向：直接沟通
    warning: ["很不符合我", "不太符合我", "一般"],
  },
  {
    id: 5,
    question: "我认为两个人在一起最重要的是性格互补。",
    reverse: false, // 中性/正向
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 6,
    question: "我可以接受异地恋，但要每天保持联系。",
    reverse: false, // 正向：维系关系意愿
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 7,
    question: "如果发现另一半有欺骗行为，我会立即结束关系。",
    reverse: false, // 正向：底线明确
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 8,
    question: "我希望在关系中保持一定的个人空间。",
    reverse: false, // 正向：独立性
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 9,
    question: "我会为了另一半改变自己的兴趣爱好。",
    reverse: true, // 反向：丧失自我
    warning: ["比较符合我", "很符合我"],
  },
  {
    id: 10,
    question: "我认为沟通是解决关系问题的唯一方法。",
    reverse: false, // 正向：重视沟通
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 11,
    question: "我能接受自己被对方当作备胎。",
    reverse: true, // 反向：高危/低自尊 (原reverse:false可能有误，此处修正为True)
    warning: ["比较符合我", "很符合我"],
  },
  {
    id: 12,
    question: "我会尊重另一半的隐私，不会查看对方的手机。",
    reverse: false, // 正向：信任与边界 (原数据warning为“符合”，逻辑有误，已修正为“不符合”才预警)
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 13,
    question: "如果另一半需要我的帮助，我会放下手中的事情去帮助他/她。",
    reverse: false, // 正向：支持伴侣
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 14,
    question: "我认为在关系中应该互相支持对方的事业或学业。",
    reverse: false, // 正向：共同成长
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 15,
    question: "我会为了另一半妥协自己的生活习惯。",
    reverse: true, // 反向：过度妥协
    warning: ["比较符合我", "很符合我"],
  },

  // --- 第二组数据新增 (沟通细节与深层性格) ---
  // 已去除与Set 1重复的题目(如备胎、查手机等)，ID顺延
  {
    id: 16,
    question: "在亲密关系中，我会主动维护各自的个人空间和独处时间。",
    reverse: false, // 正向：边界感
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 17,
    question: "我希望另一半把大部分时间与注意力都放在我身上。",
    reverse: true, // 反向：依恋焦虑/控制欲
    warning: ["比较符合我", "很符合我"],
  },
  {
    id: 18,
    question: "当我感到被越界时，我能清楚表达界限并提出具体做法。",
    reverse: false, // 正向：成熟沟通
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 19,
    question: "冲突过后，我会主动复盘、道歉并与对方约定改进方式。",
    reverse: false, // 正向：解决冲突能力
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 20,
    question: "遇到矛盾时，我常选择冷暴力处理（不回消息、拉黑或长时间回避）。",
    reverse: true, // 反向：冷暴力/高危
    warning: ["比较符合我", "很符合我"],
  },
  {
    id: 21,
    question: "遇到重大分歧时，我愿意寻求第三方或专业咨询的帮助。",
    reverse: false, // 正向：求助意愿
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 22,
    question:
      "当另一半在公共频道为一位有争议的人发声被他人解读为“喜欢对方”时，我会在下结论前先与另一半核实事实、理解动机，并共同约定边界。",
    reverse: false, // 正向：理性/信任 (对应原数据的Q12逻辑)
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 23,
    question: "转服、奔现等重大事项，我会与另一半共同讨论后再决定。",
    reverse: false, // 正向：尊重与共识
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 24,
    question: "为共同目标（如攒钱、学习、规划）我愿意持续投入时间与行动。",
    reverse: false, // 正向：长期主义
    warning: ["很不符合我", "不太符合我"],
  },
  {
    id: 25,
    question: "恋爱顺其自然最好，不必提前谈未来计划。",
    reverse: true, // 反向：回避责任/短视
    warning: ["比较符合我", "很符合我"],
  },
];

// 游戏类问卷题目
const QUESTIONNAIRE_GAME_QUESTIONS = [
  {
    id: 1,
    question: "剑网三的精髓是什么？（单选）",
    options: { A: "剑网三的精髓是什么？", B: "复制", C: "那当然是情缘啦" },
    correctAnswers: ["A", "B"],
  },
  {
    id: 2,
    question: "请说出七夕节任务与同一人连做三年的成就名（单选）",
    options: { A: "缘定三生", B: "执手三载", C: "三生相许" },
    correctAnswers: ["A"],
  },
  {
    id: 3,
    question: "咸鱼cos过的门派（单选）",
    options: { A: "刀宗", B: "七秀", C: "天策" },
    correctAnswers: ["A", "B"],
  },
];

// 登记档案的免责声明
const QUESTIONNAIRE_DISCLAIMER = `在填写档案之前，您需要先同意以下《渡渡鸟红娘免责声明》并完成问卷：
《渡渡鸟红娘免责声明》
1. 机器人只负责档案匹配，不会干涉双方交流（就算有收到关于双方任何一方的举报也不会第一时间进行通知或处理任何一方）
2. 如果真碰到逆天的，请在群公告中填写举报问卷或者私聊管理员，而不是秋后结算跳出来质问作者，诸如："早干嘛去了"或其他内容
3. 如果对作者的中立态度有疑问，你声音大你对，觉得不合理可以退群

（问卷只是为了标记一些可能会有的问题，并不代表会阻碍你填写档案）
渡渡鸟使用的AI所需费用都来自作者自掏腰包，请珍惜作者钱包（不支持任何形式的赞助）
请回复【同意】继续，或回复【退出】取消`;

// 问卷会话
interface QuestionnaireSession {
  userId: string;
  platform: string;
  step: "disclaimer" | "answering"; // disclaimer=免责声明, answering=答题中
  currentQuestionIndex: number; // 当前题目索引
  selectedQuestions: Array<{
    // 选中的题目
    id: number;
    question: string;
    type: "values" | "game"; // values=三观类, game=游戏类
    options?: any; // 选项（游戏类题目使用）
    correctAnswer?: string; // 正确答案（游戏类题目使用）
  }>;
  answers: Record<number, any>; // 题目id -> 答案
  startedAt: number;
  lastActivity: number;
}

// 进行中的问卷会话
const questionnaireSessions = new Map<string, QuestionnaireSession>();

// 随机抽题函数
function selectQuestions() {
  const selectedQuestions: QuestionnaireSession["selectedQuestions"] = [];

  // 1. 从游戏类抽取2道题
  const gameQuestions = [...QUESTIONNAIRE_GAME_QUESTIONS];
  const shuffledGames = gameQuestions.sort(() => Math.random() - 0.5);
  const selectedGames = shuffledGames.slice(0, 2);

  // 添加游戏题
  for (const game of selectedGames) {
    selectedQuestions.push({
      id: game.id,
      question: game.question,
      type: "game",
      options: game.options,
      correctAnswer: game.correctAnswers.join(","),
    });
  }

  // 2. 从三观类抽取3道题，必须包含第11和第12题
  const valueQuestions = [...QUESTIONNAIRE_VALUES_QUESTIONS];
  const requiredQ11 = valueQuestions.find((q) => q.id === 11)!;
  const requiredQ12 = valueQuestions.find((q) => q.id === 12)!;
  const otherValues = valueQuestions.filter((q) => q.id !== 11 && q.id !== 12);

  // 随机选择1道其他三观题
  const randomIndex = Math.floor(Math.random() * otherValues.length);
  const randomValue = otherValues[randomIndex];

  // 添加三观题
  selectedQuestions.push(
    {
      id: requiredQ11.id,
      question: requiredQ11.question,
      type: "values",
    },
    {
      id: requiredQ12.id,
      question: requiredQ12.question,
      type: "values",
    },
    {
      id: randomValue.id,
      question: randomValue.question,
      type: "values",
    }
  );

  // 打乱所有题目的顺序
  return selectedQuestions.sort(() => Math.random() - 0.5);
}

// 对话步骤
const DIALOGUE_STEPS = [
  {
    field: "servers",
    question:
      "请输入您的服务器（多个服务器用空格分隔）：\n例：飞龙在天 梦江南\n支持别名如：飞龙 双梦 念破 等",
    validate: (input: string) => {
      const { valid } = normalizeMultipleServers(input);
      return valid.length > 0;
    },
    error: "请输入有效的服务器名称",
  },
  {
    field: "characterName",
    question: "请输入您的主要角色名（只填一个大号）：",
    validate: (input: string) =>
      input.trim().length > 0 && !input.includes(" "),
    error: "请输入一个角色名，不要包含空格",
  },
  {
    field: "characterTypes",
    question:
      "请输入您的角色类型（多个用空格分隔）：\n例：喵哥 歌萝 琴爹 扇爹 段娘\n常见类型：花姐、秀萝、道长、军爷、黄鸡、毒姐、炮哥、喵哥、丐哥、苍爹、琴爹、扇爹、段娘等",
    validate: (input: string) => input.trim().length > 0,
    error: "角色类型不能为空",
  },
  {
    field: "gameplay",
    question:
      "请选择您的主要玩法（可多选，用空格分隔）：\nPVP PVE 其他\n例：PVP PVE",
    validate: (input: string) => {
      const valid = ["PVP", "PVE", "其他"];
      const items = input.toUpperCase().split(/\s+/);
      return items.every((item) => valid.includes(item));
    },
    error: "请输入正确的玩法：PVP、PVE、其他",
  },
  {
    field: "gender",
    question: "请输入您的真实性别（男/女）：",
    validate: (input: string) => ["男", "女"].includes(input),
    error: "请输入：男 或 女",
  },
  {
    field: "preferGender",
    question: "请输入您期待对方的性别（男/女/不限）：",
    validate: (input: string) => ["男", "女", "不限"].includes(input),
    error: "请输入：男、女 或 不限",
  },
  {
    field: "expectations",
    question:
      "请输入您的个人期待（对另一半的要求、避雷点等，重要！请包含期待的体型）：\n例：希望找个花姐或秀萝，要活泼开朗，能一起打本，避雷PVP狂魔",
    validate: (input: string) => input.trim().length > 10,
    error: "请详细描述您的期待（至少10个字）",
  },
  {
    field: "introduction",
    question: "请输入自我介绍（展示您的个性，吸引匹配对象）：",
    validate: (input: string) => input.trim().length > 10,
    error: "请详细介绍自己（至少10个字）",
  },
  {
    field: "crossServer",
    question: "是否接受跨服（是/否）：",
    validate: (input: string) => ["是", "否"].includes(input),
    error: "请输入：是 或 否",
  },
  {
    field: "realMeetup",
    question: "是否接受涉三/奔现（是/否）：",
    validate: (input: string) => ["是", "否"].includes(input),
    error: "请输入：是 或 否",
  },
  {
    field: "birthYear",
    question: "请输入您的出生年份（4位数字，如1998，选填，回复“跳过”可不填）：",
    validate: (input: string) => {
      if (input === "跳过" || input.toLowerCase() === "skip") return true;
      const year = parseInt(input);
      return !isNaN(year) && year >= 1950 && year <= new Date().getFullYear();
    },
    error: "请输入有效的4位年份（如1998）或回复“跳过”",
  },
  {
    field: "location",
    question: "请输入您的IP属地/常驻地（如：粤、川、北京，选填，回复“跳过”可不填）：",
    validate: (input: string) => input.trim().length > 0,
    error: "请输入有效的地区或回复“跳过”",
  },
];

// 进行中的对话会话
interface DialogueSession {
  userId: string;
  platform: string;
  step: number;
  data: Record<string, any>;
  lastActivity: number;
  currentField?: any;
  originalData?: any;
}

const dialogueSessions = new Map<string, DialogueSession>();

// 敏感内容检测提示语
const SENSITIVE_CHECK_PROMPT = `请检查以下游戏档案内容是否包含严重违规内容。

仅在出现以下严重问题时才标记为不安全：
1. 明确的政治敏感内容
2. 明显的色情暴力内容
3. 明确的违法犯罪内容
4. 恶意人身攻击言论

注意：普通的游戏术语、角色扮演内容、情感表达等都应视为安全。

返回JSON格式：
{
  "safe": true/false,
  "reason": "检测到的问题类型"
}`;

// 静默内容审核
async function silentContentReview(
  ctx: Context,
  profile: any,
  userId: string,
  platform: string
) {
  try {
    // 使用豆包 1.6 Lite 进行敏感内容检测
    // 选择火山方舟供应商
    const provider = AIProviders.find(
      (p) => p.modelProvider.name === "火山方舟"
    );
    if (!provider) {
      ctx.logger.error("未找到豆包AI供应商配置");
      return;
    }

    // 选择豆包 1.6 Lite 模型
    const model = provider.models.find(
      (m) => m.id === "doubao-seed-1-6-lite-251015"
    );
    if (!model) {
      ctx.logger.error("未找到豆包 1.6 Lite 模型配置");
      return;
    }

    // 构建请求数据
    const requestData: AIRequestData = {
      model: model.id,
      messages: [
        {
          role: "system",
          content: SENSITIVE_CHECK_PROMPT,
        },
        {
          role: "user",
          content: `游戏档案内容：
角色名：${profile.characterName}
个人期待：${profile.expectations}
自我介绍：${profile.introduction}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 200,
    };

    // 调用AI API
    const response = await axios.post(provider.modelProvider.url, requestData, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.modelProvider.accessToken}`,
      },
      timeout: 180000, // 3分钟超时，避免审核失败
    });

    // 解析响应
    const aiResponse = response.data.choices[0].message.content;
    const result = JSON.parse(aiResponse);

    if (!result.safe) {
      // 静默通知管理员，不通知用户
      ctx.logger.warn(
        `静默审核发现可疑内容 - 用户: ${userId}, 平台: ${platform}, 原因: ${result.reason}`
      );
    }
  } catch (error) {
    ctx.logger.error("静默审核失败:", error);
  }
}

// 对话处理函数
async function handleDialogue(ctx: Context, session: any): Promise<boolean> {
  const key = `${session.platform}:${session.userId}`;
  const dialogue = dialogueSessions.get(key);

  if (!dialogue) return false;
  dialogue.lastActivity = Date.now();

  // 处理退出
  if (session.content === "退出" || session.content === "取消") {
    dialogueSessions.delete(key);
    await session.send("已退出登记流程");
    return true;
  }

  // 处理字段输入步骤（step === -4）
  if (dialogue.step === -4) {
    const fieldMapping = dialogue.currentField;
    if (!fieldMapping) {
      await session.send("❌ 对话流程出错，请重新开始");
      dialogueSessions.delete(key);
      return true;
    }

    if (!fieldMapping.validate(session.content || "")) {
      await session.send(fieldMapping.error);
      return true;
    }

    // 保存字段值
    if (fieldMapping.field === "servers") {
      const { valid } = normalizeMultipleServers(session.content || "");
      dialogue.data[fieldMapping.field] = valid.join(" ");
    } else {
      // 处理跳过逻辑
      if (session.content === "跳过" || session.content?.toLowerCase() === "skip") {
        dialogue.data[fieldMapping.field] = null;
      } else if (fieldMapping.field === "birthYear") {
        dialogue.data[fieldMapping.field] = parseInt(session.content || "0");
      } else {
        dialogue.data[fieldMapping.field] = (session.content || "").trim();
      }
    }

    await session.send("✅ 已更新该项目");

    // 返回选择菜单
    dialogue.step = -2;
    let message = "📝 选择要更新的档案项目：\n\n";
    message += "1. 服务器\n";
    message += "2. 角色名\n";
    message += "3. 角色类型\n";
    message += "4. 主要玩法\n";
    message += "5. 个人期待\n";
    message += "6. 自我介绍\n";
    message += "7. 真实性别\n";
    message += "8. 期待对方性别\n";
    message += "9. 是否接受跨服\n";
    message += "10. 是否接受涉三/奔现\n";
    message += "11. 出生年份\n";
    message += "12. IP属地\n";
    message += "0. 保存并完成更新\n";
    message += "99. 退出不保存\n\n";
    message += "请输入要修改项目的序号：";

    await session.send(message);
    return true;
  }

  // 特殊处理选择性更新菜单（step === -2）
  if (dialogue.step === -2) {
    const choice = parseInt(session.content || "0");

    if (choice === 0) {
      // 保存并完成更新
      const completeProfile = {
        ...dialogue.data.originalData, // 原始数据作为基础
        ...dialogue.data, // 更新的数据覆盖
      };

      // 移除非档案字段
      delete completeProfile.id;
      delete completeProfile.originalData;

      // 保存到数据库
      const updateData = { ...completeProfile };
      updateData.updatedAt = Date.now();

      await ctx.database.set("soul_profiles", dialogue.data.id!, updateData);

      // 异步生成 embedding（不阻塞用户流程）
      generateProfileEmbedding(updateData as any, ctx).then(emb => {
        if (emb) {
          ctx.database.set("soul_profiles", dialogue.data.id!, { embedding: emb }).catch(() => { });
        }
      });

      // 静默审核内容
      await silentContentReview(
        ctx,
        completeProfile,
        session.userId!,
        session.platform!
      );

      await session.send("✅ 档案更新成功！");

      dialogueSessions.delete(key);
    } else if (choice >= 1 && choice <= 12) {
      // 选择要更新的字段
      const fieldMappings = [
        {
          field: "servers",
          question:
            "请输入新的服务器（多个服务器用空格分隔，如：飞龙在天 梦江南）：",
          validate: (input: string) => {
            const { valid } = normalizeMultipleServers(input);
            return valid.length > 0;
          },
          error: "请输入有效的服务器名称",
        },
        {
          field: "characterName",
          question: "请输入新的角色名：",
          validate: (input: string) =>
            input.trim().length > 0 && !input.includes(" "),
          error: "请输入一个角色名，不要包含空格",
        },
        {
          field: "characterTypes",
          question: "请输入新的角色类型（多个用空格分隔，如：喵哥 歌萝）：",
          validate: (input: string) => input.trim().length > 0,
          error: "角色类型不能为空",
        },
        {
          field: "gameplay",
          question: "请输入新的主要玩法（可多选，用空格分隔，如：PVP PVE）：",
          validate: (input: string) => {
            const valid = ["PVP", "PVE", "其他"];
            const items = input.toUpperCase().split(/\s+/);
            return items.every((item) => valid.includes(item));
          },
          error: "请输入正确的玩法：PVP、PVE、其他",
        },
        {
          field: "expectations",
          question: "请输入新的个人期待（对另一半的要求、避雷点等）：",
          validate: (input: string) => input.trim().length > 10,
          error: "请详细描述您的期待（至少10个字）",
        },
        {
          field: "introduction",
          question: "请输入新的自我介绍：",
          validate: (input: string) => input.trim().length > 10,
          error: "请详细介绍自己（至少10个字）",
        },
        {
          field: "gender",
          question: "请输入新的真实性别（男/女）：",
          validate: (input: string) => ["男", "女"].includes(input),
          error: "请输入：男 或 女",
        },
        {
          field: "preferGender",
          question: "请输入新的期待对方性别（男/女/不限）：",
          validate: (input: string) => ["男", "女", "不限"].includes(input),
          error: "请输入：男、女 或 不限",
        },
        {
          field: "crossServer",
          question: "请输入新的是否接受跨服（是/否）：",
          validate: (input: string) => ["是", "否"].includes(input),
          error: "请输入：是 或 否",
        },
        {
          field: "realMeetup",
          question: "请输入新的是否接受涉三/奔现（是/否）：",
          validate: (input: string) => ["是", "否"].includes(input),
          error: "请输入：是 或 否",
        },
        {
          field: "birthYear",
          question: "请输入新的出生年份（4位数字，如1998，选填，回复“跳过”可不填）：",
          validate: (input: string) => {
            if (input === "跳过" || input.toLowerCase() === "skip") return true;
            const year = parseInt(input);
            return !isNaN(year) && year >= 1950 && year <= new Date().getFullYear();
          },
          error: "请输入有效的4位年份（如1998）或回复“跳过”",
        },
        {
          field: "location",
          question: "请输入新的IP属地/常驻地（如：粤、川、北京，选填，回复“跳过”可不填）：",
          validate: (input: string) => input.trim().length > 0,
          error: "请输入有效的地区或回复“跳过”",
        },
      ];

      const fieldMapping = fieldMappings[choice - 1];
      dialogue.currentField = fieldMapping;
      dialogue.step = -4; // 标记为字段输入步骤

      // 显示当前值
      const currentValue = dialogue.data[fieldMapping.field] || "未设置";
      await session.send(`当前值：${currentValue}\n\n${fieldMapping.question}`);
    } else if (choice === 99) {
      // 退出不保存
      dialogueSessions.delete(key);
      await session.send("已退出更新流程，未保存任何更改");
    } else {
      await session.send("请输入有效的序号（0-12, 99）");
    }
    return true;
  }

  // 处理确认步骤
  if (dialogue.step === DIALOGUE_STEPS.length) {
    const choice = session.content?.trim();

    if (choice === "1") {
      // 确认并保存
      const profile = {
        ...(dialogue.data as any),
        userId: session.userId!,
        platform: session.platform!,
        groupId: dialogue.data.groupId || "YOUR_GROUP_ID_1", // 默认群组
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await ctx.database.create("soul_profiles", profile);

      // 异步生成 embedding（不阻塞用户流程）
      generateProfileEmbedding(profile as any, ctx).then(emb => {
        if (emb) {
          ctx.database.set("soul_profiles", { userId: session.userId!, platform: session.platform! }, { embedding: emb }).catch(() => { });
        }
      });

      // 静默审核内容
      await silentContentReview(
        ctx,
        profile,
        session.userId!,
        session.platform!
      );

      await session.send("✅ 档案登记成功！");
      dialogueSessions.delete(key);
    } else if (choice === "2") {
      // 重新填写
      dialogue.step = 0;
      dialogue.data = { userId: session.userId!, platform: session.platform! };
      await session.send(DIALOGUE_STEPS[0].question);
    } else {
      await session.send("请输入正确的选项：1 或 2");
    }
    return true;
  }

  // 处理普通对话步骤
  if (dialogue.step < DIALOGUE_STEPS.length) {
    const step = DIALOGUE_STEPS[dialogue.step];
    if (step.validate(session.content || "")) {
      // 保存答案
      if (step.field === "servers") {
        const { valid } = normalizeMultipleServers(session.content || "");
        dialogue.data[step.field] = valid.join(" ");
      } else {
        // 处理跳过逻辑
        if (session.content === "跳过" || session.content?.toLowerCase() === "skip") {
          dialogue.data[step.field] = null;
        } else if (step.field === "birthYear") {
          dialogue.data[step.field] = parseInt(session.content || "0");
        } else {
          dialogue.data[step.field] = (session.content || "").trim();
        }
      }

      // 进入下一步
      dialogue.step += 1;

      if (dialogue.step < DIALOGUE_STEPS.length) {
        // 下一个问题
        await session.send(DIALOGUE_STEPS[dialogue.step].question);
      } else {
        // 最后一步，直接保存无需确认
        const profile = {
          ...dialogue.data,
          userId: session.userId!, // 确保包含用户ID
          platform: session.platform!, // 确保包含平台
          groupId: dialogue.data.groupId || "YOUR_GROUP_ID_1", // 默认群组ID
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        // 保存到数据库
        await ctx.database.create("soul_profiles", profile);

        // 异步生成 embedding（不阻塞用户流程）
        generateProfileEmbedding(profile as any, ctx).then(emb => {
          if (emb) {
            ctx.database.set("soul_profiles", { userId: session.userId!, platform: session.platform! }, { embedding: emb }).catch(() => { });
          }
        });

        // 静默审核内容
        await silentContentReview(
          ctx,
          profile,
          session.userId!,
          session.platform!
        );

        await session.send("✅ 档案登记成功！");
        dialogueSessions.delete(key);
      }
      return true;
    } else {
      // 验证失败
      await session.send(step.error);
      return true;
    }
  }

  return false;
}

// 用户封存档案命令
export function registerArchiveCommands(ctx: Context) {
  // 使用ctx.logger记录日志
  const logger = ctx.logger;

  // 监听用户消息，处理对话和问卷
  ctx.on("message", async (session) => {
    if (session.isDirect) {
      // 处理问卷会话
      const sessionKey = `${session.userId}-${session.platform}`;
      const questionnaireSession = questionnaireSessions.get(sessionKey);

      if (questionnaireSession && session.content) {
        const input = session.content.trim();

        // 处理退出命令
        if (input === "退出" || input === "取消") {
          questionnaireSessions.delete(sessionKey);
          await session.send("已退出问卷填写");
          return;
        }

        // 免责声明阶段
        if (questionnaireSession.step === "disclaimer") {
          if (input === "同意") {
            // 检查问卷是否已经完成
            const existingResult = await ctx.database.get(
              "questionnaire_results",
              {
                userId: session.userId!,
                platform: session.platform!,
                passed: true,
              }
            );

            if (existingResult.length > 0) {
              // 问卷已完成，直接开始档案登记流程
              questionnaireSessions.delete(sessionKey);

              // 开始档案登记流程
              const key = `${session.platform}:${session.userId}`;
              dialogueSessions.set(key, {
                userId: session.userId!,
                platform: session.platform!,
                step: 0,
                data: {},
                lastActivity: Date.now(),
              });

              await session.send(
                "✅ 您已同意免责条款且问卷已完成，现在开始登记档案\n\n" +
                DIALOGUE_STEPS[0].question
              );
              return;
            }

            // 问卷未完成，开始答题
            questionnaireSession.step = "answering";
            questionnaireSession.currentQuestionIndex = 0;
            questionnaireSession.lastActivity = Date.now();
            questionnaireSessions.set(sessionKey, questionnaireSession);

            const firstQ = questionnaireSession.selectedQuestions[0];
            let message = `✅ 您已同意免责条款\n\n现在开始问卷（共${questionnaireSession.selectedQuestions.length}题）\n\n第1题：${firstQ.question}\n\n`;

            if (firstQ.type === "values") {
              message += QUESTIONNAIRE_OPTIONS.map(
                (opt, idx) => `${idx + 1}. ${opt}`
              ).join("\n");
              message += "\n\n请输入选项数字（1-5）";
            } else if (firstQ.type === "game") {
              // 显示游戏题选项
              for (const [key, value] of Object.entries(firstQ.options!)) {
                message += `${key}. ${value}\n`;
              }
              message += "\n\n请输入选项字母（如A、B、C）";
            }
            await session.send(message);
            return;
          } else {
            await session.send("请输入【同意】以继续，或【退出】以取消");
            return;
          }
        }

        // 答题阶段
        if (questionnaireSession.step === "answering") {
          const currentQ =
            questionnaireSession.selectedQuestions[
            questionnaireSession.currentQuestionIndex
            ];

          if (currentQ.type === "values") {
            const answerIndex = parseInt(input) - 1;
            if (
              answerIndex >= 0 &&
              answerIndex < QUESTIONNAIRE_OPTIONS.length
            ) {
              questionnaireSession.answers[currentQ.id] =
                QUESTIONNAIRE_OPTIONS[answerIndex];
            } else {
              await session.send(
                `请输入正确的选项数字（1-${QUESTIONNAIRE_OPTIONS.length}）`
              );
              return;
            }
          } else if (currentQ.type === "game") {
            // 游戏题答案处理：保留用户输入的原始字母
            const normalizedAnswer = input.toUpperCase().trim();
            // 简单验证：确保输入是字母
            if (/^[A-Z]$/.test(normalizedAnswer)) {
              questionnaireSession.answers[currentQ.id] = normalizedAnswer;
            } else {
              await session.send("请输入正确的选项字母（如A、B、C）");
              return;
            }
          }

          // 进入下一题或完成
          questionnaireSession.currentQuestionIndex += 1;
          questionnaireSession.lastActivity = Date.now();

          if (
            questionnaireSession.currentQuestionIndex <
            questionnaireSession.selectedQuestions.length
          ) {
            // 下一题
            const nextQ =
              questionnaireSession.selectedQuestions[
              questionnaireSession.currentQuestionIndex
              ];
            let message = `第${questionnaireSession.currentQuestionIndex + 1
              }题：${nextQ.question}\n\n`;

            if (nextQ.type === "values") {
              message += QUESTIONNAIRE_OPTIONS.map(
                (opt, idx) => `${idx + 1}. ${opt}`
              ).join("\n");
              message += "\n\n请输入选项数字（1-5）";
            } else if (nextQ.type === "game") {
              // 显示游戏题选项
              for (const [key, value] of Object.entries(nextQ.options!)) {
                message += `${key}. ${value}\n`;
              }
              message += "\n\n请输入选项字母（如A、B、C）";
            }
            await session.send(message);
            questionnaireSessions.set(sessionKey, questionnaireSession);
          } else {
            // 完成问卷
            questionnaireSessions.delete(sessionKey);

            // 检查是否有任何答案匹配warning字段
            const warnings: { question: string; answer: string }[] = [];
            for (const [qId, answer] of Object.entries(questionnaireSession.answers)) {
              // 找到对应的原始问题
              const valueQuestion = QUESTIONNAIRE_VALUES_QUESTIONS.find(q => q.id === parseInt(qId));
              if (valueQuestion && valueQuestion.warning) {
                // 检查答案是否在warning列表中
                if (valueQuestion.warning.includes(answer)) {
                  warnings.push({
                    question: valueQuestion.question,
                    answer: answer
                  });
                }
              }
            }

            // 如果有warning答案，通知管理员
            if (warnings.length > 0) {
              // 构建警告消息
              let warningMessage = `⚠️ 问卷警告通知\n\n用户ID：${session.userId}\n平台：${session.platform}\n完成时间：${new Date().toLocaleString()}\n\n`;
              warningMessage += "匹配到以下警告答案：\n";
              for (const w of warnings) {
                warningMessage += `\n问题：${w.question}\n答案：${w.answer}\n`;
              }

              // 获取当前bot
              const bot = session.bot;
              if (bot) {
                // 发送警告给所有管理员
                for (const adminId of ADMIN_IDS) {
                  try {
                    // 构造私人消息频道ID
                    const privateChannelId = `private:${adminId}`;
                    await bot.sendMessage(privateChannelId, warningMessage);
                    logger.info(`已向管理员 ${adminId} 发送问卷警告通知`);
                  } catch (error) {
                    logger.error(`向管理员 ${adminId} 发送问卷警告通知失败：${error}`);
                  }
                }
              }
            }

            // 保存问卷结果
            await ctx.database.upsert("questionnaire_results", [
              {
                userId: session.userId!,
                platform: session.platform!,
                passed: true,
                passedAt: Date.now(),
                answers: JSON.stringify(questionnaireSession.answers),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ]);

            await session.send(
              "✅ 问卷已完成！\n\n请重新发送【登记档案】命令以继续档案登记流程"
            );
            return;
          }
        }
      }

      // 处理对话
      await handleDialogue(ctx, session);
    }
  });

  // 用户封存档案命令
  ctx
    .command("封存档案")
    .alias("封存我的档案")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return;

      try {
        // 检查用户是否有档案
        const profiles = await ctx.database.get("soul_profiles", {
          userId: session.userId,
          platform: session.platform,
        });

        if (profiles.length === 0) {
          return "❌ 您还没有档案，无法封存";
        }

        const profile = profiles[0] as SoulProfile;

        // 检查档案是否已经被封存（且未解封）
        const existingArchive = await ctx.database.get(
          "soul_archived_profiles",
          {
            profileId: profile.id!,
            unArchivedAt: null,
          }
        );

        if (existingArchive.length > 0) {
          return `❌ 您的档案已经被封存\n封存时间：${new Date(
            existingArchive[0].archivedAt
          ).toLocaleString()}\n封存原因：${existingArchive[0].archiveReason}`;
        }

        // 使用 upsert 创建或更新封存记录
        // 这样可以处理之前被解封的档案重新封存的情况
        await ctx.database.upsert("soul_archived_profiles", [
          {
            userId: profile.userId,
            platform: profile.platform,
            groupId: profile.groupId,
            profileId: profile.id!,
            archivedBy: session.userId,
            archiveReason: "用户主动封存",
            archivedAt: Date.now(),
            unArchivedAt: null,
            unArchivedBy: "",
          },
        ], ["profileId"]);

        logger.info(
          `用户 ${session.userId} 封存了自己的档案 ${profile.id} (${profile.characterName})`
        );
        return `✅ 已封存您的档案\n角色名：${profile.characterName
          }\n封存时间：${new Date().toLocaleString()}\n\n📝 档案封存后将不会参与匹配，如需重新参与请使用"解封档案"命令`;
      } catch (error) {
        logger.error("用户封存档案失败:", error);
        return `❌ 封存失败: ${error instanceof Error ? error.message : "未知错误"
          }`;
      }
    });

  // 用户解封档案命令
  ctx
    .command("解封档案")
    .alias("解封我的档案")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return;

      try {
        // 检查用户是否有档案
        const profiles = await ctx.database.get("soul_profiles", {
          userId: session.userId,
          platform: session.platform,
        });

        if (profiles.length === 0) {
          return "❌ 您还没有档案";
        }

        const profile = profiles[0] as SoulProfile;

        // 检查档案是否被封存
        const archivedProfiles = await ctx.database.get(
          "soul_archived_profiles",
          {
            profileId: profile.id!,
            unArchivedAt: null,
          }
        );

        if (archivedProfiles.length === 0) {
          return "❌ 您的档案没有被封存";
        }

        const archivedProfile = archivedProfiles[0] as SoulArchivedProfile;

        // 更新封存记录，标记为已解封
        await ctx.database.set(
          "soul_archived_profiles",
          { id: archivedProfile.id! },
          {
            unArchivedAt: Date.now(),
            unArchivedBy: session.userId,
          }
        );

        logger.info(
          `用户 ${session.userId} 解封了自己的档案 ${profile.id} (${profile.characterName})`
        );
        return `✅ 已解封您的档案\n角色名：${profile.characterName
          }\n解封时间：${new Date().toLocaleString()}\n\n📝 档案已恢复，可以参与匹配`;
      } catch (error) {
        logger.error("用户解封档案失败:", error);
        return `❌ 解封失败: ${error instanceof Error ? error.message : "未知错误"
          }`;
      }
    });

  // 用户删除档案命令
  ctx
    .command("删除档案")
    .alias("删除情缘档案")
    .action(async ({ session }) => {
      if (!session?.userId || !session?.platform) return;

      const result = await ctx.database.remove("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      if (result.removed && result.removed > 0) {
        return "✅ 档案已删除";
      } else {
        return "您没有档案可删除";
      }
    });

  // 用户登记档案命令
  ctx
    .command("登记档案")
    .alias("登记情缘档案")
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) {
        return "请私聊使用此命令";
      }

      // 检查是否已有档案
      const existing = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      if (existing && existing.length > 0) {
        return '您已有档案，如需更新请使用"更新档案"命令';
      }

      // 开始问卷流程
      const sessionKey = `${session.userId}-${session.platform}`;
      const selectedQuestions = selectQuestions();

      questionnaireSessions.set(sessionKey, {
        userId: session.userId!,
        platform: session.platform!,
        step: "disclaimer",
        currentQuestionIndex: 0,
        selectedQuestions,
        answers: {},
        startedAt: Date.now(),
        lastActivity: Date.now(),
      });

      return QUESTIONNAIRE_DISCLAIMER;
    });

  // 用户更新档案命令
  ctx
    .command("更新档案")
    .alias("更新情缘档案")
    .action(async ({ session }) => {
      if (!session) return;
      if (!session.isDirect) {
        return "请私聊使用此命令";
      }

      // 检查是否有档案
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId,
        platform: session.platform,
      });

      if (!profiles || profiles.length === 0) {
        return '您还没有档案，请先使用"登记档案"创建';
      }

      const profile = profiles[0];
      const key = `${session.platform}:${session.userId}`;

      // 开始选择性更新对话，使用特殊步骤 -2 表示选择菜单
      dialogueSessions.set(key, {
        userId: session.userId!,
        platform: session.platform!,
        step: -2, // 特殊标记：选择更新菜单
        data: {
          ...profile,
          id: profile.id,
          originalData: { ...profile },
        } as any, // 保留原数据和ID
        lastActivity: Date.now(),
      });

      let message = "📝 选择要更新的档案项目：\n\n";
      message += "1. 服务器\n";
      message += "2. 角色名\n";
      message += "3. 角色类型\n";
      message += "4. 主要玩法\n";
      message += "5. 个人期待\n";
      message += "6. 自我介绍\n";
      message += "7. 真实性别\n";
      message += "8. 期待对方性别\n";
      message += "9. 是否接受跨服\n";
      message += "10. 是否接受涉三/奔现\n";
      message += "11. 出生年份\n";
      message += "12. IP属地\n";
      message += "0. 保存并完成更新\n";
      message += "99. 退出不保存\n\n";
      message += "请输入要修改项目的序号：";

      return message;
    });

  // 检测无效档案命令（管理员专用，仅检测不清除）
  ctx.command("检测无效档案").action(async ({ session }) => {
    if (!session?.userId || !session?.platform) return;

    // 验证管理员权限
    if (!isAdminUserId(session.userId)) {
      return "❌ 您没有权限执行此操作";
    }

    try {
      ctx.logger.info("开始检测无效档案...");

      // 定义有效群组（与旧插件保持一致）
      const validGroups = ["YOUR_GROUP_ID_1", "YOUR_GROUP_ID_2"];
      const allValidMembers = new Set<string>();

      for (const groupId of validGroups) {
        try {
          // 尝试获取群成员列表
          // 注意：此API可能需要机器人有群管理员权限或对应平台的特殊权限
          const members = await session.bot.internal.getGroupMemberList(
            groupId
          );
          if (members && Array.isArray(members)) {
            members.forEach((member) => {
              if (member.user_id) {
                allValidMembers.add(member.user_id.toString());
              }
            });
            ctx.logger.info(`群 ${groupId} 有 ${members.length} 个成员`);
          }
        } catch (error) {
          ctx.logger.warn(`获取群 ${groupId} 成员列表失败:`, error);
        }
      }

      ctx.logger.info(`总计有效成员数: ${allValidMembers.size}`);

      // 获取所有档案
      const allProfiles = await ctx.database.get("soul_profiles", {});

      // 找出无效档案（用户不在任何有效群聊中）
      const invalidProfiles = allProfiles.filter(
        (profile) => !allValidMembers.has(profile.userId)
      );

      if (invalidProfiles.length === 0) {
        return "✅ 没有发现无效档案，所有档案用户都在有效群聊中";
      }

      // 整理无效档案信息
      let message = `🚨 发现 ${invalidProfiles.length} 个无效档案（用户不在有效群聊中）：\n\n`;

      invalidProfiles.forEach((profile, index) => {
        message += `${index + 1}. 用户ID: ${profile.userId}\n`;
        message += `   角色名: ${profile.characterName}\n`;
        message += `   服务器: ${profile.servers}\n`;
        message += `   群组ID: ${profile.groupId}\n`;
        message += `   创建时间: ${new Date(profile.createdAt).toLocaleString(
          "zh-CN"
        )}\n\n`;
      });

      message += `\n💡 如需清除这些无效档案，请使用 "清除无效档案" 命令`;

      ctx.logger.info(`检测完成，发现 ${invalidProfiles.length} 个无效档案`);
      return message;
    } catch (error) {
      ctx.logger.error("检测无效档案失败:", error);
      return `❌ 检测失败: ${error instanceof Error ? error.message : "未知错误"
        }`;
    }
  });

  // 清除无效档案命令（管理员专用，支持群聊）
  ctx.command("清除无效档案").action(async ({ session }) => {
    if (!session?.userId || !session?.platform) return;

    // 验证管理员权限
    if (!isAdminUserId(session.userId)) {
      return "❌ 您没有权限执行此操作";
    }

    try {
      await session.send("🔍 开始检测无效档案...");
      ctx.logger.info("管理员开始检测无效档案...");

      // 定义有效群组（与旧插件保持一致）
      const validGroups = ["YOUR_GROUP_ID_1", "YOUR_GROUP_ID_2"];
      const allValidMembers = new Set<string>();

      for (const groupId of validGroups) {
        try {
          // 尝试获取群成员列表
          const members = await session.bot.internal.getGroupMemberList(
            groupId
          );
          if (members && Array.isArray(members)) {
            members.forEach((member) => {
              if (member.user_id) {
                allValidMembers.add(member.user_id.toString());
              }
            });
          }
        } catch (error) {
          ctx.logger.warn(`获取群 ${groupId} 成员列表失败: ${error}`);
          continue;
        }
      }

      if (allValidMembers.size === 0) {
        return "❌ 无法获取群成员列表，检测中止";
      }

      // 获取所有档案
      const allProfiles = await ctx.database.get("soul_profiles", {});

      // 筛选出无效档案（用户不在任何有效群聊中）
      const invalidProfiles = allProfiles.filter((profile) => {
        return !allValidMembers.has(profile.userId);
      });

      if (invalidProfiles.length === 0) {
        return "✅ 未发现无效档案，所有档案均有效";
      }

      await session.send(
        `📊 发现 ${invalidProfiles.length} 个无效档案，开始清除...`
      );

      // 直接清除无效档案
      let deletedCount = 0;
      for (const profile of invalidProfiles) {
        try {
          await ctx.database.remove("soul_profiles", { id: profile.id! });
          deletedCount++;
        } catch (error) {
          ctx.logger.warn(`删除档案 ${profile.id} 失败: ${error}`);
        }
      }

      const resultMessage = `✅ 清除完成！
📊 检测到无效档案: ${invalidProfiles.length} 个
🗑️ 成功清除: ${deletedCount} 个
${deletedCount < invalidProfiles.length
          ? `⚠️ 清除失败: ${invalidProfiles.length - deletedCount} 个`
          : ""
        }`;

      ctx.logger.info(
        `无效档案清除完成，成功删除 ${deletedCount}/${invalidProfiles.length} 个档案`
      );
      return resultMessage;
    } catch (error) {
      ctx.logger.error("清除无效档案失败:", error);
      return `❌ 操作失败: ${error instanceof Error ? error.message : "未知错误"
        }`;
    }
  });

  logger.info("封存档案组件已经加载成功");
}
export function registerResetExclusionListCommand(ctx: Context) {
  ctx
    .command("重置排除列表")
    .alias("清空排除列表")
    .action(async ({ session }) => {
      if (!session) {
        return "？";
      }

      const userId = session.userId!;
      const platform = session.platform!;

      try {
        // 1. 检查是否有排除记录
        const exclusions = await ctx.database.get("soul_exclusions", {
          userId,
          platform,
        });
        if (exclusions.length === 0) {
          return `<at id="${userId}" /> 你的排除列表已经是空的了！`;
        }

        // 2. 获取用户档案和咕咕币余额
        const profile = await ctx.database.get("soul_profiles", {
          userId,
          platform,
        });
        if (profile.length === 0) {
          return "您还没有档案，无法使用此功能。";
        }

        const userCoins = profile[0].coins;

        // 3. 获取指令使用次数
        const usage = await ctx.database.get("soul_command_usage", {
          userId,
          platform,
          command: "重置排除列表",
        });

        let usageCount = 0;
        if (usage.length > 0) {
          usageCount = usage[0].count;
        }

        // 4. 计算费用
        let cost = 0;
        if (usageCount === 0) {
          cost = 200;
        } else if (usageCount === 1) {
          cost = 500;
        } else {
          cost = 1000;
        }

        // 5. 检查咕咕币是否足够
        if (userCoins < cost) {
          return `您的咕咕币不足，需要 ${cost} 咕咕币，当前余额 ${userCoins}。`;
        }

        // 6. 重置排除列表
        const result = await ctx.database.remove("soul_exclusions", {
          userId,
          platform,
        });

        if (result.matched && result.matched > 0) {
          // 7. 扣除咕咕币
          const afterCoins = userCoins - cost;
          await ctx.database.set(
            "soul_profiles",
            { userId, platform },
            { coins: afterCoins }
          );

          // 8. 更新指令使用次数
          if (usage.length > 0) {
            await ctx.database.set(
              "soul_command_usage",
              { id: usage[0].id },
              { count: usageCount + 1, updatedAt: Date.now() }
            );
          } else {
            await ctx.database.create("soul_command_usage", {
              userId,
              platform,
              command: "重置排除列表",
              count: 1,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }

          return `<at id="${userId}" /> 你的排除列表已经重置好了！本次消费 ${cost} 咕咕币，剩余 ${afterCoins} 咕咕币。`;
        } else {
          return `<at id="${userId}" /> 操作失败，请稍后重试。`;
        }
      } catch (error) {
        ctx.logger.error(`重置排除列表失败: ${error}`);
        return "重置排除列表时发生错误，请稍后再试。";
      }
    });
}
// 用户查看档案命令（只能查看自己的）
export function registerViewProfileCommand(ctx: Context) {
  ctx
    .command("查看档案")
    .alias("我的情缘档案")
    .alias("查看情缘档案")
    .action(async ({ session }) => {
      if (!session) return;

      // 检查是否是私聊
      if (!session.isDirect) {
        return "仅限私聊使用";
      }

      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });

      if (!profiles || profiles.length === 0) {
        return '您还没有档案，请使用"登记档案"创建';
      }

      const profile = profiles[0];
      let message = "📋 您的情缘档案：\n\n";

      message += `服务器：${profile.servers}\n`;
      message += `角色名：${profile.characterName}\n`;
      message += `角色类型：${profile.characterTypes}\n`;
      message += `主要玩法：${profile.gameplay}\n`;
      message += `真实性别：${profile.gender}\n`;
      message += `期待对方：${profile.preferGender}\n`;
      message += `跨服：${profile.crossServer} | 涉三：${profile.realMeetup}\n`;

      // 显示年龄和属地
      if (profile.birthYear) {
        const currentYear = new Date().getFullYear();
        const age = currentYear - profile.birthYear;
        message += `年龄：${age}岁（${profile.birthYear}年生）\n`;
      } else {
        message += `年龄：未填写\n`;
      }
      message += `IP属地：${profile.location || "未填写"}\n`;

      message += `\n个人期待：${profile.expectations}\n\n`;
      message += `自我介绍：${profile.introduction}`;

      // 查询单相思状态
      const whitelist = await ctx.database.get("soul_match_whitelist", {
        userId: session.userId!,
        platform: session.platform!,
        defaultExclude: true,
      });
      if (whitelist.length > 0) {
        const targetProfiles = await ctx.database.get("soul_profiles", {
          userId: whitelist[0].whitelistedUserId,
        });
        const targetName = targetProfiles.length > 0
          ? targetProfiles[0].characterName || whitelist[0].whitelistedUserId
          : whitelist[0].whitelistedUserId;
        message += `\n\n💘 单相思模式已开启\n目标：${targetName}（${whitelist[0].whitelistedUserId}）`;
      }

      return message;
    });

  // 管理员检查用户是否有档案（支持批量）
  ctx.command("检查档案 <userIds>").action(async ({ session }, userIds) => {
    if (!session || !session.isDirect) return "请私聊使用此命令。";
    if (!isAdminUserId(session.userId!)) return "❌ 您没有权限执行此操作";
    if (!userIds)
      return "格式错误，请使用：检查档案 123456\n或批量：检查档案 123456,789012";

    // 处理单个或多个用户ID（支持逗号分隔）
    const userIdList = userIds.split(",").map((id) => id.trim());
    const hasProfileUsers: string[] = [];
    const noProfileUsers: string[] = [];
    const hasFriendProfileUsers: string[] = [];
    const noFriendProfileUsers: string[] = [];

    for (const userId of userIdList) {
      try {
        // 检查用户是否有档案
        const profiles = await ctx.database.get("soul_profiles", {
          userId,
        });

        if (profiles && profiles.length > 0) {
          hasProfileUsers.push(userId);
        } else {
          noProfileUsers.push(userId);
        }
      } catch (error) {
        noProfileUsers.push(userId);
      }

      // 检查jx3-specfriends亲友档案
      try {
        const friendProfiles = await ctx.database.get("spec_friends_profiles", {
          userId,
        });

        if (friendProfiles && friendProfiles.length > 0) {
          hasFriendProfileUsers.push(userId);
        } else {
          noFriendProfileUsers.push(userId);
        }
      } catch (error) {
        // 如果表不存在或其他错误，不处理
        ctx.logger.info(`检查亲友档案失败 (${userId})：${error.message}`);
        noFriendProfileUsers.push(userId);
      }
    }

    let result = `✅ 档案检查完成：\n\n`;

    if (hasProfileUsers.length > 0) {
      result += `已创建情缘档案：${hasProfileUsers.join(", ")}\n`;
    }

    if (noProfileUsers.length > 0) {
      result += `未创建情缘档案：${noProfileUsers.join(", ")}\n`;
    }

    result += `\n--- 亲友档案检查 --- \n`;

    if (hasFriendProfileUsers.length > 0) {
      result += `已创建亲友档案：${hasFriendProfileUsers.join(", ")}\n`;
    }

    if (noFriendProfileUsers.length > 0) {
      result += `未创建亲友档案：${noFriendProfileUsers.join(", ")}\n`;
    }

    return result;
  });
}
