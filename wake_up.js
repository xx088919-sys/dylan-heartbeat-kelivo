require("dotenv").config();

const Fastify = require("fastify");
const fs = require("fs-extra");

const DEFAULT_BODY_LIMIT_MB = 50;

function readBodyLimitBytes() {
const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
logger: true,
bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIMELINE_FILE = "enhanced_messages.json";
const TIMESTAMP_DB_FILE = "./message_timestamps.json";
const DEFAULT_RESTART_COMMAND = "";

// ========================
// 多模态消息处理
// ========================
function shouldForwardMultimodalContent() {
const mode = (process.env.MULTIMODAL_MODE || "text").trim().toLowerCase();
return mode === "passthrough" || mode === "vision" || mode === "true";
}

function isDataImageUrl(value) {
return typeof value === "string" && /^data:image//i.test(value);
}

function isImageContentPart(part) {
if (!part || typeof part !== "object") return false;
if (part.image_url) return true;
const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
return type.includes("image");
}

function isFileContentPart(part) {
if (!part || typeof part !== "object") return false;
if (part.file) return true;
const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
return type.includes("file");
}

function getTextFromContentPart(part) {
if (typeof part === "string") return part;
if (!part || typeof part !== "object") return "";
const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
if (type === "text" || type === "input_text") return part.text || part.content || "";
if (typeof part.text === "string") return part.text;
return "";
}

function normalizeContentToText(content) {
if (typeof content === "string") return content;
if (content == null) return "";

if (Array.isArray(content)) {
const parts = content
.map(part => {
const text = getTextFromContentPart(part).trim();
if (text) return text;
if (isImageContentPart(part)) return "[图片]";
if (isFileContentPart(part)) return "[文件]";
return "";
})
.filter(Boolean);
return parts.join("\n");
}

if (isImageContentPart(content)) return "[图片]";
if (isFileContentPart(content)) return "[文件]";
return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
return { ...msg, content: normalizeContentToText(msg.content) };
}

function sanitizeForLog(value) {
if (typeof value === "string") {
if (isDataImageUrl(value)) return "[base64 image omitted]";
if (value.length > 1000) return value.slice(0, 1000) + "...";
return value;
}
if (Array.isArray(value)) return value.map(sanitizeForLog);
if (value && typeof value === "object") {
const out = {};
for (const k in value) out[k] = sanitizeForLog(value[k]);
return out;
}
return value;
}

// ========================
// timeline
// ========================
function loadTimeline() {
if (!fs.existsSync(TIMELINE_FILE)) fs.writeFileSync(TIMELINE_FILE, "[]");
try {
const data = fs.readJsonSync(TIMELINE_FILE);
return Array.isArray(data) ? data : [];
} catch {
return [];
}
}

function saveTimeline(messages) {
fs.writeJsonSync(TIMELINE_FILE, messages, { spaces: 2 });
}

// ========================
// ⭐ 修复点：appendSpecialEvent
// ========================
async function appendSpecialEvent(content) {
const timeline = loadTimeline();
const maxPos = timeline.reduce((m, i) => Math.max(m, i.position || 0), 0);

const newEvent = {
role: "assistant",
content,
position: maxPos + 0.5
};

timeline.push(newEvent);
saveTimeline(timeline);

console.log("🟢 special event:", content);

// ⭐ 防御性调用
try {
if (typeof sendBark === "function") {
await sendBark("HEARTBEAT", content);
} else {
console.warn("sendBark not defined, skip push");
}
} catch (e) {
console.error("sendBark failed:", e.message);
}
}

// ========================
// ⭐ 修复点：internal wake-event
// ========================
app.post("/internal/wake-event", async (req, reply) => {
try {
const { content } = req.body || {};
if (!content) return reply.code(400).send({ error: "content required" });

```
await appendSpecialEvent(content);

reply.send({ success: true });
```

} catch (err) {
reply.code(500).send({ error: err.message });
}
});

// ========================
// heartbeat
// ========================
let wakeUpLastHeartbeat = null;

app.post("/internal/heartbeat", async (req, reply) => {
wakeUpLastHeartbeat = Date.now();
reply.send({ ok: true });
});

// ========================
// chat completions（保持原逻辑）
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
try {
const body = req.body;

```
const llmMessages = (body.messages || []).map(m => ({
  ...m,
  content: normalizeContentToText(m.content)
}));

const response = await fetch(TARGET_API_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.TARGET_API_KEY}`
  },
  body: JSON.stringify({ ...body, messages: llmMessages })
});

const json = await response.json();
return reply.send(json);
```

} catch (e) {
console.error(e);
reply.code(500).send({ error: e.message });
}
});

// ========================
app.listen({ port: PORT, host: "0.0.0.0" }, () => {
console.log("gateway running");
});
