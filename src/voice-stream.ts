import { Readable } from "node:stream";
import { ChannelType, type Client } from "discord.js";
import { FRAME_BYTES, PcmMixer } from "./voice-mix.js";

const PUMP_MS = 20;

type OpenStream = {
  channelId: string;
  guildId: string;
  mixer: PcmMixer;
  stream: Readable;
  timer: NodeJS.Timeout;
  destroy: () => void;
};

let active: OpenStream | null = null;

export function voiceStreamStatus(): {
  open: boolean;
  channelId: string | null;
  layers: { id: string; loop: boolean; framesLeft: number }[];
} {
  if (!active) return { open: false, channelId: null, layers: [] };
  return { open: true, channelId: active.channelId, layers: active.mixer.list() };
}

export function voiceStreamMixer(): PcmMixer | null {
  return active?.mixer ?? null;
}

export async function openVoiceStream(client: Client, channelId: string): Promise<void> {
  if (active?.channelId === channelId) return;
  closeVoiceStream();
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice || !channel.guild) {
    throw new Error("not_a_voice_channel");
  }
  const voice = await import("@discordjs/voice");
  const connection = voice.joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const mixer = new PcmMixer();
  const stream = new Readable({ read() {} });
  const player = voice.createAudioPlayer();
  try {
    await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15_000);
    connection.subscribe(player);
    stream.push(Buffer.alloc(FRAME_BYTES));
    player.play(voice.createAudioResource(stream, { inputType: voice.StreamType.Raw }));
    await voice.entersState(player, voice.AudioPlayerStatus.Playing, 10_000);
  } catch (err) {
    connection.destroy();
    stream.destroy();
    throw err;
  }
  const timer = setInterval(() => {
    const frame = mixer.nextFrame();
    if (!stream.push(frame)) stream.resume();
  }, PUMP_MS);
  timer.unref?.();
  active = {
    channelId: channel.id,
    guildId: channel.guild.id,
    mixer,
    stream,
    timer,
    destroy: () => connection.destroy(),
  };
}

export function closeVoiceStream(): boolean {
  if (!active) return false;
  clearInterval(active.timer);
  active.stream.push(null);
  active.destroy();
  active = null;
  return true;
}
