const express = require("express");
const crypto = require("crypto");
const app = express();

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const PC_APP_ID            = process.env.PC_APP_ID;
const PC_SECRET            = process.env.PC_SECRET;
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// ─── Target service types & teams ────────────────────────────────────────────
const TARGET_SERVICE_TYPES = ["Worship Experience", "Midweek Experience", "Bridge Youth"];
const PRODUCTION_TEAM_NAME = "Production";

// ─── In-memory state ─────────────────────────────────────────────────────────
const conversations = {};

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
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function fmtTime(s) {
  if (!s) return "";
  return new Date(s).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
}

// ─── Get target service types ─────────────────────────────────────────────────
async function getTargetServiceTypes() {
  const data = await pcFetch("/services/v2/service_types?per_page=25");
  const all = data.data || [];
  return all.filter((st) => TARGET_SERVICE_TYPES.includes(st.attributes.name));
}

// ─── Get Production team ID for a plan ───────────────────────────────────────
async function getProductionTeamId(serviceTypeId, planId) {
  try {
    const data = await pcFetch(
      `/services/v2/service_types/${serviceTypeId}/plans/${planId}/teams?per_page=25`
    );
    const teams = data.data || [];
    console.log("Teams found:", teams.map((t) => t.attributes.name));
    const prodTeam = teams.find((t) =>
      t.attributes.name.toLowerCase().includes(PRODUCTION_TEAM_NAME.toLowerCase())
    );
    return prodTeam ? prodTeam.id : null;
  } catch (e) {
    console.error("Error fetching teams:", e.message);
    return null;
  }
}

// ─── Get only Production team members for a plan ─────────────────────────────
async function getProductionMembers(serviceTypeId, planId) {
  const teamId = await getProductionTeamId(serviceTypeId, planId);
  if (!teamId) {
    console.log("No Production team found, returning all members");
    const data = await pcFetch(
      `/services/v2/service_types/${serviceTypeId}/plans/${planId}/team_members?per_page=100`
    );
    return data.data || [];
  }
  const data = await pcFetch(
    `/services/v2/service_types/${serviceTypeId}/plans/${planId}/team_members?filter=team&where[team_id]=${teamId}&per_page=100`
  );
  return data.data || [];
}

// ─── Planning Center Tools ────────────────────────────────────────────────────

async function getScheduleSummary(productionOnly = false) {
  try {
    const sts = await getTargetServiceTypes();
    if (!sts.length) return "Could not find Worship Experience, Midweek Experience, or Bridge Youth in Planning Center.";

    let ctx = "";

    for (const st of sts) {
      const plansData = await pcFetch(
        `/services/v2/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=2`
      );
      const plans = plansData.data || [];

      if (!plans.length) {
        ctx += `\n[${st.attributes.name}] No upcoming plans.\n`;
        continue;
      }

      for (const plan of plans.slice(0, 2)) {
        const p = plan.attributes;
        let team;
        if (productionOnly) {
          team = await getProductionMembers(st.id, plan.id);
        } else {
          const teamData = await pcFetch(
            `/services/v2/service_types/${st.id}/plans/${plan.id}/team_members?per_page=100`
          );
          team = teamData.data || [];
        }

        const confirmed   = team.filter((m) => m.attributes.status === "C");
        const unconfirmed = team.filter((m) => m.attributes.status === "U");
        const declined    = team.filter((m) => m.attributes.status === "D");

        ctx += `\n[${st.attributes.name}] "${p.title || "Service"}" on ${fmtDate(p.sort_date)}\n`;
        ctx += `  ${confirmed.length} confirmed, ${unconfirmed.length} pending, ${declined.length} declined\n`;

        if (confirmed.length) ctx += `  Confirmed: ${confirmed.map((m) => `${m.attributes.name} (${m.attributes.team_position_name})`).join(", ")}\n`;
        if (unconfirmed.length) ctx += `  Pending: ${unconfirmed.map((m) => `${m.attributes.name} (${m.attributes.team_position_name})`).join(", ")}\n`;
        if (declined.length) ctx += `  Declined: ${declined.map((m) => `${m.attributes.name} (${m.attributes.team_position_name})`).join(", ")}\n`;
      }
    }

    return ctx || "No upcoming plans found.";
  } catch (e) {
    return `Error fetching schedule: ${e.message}`;
  }
}

