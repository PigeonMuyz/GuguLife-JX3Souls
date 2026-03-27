import { Context } from "koishi";
import { SoulProfile } from "../types";
import * as fs from "fs";
import * as path from "path";

// 配置
const QUESTION_TIMEOUT_MS = 30 * 1000; // 30秒超时
const MAX_QUESTIONS = 20;
const MIN_BALANCE = -100; // 最低余额
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 题目接口
interface QuizQuestion {
    question: string;
    options: string[];
    answer: string; // A/B/C/D
}

// 活跃答题会话
interface QuizSession {
    userId: string;
    platform: string;
    currentQuestion: number;
    accumulatedReward: number;
    questions: QuizQuestion[];
    timeoutTimer?: ReturnType<typeof setTimeout>;
}

const activeQuizSessions = new Map<string, QuizSession>();

/**
 * 获取当前周应该使用的题库
 */
function getCurrentQuizFile(ctx: Context): string | null {
    const quizDir = path.join(__dirname, "../config/quizzes");

    if (!fs.existsSync(quizDir)) {
        fs.mkdirSync(quizDir, { recursive: true });
        return null;
    }

    const files = fs.readdirSync(quizDir).filter(f => f.endsWith(".json")).sort();
    if (files.length === 0) return null;

    // 根据当前周数选择题库
    const weekNumber = Math.floor(Date.now() / WEEK_MS);
    const quizIndex = weekNumber % files.length;

    return path.join(quizDir, files[quizIndex]);
}

/**
 * 加载题库
 */
function loadQuizQuestions(filePath: string): QuizQuestion[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const questions = JSON.parse(content) as QuizQuestion[];
        return questions.slice(0, MAX_QUESTIONS);
    } catch (e) {
        return [];
    }
}

/**
 * 计算奖励（每题+10，每10题额外+50）
 */
function getReward(questionNumber: number): number {
    const base = 10;
    const bonus = questionNumber % 10 === 0 ? 50 : 0;
    return base + bonus;
}

/**
 * 计算惩罚（固定20）
 */
function getPenalty(questionNumber: number): number {
    return 20;
}

/**
 * 获取本周开始时间
 */
function getWeekStart(): number {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // 周一为本周开始
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diff);
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

/**
 * 注册咕咕周测命令
 */
export function registerQuizCommands(ctx: Context) {
    // 开始答题命令
    ctx
        .command("咕咕周测")
        .action(async ({ session }) => {
            if (!session) return;

            // 必须私聊
            if (!session.isDirect) {
                return "❌ 咕咕周测只能在私聊中进行";
            }

            const sessionKey = `${session.userId}-${session.platform}`;

            // 检查是否有进行中的会话
            if (activeQuizSessions.has(sessionKey)) {
                return "❌ 你已经有一场进行中的周测，请先完成或等待超时";
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

            // 检查本周是否已参与
            const weekStart = getWeekStart();
            const usageRecords = await ctx.database.get("soul_command_usage", {
                userId: session.userId!,
                platform: session.platform!,
                command: "weekly_quiz",
            });

            if (usageRecords.length > 0 && usageRecords[0].updatedAt >= weekStart) {
                return "❌ 本周已参与过咕咕周测，下周再来吧~";
            }

            // 检查余额（第一题惩罚为20）
            const firstPenalty = getPenalty(1);
            if (myProfile.coins < firstPenalty + MIN_BALANCE) {
                return `❌ 余额不足！周测第一题答错将扣${firstPenalty}币，你需要至少${firstPenalty + MIN_BALANCE}咕咕币`;
            }

            // 加载题库
            const quizFile = getCurrentQuizFile(ctx);
            if (!quizFile) {
                return "❌ 题库未准备好，请联系管理员";
            }

            const questions = loadQuizQuestions(quizFile);
            if (questions.length === 0) {
                return "❌ 题库为空，请联系管理员";
            }

            // 创建答题会话
            const quizSession: QuizSession = {
                userId: session.userId!,
                platform: session.platform!,
                currentQuestion: 0,
                accumulatedReward: 0,
                questions,
            };

            activeQuizSessions.set(sessionKey, quizSession);

            // 记录使用
            if (usageRecords.length > 0) {
                await ctx.database.set("soul_command_usage", {
                    userId: session.userId!,
                    platform: session.platform!,
                    command: "weekly_quiz",
                }, {
                    count: 1,
                    updatedAt: Date.now(),
                });
            } else {
                await ctx.database.create("soul_command_usage", {
                    userId: session.userId!,
                    platform: session.platform!,
                    command: "weekly_quiz",
                    count: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });
            }

            // 发送第一题
            await sendQuestion(ctx, session, quizSession, myProfile);
        });

    // 中间件处理答题回复
    ctx.middleware(async (session, next) => {
        if (!session.isDirect || !session.content) {
            return next();
        }

        const sessionKey = `${session.userId}-${session.platform}`;
        const quizSession = activeQuizSessions.get(sessionKey);

        if (!quizSession) {
            return next();
        }

        const content = session.content.trim().toUpperCase();

        // 结算命令
        if (content === "结算") {
            clearTimeout(quizSession.timeoutTimer);
            activeQuizSessions.delete(sessionKey);

            await settleQuiz(ctx, session, quizSession, "主动结算");
            return;
        }

        // 检查答案格式
        if (!["A", "B", "C", "D"].includes(content)) {
            return next();
        }

        // 清除超时计时器
        clearTimeout(quizSession.timeoutTimer);

        const currentQ = quizSession.questions[quizSession.currentQuestion];
        const questionNum = quizSession.currentQuestion + 1;
        const reward = getReward(questionNum);
        const penalty = getPenalty(questionNum);

        if (content === currentQ.answer) {
            // 答对
            quizSession.accumulatedReward += reward;
            quizSession.currentQuestion++;

            // 检查是否答完所有题
            if (quizSession.currentQuestion >= quizSession.questions.length) {
                activeQuizSessions.delete(sessionKey);
                await settleQuiz(ctx, session, quizSession, "全部答对");
                return;
            }

            // 获取用户最新余额
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });
            const myProfile = profiles[0] as SoulProfile;

            // 检查余额是否足够继续
            const nextPenalty = getPenalty(quizSession.currentQuestion + 1);
            if (myProfile.coins + quizSession.accumulatedReward < nextPenalty + MIN_BALANCE) {
                activeQuizSessions.delete(sessionKey);
                await settleQuiz(ctx, session, quizSession, "余额不足");
                return;
            }

            // 发送下一题
            try {
                await session.send(`✅ 答对！+${reward}币（累计+${quizSession.accumulatedReward}）\n回复"结算"可提前结束`);
                await sendQuestion(ctx, session, quizSession, myProfile);
            } catch (e) {
                activeQuizSessions.delete(sessionKey);
                await settleQuiz(ctx, session, quizSession, "消息发送失败", 0.5);
            }
        } else {
            // 答错
            activeQuizSessions.delete(sessionKey);

            // 扣除惩罚
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });
            const myProfile = profiles[0] as SoulProfile;
            const newCoins = Math.max(MIN_BALANCE, myProfile.coins - penalty);

            await ctx.database.set("soul_profiles", { id: myProfile.id }, {
                coins: newCoins,
                updatedAt: Date.now(),
            });

            await session.send(
                `❌ 答错了！正确答案是 ${currentQ.answer}\n` +
                `💸 扣除 ${penalty} 咕咕币\n` +
                `💰 当前余额：${newCoins}`
            );
        }
    });

    ctx.logger.info("咕咕周测命令已加载");
}

