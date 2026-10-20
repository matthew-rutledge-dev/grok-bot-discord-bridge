#!/usr/bin/env node
// LOCAL_PLANNER_POWERSHELL stand-in for the Linux bridge container.
// The bridge spawns this with the same argv it would pass powershell.exe:
//   -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <ps1> -UserPrompt <text> [-ImagePath <file>]
// The container cannot see the planner host's local drives (the ps1 path is passed
// through unchanged, e.g. C:\path\to\planner.ps1) and the planner host has no sshd, so this forwards to the
// localhost planner listener (reverse tunnel) which spawns the ps1 as a child.
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
}
const userPrompt = flag("-UserPrompt");
const imagePath = flag("-ImagePath");
const dryRun = args.includes("-DryRun");
const url = (process.env.LOCAL_PLANNER_URL || "http://host.docker.internal:18771/plan").trim();
const token = (process.env.LOCAL_PLANNER_TOKEN || "").trim();
if (!userPrompt || !token || !url) {
  console.error("local_planner_forward_missing");
  process.exit(2);
}
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + token,
  },
  body: JSON.stringify({
    userPrompt,
    imagePath,
    channelId: "",
    slug: "local-planner",
    messageId: "bridge-spawn",
    dryRun,
  }),
});
const text = await res.text();
let parsed = {};
try { parsed = JSON.parse(text); } catch { /* ignore */ }
const blob = String(parsed.stdoutTail || "") + "\n" + String(parsed.stderrTail || "");
for (const line of blob.split(/\r?\n/)) {
  if (/primary_llm|wake_local_planner|wake_pixel_edit|entrypoint|DryRun|planner phase|calling in help|escalation|unavailable|Comfy/.test(line)) {
    console.log(line.slice(0, 240));
  }
}
console.log("forward_status=" + res.status + " exit=" + (parsed.exitCode ?? ""));
process.exit(res.ok && parsed.ok === true ? 0 : 1);
