require("dotenv").config();
const fs = require("fs");
const path = require("path");

const TIMELINE_PATH = path.join(__dirname, "enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = process.env.TIME_ZONE || "Europe/London";

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function loadTimelineMessages() {
  // ========== 新增：文件不存在则自动创建空数组 ==========
  if (!fs.existsSync(TIMELINE_PATH)) {
    fs.writeFileSync(TIMELINE_PATH, JSON.stringify([], null, 2), "utf-8");
    console.log("自动创建空 enhanced_messages.json");
  }
  // =====================================================

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return new Date().toLocaleString("zh-CN", { timeZone: TIME_ZONE });
}

function getLocalTimeString() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  const hour = now.getHours();
  if (hour >= 10 && hour < 24) return diffMinutes >= 60;
  return diffMinutes >= 120;
}
function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      // 优先取消息自带时间字段，不再解析文本
      const timeVal = msg.timestamp || msg.time || msg.created_at;
      if (timeVal) {
        return new Date(timeVal);
      }
    }
  }
  // 兜底：实在没有任何时间字段，返回当前时间（避免直接退出）
  console.log("消息无内置时间字段，使用系统当前时间兜底");
  return new Date();
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes) {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes);
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成 Bark 推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  // ========= 仅新增这两行，其余不动 =========
  console.log("【间隔分钟数】", diffMinutes);
  console.log("【最后用户时间戳】", lastUserTime);
  // ========================================

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
  { role: "system", content: wakePrompt },
  { role: "system", content: cleanSP },
  {
    role: "system",
    content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
  },
  // 新增一条必须的 user 消息，满足硅基接口校验规则
  {
    role: "user",
    content: "用户已经长时间没有进行对话，请你结合聊天记录，按照你的唤醒规则判断是否需要发送提醒消息。"
  }
];

  console.log("\n===== WAKE MESSAGES =====\n");
  console.log(JSON.stringify(wakeMessages, null, 2));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 15000);
const response = await fetch(process.env.TARGET_API_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.TARGET_API_KEY}`
  },
  body: JSON.stringify({
    model: process.env.MODEL_NAME,
    messages: wakeMessages,
    temperature: 0.8,
    top_p: 0.95,
    stream: false
  }),
  signal: controller.signal
}).finally(() => clearTimeout(timeoutId));

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`模型返回的不是 JSON（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  console.log("\nWake Result:\n");
  console.log(JSON.stringify(data, null, 2));

  const aiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nAI内容：\n");
  console.log(aiText);

  let eventContent;

  if (!aiText) {
    console.log("\nAI 返回空内容，本次不发送 Bark\n");
    eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark｜原因：模型空回复）`;
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI 选择不发送 Bark
    console.log("\nAI 选择不发送 Bark\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark）`;
  } else {
    // 没有 [NO_ACTION] 就视为想发 Bark
    console.log("\nAI 选择发送 Bark\n");
    let barkText = aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\nBark 内容清洗后为空，本次不发送 Bark\n");
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark｜原因：Bark 内容为空）`;
    } else if (lines.length === 1) {
      title = "🫥";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // ≥3 行：第一行标题，剩余用空格拼接成正文
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // 保护：截断过长正文（Bark 限制约 500 字符）
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      // 若标题为空或以数字开头，加个前缀，可自行修改
      let safeTitle = title || "来自伴侣";
      if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;

      if (!process.env.BARK_KEY) {
        console.log("\n未配置 BARK_KEY，本次不发送 Bark\n");
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark｜原因：Bark Key 未配置）`;
      } else {
// 改用GET链接推送，移除POST兼容问题
// 拼接自定义图标参数
let iconSuffix = "";
if (process.env.CUSTOM_ICON_URL && process.env.CUSTOM_ICON_URL.trim() !== "") {
  iconSuffix = `?icon=${encodeURIComponent(process.env.CUSTOM_ICON_URL.trim())}`;
}
// 拼接带图标的推送地址
const barkUrl = `https://api.day.app/${process.env.BARK_KEY}/${encodeURIComponent(safeTitle)}/${encodeURIComponent(safeBody)}${iconSuffix}`;
const barkResponse = await fetch(barkUrl);
const barkTextResult = await barkResponse.text();
let barkResult = {};
try {
  barkResult = JSON.parse(barkTextResult);
} catch {}
console.log("\nBark Result:\n", barkResult || barkTextResult);

if (!barkResponse.ok || (barkResult.code && barkResult.code !== 200)) {
  const reason = barkResult.message || `HTTP ${barkResponse.status}`;
  eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送 Bark｜原因：Bark 推送失败：${reason}）`;
} else {
  eventContent = `（${getLocalTimeString()} 刚刚给用户发了 Bark：${safeTitle}｜${safeBody}）`;
}
      }
    }
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  const hour = new Date().getHours();
  const isNight = hour >= 0 && hour < 10;   // 夜间 0-10 点
  return isNight ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;  // 夜间2h，白天10min
}

async function scheduleNextCheck() {
  const intervalMin = getCheckIntervalMs() / 60000;
  console.log(`【定时轮询节点】本轮检测开始，预设间隔 ${intervalMin} 分钟`);
  try {
    // 发送心跳（增加8秒超时，空捕获会卡死循环）
    try {
      const hbController = new AbortController();
      const hbTimeout = setTimeout(() => hbController.abort(), 8000);
      await fetch(HEARTBEAT_URL, { 
        method: "POST",
        signal: hbController.signal
      }).finally(() => clearTimeout(hbTimeout));
    } catch (err) {
      console.log("内部心跳接口请求异常，跳过本轮心跳:", err.message);
    }
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查整体出错:", err);
  }
  // 无论成败，强制预约下一轮，杜绝循环断掉
  const nextDelay = getCheckIntervalMs();
  console.log(`【定时轮询节点】已预约下一次检测，${nextDelay/60000}分钟后执行`);
  setTimeout(scheduleNextCheck, nextDelay);
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log("==================================\n");