/**
 * 发送题目
 */
async function sendQuestion(
    ctx: Context,
    session: any,
    quizSession: QuizSession,
    profile: SoulProfile
) {
    const questionNum = quizSession.currentQuestion + 1;
    const q = quizSession.questions[quizSession.currentQuestion];
    const reward = getReward(questionNum);
    const penalty = getPenalty(questionNum);

    const message =
        `📝 第${questionNum}题（答对+${reward}，答错-${penalty}）\n` +
        `━━━━━━━━━━━\n` +
        `${q.question}\n\n` +
        q.options.join("\n") +
        `\n\n⏰ 30秒内回复 A/B/C/D`;

    try {
        await session.send(message);

        // 设置超时
        const sessionKey = `${quizSession.userId}-${quizSession.platform}`;
        quizSession.timeoutTimer = setTimeout(async () => {
            const current = activeQuizSessions.get(sessionKey);
            if (current) {
                activeQuizSessions.delete(sessionKey);

                // 超时按答错惩罚
                const questionNum = current.currentQuestion + 1;
                const penalty = getPenalty(questionNum);
                const currentQ = current.questions[current.currentQuestion];

                const profiles = await ctx.database.get("soul_profiles", {
                    userId: current.userId,
                    platform: current.platform,
                });

                if (profiles.length > 0) {
                    const profile = profiles[0];
                    const newCoins = Math.max(MIN_BALANCE, profile.coins - penalty);

                    await ctx.database.set("soul_profiles", { id: profile.id }, {
                        coins: newCoins,
                        updatedAt: Date.now(),
                    });

                    try {
                        await session.send(
                            `⏰ 超时了！正确答案是 ${currentQ.answer}\n` +
                            `💸 扣除 ${penalty} 咕咕币\n` +
                            `💰 当前余额：${newCoins}`
                        );
                    } catch (e) {
                        // 消息发送失败，按50%结算
                        ctx.logger.warn(`超时消息发送失败，按50%结算: ${e}`);
                        const refund = Math.floor(current.accumulatedReward * 0.5);
                        const refundedCoins = newCoins + penalty + refund; // 退回惩罚 + 50%累计奖励
                        await ctx.database.set("soul_profiles", { id: profile.id }, {
                            coins: refundedCoins,
                            updatedAt: Date.now(),
                        });
                    }
                }
            }
        }, QUESTION_TIMEOUT_MS);
    } catch (e) {
        ctx.logger.warn(`发送周测题目失败: ${e}`);
        activeQuizSessions.delete(`${quizSession.userId}-${quizSession.platform}`);
        await settleQuiz(ctx, session, quizSession, "消息发送失败", 0.5);
    }
}

/**
 * 结算答题
 */
async function settleQuiz(
    ctx: Context,
    session: any,
    quizSession: QuizSession,
    reason: string,
    multiplier: number = 1
) {
    const finalReward = Math.floor(quizSession.accumulatedReward * multiplier);

    const profiles = await ctx.database.get("soul_profiles", {
        userId: quizSession.userId,
        platform: quizSession.platform,
    });

    if (profiles.length > 0) {
        const profile = profiles[0];
        await ctx.database.set("soul_profiles", { id: profile.id }, {
            coins: profile.coins + finalReward,
            updatedAt: Date.now(),
        });

        try {
            let message = `🏁 咕咕周测结束\n`;
            message += `━━━━━━━━━━━\n`;
            message += `📊 答对 ${quizSession.currentQuestion} 题\n`;
            message += `💰 获得 ${finalReward} 咕咕币`;
            if (multiplier < 1) {
                message += `（${reason}，按${multiplier * 100}%结算）`;
            } else if (reason !== "主动结算" && reason !== "全部答对") {
                message += `（${reason}）`;
            }
            message += `\n💰 当前余额：${profile.coins + finalReward}`;

            await session.send(message);
        } catch (e) {
            ctx.logger.warn(`发送周测结算消息失败: ${e}`);
        }
    }
}
