// Wake one Grok Bot through this bridge's sendPrompt endpoint.
// Roster path: GROK_BOT_ROSTER, or config/grok-bot-roster.json next to the repo root.
// Copy config/grok-bot-roster.example.json over that file and replace the placeholder ids.
// Requires GROK_BOT_SENDPROMPT_URL and GROK_BOT_GATEWAY_TOKEN (already set in the container).
// Does not print the token or the agent id.
//
// node scripts/send-grok-bot-prompt.mjs example_bot "List the bots you know."

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const replyPath = [
  "Reply on Discord through your Discord connector.",
  "This send did not come from a Discord channel and does not include a channel id or a callback.",
  "accepted:true only means you were woken.",
  "A reply that stays in the Grok Bot session is not delivered to Discord.",
  "Post the answer with the bridge POST /callback for the channel you were asked about, or through the Grok Bot Discord connector.",
].join(" ");

const alias = (process.argv[2] || "").trim();
const promptBody = process.argv.slice(3).join(" ").trim();
const prompt = promptBody ? `${promptBody}\n\n${replyPath}` : "";
if (!alias || !prompt) {
  console.log("usage: node scripts/send-grok-bot-prompt.mjs <alias> <prompt>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rosterPath = process.env.GROK_BOT_ROSTER || resolve(root, "config", "grok-bot-roster.json");
const roster = JSON.parse(await readFile(rosterPath, "utf8"));
const row = roster.find((item) => item.alias === alias);
if (!row?.agentId || row.agentId.endsWith("000000000001") || row.agentId.endsWith("000000000002")) {
  console.log("status unknown-alias");
  console.log(alias);
  process.exit(2);
}

const url = process.env.GROK_BOT_SENDPROMPT_URL;
const token = process.env.GROK_BOT_GATEWAY_TOKEN;
if (!url || !token) {
  console.log("status missing-env");
  process.exit(1);
}

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json",
    authorization: "Bearer " + token,
  },
  body: JSON.stringify({
    agentId: row.agentId,
    prompt,
    metadata: { source: "bridge-send-grok-bot-prompt", alias },
  }),
});
const text = await res.text();
console.log("status", res.status);
console.log(text.slice(0, 2000));
if (!res.ok) process.exit(1);
