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
