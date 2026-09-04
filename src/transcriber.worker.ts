/// <reference lib="webworker" />
/**
 * 무거운 작업(모델 다운로드 + 추론)을 담당하는 Web Worker.
 * 메인 스레드와는 postMessage 로만 통신한다.
 */
import { pipeline, env } from "@huggingface/transformers";
import { MODELS, dtypeFor, type DeviceKind, type ModelKey } from "./models";
import type { WhisperChunk } from "./subtitle";

/** 파이프라인 호출부의 타입 유니온이 과도하게 커서, 호출 시그니처만 좁혀 사용. */
type AsrRunner = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text?: string; chunks?: WhisperChunk[] }>) & {
  dispose?: () => Promise<void>;
};

// 브라우저 전용: 로컬 모델 탐색 비활성화, HF Hub 에서만 로드
env.allowLocalModels = false;

type InMessage =
  | { type: "load"; modelKey: ModelKey; device: DeviceKind }
  | { type: "transcribe"; audio: Float32Array; language: string };

type OutMessage =
  | { type: "log"; message: string }
  | { type: "download"; overall: number; files: FileProgress[] }
  | { type: "ready"; device: DeviceKind; modelKey: ModelKey }
  | { type: "result"; chunks: unknown; text: string; elapsedSec: number }
  | { type: "error"; message: string };

interface FileProgress {
  file: string;
  loaded: number;
  total: number;
  progress: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: OutMessage, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}

let transcriber: AsrRunner | null = null;
let loadedKey = "";
let loadedDevice = "";

const fileProgress = new Map<string, FileProgress>();

function handleProgress(data: {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}) {
  if (!data.file) return;
  if (data.status === "progress" || data.status === "download" || data.status === "initiate") {
    const prev = fileProgress.get(data.file) ?? {
      file: data.file,
      loaded: 0,
      total: 0,
      progress: 0,
    };
    fileProgress.set(data.file, {
      file: data.file,
      loaded: data.loaded ?? prev.loaded,
      total: data.total ?? prev.total,
      progress: data.progress ?? prev.progress,
    });
  }
  if (data.status === "done" && fileProgress.has(data.file)) {
    const f = fileProgress.get(data.file)!;
    f.progress = 100;
    f.loaded = f.total || f.loaded;
  }

  const files = [...fileProgress.values()].filter((f) => f.total > 0);
  const totalBytes = files.reduce((s, f) => s + f.total, 0);
  const loadedBytes = files.reduce((s, f) => s + f.loaded, 0);
  const overall = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
  post({ type: "download", overall, files });
}

async function load(modelKey: ModelKey, device: DeviceKind) {
  if (transcriber && loadedKey === modelKey && loadedDevice === device) {
    post({ type: "ready", device, modelKey });
    return;
  }

  if (transcriber) {
    await transcriber.dispose?.().catch(() => {});
    transcriber = null;
  }
  fileProgress.clear();

  const info = MODELS[modelKey];
  post({ type: "log", message: `모델 로드 시작: ${info.id} (${device})` });

  transcriber = (await pipeline("automatic-speech-recognition", info.id, {
    device,
    dtype: dtypeFor(modelKey, device),
    progress_callback: handleProgress as (progress: unknown) => void,
  })) as unknown as AsrRunner;

  loadedKey = modelKey;
  loadedDevice = device;
  post({ type: "log", message: "모델 준비 완료" });
  post({ type: "ready", device, modelKey });
}

async function transcribe(audio: Float32Array, language: string) {
  if (!transcriber) throw new Error("모델이 아직 로드되지 않았습니다.");

  post({ type: "log", message: "전사 시작..." });
  const t0 = performance.now();

  const options: Record<string, unknown> = {
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    // 무음에서의 환각을 줄이기 위한 보수적 설정
    no_speech_threshold: 0.6,
    logprob_threshold: -1.0,
    compression_ratio_threshold: 2.4,
  };
  // 빈 문자열이면 언어 자동 감지 (키 자체를 넣지 않음)
  if (language) options.language = language;

  const output = await transcriber(audio, options);
  const result = Array.isArray(output) ? output[0] : output;

  post({
    type: "result",
    chunks: (result as { chunks?: unknown }).chunks ?? [],
    text: (result as { text?: string }).text ?? "",
    elapsedSec: (performance.now() - t0) / 1000,
  });
}

ctx.addEventListener("message", async (event: MessageEvent<InMessage>) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      await load(msg.modelKey, msg.device);
    } else if (msg.type === "transcribe") {
      await transcribe(msg.audio, msg.language);
    }
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
});
