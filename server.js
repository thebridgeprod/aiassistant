const express = require("express");
const crypto = require("crypto");
const app = express();

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID            = process.env.PC_APP_ID;
const PC_SECRET            = process.env.PC_SECRET;
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// ─── In-memory state ─────────────────────────────────────────────────────────
const conversations = {};
let pcCache = { context: null, fetchedAt: 0 };

// ─── Raw body parser ─────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ─── Slack signature verification ────────────────────────────────────────────
function verifySlackSignature(req) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBase = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ─── Planning Center API helper ───────────────────────────────────────────────
async function pcFetch(path) {
  const auth = Buffer.from(`${PC_APP_ID}:${PC_SECRET}`).toString("base64");
  const r = await fetch(`https://api.planningcenteronline.com${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`PC API error ${r.status} on ${path}`);
  return r.json();
}

function fmtDate(s) {
  if (!s) return "TBD";
  return new Date(s).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function fmtTime(s) {
  if (!s) return "";
  return new Date(s).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

// ─── Planning Center Tools ────────────────────────────────────────────────────

async function getScheduleSummary() {
  try {
    const stData = await pcFetch("/services/v2/service_types?per_page=10");
    const sts = stData.data || [];
    if (!sts.length) return "No service types found.";

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
          if (unconfirmed.length) ctx += `  Pending: ${unconfirmed.map((m) => `${m.attributes.name} (${m.attributes.team_position_name || "team"})`).join(", ")}\n`;
          if (declined.length) ctx += `  Declined: ${declined.map((m) => `${m.attributes.name} (${m.attributes.team_position_name || "team"})`).join(", ")}\n`;
        } catch {
          ctx += "  (Could not load team)\n";
        }
      }
    }

    pcCache = { context: ctx, fetchedAt: Date.now() };
    return ctx;
  } catch (e) {
    return `Could not fetch schedule: ${e.message}`;
  }
}

async function searchPeople(name) {
  try {
    const data = await pcFetch(
      `/people/v2/people?where[search_name]=${encodeURIComponent(name)}&include=emails,phone_numbers,addresses&per_page=5`
    );
    const people = data.data || [];
    if (!people.length) return `No one found matching "${name}".`;

    const included = data.included || [];

    return people.map((p) => {
      const attr = p.attributes;
      const personEmails = included
        .filter((i) => i.type === "Email" && p.relationships?.emails?.data?.some((e) => e.id === i.id))
        .map((i) => `${i.attributes.address} (${i.attributes.location || "email"})`);
      const personPhones = included
        .filter((i) => i.type === "PhoneNumber" && p.relationships?.phone_numbers?.data?.some((ph) => ph.id === i.id))
        .map((i) => `${i.attributes.number} (${i.attributes.location || "phone"})`);

      return [
        `Name: ${attr.first_name} ${attr.last_name}`,
        attr.birthdate ? `Birthday: ${attr.birthdate}` : "",
        personPhones.length ? `Phone: ${personPhones.join(", ")}` : "Phone: not on file",
        personEmails.length ? `Email: ${personEmails.join(", ")}` : "Email: not on file",
      ].filter(Boolean).join("\n");
    }).join("\n\n");
  } catch (e) {
    return `Error searching people: ${e.message}`;
  }
}

async function getBlockouts(startDate, endDate) {
  try {
    const start = startDate || new Date().toISOString().split("T")[0];
    const end = endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const data = await pcFetch(
      `/services/v2/blockouts?filter=future&where[starts_at][gte]=${start}&where[ends_at][lte]=${end}&include=person&per_page=50`
    );
    const blockouts = data.data || [];
    if (!blockouts.length) return `No blockouts found between ${start} and ${end}.`;

    const included = data.included || [];

    return blockouts.map((b) => {
      const attr = b.attributes;
      const personId = b.relationships?.person?.data?.id;
      const person = included.find((i) => i.id === personId);
      const personName = person ? `${person.attributes.first_name} ${person.attributes.last_name}` : "Unknown";
      return `${personName}: blocked out ${fmtDate(attr.starts_at)} to ${fmtDate(attr.ends_at)}${attr.reason ? ` (${attr.reason})` : ""}`;
    }).join("\n");
  } catch (e) {
    return `Error fetching blockouts: ${e.message}`;
  }
}

async function getServiceTimes(planId, serviceTypeId) {
  try {
    let stId = serviceTypeId;
    let pId = planId;

    // If no IDs provided, get the next upcoming plan
    if (!stId || !pId) {
      const stData = await pcFetch("/services/v2/service_types?per_page=5");
      const sts = stData.data || [];
      if (!sts.length) return "No service types found.";

      let results = [];
      for (const st of sts.slice(0, 2)) {
        const plansData = await pcFetch(
          `/services/v2/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=2`
        );
        const plans = plansData.data || [];
        for (const plan of plans.slice(0, 2)) {
          const timesData = await pcFetch(
            `/services/v2/service_types/${st.id}/plans/${plan.id}/plan_times`
          );
          const times = timesData.data || [];
          const p = plan.attributes;
          const timeStrs = times.map((t) => {
            const ta = t.attributes;
            return `${ta.name || "Service"}: ${fmtTime(ta.starts_at)} - ${fmtTime(ta.ends_at)}`;
          });
          results.push(`[${st.attributes.name}] ${p.title || "Service"} on ${fmtDate(p.sort_date)}:\n  ${timeStrs.join("\n  ") || "No times set"}`);
        }
      }
      return results.join("\n\n") || "No upcoming service times found.";
    }
  } catch (e) {
    return `Error fetching service times: ${e.message}`;
  }
}

async function getPersonSchedule(name) {
  try {
    // First find the person
    const peopleData = await pcFetch(
      `/people/v2/people?where[search_name]=${encodeURIComponent(name)}&per_page=3`
    );
    const people = peopleData.data || [];
    if (!people.length) return `No one found matching "${name}".`;

    const person = people[0];
    const personName = `${person.attributes.first_name} ${person.attributes.last_name}`;

    // Get their upcoming schedule from services
    const scheduleData = await pcFetch(
      `/services/v2/people/${person.id}/schedules?filter=future&per_page=10`
    );
    const schedules = scheduleData.data || [];
    if (!schedules.length) return `${personName} has no upcoming scheduled services.`;

    const scheduleList = schedules.map((s) => {
      const a = s.attributes;
      return `${fmtDate(a.sort_date)}: ${a.service_type_name || "Service"} — ${a.team_position_name || "Team"} (${a.status || "unknown"})`;
    }).join("\n");

    return `${personName}'s upcoming schedule:\n${scheduleList}`;
  } catch (e) {
    return `Error fetching schedule for ${name}: ${e.message}`;
  }
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────
const tools = [
  {
    name: "get_schedule_summary",
    description: "Get the current schedule summary including upcoming service plans, team member counts, confirmed/pending/declined status. Use this for general schedule questions.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "search_people",
    description: "Search for a person by name and get their contact information including phone numbers and email addresses.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the person to search for (first name, last name, or both)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_blockouts",
    description: "Get a list of people who have blocked out their availability (marked as unavailable) within a date range.",
    input_schema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format. Defaults to today if not provided.",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format. Defaults to 14 days from now if not provided.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_service_times",
    description: "Get the actual service times (start and end times) for upcoming plans.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_person_schedule",
    description: "Get the upcoming service schedule for a specific person — what services they are scheduled for and their status.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the person",
        },
      },
      required: ["name"],
    },
  },
];