async function getPlanTeam(serviceTypeName, dateHint, productionOnly = true) {
  try {
    const sts = await getTargetServiceTypes();
    const st = sts.find((s) =>
      s.attributes.name.toLowerCase().includes(serviceTypeName.toLowerCase())
    ) || sts[0];

    if (!st) return "Could not find that service type.";

    const plansData = await pcFetch(
      `/services/v2/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=10`
    );
    const plans = plansData.data || [];
    if (!plans.length) return `No upcoming plans found for ${st.attributes.name}.`;

    let targetPlan = plans[0];
    if (dateHint) {
      const hintDate = new Date(dateHint);
      let closest = Infinity;
      for (const plan of plans) {
        const planDate = new Date(plan.attributes.sort_date);
        const diff = Math.abs(planDate - hintDate);
        if (diff < closest) {
          closest = diff;
          targetPlan = plan;
        }
      }
    }

    const p = targetPlan.attributes;
    let team;
    if (productionOnly) {
      team = await getProductionMembers(st.id, targetPlan.id);
    } else {
      const teamData = await pcFetch(
        `/services/v2/service_types/${st.id}/plans/${targetPlan.id}/team_members?per_page=100`
      );
      team = teamData.data || [];
    }

    if (!team.length) {
      return productionOnly
        ? `No Production team members scheduled for ${st.attributes.name} on ${fmtDate(p.sort_date)}. The team may not be scheduled yet.`
        : `No team members scheduled for ${st.attributes.name} on ${fmtDate(p.sort_date)}.`;
    }

    const confirmed   = team.filter((m) => m.attributes.status === "C");
    const unconfirmed = team.filter((m) => m.attributes.status === "U");
    const declined    = team.filter((m) => m.attributes.status === "D");

    let result = `${st.attributes.name} — ${p.title || "Service"} on ${fmtDate(p.sort_date)}\n`;
    result += `Production Team: ${confirmed.length} confirmed, ${unconfirmed.length} pending, ${declined.length} declined\n\n`;

    if (confirmed.length) {
      result += `CONFIRMED:\n${confirmed.map((m) => `  ${m.attributes.team_position_name}: ${m.attributes.name}`).join("\n")}\n\n`;
    }
    if (unconfirmed.length) {
      result += `PENDING:\n${unconfirmed.map((m) => `  ${m.attributes.team_position_name}: ${m.attributes.name}`).join("\n")}\n\n`;
    }
    if (declined.length) {
      result += `DECLINED:\n${declined.map((m) => `  ${m.attributes.team_position_name}: ${m.attributes.name}`).join("\n")}\n`;
    }

    return result;
  } catch (e) {
    return `Error fetching team: ${e.message}`;
  }
}

async function searchPeople(name) {
  try {
    const data = await pcFetch(
      `/people/v2/people?where[search_name]=${encodeURIComponent(name)}&include=emails,phone_numbers&per_page=5`
    );
    const people = data.data || [];
    if (!people.length) return `No one found matching "${name}".`;

    const included = data.included || [];

    return people.map((p) => {
      const attr = p.attributes;
      const phones = included
        .filter((i) => i.type === "PhoneNumber" && p.relationships?.phone_numbers?.data?.some((ph) => ph.id === i.id))
        .map((i) => `${i.attributes.number} (${i.attributes.location || "phone"})`);
      const emails = included
        .filter((i) => i.type === "Email" && p.relationships?.emails?.data?.some((e) => e.id === i.id))
        .map((i) => `${i.attributes.address} (${i.attributes.location || "email"})`);

      return [
        `Name: ${attr.first_name} ${attr.last_name}`,
        phones.length ? `Phone: ${phones.join(", ")}` : "Phone: not on file",
        emails.length ? `Email: ${emails.join(", ")}` : "Email: not on file",
      ].join("\n");
    }).join("\n\n");
  } catch (e) {
    return `Error searching people: ${e.message}`;
  }
}

async function getBlockouts(startDate, endDate) {
  try {
    const start = startDate || new Date().toISOString().split("T")[0];
    const end = endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const data = await pcFetch(`/services/v2/blockouts?filter=future&per_page=50`);
    const blockouts = data.data || [];
    const included = data.included || [];

    const filtered = blockouts.filter((b) => {
      const bStart = new Date(b.attributes.starts_at);
      const bEnd = new Date(b.attributes.ends_at);
      return bStart <= new Date(end) && bEnd >= new Date(start);
    });

    if (!filtered.length) return `No blockouts found between ${start} and ${end}.`;

    return filtered.map((b) => {
      const attr = b.attributes;
      const personId = b.relationships?.person?.data?.id;
      const person = included.find((i) => i.id === personId);
      const personName = person ? `${person.attributes.first_name} ${person.attributes.last_name}` : "Unknown";
      return `${personName}: ${fmtDate(attr.starts_at)} to ${fmtDate(attr.ends_at)}${attr.reason ? ` — ${attr.reason}` : ""}`;
    }).join("\n");
  } catch (e) {
    return `Error fetching blockouts: ${e.message}`;
  }
}

async function getServiceTimes() {
  try {
    const sts = await getTargetServiceTypes();
    let results = [];

    for (const st of sts) {
      const plansData = await pcFetch(
        `/services/v2/service_types/${st.id}/plans?filter=future&order=sort_date&per_page=2`
      );
      const plans = plansData.data || [];

      for (const plan of plans.slice(0, 1)) {
        const p = plan.attributes;
        const timesData = await pcFetch(
          `/services/v2/service_types/${st.id}/plans/${plan.id}/plan_times`
        );
        const times = timesData.data || [];
        const timeStrs = times.map((t) => {
          const ta = t.attributes;
          return `  ${ta.name || "Service"}: ${fmtTime(ta.starts_at)} - ${fmtTime(ta.ends_at)}`;
        });
        results.push(
          `[${st.attributes.name}] ${p.title || "Service"} on ${fmtDate(p.sort_date)}:\n${timeStrs.join("\n") || "  No times set"}`
        );
      }
    }

    return results.join("\n\n") || "No upcoming service times found.";
  } catch (e) {
    return `Error fetching service times: ${e.message}`;
  }
}

