/**
 * JX3BOX 副本优先级分析引擎
 * 按具体副本（SceneName + LayerName）分组分析成就完成进度
 */

import {
  getPoints,
  getMenus,
  getUserAchievements,
  getDetail,
  flattenAchievementIds,
  type JX3AchievementDetail,
} from "./jx3box-api";

// ===== 类型 =====

export interface DungeonPriority {
  sceneName: string;
  layerName: string;
  totalAchievements: number;
  completedAchievements: number;
  remainingAchievements: number;
  totalPoints: number;
  earnedPoints: number;
  remainingPoints: number;
  efficiency: number;
  remainingList: Array<{ id: number; name: string; desc?: string; points: number }>;
}

export interface AnalysisResult {
  roleName: string;
  server: string;
  totalDungeonAchievements: number;
  completedDungeonAchievements: number;
  totalDungeonPoints: number;
  earnedDungeonPoints: number;
  dungeons: DungeonPriority[];
}

// 排除的秘境
const EXCLUDED_SCENES = new Set(["天子峰"]);
const DUNGEON_CATEGORY_ID = 11;

/**
 * 分析副本优先级
 */
export async function analyzeDungeonPriority(
  jx3id: string,
  roleName: string,
  server: string,
): Promise<AnalysisResult> {
  const [completedIds, pointsMap, menus] = await Promise.all([
    getUserAchievements(jx3id),
    getPoints(),
    getMenus(),
  ]);

  const dungeonCategory = menus.find(c => c.id === DUNGEON_CATEGORY_ID);
  if (!dungeonCategory) {
    throw new Error("未找到副本分类（ID=11）");
  }

  // 收集所有副本成就 ID
  const allAchievementIds: number[] = [];
  for (const sub of dungeonCategory.children) {
    allAchievementIds.push(...flattenAchievementIds(sub.achievements));
  }
  const uniqueIds = [...new Set(allAchievementIds)];

  // 加载所有成就详情（20 并发，永久缓存）
  const detailsMap = new Map<number, JX3AchievementDetail>();
  const CONCURRENCY = 20;
  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(id => getDetail(id)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) detailsMap.set(batch[j], results[j]!);
    }
  }

  // 按 SceneName + LayerName 分组
  const groups = new Map<string, {
    sceneName: string;
    layerName: string;
    achievementIds: number[];
  }>();

  for (const id of uniqueIds) {
    const detail = detailsMap.get(id);
    if (!detail?.SceneName) continue;
    if (EXCLUDED_SCENES.has(detail.SceneName)) continue;

    const layerName = detail.LayerName ?? "普通";
    const key = `${detail.SceneName}|${layerName}`;

    if (!groups.has(key)) {
      groups.set(key, { sceneName: detail.SceneName, layerName, achievementIds: [] });
    }
    groups.get(key)!.achievementIds.push(id);
  }

  // 计算优先级
  const dungeons: DungeonPriority[] = [];
  let totalDungeonAch = 0;
  let completedDungeonAch = 0;
  let totalDungeonPts = 0;
  let earnedDungeonPts = 0;

  for (const [, group] of groups) {
    const total = group.achievementIds.length;
    const completed = group.achievementIds.filter(id => completedIds.has(id)).length;
    const remaining = total - completed;

    const totalPts = group.achievementIds.reduce(
      (s, id) => s + (pointsMap[id] ?? detailsMap.get(id)?.Point ?? 0), 0
    );
    const earnedPts = group.achievementIds
      .filter(id => completedIds.has(id))
      .reduce((s, id) => s + (pointsMap[id] ?? detailsMap.get(id)?.Point ?? 0), 0);
    const remainingPts = totalPts - earnedPts;

    totalDungeonAch += total;
    completedDungeonAch += completed;
    totalDungeonPts += totalPts;
    earnedDungeonPts += earnedPts;

    if (remaining === 0) continue;

    const remainingList = group.achievementIds
      .filter(id => !completedIds.has(id))
      .map(id => {
        const d = detailsMap.get(id);
        return {
          id,
          name: d?.Name ?? `成就#${id}`,
          desc: d?.ShortDesc ?? d?.Desc,
          points: pointsMap[id] ?? d?.Point ?? 0,
        };
      })
      .sort((a, b) => b.points - a.points);

    dungeons.push({
      sceneName: group.sceneName,
      layerName: group.layerName,
      totalAchievements: total,
      completedAchievements: completed,
      remainingAchievements: remaining,
      totalPoints: totalPts,
      earnedPoints: earnedPts,
      remainingPoints: remainingPts,
      efficiency: remaining > 0 ? remainingPts / remaining : 0,
      remainingList,
    });
  }

  dungeons.sort((a, b) => b.remainingPoints - a.remainingPoints);

  return {
    roleName,
    server,
    totalDungeonAchievements: totalDungeonAch,
    completedDungeonAchievements: completedDungeonAch,
    totalDungeonPoints: totalDungeonPts,
    earnedDungeonPoints: earnedDungeonPts,
    dungeons,
  };
}
