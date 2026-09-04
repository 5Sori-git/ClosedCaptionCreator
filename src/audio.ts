/**
 * 임의의 오디오/영상 File -> Whisper 입력용 16kHz mono Float32Array.
 *
 * - 영상: ffmpeg.wasm 으로 오디오만 뽑아 WAV 로 만든 뒤 디코드
 * - 오디오: 브라우저 내장 디코더로 바로 디코드
 * - 16kHz 가 아니면 OfflineAudioContext 로 리샘플, 스테레오는 mono 로 다운믹스
 */
import { extractAudioFromVideo } from "./ffmpeg";

const TARGET_SAMPLE_RATE = 16000;

type Logger = (message: string) => void;

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|ts|mpg|mpeg|wmv|flv|3gp)$/i;

function isVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  if (file.type.startsWith("audio/")) return false;
  return VIDEO_EXT.test(file.name);
}

export interface DecodedAudio {
  pcm: Float32Array;
  durationSec: number;
}

export async function fileToPcm16k(file: File, onLog?: Logger): Promise<DecodedAudio> {
  let bytes: ArrayBuffer;

  if (isVideo(file)) {
    onLog?.("영상에서 오디오 추출 중 (ffmpeg.wasm)...");
    bytes = await extractAudioFromVideo(file, onLog);
  } else {
    bytes = await file.arrayBuffer();
  }

  onLog?.("오디오 디코딩 중...");
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  // 가능한 브라우저에서는 디코딩 단계에서 바로 16kHz 로 리샘플되도록 시도
  let ctx: AudioContext;
  try {
    ctx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    ctx = new AudioCtx();
  }

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }

  const pcm = await toMono16k(audioBuffer, onLog);
  return { pcm, durationSec: pcm.length / TARGET_SAMPLE_RATE };
}

async function toMono16k(buffer: AudioBuffer, onLog?: Logger): Promise<Float32Array> {
  if (buffer.sampleRate === TARGET_SAMPLE_RATE) {
    return downmix(buffer);
  }

  onLog?.(`리샘플링 ${buffer.sampleRate}Hz -> ${TARGET_SAMPLE_RATE}Hz...`);
  const frameCount = Math.ceil(buffer.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();

  const length = buffer.length;
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  for (let i = 0; i < length; i++) out[i] /= channels;
  return out;
}
