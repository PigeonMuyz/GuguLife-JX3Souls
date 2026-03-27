import { Context } from "koishi";

// 商城会话状态
interface MallSession {
  step: "main" | "category" | "product" | "confirm";
  category?: "ai" | "physical";
  selectedProduct?: any;
  balance?: number;
  lastActivity: number;
}

// 存储商城会话
const mallSessions = new Map<string, MallSession>();

// 会话超时时间（5分钟）
const SESSION_TIMEOUT = 5 * 60 * 1000;

// 生成唯一订单号
function generateOrderId(): string {
  return `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// 检查是否是管理员
function isAdmin(userId: string, platform: string): boolean {
  const adminList = ["YOUR_ADMIN_QQ_1"];
  return adminList.includes(userId);
}

// 初始化商品数据
async function initializeProducts(ctx: Context) {
  const existingProducts = await ctx.database.get("mall_products", {});
  if (existingProducts.length === 0) {
    // AI类商品（暂无）
    ctx.logger.info("暂无AI类商品");
  }

  const existingPhysicalProducts = await ctx.database.get("mall_products", {
    category: "physical",
  });
  if (existingPhysicalProducts.length === 0) {
    // 实体类商品
    const physicalProducts = [
      {
        name: "特惠！100g 3D打印模型",
        description: "PLA材料，可打印低于15cm高度的游戏角色（正太，萝莉最佳）",
        category: "physical",
        price: 4200,
        stock: 5,
        item_type: "physical",
        item_config: {},
        is_active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        name: "咕咕欢迎你来礼包",
        description: `1.100g PLA材料3D打印模型\n2. 附加 (二选一)\n   A: 黄鸡大笑 磁吸版 (2个)\n   B: 唐门机关小猪 (含配套零件)\n   C: 任选两个50g以内的模型\n3. 组合包额外礼物（大概率是小玩具）`,
        category: "physical",
        price: 4500,
        stock: 5,
        item_type: "physical",
        item_config: {},
        is_active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        name: "咕咕特殊礼",
        description: `1. 200g 3D打印模型 (可以打印20-25cm 游戏角色模型)\n2. 附加 (二选一)\n   A: '黄鸡大笑' 磁吸版 (2个)\n   B: '唐门机关小猪' (含配套零件)\n   C: 任选两个50g以内的模型\n3. 组合包额外礼物（大概率是小玩具）`,
        category: "physical",
        price: 12500,
        stock: 5,
        item_type: "physical",
        item_config: {},
        is_active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    // 使用循环创建多个实体商品记录
    for (const product of physicalProducts) {
      await ctx.database.create("mall_products", product);
    }
    ctx.logger.info("已初始化实体类商品");
  }
}

// 获取用户余额
async function getUserBalance(ctx: Context, userId: string, platform: string): Promise<number> {
  const profiles = await ctx.database.get("soul_profiles", { userId, platform });
  return profiles.length > 0 ? profiles[0].coins : 0;
}

// 格式化商品列表
function formatProductList(products: any[], showIndex: boolean = true): string {
  return products.map((p, i) => {
    const stockStatus = p.stock <= 0 ? "【售罄】" : p.stock <= 3 ? `【仅剩${p.stock}份】` : "";
    const indexPrefix = showIndex ? `${i + 1}. ` : "➤ ";
    return `${indexPrefix}${p.name}\n   💰 ${p.price.toLocaleString()} 咕咕币 ${stockStatus}\n   📝 ${p.description.split("\n")[0]}`;
  }).join("\n\n");
}

// 显示主菜单
async function showMainMenu(ctx: Context, session: any): Promise<string> {
  const { userId, platform } = session;
  const balance = await getUserBalance(ctx, userId, platform);

  // 获取商品统计
  const products = await ctx.database.get("mall_products", { is_active: true });
  const aiCount = products.filter(p => p.category === "ai").length;
  const physicalCount = products.filter(p => p.category === "physical").length;

  // 保存会话
  const sessionKey = `${platform}:${userId}`;
  mallSessions.set(sessionKey, {
    step: "main",
    balance,
    lastActivity: Date.now(),
  });

  let message = `🏪 欢迎来到咕咕商城！\n\n`;
  message += `💰 您的余额：${balance.toLocaleString()} 咕咕币\n\n`;
  message += `📦 商品分类：\n`;
  message += `   🤖 AI服务（${aiCount}款）- 回复「AI」\n`;
  message += `   🎁 实体商品（${physicalCount}款）- 回复「实体」\n\n`;
  message += `📋 其他功能：\n`;
  message += `   📜 查看兑换记录 - 回复「记录」\n`;
  message += `   ❌ 离开商城 - 回复「退出」`;

  return message;
}

// 显示分类商品
async function showCategoryProducts(ctx: Context, session: any, category: "ai" | "physical"): Promise<string> {
  const { userId, platform } = session;
  const sessionKey = `${platform}:${userId}`;
  const mallSession = mallSessions.get(sessionKey);

  if (!mallSession) return "";

  const products = await ctx.database.get("mall_products", {
    is_active: true,
    category
  });

  if (products.length === 0) {
    return `当前分类暂无商品，回复「返回」查看其他分类`;
  }

  // 更新会话状态
  mallSession.step = "category";
  mallSession.category = category;
  mallSession.lastActivity = Date.now();

  const categoryName = category === "ai" ? "🤖 AI服务" : "🎁 实体商品";

  let message = `${categoryName}\n\n`;
  message += formatProductList(products);
  message += `\n\n━━━━━━━━━━━━━━━\n`;
  message += `💰 您的余额：${mallSession.balance?.toLocaleString() || 0} 咕咕币\n\n`;
  message += `📌 操作指南：\n`;
  message += `   输入序号（如 1）查看商品详情\n`;
  message += `   回复「返回」回主菜单\n`;
  message += `   回复「退出」离开商城`;

  return message;
}

// 显示商品详情
async function showProductDetail(ctx: Context, session: any, productIndex: number): Promise<string> {
  const { userId, platform } = session;
  const sessionKey = `${platform}:${userId}`;
  const mallSession = mallSessions.get(sessionKey);

  if (!mallSession || !mallSession.category) return "";

  const products = await ctx.database.get("mall_products", {
    is_active: true,
    category: mallSession.category
  });

  if (productIndex < 1 || productIndex > products.length) {
    return `❌ 请输入有效的商品序号（1-${products.length}）`;
  }

  const product = products[productIndex - 1];

  // 更新会话状态
  mallSession.step = "product";
  mallSession.selectedProduct = product;
  mallSession.lastActivity = Date.now();

  const stockStatus = product.stock <= 0
    ? "❌ 已售罄"
    : product.stock <= 3
      ? `⚠️ 仅剩 ${product.stock} 份`
      : `✅ 库存充足 (${product.stock})`;

  let message = `📦 商品详情\n`;
  message += `━━━━━━━━━━━━━━━\n\n`;
  message += `🏷️ ${product.name}\n\n`;
  message += `💰 价格：${product.price.toLocaleString()} 咕咕币\n`;
  message += `📊 库存：${stockStatus}\n\n`;
  message += `📝 商品描述：\n${product.description}\n\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `💰 您的余额：${mallSession.balance?.toLocaleString() || 0} 咕咕币\n\n`;

  // 判断是否可以购买
  const canBuy = product.stock > 0 && (mallSession.balance || 0) >= product.price;

  if (product.stock <= 0) {
    message += `⚠️ 此商品已售罄，无法兑换\n\n`;
  } else if ((mallSession.balance || 0) < product.price) {
    message += `⚠️ 余额不足，还差 ${(product.price - (mallSession.balance || 0)).toLocaleString()} 咕咕币\n\n`;
  }

  message += `📌 操作指南：\n`;
  if (canBuy) {
    message += `   回复「确认」兑换此商品\n`;
  }
  message += `   回复「返回」回商品列表\n`;
  message += `   回复「退出」离开商城`;

  return message;
}

