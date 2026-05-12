const express = require("express");
const crypto = require("crypto");
const app = express();

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID          = process.env.PC_APP_ID;
const PC_SECRET          = process.env.PC_SECRET;
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// ─── In-memory state ─────────────────────────────────────────────────────────
const conversations = {};
let pcCache = { context: null, fetchedAt: 0 };

// ─── Raw body parser for Slack signature verification ────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ─── Slack signature verification ────────────────────────────────────────────
function verifySlackSignature(req) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  // Prevent replay attacks
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const sigBase = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return "TBD";
  return new Date(s).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

async function pcFetch(path) {
  const auth = Buffer.from(`${PC_APP_ID}:${PC_SECRET}`).toString("base64");
  const r = await fetch(`https://api.planningcenteronline.com${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`PC ${r.status}`);
  return r.json();
}

async function getPlanningCenterContext() {
  if (pcCache.context && Date.now() - pcCache.fetchedAt < 5 * 60 * 1000) {
    return pcCache.context;
  }
  try {
    const stData = await pcFetch("/services/v2/service_types?per_page=10");
    const sts = stData.data || [];
    if (!sts.length) return "No service types found in Planning Center.";

    let ctx = `Service types: ${sts.map((s) => s.attributes.name).join(", ")}.\n`;

    for (const st of sts.slice(0, 2)) {
      const plansData = await pcFetch(
        `/services/v2/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=3`
      );
      const plans = plansData.data || [];

      for (const plan of plans.slice(0, 2)) {
        const p = plan.attributes;
        ctx += `\n[${st.attributes.name}] "${p.title || "Service"}" on ${fmtDate(p.sort_date)}\n`;
        try {
          const teamData = await pcFetch(
            `/services/v2/service_types/${st.id}/plans/${plan.id}/team_members?per_page=40`
          );
          const team = teamData.data || [];
          const confirmed   = team.filter((m) => m.attributes.status === "C");
          const unconfirmed = team.filter((m) => m.attributes.status === "U");
          const declined    = team.filter((m) => m.attributes.status === "D");
          ctx += `  Team: ${confirmed.length} confirmed, ${unconfirmed.length} pending, ${declined.length} declined\n`;
          if (unconfirmed.length) {
            ctx += `  Pending: ${unconfirmed.map((m) => `${m.attributes.name} (${m.attributes.team_position_name || "team"})`).join(", ")}\n`;
          }
          if (declined.length) {
            ctx += `  Declined: ${declined.map((m) => `${m.attributes.name} (${m.attributes.team_position_name || "team"})`).join(", ")}\n`;
          }
        } catch {
          ctx += "  (Could not load team members)\n";
        }
      }
    }

    pcCache = { context: ctx, fetchedAt: Date.now() };
    return ctx;
  } catch (e) {
    return `Could not fetch Planning Center data: ${e.message}`;
  }
}

async function sendSlackMessage(channel, text) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await r.json();
  if (!data.ok) console.error("Slack send error:", data.error);
}

async function handleMessage(userId, channelId, text) {
  if (!text) return;

  console.log(`Message from ${userId}: ${text}`);

  // Reset command
  if (["reset", "clear"].includes(text.toLowerCase())) {
    conversations[userId] = [];
    pcCache = { context: null, fetchedAt: 0 };
    await sendSlackMessage(channelId, "Cleared! Fresh start. What do you need?");
    return;
  }

  // Refresh command
  if (text.toLowerCase() === "refresh") {
    pcCache = { context: null, fetchedAt: 0 };
    await sendSlackMessage(channelId, "Planning Center data will refresh on your next message.");
    return;
  }

  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: "user", content: text });
  if (conversations[userId].length > 10) conversations[userId] = conversations[userId].slice(-10);

  try {
    const pcContext = await getPlanningCenterContext();

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: `You are a Production Team AI assistant for a church, accessed via Slack. Help the production director manage their volunteer team.

Live Planning Center data (refreshed every 5 minutes):
${pcContext}

Keep responses concise and practical. No markdown formatting — plain text only. For drafted messages or detailed lists, longer responses are fine.
Commands the user can send: reset (clear history), refresh (force Planning Center data update).`,
        messages: conversations[userId].map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const data = await aiRes.json();
    const reply =
      data.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ||
      "Sorry, I couldn't respond. Try again.";

    conversations[userId].push({ role: "assistant", content: reply });
    await sendSlackMessage(channelId, reply);
    console.log(`Replied to ${userId}`);
  } catch (e) {
    console.error("Error:", e.message);
    await sendSlackMessage(channelId, "Something went wrong. Please try again.");
  }
}

// ─── Slack Events endpoint ────────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  // Verify signature
  if (!verifySlackSignature(req)) {
    return res.status(401).send("Unauthorized");
  }

  const { type, challenge, event } = req.body;

  // URL verification challenge
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // Acknowledge immediately
  res.sendStatus(200);

  // Handle direct messages and app mentions
  if (type === "event_callback") {
    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype === "bot_message") return;

    if (event.type === "message" || event.type === "app_mention") {
      const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();
      await handleMessage(event.user, event.channel, text);
    }
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Production Hub Slack server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.on("uncaughtException", (e) => console.error("Uncaught exception:", e.message));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
