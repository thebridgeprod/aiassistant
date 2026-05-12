const express = require("express");
const app = express();
app.use(express.json());

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID      = process.env.PC_APP_ID;
const PC_SECRET      = process.env.PC_SECRET;
const MY_PHONE       = process.env.MY_PHONE_NUMBER;
const SIGNAL_NUMBER  = process.env.SIGNAL_NUMBER;
const SIGNAL_API     = process.env.SIGNAL_API || "http://signal-cli-rest-api.railway.internal:8080";
const POLL_INTERVAL  = 3000;

// ─── In-memory state ─────────────────────────────────────────────────────────
const conversations = {};
let lastTimestamp = Date.now();
let isPolling = false;

// ─── Planning Center cache (5 min TTL) ──────────────────────────────────────
let pcCache = { context: null, fetchedAt: 0 };

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

async function sendSignalMessage(recipient, message) {
  try {
    const r = await fetch(`${SIGNAL_API}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        number: SIGNAL_NUMBER,
        recipients: [recipient],
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error(`Signal send failed: ${r.status} ${text}`);
    }
  } catch (e) {
    console.error("Send error:", e.message);
  }
}

async function handleMessage(from, body) {
  if (!body) return;
  if (MY_PHONE && from !== MY_PHONE) return;

  console.log(`Message from ${from}: ${body}`);

  if (["reset", "clear"].includes(body.toLowerCase())) {
    conversations[from] = [];
    pcCache = { context: null, fetchedAt: 0 };
    await sendSignalMessage(from, "Cleared! Fresh start. What do you need?");
    return;
  }

  if (body.toLowerCase() === "refresh") {
    pcCache = { context: null, fetchedAt: 0 };
    await sendSignalMessage(from, "Planning Center data will refresh on your next message.");
    return;
  }

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: "user", content: body });
  if (conversations[from].length > 10) conversations[from] = conversations[from].slice(-10);

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
        system: `You are a Production Team AI assistant for a church, accessed via Signal messenger. Help the production director manage their volunteer team.

Live Planning Center data (refreshed every 5 minutes):
${pcContext}

Keep responses concise and practical. No markdown formatting — plain text only since this is a messaging app. For drafted messages or detailed lists, longer responses are fine.
Commands the user can send: RESET (clear history), REFRESH (force Planning Center data update).`,
        messages: conversations[from].map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const data = await aiRes.json();
    const reply =
      data.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ||
      "Sorry, I couldn't respond. Try again.";

    conversations[from].push({ role: "assistant", content: reply });
    await sendSignalMessage(from, reply);
    console.log(`Replied to ${from}`);
  } catch (e) {
    console.error("AI error:", e.message);
    await sendSignalMessage(from, "Something went wrong. Please try again.");
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
async function pollMessages() {
  if (isPolling) return; // prevent overlapping polls
  isPolling = true;
  try {
    const url = `${SIGNAL_API}/v1/receive/${encodeURIComponent(SIGNAL_NUMBER)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (r.status === 200) {
      const text = await r.text();
      if (!text || text === "null") return;
      
      let messages;
      try {
        messages = JSON.parse(text);
      } catch {
        return;
      }

      if (!Array.isArray(messages) || messages.length === 0) return;

      for (const msg of messages) {
        try {
          const envelope = msg?.envelope;
          if (!envelope) continue;

          const dataMessage = envelope?.dataMessage;
          if (!dataMessage) continue;

          const msgTimestamp = envelope.timestamp || 0;
          if (msgTimestamp && msgTimestamp <= lastTimestamp) continue;
          if (msgTimestamp) lastTimestamp = msgTimestamp;

          const from = envelope.source;
          const body = (dataMessage.message || "").trim();

          await handleMessage(from, body);
        } catch (e) {
          console.error("Error processing individual message:", e.message);
        }
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  } finally {
    isPolling = false;
  }
}

// Start polling
setTimeout(() => {
  console.log("Starting message polling...");
  setInterval(pollMessages, POLL_INTERVAL);
}, 3000);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Production Hub Signal server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Keep process alive and handle errors gracefully
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e.message));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