// 执行兑换
async function executeExchange(ctx: Context, session: any): Promise<string> {
  const { userId, platform } = session;
  const sessionKey = `${platform}:${userId}`;
  const mallSession = mallSessions.get(sessionKey);

  if (!mallSession || !mallSession.selectedProduct) {
    return "❌ 会话已过期，请重新进入商城";
  }

  const product = mallSession.selectedProduct;

  // 重新检查余额和库存
  const profiles = await ctx.database.get("soul_profiles", { userId, platform });
  if (profiles.length === 0) {
    mallSessions.delete(sessionKey);
    return "❌ 您还没有档案，请先使用「登记档案」创建";
  }

  const profile = profiles[0];

  // 重新获取商品最新状态
  const latestProducts = await ctx.database.get("mall_products", { id: product.id });
  if (latestProducts.length === 0 || !latestProducts[0].is_active) {
    mallSessions.delete(sessionKey);
    return "❌ 该商品已下架";
  }

  const latestProduct = latestProducts[0];

  if (latestProduct.stock <= 0) {
    mallSessions.delete(sessionKey);
    return "❌ 该商品已售罄";
  }

  if (profile.coins < latestProduct.price) {
    return `❌ 余额不足\n当前余额 ${profile.coins} 咕咕币，需要 ${latestProduct.price} 咕咕币`;
  }

  // 扣减货币
  await ctx.database.set(
    "soul_profiles",
    { id: profile.id },
    {
      coins: profile.coins - latestProduct.price,
      updatedAt: Date.now(),
    }
  );

  // 减少商品库存
  await ctx.database.set(
    "mall_products",
    { id: latestProduct.id },
    {
      stock: latestProduct.stock - 1,
      updatedAt: Date.now(),
    }
  );

  // 生成订单记录
  const orderId = generateOrderId();
  const status = latestProduct.item_type === "physical" ? "pending" : "completed";

  await ctx.database.create("mall_exchange_records", {
    userId,
    platform,
    product_id: latestProduct.id,
    product_name: latestProduct.name,
    coins_used: latestProduct.price,
    status,
    exchange_date: Date.now(),
    order_id: orderId,
    remarks: null,
    updatedAt: Date.now(),
  });

  // 处理AI类商品，增加次数
  if (latestProduct.item_type === "ai_image") {
    // @ts-ignore - image_quota table defined in another plugin
    let imageQuota = await ctx.database.get("image_quota" as any, { userId, platform });
    const count = latestProduct.item_config.count;

    if (imageQuota.length > 0) {
      const quota = imageQuota[0] as any;
      const updateData: any = { updatedAt: Date.now() };

      if (latestProduct.item_config.type === "t2i" || latestProduct.item_config.type === "both") {
        updateData.t2iQuota = quota.t2iQuota + count;
      }
      if (latestProduct.item_config.type === "i2i" || latestProduct.item_config.type === "both") {
        updateData.i2iQuota = quota.i2iQuota + count;
      }

      // @ts-ignore
      await ctx.database.set("image_quota" as any, { userId, platform }, updateData);
    } else {
      const initialT2i = latestProduct.item_config.type === "t2i" || latestProduct.item_config.type === "both" ? count : 0;
      const initialI2i = latestProduct.item_config.type === "i2i" || latestProduct.item_config.type === "both" ? count : 0;

      // @ts-ignore
      await ctx.database.create("image_quota" as any, {
        userId,
        platform,
        t2iQuota: initialT2i,
        t2iUsed: 0,
        i2iQuota: initialI2i,
        i2iUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  } else if (latestProduct.item_type === "ai_video") {
    // @ts-ignore - user_authorizations table defined in another plugin
    let auth = await ctx.database.get("user_authorizations" as any, { userId, platform });

    if (auth.length > 0) {
      const authRecord = auth[0] as any;
      // @ts-ignore
      await ctx.database.set(
        "user_authorizations" as any,
        { userId, platform },
        {
          authorizedCount: authRecord.authorizedCount + latestProduct.item_config.count,
          updatedAt: Date.now(),
        }
      );
    } else {
      // @ts-ignore
      await ctx.database.create("user_authorizations" as any, {
        userId,
        platform,
        authorizedBy: `${platform}:${userId}`,
        authorizedCount: latestProduct.item_config.count,
        usedCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  // 通知管理员有新的实体商品兑换
  if (latestProduct.item_type === "physical") {
    try {
      const adminChannelId = "private:YOUR_ADMIN_QQ_1";
      const bot = ctx.bots.find(b => b.platform === "qq" || b.platform === "onebot");
      if (bot) {
        await bot.sendMessage(
          adminChannelId,
          `📬 新的实体商品兑换请求：\n用户ID：${userId}\n商品：${latestProduct.name}\n订单号：${orderId}\n请及时处理！`
        );
      }
    } catch (e) {
      ctx.logger.warn("通知管理员失败", e);
    }
  }

  // 清除会话
  mallSessions.delete(sessionKey);

  const resultMessage = latestProduct.item_type === "physical"
    ? `✅ 兑换成功！\n\n📦 商品：${latestProduct.name}\n📋 订单号：${orderId}\n\n管理员将在3-5个工作日内联系您处理，请保持私聊畅通。`
    : `✅ 兑换成功！\n\n🎉 ${latestProduct.name} 已添加到您的账户\n💰 剩余余额：${profile.coins - latestProduct.price} 咕咕币\n\n现在就可以使用啦！`;

  return resultMessage;
}

// 查看兑换记录
async function showExchangeRecords(ctx: Context, session: any): Promise<string> {
  const { userId, platform } = session;

  const records = await ctx.database.get(
    "mall_exchange_records",
    { userId, platform }
  );

  // 手动排序
  records.sort((a, b) => b.exchange_date - a.exchange_date);

  if (records.length === 0) {
    return "📜 您还没有任何兑换记录\n\n回复「返回」回主菜单";
  }

  const statusMap: Record<string, string> = {
    pending: "⏳ 待处理",
    processing: "🔄 处理中",
    shipped: "📦 已发货",
    completed: "✅ 已完成",
    cancelled: "❌ 已取消",
  };

  let message = `📜 您的兑换记录\n━━━━━━━━━━━━━━━\n\n`;

  for (const record of records.slice(0, 10)) {
    const date = new Date(record.exchange_date).toLocaleDateString("zh-CN");
    message += `📦 ${record.product_name}\n`;
    message += `   💰 消耗 ${record.coins_used} 咕咕币\n`;
    message += `   ${statusMap[record.status] || record.status}\n`;
    message += `   📅 ${date}\n`;
    if (record.remarks) {
      message += `   💬 ${record.remarks}\n`;
    }
    message += `\n`;
  }

  if (records.length > 10) {
    message += `... 共 ${records.length} 条记录\n\n`;
  }

  message += `回复「返回」回主菜单`;

  return message;
}

// 管理员：更新订单状态
async function adminUpdateOrderStatus(
  ctx: Context,
  session: any,
  orderId: string,
  newStatus: string,
  remarks?: string
) {
  if (!isAdmin(session.userId, session.platform)) {
    return "只有管理员才能执行此操作";
  }

  const validStatus = ["pending", "processing", "shipped", "completed", "cancelled"];
  if (!validStatus.includes(newStatus)) {
    return `无效的状态，可用状态：${validStatus.join(", ")}`;
  }

  const records = await ctx.database.get("mall_exchange_records", { order_id: orderId });
  if (records.length === 0) {
    return "该订单不存在";
  }

  const record = records[0];

  await ctx.database.set(
    "mall_exchange_records",
    { order_id: orderId },
    {
      status: newStatus as any,
      remarks: remarks || record.remarks,
      updatedAt: Date.now(),
    }
  );

  const statusMap: Record<string, string> = {
    pending: "待处理",
    processing: "处理中",
    shipped: "已发货",
    completed: "已完成",
    cancelled: "已取消",
  };

  try {
    const userChannelId = `private:${record.userId}`;
    const bot = ctx.bots.find(b => b.platform === record.platform || b.platform === "onebot");
    if (bot) {
      await bot.sendMessage(
        userChannelId,
        `📬 您的订单 ${orderId} 状态已更新：${statusMap[newStatus]}${remarks ? `\n备注：${remarks}` : ""}`
      );
    }
  } catch (e) {
    ctx.logger.warn("通知用户订单状态失败", e);
  }

  return `✅ 订单 ${orderId} 状态已更新为 ${newStatus}`;
}

export function registerMallCommands(ctx: Context) {
  // 初始化商品数据
  initializeProducts(ctx);

  // 清理过期会话
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of mallSessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT) {
        mallSessions.delete(key);
      }
    }
  }, 60000);

  // 查看商城商品
  ctx
    .command("咕咕商城")
    .alias("咕咕币商城")
    .action(async ({ session }) => {
      if (!session) return;

      // 限制只在私聊中使用
      if (session.guildId) {
        return "📱 商城只能在私聊中使用哦~\n请私聊我发送「咕咕商城」";
      }

      return showMainMenu(ctx, session);
    });

  // 查看我的余额（咕咕币余额）
  ctx.command("咕咕币余额").action(async ({ session }) => {
    if (!session) return;
    const balance = await getUserBalance(ctx, session.userId!, session.platform!);
    return `💰 您当前拥有 ${balance.toLocaleString()} 咕咕币`;
  });

  // 我的兑换记录
  ctx
    .command("我的兑换记录")
    .alias("兑换记录")
    .action(async ({ session }) => {
      if (!session) return;
      if (session.guildId) {
        return "📱 请私聊我查看兑换记录";
      }
      return showExchangeRecords(ctx, session);
    });

  // 管理员命令 - 更新订单状态
  ctx
    .command("更新订单状态 <orderId:string> <status:string> [remarks:string]")
    .action(async ({ session }, orderId, status, remarks) => {
      if (!session) return;
      return adminUpdateOrderStatus(ctx, session, orderId, status, remarks);
    });

  // 监听消息事件，处理商城会话
  ctx.on("message", async (session) => {
    const sessionKey = `${session.platform}:${session.userId}`;
    const mallSession = mallSessions.get(sessionKey);

    // 如果没有会话或在群聊中，忽略
    if (!mallSession || session.guildId) {
      return;
    }

    // 更新会话时间
    mallSession.lastActivity = Date.now();

    try {
      const input = session.content?.trim().toLowerCase() || "";
      const originalInput = session.content?.trim() || "";

      // 通用退出
      if (input === "退出" || input === "exit") {
        mallSessions.delete(sessionKey);
        await session.send("👋 下次再来喔");
        return;
      }

      // 主菜单阶段
      if (mallSession.step === "main") {
        if (input === "ai" || input === "虚拟") {
          const response = await showCategoryProducts(ctx, session, "ai");
          await session.send(response);
          return;
        }
        if (input === "实体" || input === "实物") {
          const response = await showCategoryProducts(ctx, session, "physical");
          await session.send(response);
          return;
        }
        if (input === "记录") {
          const response = await showExchangeRecords(ctx, session);
          await session.send(response);
          return;
        }
        // 无效输入
        await session.send("❓ 请输入有效选项：AI、实体、记录 或 退出");
        return;
      }

      // 分类商品阶段
      if (mallSession.step === "category") {
        if (input === "返回") {
          const response = await showMainMenu(ctx, session);
          await session.send(response);
          return;
        }

        // 尝试解析商品序号
        const productIndex = parseInt(originalInput);
        if (!isNaN(productIndex) && productIndex >= 1) {
          const response = await showProductDetail(ctx, session, productIndex);
          await session.send(response);
          return;
        }

        await session.send("❓ 请输入商品序号查看详情，或回复「返回」回主菜单");
        return;
      }

      // 商品详情阶段
      if (mallSession.step === "product") {
        if (input === "返回") {
          // 返回分类列表
          if (mallSession.category) {
            const response = await showCategoryProducts(ctx, session, mallSession.category);
            await session.send(response);
          }
          return;
        }

        if (input === "确认" || input === "兑换") {
          const response = await executeExchange(ctx, session);
          await session.send(response);
          return;
        }

        await session.send("❓ 回复「确认」兑换，或「返回」回商品列表");
        return;
      }

    } catch (error) {
      ctx.logger.error("处理商城消息失败:", error);
      await session.send("❌ 处理过程中出现错误，请重新进入商城");
      mallSessions.delete(sessionKey);
    }
  });

  ctx.logger.info("商城命令已注册");
}
