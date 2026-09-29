import { loadConfig } from "./config.js";
import {
  createDiscordClient,
  loginDiscord,
  wireDiscord,
} from "./discord-bot.js";
import { createHttpServer, listenHttp } from "./http-server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  let discord: ReturnType<typeof createDiscordClient> | null = null;

  const app = createHttpServer(cfg, () => discord);
  await listenHttp(app, cfg);

  if (cfg.httpOnly) {
    console.log("[boot] HTTP_ONLY=1 — Discord Gateway disabled");
    return;
  }

  if (!cfg.hasRealDiscordToken) {
    console.error(
      "[boot] DISCORD_BOT_TOKEN missing or placeholder — refusing Discord Gateway login.",
    );
    console.error(
      "[boot] HTTP /healthz is up. Fill .env from vault DISCORD_FLEET_WAKE, then restart.",
    );
    console.error(
      "[boot] Exiting cleanly so compose does not pretend to be live. Leave stack stopped until token is set.",
    );
    // Exit non-zero so operators notice; prefer keeping compose down until ready.
    process.exitCode = 2;
    // Keep HTTP briefly so `compose config` / health probes during bring-up can see us, then exit.
    setTimeout(() => process.exit(2), 1500);
    return;
  }

  discord = createDiscordClient();
  wireDiscord(discord, cfg);
  await loginDiscord(discord, cfg.discordToken);
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
