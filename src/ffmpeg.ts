/**
 * 영상 컨테이너(mp4/mov/mkv/webm 등)에서 오디오 트랙만 뽑아
 * 16kHz mono WAV(ArrayBuffer)로 돌려준다. ffmpeg.wasm 사용.
 *
 * cross-origin isolation(crossOriginIsolated === true) 이면 멀티스레드 코어를,
 * 아니면 싱글스레드 코어를 unpkg 에서 로드한다. 두 경우 모두 toBlobURL 로
 * 받아오므로 COEP require-corp 하에서도 차단되지 않는다.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { readFileBytes } from "./readfile";

const CORE_VERSION = "0.12.6";

let ffmpegPromise: Promise<FFmpeg> | null = null;

type Logger = (message: string) => void;

async function createFFmpeg(onLog?: Logger): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));

  const multiThread = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const pkg = multiThread ? "core-mt" : "core";
  const baseURL = `https://unpkg.com/@ffmpeg/${pkg}@${CORE_VERSION}/dist/esm`;

  onLog?.(`ffmpeg 코어 로드 중 (${multiThread ? "멀티스레드" : "싱글스레드"})...`);

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    ...(multiThread
      ? { workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript") }
      : {}),
  });

  return ffmpeg;
}

function getFFmpeg(onLog?: Logger): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = createFFmpeg(onLog).catch((err) => {
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

export async function extractAudioFromVideo(
  file: File,
  onLog?: Logger,
): Promise<ArrayBuffer> {
  const ffmpeg = await getFFmpeg(onLog);

  const ext = file.name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() || ".mp4";
  const inputName = `input${ext}`;
  const outputName = "audio.wav";

  onLog?.("입력 파일 읽는 중...");
  const bytes = await readFileBytes(file);

  onLog?.(`입력 파일 기록 중... (${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)`);
  await ffmpeg.writeFile(inputName, bytes);

  onLog?.("오디오 트랙 추출 중...");
  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputName,
  ]);

  const data = (await ffmpeg.readFile(outputName)) as Uint8Array;

  await ffmpeg.deleteFile(inputName).catch(() => {});
  await ffmpeg.deleteFile(outputName).catch(() => {});

  // 복사본을 만들어 ArrayBuffer 로 반환 (원본 뷰는 재사용될 수 있음)
  return data.slice().buffer;
}
