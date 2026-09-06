/**
 * 긴 파일도 처리하는 시간 창(window) 단위 전사 파이프라인.
 *
 *  mount(WORKERFS)  ─ 파일 전체를 메모리에 올리지 않음
 *  for each window [i*W, (i+1)*W):
 *      ffmpeg 로 [segStart, segEnd] 구간만 16kHz mono PCM 추출  (앞뒤 OVERLAP 여유)
 *      whisper 워커로 전사 → 세그먼트 상대 타임스탬프에 segStart 오프셋
 *      수용 밴드 [i*W, (i+1)*W) 안(중앙값 기준)의 조각만 채택 → 경계 중복 제거
 *      부분 자막 콜백 + localStorage 에 진행 저장
 *  최대 메모리 ≈ 한 구간분, 처리 시간만 길이에 비례.
 */
import {
  loadFFmpeg,
  mountFile,
  unmountFile,
  probeDurationSec,
  extractSegmentPcm,
  SAMPLE_RATE,
} from "./ffmpeg";
import type { DeviceKind, ModelKey } from "./models";
import { chunksToCues, type Cue, type WhisperChunk } from "./subtitle";
import {
  loadProgress,
  saveProgress,
  clearProgress,
  makeSignature,
} from "./progress-store";

export const WINDOW_SEC = 600; // 10분
export const OVERLAP_SEC = 4; // 창 앞뒤로 물리는 여유 (whisper 문맥용)

export interface PipelineOptions {
  file: File;
  modelKey: ModelKey;
  device: DeviceKind;
  language: string; // "" = 자동 감지
  resume: boolean;
}

export interface PipelineCallbacks {
  onLog: (message: string) => void;
  /** 모델 다운로드 진행 (최초 1회). pct 0~100 */
  onModelDownload: (pct: number, detail: string) => void;
  onPhase: (label: string) => void;
  /** 한 구간 끝날 때마다: 지금까지의 자막과 처리 위치 */
  onWindow: (info: { processedSec: number; totalSec: number; cues: Cue[] }) => void;
  /** true 를 돌려주면 다음 구간 전에 중단(진행은 저장됨) */
  shouldCancel?: () => boolean;
}

export interface PipelineResult {
  cues: Cue[];
  totalSec: number;
  elapsedSec: number;
  canceled: boolean;
}

/* ------------------------------------------------------------------ *
 * whisper 워커 (파이프라인이 소유, 세션 내 재사용)
 * ------------------------------------------------------------------ */
let worker: Worker | null = null;
let onReady: (() => void) | null = null;
let onResult: ((r: { chunks: WhisperChunk[] }) => void) | null = null;
let onError: ((e: Error) => void) | null = null;
let onDownload: ((pct: number, detail: string) => void) | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./transcriber.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data;
    switch (m?.type) {
      case "download": {
        const done = m.files.filter((f: { progress: number }) => f.progress >= 100).length;
        onDownload?.(m.overall, `${done}/${m.files.length} 파일`);
        break;
      }
      case "ready":
        onReady?.();
        onReady = null;
        break;
      case "result":
        onResult?.({ chunks: m.chunks as WhisperChunk[] });
        onResult = null;
        break;
      case "error":
        onError?.(new Error(m.message));
        onError = null;
        break;
    }
  });
  return worker;
}

function workerLoad(modelKey: ModelKey, device: DeviceKind): Promise<void> {
  return new Promise((resolve, reject) => {
    onReady = resolve;
    onError = reject;
    ensureWorker().postMessage({ type: "load", modelKey, device });
  });
}

function workerTranscribe(pcm: Float32Array, language: string): Promise<WhisperChunk[]> {
  return new Promise((resolve, reject) => {
    onResult = ({ chunks }) => resolve(chunks);
    onError = reject;
    ensureWorker().postMessage({ type: "transcribe", audio: pcm, language }, [pcm.buffer]);
  });
}

/* ------------------------------------------------------------------ */

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return (h ? `${h}:` : "") + `${mm}:${String(ss).padStart(2, "0")}`;
}

