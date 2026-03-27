/**
 * JX3BOX API 客户端（jx3-soul-new 版）
 * 用 axios 替代 fetch，永久缓存成就详情
 */

import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ===== 类型定义 =====

export interface JX3BoxConfig {
  authToken?: string;
  cookie?: string;
  updatedAt?: number;
}

export interface JX3GameRole {
  ID: number;
  uid: number;
  jx3id: string;
  player_id: string;
  server: string;
  name: string;
  mount: string;
  body_type: string;
  status: number;
  sync_achievements: number;
}

export interface JX3AchievementDetail {
  ID: number;
  Name: string;
  ShortDesc?: string;
  Desc?: string;
  Point?: number;
  General?: number;
  Sub?: number;
  Detail?: number;
  SceneID?: string;
  SceneName?: string;
  LayerName?: string;
  dwDLCID?: number;
  dwMapID?: number;
}

export interface JX3AchievementSubCategory {
  id: string;
  name: string;
  sub?: number;
  detail?: number | string;
  achievements: Array<number | number[]>;
  achievementsCount?: number;
}

export interface JX3AchievementCategory {
  id: number;
  name: string;
  children: JX3AchievementSubCategory[];
}

export interface JX3BoxBinding {
  jx3id: string;
  roleName: string;
  server: string;
  boundAt: number;
}

// ===== 路径 =====

const DATA_DIR = path.join(os.homedir(), ".jx3soul");
const CACHE_DIR = path.join(DATA_DIR, "jx3box-cache");
const CONFIG_FILE = path.join(DATA_DIR, "jx3box-config.json");
const BINDINGS_FILE = path.join(DATA_DIR, "jx3box-bindings.json");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cachePath(name: string): string {
  return path.join(CACHE_DIR, name);
}

// ===== Token 管理 =====

export function getJX3Config(): JX3BoxConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

