import { Context } from "koishi";
import axios from "axios";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SoulProfile } from "../types";
import { jx3api, minioConfig } from "../config";

const PROFILE_CARD_COST = 200; // 档案名片费用

// 初始化 S3/MinIO 客户端
let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
    if (!s3Client) {
        s3Client = new S3Client({
            endpoint: `http://${minioConfig.endpoint}:${minioConfig.port}`,
            region: "us-east-1",
            credentials: {
                accessKeyId: minioConfig.accessKey,
                secretAccessKey: minioConfig.secretKey,
            },
            forcePathStyle: true,
        });
    }
    return s3Client;
}

/**
 * 调用 jx3api 获取角色名片
 */
async function fetchProfileCard(
    server: string,
    characterName: string,
    logger: any
): Promise<{ avatarUrl: string; showHash: string } | null> {
    try {
        const response = await axios.get("https://www.jx3api.com/data/show/card", {
            params: {
                server,
                name: characterName,
                token: jx3api.tokenv2,
            },
            timeout: 30000,
        });

        if (response.data.code === 200 && response.data.data) {
            return {
                avatarUrl: response.data.data.showAvatar,
                showHash: response.data.data.showHash,
            };
        } else {
            logger.warn(`jx3api 返回错误: ${response.data.msg}`);
            return null;
        }
    } catch (error: any) {
        logger.error(`调用 jx3api 失败:`, error.message);
        return null;
    }
}

/**
 * 下载图片并上传到 MinIO
 */
async function uploadImageToMinio(
    imageUrl: string,
    userId: string,
    platform: string,
    logger: any
): Promise<string | null> {
    try {
        const client = getS3Client();

        // 下载图片
        const response = await axios.get(imageUrl, {
            responseType: "arraybuffer",
            timeout: 30000,
        });

        if (!response.data || response.data.length === 0) {
            throw new Error("下载的图片数据为空");
        }

        // 生成文件路径
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
        const key = `profile-cards/${platform}/${userId}/${timestamp}.png`;

        // 上传到 MinIO
        await client.send(
            new PutObjectCommand({
                Bucket: minioConfig.bucket,
                Key: key,
                Body: Buffer.from(response.data),
                ContentType: "image/png",
            })
        );

        const minioUrl = `http://${minioConfig.endpoint}:${minioConfig.port}/${minioConfig.bucket}/${key}`;
        logger.info(`档案名片已上传到 MinIO: ${minioUrl}`);

        return minioUrl;
    } catch (error: any) {
        logger.error(`上传图片到 MinIO 失败:`, error.message);
        return null;
    }
}

export function registerProfileCardCommands(ctx: Context) {
    const logger = ctx.logger;

    ctx
        .command("档案名片 [server:string] [characterName:string]", "获取游戏角色名片（200咕咕币）")
        .alias("更新名片")
        .action(async ({ session }, inputServer, inputCharacterName) => {
            if (!session?.userId || !session?.platform) return;

            // 获取用户档案
            const profiles = await ctx.database.get("soul_profiles", {
                userId: session.userId,
                platform: session.platform,
            });

            if (profiles.length === 0) {
                return "❌ 你还没有创建情缘档案，请先使用「登记档案」命令创建档案";
            }

            const profile = profiles[0] as SoulProfile;

            // 检查咕咕币余额
            if (profile.coins < PROFILE_CARD_COST) {
                return `❌ 咕咕币不足！获取档案名片需要 ${PROFILE_CARD_COST} 咕咕币\n当前余额: ${profile.coins} 咕咕币`;
            }

            // 确定服务器和角色名
            let server: string;
            let characterName: string;

            if (inputServer && inputCharacterName) {
                // 使用用户提供的参数
                server = inputServer;
                characterName = inputCharacterName;
            } else {
                // 使用档案中的信息
                const servers = profile.servers.split(/\s+/);
                if (servers.length === 0 || !profile.characterName) {
                    return "❌ 档案信息不完整，请使用「档案名片 服务器 角色名」格式指定";
                }
                server = servers[0];
                characterName = profile.characterName;
            }

            await session.send(
                `🔍 正在获取 ${server} - ${characterName} 的名片...\n💰 将消耗 ${PROFILE_CARD_COST} 咕咕币`
            );

            // 扣除咕咕币
            await ctx.database.set(
                "soul_profiles",
                { userId: session.userId, platform: session.platform },
                { coins: profile.coins - PROFILE_CARD_COST, updatedAt: Date.now() }
            );

            logger.info(
                `用户 ${session.userId} 扣除 ${PROFILE_CARD_COST} 咕咕币获取档案名片`
            );

            // 调用 jx3api 获取名片
            const cardResult = await fetchProfileCard(server, characterName, logger);

            if (!cardResult) {
                // 返还咕咕币
                await ctx.database.set(
                    "soul_profiles",
                    { userId: session.userId, platform: session.platform },
                    { coins: profile.coins, updatedAt: Date.now() }
                );
                return `❌ 获取名片失败，可能是角色名或服务器不正确\n服务器: ${server}\n角色名: ${characterName}\n咕咕币已返还`;
            }

            // 上传到 MinIO
            const minioUrl = await uploadImageToMinio(
                cardResult.avatarUrl,
                session.userId,
                session.platform,
                logger
            );

            if (!minioUrl) {
                // 返还咕咕币
                await ctx.database.set(
                    "soul_profiles",
                    { userId: session.userId, platform: session.platform },
                    { coins: profile.coins, updatedAt: Date.now() }
                );
                return "❌ 图片存储失败，咕咕币已返还";
            }

            // 更新档案中的名片URL（追加到数组）
            const existingImages = profile.characterImageUrl || [];
            const newImages = [...existingImages, minioUrl];

            await ctx.database.set(
                "soul_profiles",
                { userId: session.userId, platform: session.platform },
                { characterImageUrl: newImages, updatedAt: Date.now() }
            );

            logger.info(`用户 ${session.userId} 档案名片已更新: ${minioUrl}`);

            // 发送名片给用户
            try {
                await session.send(`✅ 档案名片获取成功！\n💰 消耗 ${PROFILE_CARD_COST} 咕咕币，剩余 ${profile.coins - PROFILE_CARD_COST} 咕咕币`);
                await session.send(`<image url="${minioUrl}" />`);
                return `📝 名片已保存到你的档案，其他用户匹配到你时可以看到这张名片`;
            } catch (error) {
                logger.warn(`发送名片图片失败:`, error);
                return `✅ 档案名片获取成功！\n💰 消耗 ${PROFILE_CARD_COST} 咕咕币\n🔗 名片链接: ${minioUrl}`;
            }
        });

    logger.info("档案名片命令已注册");
}
