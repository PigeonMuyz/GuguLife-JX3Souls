/**
 * JX3BOX 成就分析命令模块
 * 提供角色绑定、副本推荐、副本详情查询
 */

import { Context } from "koishi";
import { ADMIN_IDS } from "../config";
import { SoulProfile } from "../types";
import {
  setJX3Token,
  getJX3Config,
  generateBindCode,
  getGameRoles,
  getBinding,
  setBinding,
  removeBinding,
  getExcludedDungeons,
  addExcludedDungeon,
  removeExcludedDungeon,
} from "../utils/jx3box-api";
import { analyzeDungeonPriority } from "../utils/jx3box-analyzer";

const RECOMMEND_COST = 300;

/** 等待用户选择角色的临时缓存 */
const pendingRoleSelection = new Map<string, Array<{ jx3id: string; name: string; server: string }>>();

export function registerAchievementCommands(ctx: Context) {

  // ===== 管理员：设置 Token =====
  ctx
    .command("设置魔盒 <token:text>", "设置 JX3BOX Token（仅管理员）")
    .action(async ({ session }, token) => {
      if (!session) return;
      if (!ADMIN_IDS.includes(session.userId!)) {
        return "❌ 仅管理员可操作";
      }
      if (!token?.trim()) {
        return "❌ 请提供 Token\n用法：设置魔盒 <AuthToken>|<Cookie>\n示例：设置魔盒 Basic xxx|token=yyy;season_token=zzz";
      }
      setJX3Token(token.trim());
      return "✅ JX3BOX Token 已保存";
    });

  // ===== 绑定角色：生成绑定码 =====
  ctx
    .command("绑定角色", "生成 JX3BOX 角色绑定码")
    .action(async ({ session }) => {
      if (!session) return;
      const config = getJX3Config();
      if (!config.authToken) {
        return "❌ 管理员还未设置 JX3BOX Token，请联系管理员";
      }
      try {
        const code = await generateBindCode();
        return `🔗 你的绑定码：${code}\n\n请按以下步骤操作：\n1. 打开 jx3box.com\n2. 进入 个人中心 → 角色管理\n3. 输入上面的绑定码\n4. 绑定完成后发送「关联角色 你的角色名」`;
      } catch (e: any) {
        return `❌ 获取绑定码失败: ${e?.message}`;
      }
    });

  // ===== 关联角色 =====
  ctx
    .command("关联角色 <roleName:text>", "将 QQ 号与 JX3BOX 角色关联")
    .action(async ({ session }, roleName) => {
      if (!session) return;
      if (!roleName?.trim()) {
        return "❌ 请提供角色名\n用法：关联角色 渡清欢";
      }
      try {
        const roles = await getGameRoles();
        if (roles.length === 0) {
          return "❌ 未找到任何已绑定角色。请先使用「绑定角色」获取绑定码";
        }

        const keyword = roleName.trim();
        // 模糊匹配
        const matched = roles.filter(r => r.name.includes(keyword));

        if (matched.length === 0) {
          const available = roles.map(r => `${r.name} (${r.server})`).join("\n  ");
          return `❌ 未找到包含「${keyword}」的角色\n已绑定的角色：\n  ${available}`;
        }

        if (matched.length === 1) {
          // 唯一匹配，直接关联
          const role = matched[0];
          setBinding(session.userId!, {
            jx3id: role.jx3id,
            roleName: role.name,
            server: role.server,
            boundAt: Date.now(),
          });
          return `✅ 已关联: ${role.name} (${role.server})`;
        }

        // 多个匹配，让用户选
        const userKey = `${session.userId}-${session.platform}`;
        pendingRoleSelection.set(userKey, matched.map(r => ({
          jx3id: r.jx3id,
          name: r.name,
          server: r.server,
        })));

        const list = matched.map((r, i) => `${i + 1}. ${r.name} (${r.server})`).join("\n");
        return `🔍 找到多个角色，请回复序号选择：\n${list}\n\n发送「选择角色 <序号>」来确认`;

      } catch (e: any) {
        return `❌ 关联失败: ${e?.message}`;
      }
    });

  // ===== 选择角色（多角色时使用）=====
  ctx
    .command("选择角色 <index:number>", "从多角色列表中选择")
    .action(async ({ session }, index) => {
      if (!session) return;
      const userKey = `${session.userId}-${session.platform}`;
      const pending = pendingRoleSelection.get(userKey);
      if (!pending) {
        return "❌ 没有待选择的角色列表，请先使用「关联角色 角色名」";
      }
      if (!index || index < 1 || index > pending.length) {
        return `❌ 请输入 1-${pending.length} 的序号`;
      }
      const role = pending[index - 1];
      pendingRoleSelection.delete(userKey);
      setBinding(session.userId!, {
        jx3id: role.jx3id,
        roleName: role.name,
        server: role.server,
        boundAt: Date.now(),
      });
      return `✅ 已关联: ${role.name} (${role.server})`;
    });

  // ===== 解绑角色 =====
  ctx
    .command("解绑角色", "解除 JX3BOX 角色关联")
    .action(async ({ session }) => {
      if (!session) return;
      const binding = getBinding(session.userId!);
      if (!binding) {
        return "❌ 你还没有关联角色";
      }
      removeBinding(session.userId!);
      return `✅ 已解绑: ${binding.roleName} (${binding.server})`;
    });

  // ===== 副本推荐 =====
  ctx
    .command("副本推荐", "分析副本成就优先级")
    .alias("成就分析")
    .alias("资历分析")
    .action(async ({ session }) => {
      if (!session) return;
      const binding = getBinding(session.userId!);
      if (!binding) {
        return "❌ 你还没有关联角色\n请先使用「绑定角色」获取绑定码，然后「关联角色 角色名」";
      }

      // 检查是否有档案 → 有档案则收费
      const profiles = await ctx.database.get("soul_profiles", {
        userId: session.userId!,
        platform: session.platform!,
      });
      const profile = profiles?.[0] as SoulProfile | undefined;
      let charged = false;

      if (profile) {
        if (profile.coins < RECOMMEND_COST) {
          return `❌ 咕咕币不足！副本推荐需要 ${RECOMMEND_COST} 咕咕币\n当前余额：${profile.coins} 咕咕币`;
        }
        await ctx.database.set(
          "soul_profiles",
          { userId: session.userId!, platform: session.platform! },
          { coins: profile.coins - RECOMMEND_COST }
        );
        charged = true;
      }

      try {
        // 只在缓存为空时提示
        const cacheDir = require("path").join(require("os").homedir(), ".jx3soul", "jx3box-cache", "details");
        const hasCache = require("fs").existsSync(cacheDir) && require("fs").readdirSync(cacheDir).length > 100;
        if (!hasCache) {
          await session.send("⏳ 首次分析需要下载成就数据，请稍等...");
        }
        const result = await analyzeDungeonPriority(
          binding.jx3id,
          binding.roleName,
          binding.server,
        );

        // 过滤用户排除的副本
        const excluded = getExcludedDungeons(session.userId!);
        const filtered = result.dungeons.filter(d => {
          const key = `${d.sceneName}·${d.layerName}`;
          return !excluded.has(key);
        });

        const lines: string[] = [
          `📊 ${result.roleName} · ${result.server}`,
          `秘境成就进度: 已完成 ${result.completedDungeonAchievements}/${result.totalDungeonAchievements} (${result.earnedDungeonPoints}/${result.totalDungeonPoints}点)`,
          "",
          "🔥 推荐优先刷",
        ];

        const top10 = filtered.slice(0, 10);
        for (let i = 0; i < top10.length; i++) {
          const d = top10[i];
          lines.push(
            `${i + 1}. ${d.sceneName}·${d.layerName} — 已完成 ${d.completedAchievements}/${d.totalAchievements}，还差 ${d.remainingAchievements} 个 (${d.remainingPoints}点)`
          );
        }

        if (excluded.size > 0) {
          lines.push("");
          lines.push(`已排除 ${excluded.size} 个副本（取消排除：取消排除副本 <副本名>）`);
        }

        lines.push("");
        lines.push("💡 排除不想刷的：排除副本 <副本名>");
        lines.push("💡 查看详情：副本详情 <副本名>");

        if (charged) {
          lines.push("");
          lines.push(`💰 消耗 ${RECOMMEND_COST} 咕咕币，剩余 ${profile!.coins - RECOMMEND_COST}`);
        }

        return lines.join("\n");
      } catch (e: any) {
        // 退还咕咕币
        if (charged && profile) {
          await ctx.database.set(
            "soul_profiles",
            { userId: session.userId!, platform: session.platform! },
            { coins: profile.coins }
          );
        }
        return `❌ 分析失败: ${e?.message}${charged ? `\n（已退还 ${RECOMMEND_COST} 咕咕币）` : ""}`;
      }
    });

  // ===== 排除副本 =====
  ctx
    .command("排除副本 <dungeonName:text>", "从推荐列表中排除副本")
    .action(async ({ session }, dungeonName) => {
      if (!session || !dungeonName?.trim()) {
        return "❌ 用法：排除副本 巨冥湾";
      }
      const binding = getBinding(session.userId!);
      if (!binding) return "❌ 你还没有关联角色";

      const result = await analyzeDungeonPriority(binding.jx3id, binding.roleName, binding.server);
      const keyword = dungeonName.trim();
      const matched = result.dungeons.filter(d =>
        d.sceneName.includes(keyword) || d.layerName.includes(keyword)
      );

      if (matched.length === 0) {
        return `❌ 未找到包含「${keyword}」的副本`;
      }

      const excluded: string[] = [];
      for (const d of matched) {
        const key = `${d.sceneName}·${d.layerName}`;
        addExcludedDungeon(session.userId!, key);
        excluded.push(key);
      }
      return `✅ 已排除：\n${excluded.join("\n")}\n\n重新查看：副本推荐`;
    });

  // ===== 取消排除 =====
  ctx
    .command("取消排除副本 <dungeonName:text>", "从排除列表中恢复副本")
    .action(async ({ session }, dungeonName) => {
      if (!session || !dungeonName?.trim()) {
        const excluded = getExcludedDungeons(session?.userId ?? "");
        if (excluded.size === 0) return "当前没有排除的副本";
        return `当前排除的副本：\n${[...excluded].join("\n")}\n\n用法：取消排除副本 <副本名>`;
      }
      const keyword = dungeonName.trim();
      const excluded = getExcludedDungeons(session.userId!);
      const toRemove = [...excluded].filter(k => k.includes(keyword));
      if (toRemove.length === 0) {
        return `❌ 排除列表中没有包含「${keyword}」的副本`;
      }
      for (const key of toRemove) {
        removeExcludedDungeon(session.userId!, key);
      }
      return `✅ 已恢复：\n${toRemove.join("\n")}`;
    });

  // ===== 副本详情 =====
  ctx
    .command("副本详情 <dungeonName:text>", "查看指定副本未完成的成就")
    .action(async ({ session }, dungeonName) => {
      if (!session) return;
      if (!dungeonName?.trim()) {
        return "❌ 请提供副本名\n用法：副本详情 达摩洞";
      }
      const binding = getBinding(session.userId!);
      if (!binding) {
        return "❌ 你还没有关联角色";
      }
      try {
        const result = await analyzeDungeonPriority(
          binding.jx3id,
          binding.roleName,
          binding.server,
        );
        const keyword = dungeonName.trim();
        const matched = result.dungeons.filter(d =>
          d.sceneName.includes(keyword) || d.layerName.includes(keyword)
        );
        if (matched.length === 0) {
          const allNames = result.dungeons.slice(0, 15).map(d => `${d.sceneName}·${d.layerName}`);
          return `❌ 未找到包含「${keyword}」的副本\n\n可查询的副本（前15）：\n${allNames.join("\n")}`;
        }

        const parts: string[] = [];
        for (const d of matched.slice(0, 3)) {
          const header = `📋 ${d.sceneName}·${d.layerName}\n已完成 ${d.completedAchievements}/${d.totalAchievements}，还差 ${d.remainingAchievements} 个 (${d.remainingPoints}点)`;
          const list = d.remainingList.slice(0, 10).map(a => {
            const desc = a.desc ? ` — ${a.desc}` : "";
            return `• ${a.name} (${a.points}点)${desc}`;
          });
          if (d.remainingList.length > 10) {
            list.push(`...还有 ${d.remainingList.length - 10} 个`);
          }
          parts.push(`${header}\n\n未完成成就:\n${list.join("\n")}`);
        }

        return parts.join("\n\n━━━━━━━━━━━━━━━━\n\n");
      } catch (e: any) {
        return `❌ 查询失败: ${e?.message}`;
      }
    });
}
