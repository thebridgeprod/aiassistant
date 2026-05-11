const express = require("express");
const app = express();
app.use(express.urlencoded({ extended: false }));

// ─── Environment variables (set these in Railway) ────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID      = process.env.PC_APP_ID;
const PC_SECRET      = process.env.PC_SECRET;
const MY_PHONE       = process.env.MY_PHONE_NUMBER; // e.g. +14051234567

// ─── In-memory conversation history (resets if server restarts) ──────────────
const conversations = {};

// ─── Simple 5-minute cache for Planning Center data ──────────────────────────
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
  // Return cached data if it's less than 5 minutes old
  if (pcCache.context && Date.now() - pcCache.fetchedAt < 5 * 60 * 1000) {
    return pcCache.context;
  }

  try {
    const stData = await pcFetch("/services/v2/service_types?per_page=10");
    const sts = stData.data || [];
    if (!sts.length) return "No service types found in Planning Center.";

    let ctx = `Service types: ${sts.map((s) => s.attributes.name).join(", ")}.\n`;

    // Pull upcoming plans for each service type (up to 2 types)
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

function xmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function twimlReply(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`;
}

// ─── SMS webhook ─────────────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  res.type("text/xml");

  // Security: ignore texts from unknown numbers
  if (MY_PHONE && from !== MY_PHONE) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  // "reset" clears conversation history
  if (["reset", "clear"].includes(body.toLowerCase())) {
    conversations[from] = [];
    pcCache = { context: null, fetchedAt: 0 }; // also bust the PC cache
    return res.send(twimlReply("Cleared! Fresh start. What do you need?"));
  }

  // "refresh" forces a fresh Planning Center pull
  if (body.toLowerCase() === "refresh") {
    pcCache = { context: null, fetchedAt: 0 };
    return res.send(twimlReply("Planning Center data will refresh on your next message."));
  }

  // Initialize history for this number
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: "user", content: body });

  // Keep last 10 messages to stay within token limits
  if (conversations[from].length > 10) {
    conversations[from] = conversations[from].slice(-10);
  }

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
        max_tokens: 500,
        system: `You are a Production Team AI assistant for a church, accessed via SMS. Help the production director manage their volunteer team.

Live Planning Center data (refreshed every 5 minutes):
${pcContext}

SMS rules:
- Keep most replies under 320 characters (1-2 texts)
- For drafted messages or lists, longer is fine
- Be direct, warm, and practical
- No markdown — plain text only
- Commands the user can send: RESET (clear history), REFRESH (force PC data update)`,
        messages: conversations[from].map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    const data = await aiRes.json();
    const reply =
      data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") || "Sorry, I couldn't respond. Try again.";

    conversations[from].push({ role: "assistant", content: reply });
    return res.send(twimlReply(reply));
  } catch (e) {
    console.error("Error:", e);
    return res.send(twimlReply(`Something went wrong: ${e.message.slice(0, 100)}`));
  }
});

// Health check
app.get("/", (req, res) => res.send("Production Hub SMS server is running ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