export async function runPipeline(
  opts: PipelineOptions,
  cb: PipelineCallbacks,
): Promise<PipelineResult> {
  const started = performance.now();
  onDownload = (pct, detail) =>
    cb.onModelDownload(pct, `모델 다운로드 ${pct.toFixed(0)}% · ${detail} (최초 1회, 이후 캐시)`);

  const sig = makeSignature(opts.file, opts.modelKey, opts.language, WINDOW_SEC);

  cb.onPhase("ffmpeg 준비 중…");
  await loadFFmpeg(cb.onLog);
  const inputPath = await mountFile(opts.file, cb.onLog);

  cb.onPhase("미디어 길이 확인 중…");
  let totalSec = await probeDurationSec(inputPath, cb.onLog);
  cb.onLog(totalSec > 0 ? `미디어 길이 ${fmtDuration(totalSec)}` : "길이를 알 수 없음 — 끝까지 진행");

  cb.onPhase("모델 로드 중…");
  await workerLoad(opts.modelKey, opts.device);

  // 재개 상태 복원
  let rawChunks: WhisperChunk[] = [];
  let startIndex = 0;
  if (opts.resume) {
    const saved = loadProgress();
    if (saved && saved.sig === sig) {
      rawChunks = saved.rawChunks;
      startIndex = saved.nextIndex;
      if (totalSec <= 0 && saved.totalSec > 0) totalSec = saved.totalSec;
      cb.onLog(`이어서 재개: 구간 ${startIndex + 1}부터, 기존 조각 ${rawChunks.length}개`);
    }
  } else {
    clearProgress();
  }

  const numWindows =
    totalSec > 0 ? Math.max(1, Math.ceil(totalSec / WINDOW_SEC)) : Number.MAX_SAFE_INTEGER;

  let canceled = false;

  for (let i = startIndex; i < numWindows; i++) {
    if (cb.shouldCancel?.()) {
      canceled = true;
      cb.onLog("사용자 중단 — 진행 상태 저장됨 (다시 실행하면 이어서 진행)");
      break;
    }

    const bandLo = i * WINDOW_SEC;
    const bandHi = bandLo + WINDOW_SEC;
    if (totalSec > 0 && bandLo >= totalSec) break;

    const segStart = Math.max(0, bandLo - OVERLAP_SEC);
    const segEnd = totalSec > 0 ? Math.min(totalSec, bandHi + OVERLAP_SEC) : bandHi + OVERLAP_SEC;
    const segDur = segEnd - segStart;
    const isLast = totalSec > 0 && bandHi >= totalSec;

    cb.onPhase(
      `전사 중 · ${fmtDuration(bandLo)} / ${totalSec > 0 ? fmtDuration(totalSec) : "?"}` +
        (totalSec > 0 ? ` (구간 ${i + 1}/${numWindows})` : ` (구간 ${i + 1})`),
    );

    const pcm = await extractSegmentPcm(inputPath, segStart, segDur, cb.onLog);
    if (pcm.length < SAMPLE_RATE) {
      cb.onLog(`구간 ${i + 1}: 오디오 없음 → 종료`);
      break;
    }

    const chunks = await workerTranscribe(pcm, opts.language);

    for (const c of chunks) {
      const relStart = c.timestamp?.[0] ?? 0;
      const relEnd = c.timestamp?.[1] ?? relStart;
      const cs = relStart + segStart;
      const ce = relEnd + segStart;
      const mid = (cs + ce) / 2;
      // 수용 밴드: [i*W, (i+1)*W). 마지막 구간은 상한 없음.
      if (mid >= bandLo - 0.001 && (isLast || mid < bandHi)) {
        const text = c.text.trim();
        if (text) rawChunks.push({ timestamp: [cs, ce], text });
      }
    }

    const cues = chunksToCues(rawChunks, { totalDuration: totalSec });
    const processedSec = totalSec > 0 ? Math.min(totalSec, bandHi) : segEnd;
    cb.onWindow({ processedSec, totalSec, cues });

    saveProgress({
      sig,
      rawChunks,
      nextIndex: i + 1,
      totalSec,
      windowSec: WINDOW_SEC,
      updatedAt: Date.now(),
    });

    if (isLast) break;
  }

  await unmountFile().catch(() => {});

  const cues = chunksToCues(rawChunks, { totalDuration: totalSec });
  if (!canceled) clearProgress();

  return {
    cues,
    totalSec,
    elapsedSec: (performance.now() - started) / 1000,
    canceled,
  };
}