async function getPersonSchedule(name) {
  try {
    const peopleData = await pcFetch(
      `/people/v2/people?where[search_name]=${encodeURIComponent(name)}&per_page=3`
    );
    const people = peopleData.data || [];
    if (!people.length) return `No one found matching "${name}".`;

    const person = people[0];
    const personName = `${person.attributes.first_name} ${person.attributes.last_name}`;

    const scheduleData = await pcFetch(
      `/services/v2/people/${person.id}/schedules?filter=future&per_page=10`
    );
    const schedules = scheduleData.data || [];
    if (!schedules.length) return `${personName} has no upcoming scheduled services.`;

    const list = schedules.map((s) => {
      const a = s.attributes;
      return `${fmtDate(a.sort_date)}: ${a.service_type_name || "Service"} — ${a.team_position_name || "Team"} (${a.status || "unknown"})`;
    }).join("\n");

    return `${personName}'s upcoming schedule:\n${list}`;
  } catch (e) {
    return `Error fetching schedule for ${name}: ${e.message}`;
  }
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────
const tools = [
  {
    name: "get_schedule_summary",
    description: "Get a summary of all upcoming plans for Worship Experience, Midweek Experience, and Bridge Youth. Set production_only to true to see only Production team members.",
    input_schema: {
      type: "object",
      properties: {
        production_only: {
          type: "boolean",
          description: "If true, only show Production team members. Default true.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_plan_team",
    description: "Get the team list for a specific service and date. Always use production_only=true unless the user specifically asks about another team. Use this for questions like 'who is serving this Sunday' or 'who is on the team for Wednesday'.",
    input_schema: {
      type: "object",
      properties: {
        service_type_name: {
          type: "string",
          description: "The service type: 'Worship Experience', 'Midweek Experience', or 'Bridge Youth'",
        },
        date_hint: {
          type: "string",
          description: "Date in YYYY-MM-DD format to find the closest plan to.",
        },
        production_only: {
          type: "boolean",
          description: "If true, only show Production team members. Default true.",
        },
      },
      required: ["service_type_name"],
    },
  },
  {
    name: "search_people",
    description: "Search for a person by name and get their contact info — phone and email.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_blockouts",
    description: "Get people who have blocked out their availability within a date range.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: [],
    },
  },
  {
    name: "get_service_times",
    description: "Get the actual start and end times for upcoming services.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_person_schedule",
    description: "Get the upcoming service schedule for a specific person.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name" },
      },
      required: ["name"],
    },
  },
];

// ─── Execute a tool call ──────────────────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`Tool: ${toolName}`, JSON.stringify(toolInput));
  switch (toolName) {
    case "get_schedule_summary":
      return await getScheduleSummary(toolInput.production_only !== false);
    case "get_plan_team":
      return await getPlanTeam(
        toolInput.service_type_name,
        toolInput.date_hint,
        toolInput.production_only !== false
      );
    case "search_people":       return await searchPeople(toolInput.name);
    case "get_blockouts":       return await getBlockouts(toolInput.start_date, toolInput.end_date);
    case "get_service_times":   return await getServiceTimes();
    case "get_person_schedule": return await getPersonSchedule(toolInput.name);
    default: return `Unknown tool: ${toolName}`;
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

  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: "user", content: text });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  const messages = conversations[userId].map((m) => ({ role: m.role, content: m.content }));
  const today = new Date().toISOString().split("T")[0];

  let finalReply = "";

  while (true) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: `You are a Production Team AI assistant for The Bridge Church, accessed via Slack. Help the production director manage their volunteer team.

Today's date is ${today}.

The Bridge has these regular services:
- Worship Experience: Sundays
- Midweek Experience: Wednesdays
- Bridge Youth: Wednesdays

The Production team at The Bridge handles: Cameras, FOH Audio, Online Audio, Lighting, CG (graphics), TD (technical director), Producer, Photographer, Host, Stage Manager, and similar technical roles.

CRITICAL RULES:
- NEVER invent, guess, or make up names, positions, or any data. Only report what tools return.
- ALWAYS use tools to fetch real data before answering questions about schedules, people, or availability.
- By default always use production_only=true when fetching team data unless the user asks about other teams.
- When asked about "this Sunday", calculate the next Sunday from today and use get_plan_team with "Worship Experience".
- When asked about "this Wednesday" or "this week's midweek", use get_plan_team with "Midweek Experience".
- If a tool returns no Production team members, say so honestly — the team may not be scheduled yet.
- Plain text only — no markdown. Keep responses concise and practical.

Commands: reset (clear history).`,
        tools,
        messages,
      }),
    });

    const data = await response.json();
    console.log("Claude stop reason:", data.stop_reason);

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
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
      messages.push({ role: "user", content: toolResults });
    } else {
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
    return res.status(401).send("Unauthorized");
  }
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.json({ challenge });
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
