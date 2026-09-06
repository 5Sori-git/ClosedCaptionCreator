/**
 * ffmpeg.wasm 래퍼.
 *
 * 핵심: 입력 파일을 WASM 힙에 통째로 복사하지 않는다.
 * `mount(WORKERFS, { files: [file] })` 로 Blob 을 지연 마운트하고,
 * `-ss / -t` 로 필요한 시간 구간만 16kHz mono float32 raw PCM 으로 뽑는다.
 * → 파일 크기는 디스크 용량까지, 메모리는 "한 구간분"으로 제한된다.
 */
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.6";
const MOUNT_DIR = "/mnt";

export const SAMPLE_RATE = 16000;

type Logger = (message: string) => void;

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let mountedPath: string | null = null;
const logBuffer: string[] = [];

async function doLoad(onLog?: Logger): Promise<FFmpeg> {
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => {
    logBuffer.push(message);
    if (logBuffer.length > 800) logBuffer.shift();
    onLog?.(message);
  });

  const multiThread = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const pkg = multiThread ? "core-mt" : "core";
  const baseURL = `https://unpkg.com/@ffmpeg/${pkg}@${CORE_VERSION}/dist/esm`;

  onLog?.(`ffmpeg 코어 로드 중 (${multiThread ? "멀티스레드" : "싱글스레드"})...`);

  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    ...(multiThread
      ? { workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript") }
      : {}),
  });

  ffmpeg = ff;
  return ff;
}

export function loadFFmpeg(onLog?: Logger): Promise<FFmpeg> {
  if (!loadPromise) {
    loadPromise = doLoad(onLog).catch((err) => {
      loadPromise = null;
      throw new Error(
        `ffmpeg 코어 로드 실패: ${err instanceof Error ? err.message : String(err)} ` +
          `(네트워크 연결 또는 unpkg.com 차단 여부를 확인하세요)`,
      );
    });
  }
  return loadPromise;
}

/**
 * 파일을 WORKERFS 로 마운트하고 ffmpeg 내부 경로를 돌려준다.
 * 이 시점에 파일 내용은 메모리로 복사되지 않는다.
 */
export async function mountFile(file: File, onLog?: Logger): Promise<string> {
  const ff = await loadFFmpeg(onLog);

  if (mountedPath) {
    await ff.unmount(MOUNT_DIR).catch(() => {});
    mountedPath = null;
  }

  await ff.createDir(MOUNT_DIR).catch(() => {});
  await ff.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_DIR);

  mountedPath = `${MOUNT_DIR}/${file.name}`;
  onLog?.(`파일 마운트: ${mountedPath} (지연 로딩)`);
  return mountedPath;
}

export async function unmountFile(): Promise<void> {
  if (!ffmpeg || !mountedPath) return;
  await ffmpeg.unmount(MOUNT_DIR).catch(() => {});
  mountedPath = null;
}

/** 미디어 전체 길이(초). 알 수 없으면 0. */
export async function probeDurationSec(inputPath: string, onLog?: Logger): Promise<number> {
  const ff = await loadFFmpeg(onLog);
  logBuffer.length = 0;
  try {
    // 출력 파일을 주지 않으면 ffmpeg 는 비정상 종료하지만 Duration 은 로그에 남는다
    await ff.exec(["-hide_banner", "-i", inputPath]);
  } catch {
    /* expected */
  }
  const m = logBuffer.join("\n").match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

/**
 * [startSec, startSec+durSec] 구간의 오디오를 16kHz mono Float32Array 로.
 * 데이터가 없으면(파일 끝을 지난 경우) 길이 0 배열.
 */
export async function extractSegmentPcm(
  inputPath: string,
  startSec: number,
  durSec: number,
  onLog?: Logger,
): Promise<Float32Array> {
  const ff = await loadFFmpeg(onLog);
  const out = "seg.f32";

  await ff.exec([
    "-hide_banner",
    "-ss",
    startSec.toFixed(3),
    "-i",
    inputPath,
    "-t",
    durSec.toFixed(3),
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "-y",
    out,
  ]);

  let bytes: Uint8Array;
  try {
    bytes = (await ff.readFile(out)) as Uint8Array;
  } catch {
    return new Float32Array(0);
  }
  await ff.deleteFile(out).catch(() => {});

  if (bytes.byteLength < 4) return new Float32Array(0);

  // Float32Array 는 4바이트 정렬이 필요 → 복사본(offset 0)으로 변환
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  return new Float32Array(bytes.slice(0, usable).buffer);
}