// ─── Execute a tool call ──────────────────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`Executing tool: ${toolName}`, JSON.stringify(toolInput));
  switch (toolName) {
    case "get_schedule_summary":
      return await getScheduleSummary();
    case "search_people":
      return await searchPeople(toolInput.name);
    case "get_blockouts":
      return await getBlockouts(toolInput.start_date, toolInput.end_date);
    case "get_service_times":
      return await getServiceTimes();
    case "get_person_schedule":
      return await getPersonSchedule(toolInput.name);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── Slack helpers ────────────────────────────────────────────────────────────
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

// ─── Handle message with tool use ────────────────────────────────────────────
async function handleMessage(userId, channelId, text) {
  if (!text) return;
  console.log(`Message from ${userId}: ${text}`);

  if (["reset", "clear"].includes(text.toLowerCase())) {
    conversations[userId] = [];
    await sendSlackMessage(channelId, "Cleared! Fresh start. What do you need?");
    return;
  }

  if (text.toLowerCase() === "refresh") {
    pcCache = { context: null, fetchedAt: 0 };
    await sendSlackMessage(channelId, "Cache cleared — fresh data on your next question.");
    return;
  }

  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: "user", content: text });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  const messages = conversations[userId].map((m) => ({ role: m.role, content: m.content }));

  let response;
  let finalReply = "";

  // Agentic loop — keep going until Claude stops using tools
  while (true) {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: `You are a Production Team AI assistant for a church, accessed via Slack. Help the production director manage their volunteer team.

You have access to tools that can fetch live data from Planning Center. Use them whenever the user asks about schedules, contacts, availability, or service times. Always fetch fresh data rather than guessing.

Keep responses concise and practical. Plain text only — no markdown since this is Slack. For drafted messages or lists, longer is fine.
Commands: reset (clear history), refresh (clear cache).`,
        tools,
        messages,
      }),
    });

    const data = await response.json();
    console.log("Claude stop reason:", data.stop_reason);

    if (data.stop_reason === "tool_use") {
      // Add Claude's response to messages
      messages.push({ role: "assistant", content: data.content });

      // Execute all tool calls
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      // Add tool results to messages
      messages.push({ role: "user", content: toolResults });

    } else {
      // Claude is done — extract final text reply
      finalReply = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") || "Sorry, I couldn't generate a response.";
      break;
    }
  }

  conversations[userId].push({ role: "assistant", content: finalReply });
  await sendSlackMessage(channelId, finalReply);
  console.log(`Replied to ${userId}`);
}

// ─── Slack Events endpoint ────────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  if (!verifySlackSignature(req)) {
    console.log("Signature verification failed");
    return res.status(401).send("Unauthorized");
  }

  const { type, challenge, event } = req.body;

  if (type === "url_verification") {
    return res.json({ challenge });
  }

  res.sendStatus(200);

  if (type === "event_callback") {
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

process.on("uncaughtException", (e) => console.error("Uncaught exception:", e.message, e.stack));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
