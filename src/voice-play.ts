import { Readable } from "node:stream";
import { ChannelType, type Client } from "discord.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** 48 kHz stereo s16le PCM. A short tone the voice encoder can play. */
export function buildTonePcm(seconds = 2): Buffer {
  const frames = SAMPLE_RATE * seconds;
  const buf = Buffer.alloc(frames * CHANNELS * 2);
  const freq = 440;
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.2;
    const n = Math.max(-32767, Math.min(32767, (sample * 32767) | 0));
    const offset = i * CHANNELS * 2;
    buf.writeInt16LE(n, offset);
    buf.writeInt16LE(n, offset + 2);
  }
  return buf;
}

/**
 * Join one guild voice channel, play a two-second tone, then leave.
 * Requires @discordjs/voice, an Opus library, and the GuildVoiceStates intent.
 */
export async function playToneInChannel(
  client: Client,
  channelId: string,
): Promise<void> {
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
  try {
    await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15_000);
    const player = voice.createAudioPlayer();
    connection.subscribe(player);
    const resource = voice.createAudioResource(Readable.from(buildTonePcm(2)), {
      inputType: voice.StreamType.Raw,
    });
    player.play(resource);
    await voice.entersState(player, voice.AudioPlayerStatus.Playing, 10_000);
    await voice.entersState(player, voice.AudioPlayerStatus.Idle, 15_000);
  } finally {
    connection.destroy();
  }
}
