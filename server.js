const express = require("express");
const WebSocket = require("ws");
const app = express();
app.use(express.json());

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID      = process.env.PC_APP_ID;
const PC_SECRET      = process.env.PC_SECRET;
const MY_PHONE       = process.env.MY_PHONE_NUMBER;
const SIGNAL_NUMBER  = process.env.SIGNAL_NUMBER;
const SIGNAL_API     = process.env.SIGNAL_API || "http://signal-cli-rest-api.railway.internal:8080";

// ─── In-memory conversation history ─────────────────────────────────────────
const conversations = {};

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
    throw new Error(`Signal send failed: ${r.status} ${text}`);
  }
}

async function handleMessage(from, body) {
  if (!body) return;
  if (MY_PHONE && from !== MY_PHONE) return;

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
}

// ─── WebSocket connection to signal-cli ──────────────────────────────────────
function connectWebSocket() {
  // Build WebSocket URL — encode the + in the phone number
  const wsBase = SIGNAL_API.replace("http://", "ws://").replace("https://", "wss://");
  const encodedNumber = encodeURIComponent(SIGNAL_NUMBER);
  const wsUrl = `${wsBase}/v1/receive/${encodedNumber}`;

  console.log("Connecting to WebSocket:", wsUrl);
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("Connected to signal-cli WebSocket successfully!");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log("Received message:", JSON.stringify(msg));

      const envelope = msg?.envelope;
      if (!envelope) return;

      const dataMessage = envelope?.dataMessage;
      if (!dataMessage) return;

      const from = envelope.source;
      const body = (dataMessage.message || "").trim();

      await handleMessage(from, body);
    } catch (e) {
      console.error("Error processing message:", e);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`WebSocket closed (${code}: ${reason}) — reconnecting in 5 seconds...`);
    setTimeout(connectWebSocket, 5000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

setTimeout(connectWebSocket, 3000);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Production Hub Signal server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