export function setJX3Token(token: string): void {
  ensureDir(DATA_DIR);
  const config = getJX3Config();
  // 支持格式: "authToken|cookie" 或纯 token
  if (token.includes("|")) {
    const [auth, cookie] = token.split("|", 2);
    config.authToken = auth.trim();
    config.cookie = cookie.trim();
  } else {
    config.authToken = token.trim();
  }
  config.updatedAt = Date.now();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function getAuthHeaders(): Record<string, string> {
  const config = getJX3Config();
  const headers: Record<string, string> = {};
  if (config.authToken) {
    const token = config.authToken.startsWith("Basic ")
      ? config.authToken
      : `Basic ${config.authToken}`;
    headers["Authorization"] = token;
  }
  if (config.cookie) {
    headers["Cookie"] = config.cookie;
  }
  return headers;
}

// ===== 角色绑定管理 =====

export function getBindings(): Record<string, JX3BoxBinding> {
  try {
    if (fs.existsSync(BINDINGS_FILE)) {
      return JSON.parse(fs.readFileSync(BINDINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

export function setBinding(userId: string, binding: JX3BoxBinding): void {
  ensureDir(DATA_DIR);
  const bindings = getBindings();
  bindings[userId] = binding;
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2), "utf-8");
}

export function getBinding(userId: string): JX3BoxBinding | null {
  return getBindings()[userId] ?? null;
}

export function removeBinding(userId: string): void {
  ensureDir(DATA_DIR);
  const bindings = getBindings();
  delete bindings[userId];
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2), "utf-8");
}

// ===== 排除副本管理 =====

const EXCLUSIONS_FILE = path.join(DATA_DIR, "jx3box-exclusions.json");

function getAllExclusions(): Record<string, string[]> {
  try {
    if (fs.existsSync(EXCLUSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveAllExclusions(data: Record<string, string[]>): void {
  ensureDir(DATA_DIR);
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function getExcludedDungeons(userId: string): Set<string> {
  return new Set(getAllExclusions()[userId] ?? []);
}

export function addExcludedDungeon(userId: string, dungeonKey: string): void {
  const all = getAllExclusions();
  if (!all[userId]) all[userId] = [];
  if (!all[userId].includes(dungeonKey)) all[userId].push(dungeonKey);
  saveAllExclusions(all);
}

export function removeExcludedDungeon(userId: string, dungeonKey: string): void {
  const all = getAllExclusions();
  if (!all[userId]) return;
  all[userId] = all[userId].filter(k => k !== dungeonKey);
  if (all[userId].length === 0) delete all[userId];
  saveAllExclusions(all);
}

// ===== 缓存工具 =====

function readCache<T>(name: string): T | null {
  try {
    const fp = cachePath(name);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeCache(name: string, data: unknown): void {
  ensureDir(CACHE_DIR);
  const fp = cachePath(name);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data), "utf-8");
}

// ===== API 接口 =====

/** 生成角色绑定码 */
export async function generateBindCode(): Promise<string> {
  const res = await axios.post(
    "https://team.jx3box.com/api/team/role-bind-token",
    {},
    { headers: getAuthHeaders(), timeout: 10000 }
  );
  return res.data?.data?.token ?? res.data?.data?.code ?? JSON.stringify(res.data);
}

/** 获取已绑定角色列表 */
export async function getGameRoles(): Promise<JX3GameRole[]> {
  try {
    const res = await axios.get(
      "https://team.jx3box.com/api/team/my-game-roles?_no_page=1",
      { headers: getAuthHeaders(), timeout: 10000 }
    );
    const roles = res.data.data.list as JX3GameRole[];
    writeCache("roles.json", roles);
    return roles;
  } catch {
    return readCache<JX3GameRole[]>("roles.json") ?? [];
  }
}

/** 获取用户已完成成就（永久缓存） */
export async function getUserAchievements(jx3id: string): Promise<Set<number>> {
  const cacheFile = `user-achievements/${jx3id}.json`;
  try {
    const res = await axios.get(
      `https://next2.jx3box.com/api/next2/user-achievements?jx3id=${jx3id}`,
      { headers: getAuthHeaders(), timeout: 15000 }
    );
    const ids = res.data.data.achievements.split(",").map(Number).filter((n: number) => !isNaN(n));
    writeCache(cacheFile, ids);
    return new Set(ids);
  } catch {
    const cached = readCache<number[]>(cacheFile);
    if (cached) return new Set(cached);
    throw new Error("无法获取成就数据且无缓存");
  }
}

/** 获取成就点数映射 */
export async function getPoints(): Promise<Record<number, number>> {
  const cached = readCache<Record<string, number>>("points.json");
  if (cached) {
    const result: Record<number, number> = {};
    for (const [k, v] of Object.entries(cached)) result[Number(k)] = v;
    return result;
  }
  const res = await axios.get(
    "https://node.jx3box.com/api/node/achievement/points?client=std",
    { timeout: 10000 }
  );
  writeCache("points.json", res.data.data.points);
  const result: Record<number, number> = {};
  for (const [k, v] of Object.entries(res.data.data.points as Record<string, number>)) result[Number(k)] = v;
  return result;
}

/** 获取成就菜单 */
export async function getMenus(): Promise<JX3AchievementCategory[]> {
  const cached = readCache<JX3AchievementCategory[]>("menus.json");
  if (cached) return cached;
  const res = await axios.get(
    "https://node.jx3box.com/api/node/achievement/menus?general=1&client=std",
    { timeout: 10000 }
  );
  const categories: JX3AchievementCategory[] = [];
  for (const [, menuData] of Object.entries(res.data.data.menus as Record<string, any>).sort(
    ([a], [b]) => (Number(a) || 0) - (Number(b) || 0)
  )) {
    const children: JX3AchievementSubCategory[] = (menuData.children ?? []).map((c: any) => ({
      id: c.id,
      name: c.name,
      sub: c.sub,
      detail: c.detail,
      achievements: c.achievements ?? [],
      achievementsCount: c.achievements_count,
    }));
    categories.push({ id: menuData.id, name: menuData.name, children });
  }
  writeCache("menus.json", categories);
  return categories;
}

/** 获取单个成就详情（永久缓存） */
export async function getDetail(id: number): Promise<JX3AchievementDetail | null> {
  const cacheFile = `details/${id}.json`;
  const cached = readCache<JX3AchievementDetail>(cacheFile);
  if (cached) return cached;
  try {
    const res = await axios.get(
      `https://cms.jx3box.com/api/cms/wiki/post/type/achievement/source/${id}?client=std`,
      { timeout: 10000 }
    );
    if (res.data.data.source) {
      writeCache(cacheFile, res.data.data.source);
      return res.data.data.source;
    }
  } catch {}
  return null;
}

/** 展平嵌套成就 ID 数组 */
export function flattenAchievementIds(arr: Array<number | number[]>): number[] {
  return arr.flatMap(item => (Array.isArray(item) ? item : [item]));
}
