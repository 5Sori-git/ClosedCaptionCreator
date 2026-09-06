/// <reference lib="webworker" />
/**
 * 무거운 작업(모델 다운로드 + 추론)을 담당하는 Web Worker.
 * 메인 스레드와는 postMessage 로만 통신한다.
 *
 * 전사 중에는 WhisperTextStreamer 의 on_chunk_start 로 내부 30초 청크마다
 * "구간 내 진행 위치(초)"를 보고해 세부 진행률/ETA 계산에 쓴다.
 */
import { pipeline, env, WhisperTextStreamer } from "@huggingface/transformers";
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
  | { type: "seg_progress"; offsetSec: number }
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
// 스트리머 구성에 필요한 tokenizer / processor / model 에 접근하기 위한 원본 참조
let pipelineObj: {
  tokenizer: unknown;
  processor?: { feature_extractor?: { config?: { chunk_length?: number } } };
  model?: { config?: { max_source_positions?: number } };
} | null = null;
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
    pipelineObj = null;
  }
  fileProgress.clear();

  const info = MODELS[modelKey];
  post({ type: "log", message: `모델 로드 시작: ${info.id} (${device})` });

  const p = await pipeline("automatic-speech-recognition", info.id, {
    device,
    dtype: dtypeFor(modelKey, device),
    progress_callback: handleProgress as (progress: unknown) => void,
  });

  transcriber = p as unknown as AsrRunner;
  pipelineObj = p as unknown as typeof pipelineObj;

  loadedKey = modelKey;
  loadedDevice = device;
  post({ type: "log", message: "모델 준비 완료" });
  post({ type: "ready", device, modelKey });
}

function timePrecision(): number {
  const chunkLen = pipelineObj?.processor?.feature_extractor?.config?.chunk_length;
  const maxPos = pipelineObj?.model?.config?.max_source_positions;
  if (chunkLen && maxPos) return chunkLen / maxPos;
  return 0.02; // whisper 기본값 (30 / 1500)
}

const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;
// 파이프라인이 내부적으로 오디오를 자르는 간격: window - 2*stride
const INTERNAL_JUMP_S = CHUNK_LENGTH_S - 2 * STRIDE_LENGTH_S;

async function transcribe(audio: Float32Array, language: string) {
  if (!transcriber) throw new Error("모델이 아직 로드되지 않았습니다.");

  const t0 = performance.now();

  const options: Record<string, unknown> = {
    task: "transcribe",
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    return_timestamps: true,
    // 무음에서의 환각을 줄이기 위한 보수적 설정
    no_speech_threshold: 0.6,
    logprob_threshold: -1.0,
    compression_ratio_threshold: 2.4,
  };
  if (language) options.language = language;

  // 진행 보고: WhisperTextStreamer 의 타임스탬프 콜백은 "현재 내부 30초 청크
  // 기준 상대 시각"을 주므로, on_finalize(내부 청크 종료)마다 오프셋을 누적해
  // 세그먼트 전체(0 → segDur) 기준의 절대 위치로 환산한다.
  let internalOffsetSec = 0;
  try {
    if (pipelineObj?.tokenizer) {
      const report = (relSec: number) =>
        post({ type: "seg_progress", offsetSec: internalOffsetSec + Math.max(0, relSec) });
      options.streamer = new WhisperTextStreamer(
        pipelineObj.tokenizer as ConstructorParameters<typeof WhisperTextStreamer>[0],
        {
          time_precision: timePrecision(),
          on_chunk_start: report,
          on_chunk_end: report,
          on_finalize: () => {
            internalOffsetSec += INTERNAL_JUMP_S;
            post({ type: "seg_progress", offsetSec: internalOffsetSec });
          },
        },
      );
    }
  } catch (err) {
    post({
      type: "log",
      message: `진행 스트리머 구성 실패(전사는 계속): ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

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
