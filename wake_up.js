let WAKE_RUNNING = false;
require("dotenv").config();
function reportStatus(type, extra = {}) {
  return fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      time: Date.now(),
      ...extra
    })
  }).catch(() => {});
}
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
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

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
  if (hour >= 10 && hour < 24) return diffMinutes >= 60;   // 白天：1小时
  return diffMinutes >= 120;                               // 夜间：2小时
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      const match = content.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      if (match) return new Date(match[1]);
    }
  }
  return null;
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
  if (WAKE_RUNNING) return;
  WAKE_RUNNING = true;

  try {
    const messages = loadTimelineMessages();
    if (!messages) {
      console.log("未找到 messages");
      return;
    }

    const lastUserTime = getLastUserTime(messages);
    if (!lastUserTime) {
      console.log("未找到用户时间");
      return;
    }

    const now = new Date();
    const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

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
      ? normalizeContentToText(baseSystemPrompt.content)
          .split("## Memories")[0]
          .trim()
      : "";

    const wakeMessages = [
      { role: "system", content: wakePrompt },
      { role: "system", content: cleanSP },
      {
        role: "system",
        content: `以下是最近聊天记录，仅供参考：

用户并没有发送新消息。

${historyText}`
      }
    ];

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
      })
    });

    const responseText = await response.text();

    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      console.error("JSON解析失败:", err);
      return;
    }

    if (!response.ok) {
      throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
    }

    console.log("\nWake Result:\n", data);

    const aiText = normalizeContentToText(
      data?.choices?.[0]?.message?.content
    ).trim();

    console.log("\nAI内容:\n", aiText);

  } catch (err) {
    console.error("runWakeUp error:", err);

  } finally {
    WAKE_RUNNING = false;
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  const hour = new Date().getHours();
  const isNight = hour >= 0 && hour < 10;   // 夜间 0-10 点
  return isNight ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;  // 夜间2h，白天10min
}

async function scheduleNextCheck() {
  try {
  

    await runWakeUp();

   
   } catch (err) {
    console.error("唤醒检查出错:", err);

  } finally {
    WAKE_RUNNING = false;
  }
}

  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
let started = false;

if (!started) {
  started = true;
  setTimeout(scheduleNextCheck, 10_000);
}

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log("==================================\n");
// ❌ 暂时关闭，避免重复触发
// setInterval(() => {
//   fetch(HEARTBEAT_URL).catch(() => {});
// }, 30000);


