import "./style.css";
import { fileToPcm16k } from "./audio";
import { MODELS, type DeviceKind, type ModelKey } from "./models";
import {
  chunksToCues,
  toSRT,
  toVTT,
  toPlainText,
  type WhisperChunk,
} from "./subtitle";

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */
type Phase = "idle" | "working" | "done" | "error";

const state: {
  file: File | null;
  phase: Phase;
  device: DeviceKind;
  webgpu: boolean;
  cues: ReturnType<typeof chunksToCues>;
} = {
  file: null,
  phase: "idle",
  device: "wasm",
  webgpu: false,
  cues: [],
};

/* ------------------------------------------------------------------ *
 * 뷰
 * ------------------------------------------------------------------ */
const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header>
    <h1>ClosedCaptionCreator</h1>
    <p>음성 · 영상 파일을 <strong>브라우저에서 로컬로</strong> 전사해 자막(SRT/VTT)을 만듭니다. 파일은 서버로 업로드되지 않습니다.</p>
  </header>

  <div class="badges" id="badges"></div>

  <section class="panel">
    <h2>1. 파일 선택</h2>
    <div class="dropzone" id="dropzone">
      <div><strong>클릭</strong>하거나 파일을 여기에 놓으세요</div>
      <small>mp3 · wav · m4a · flac · ogg · mp4 · mov · mkv · webm …</small>
    </div>
    <input type="file" id="fileInput" accept="audio/*,video/*" class="hidden" />
    <div class="file-line hidden" id="fileLine"></div>
  </section>

  <section class="panel">
    <h2>2. 옵션</h2>
    <div class="options">
      <label class="field">
        모델
        <select id="modelSelect"></select>
      </label>
      <label class="field">
        언어
        <select id="langSelect">
          <option value="korean" selected>한국어</option>
          <option value="english">English</option>
          <option value="japanese">日本語</option>
          <option value="chinese">中文</option>
          <option value="auto">자동 감지</option>
        </select>
      </label>
    </div>
    <div class="model-note" id="modelNote"></div>
  </section>

  <section class="panel">
    <button class="primary" id="runBtn" disabled>자막 생성</button>
    <div class="progress-wrap hidden" id="progressWrap">
      <div class="bar"><div id="bar"></div></div>
      <p class="status-text" id="statusText"></p>
    </div>
    <details class="log hidden" id="logDetails">
      <summary>상세 로그</summary>
      <pre class="log-body" id="logBody"></pre>
    </details>
  </section>

  <section class="panel hidden" id="resultPanel">
    <h2>3. 결과</h2>
    <div id="mediaMount"></div>
    <div class="result-actions">
      <button data-dl="srt">SRT 다운로드</button>
      <button data-dl="vtt">VTT 다운로드</button>
      <button data-dl="txt">텍스트 다운로드</button>
      <button data-copy>클립보드 복사</button>
    </div>
    <textarea class="subs" id="subsArea" spellcheck="false"></textarea>
  </section>

  <footer>
    모든 연산은 이 브라우저에서 수행됩니다 · Whisper (Transformers.js) ·
    <a href="https://github.com/5Sori-git/ClosedCaptionCreator" target="_blank" rel="noopener">GitHub</a>
  </footer>
`;

const el = {
  badges: document.querySelector<HTMLDivElement>("#badges")!,
  dropzone: document.querySelector<HTMLDivElement>("#dropzone")!,
  fileInput: document.querySelector<HTMLInputElement>("#fileInput")!,
  fileLine: document.querySelector<HTMLDivElement>("#fileLine")!,
  modelSelect: document.querySelector<HTMLSelectElement>("#modelSelect")!,
  langSelect: document.querySelector<HTMLSelectElement>("#langSelect")!,
  modelNote: document.querySelector<HTMLDivElement>("#modelNote")!,
  runBtn: document.querySelector<HTMLButtonElement>("#runBtn")!,
  progressWrap: document.querySelector<HTMLDivElement>("#progressWrap")!,
  bar: document.querySelector<HTMLDivElement>("#bar")!,
  statusText: document.querySelector<HTMLParagraphElement>("#statusText")!,
  logDetails: document.querySelector<HTMLDetailsElement>("#logDetails")!,
  logBody: document.querySelector<HTMLPreElement>("#logBody")!,
  resultPanel: document.querySelector<HTMLElement>("#resultPanel")!,
  mediaMount: document.querySelector<HTMLDivElement>("#mediaMount")!,
  subsArea: document.querySelector<HTMLTextAreaElement>("#subsArea")!,
};

/* ------------------------------------------------------------------ *
 * 유틸
 * ------------------------------------------------------------------ */
function log(msg: string) {
  el.logDetails.classList.remove("hidden");
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  el.logBody.textContent += `[${time}] ${msg}\n`;
  el.logBody.scrollTop = el.logBody.scrollHeight;
}

function setStatus(msg: string, isError = false) {
  el.statusText.textContent = msg;
  el.statusText.classList.toggle("err", isError);
}

function setBar(pct: number) {
  el.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function humanSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "subtitle";
}

/* ------------------------------------------------------------------ *
 * 환경 배지
 * ------------------------------------------------------------------ */
async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function renderBadges() {
  state.webgpu = await detectWebGPU();
  state.device = state.webgpu ? "webgpu" : "wasm";

  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;

  const badges: Array<{ text: string; cls: string }> = [
    state.webgpu
      ? { text: "WebGPU 사용 가능 — 빠름", cls: "good" }
      : { text: "WebGPU 없음 — WASM 모드(느림)", cls: "warn" },
    isolated
      ? { text: "cross-origin isolated ✓", cls: "good" }
      : { text: "isolation 미적용 — 영상 추출/멀티스레드 제한", cls: "warn" },
  ];

  el.badges.innerHTML = badges
    .map((b) => `<span class="badge ${b.cls}">${b.text}</span>`)
    .join("");
}

/* ------------------------------------------------------------------ *
 * 모델 셀렉트
 * ------------------------------------------------------------------ */
function renderModelOptions() {
  const keys = Object.keys(MODELS) as ModelKey[];
  el.modelSelect.innerHTML = keys
    .map((k) => `<option value="${k}">${MODELS[k].label} · ${MODELS[k].approxSize}</option>`)
    .join("");
  // 기본값: WebGPU 있으면 turbo, 없으면 small
  el.modelSelect.value = state.webgpu ? "turbo" : "small";
  updateModelNote();
}

function updateModelNote() {
  const key = el.modelSelect.value as ModelKey;
  const info = MODELS[key];
  let note = info.note;
  if (key === "turbo" && !state.webgpu) {
    note += " ⚠ 현재 WebGPU가 없어 매우 느립니다. small 을 권장합니다.";
  }
  el.modelNote.textContent = note;
}

/* ------------------------------------------------------------------ *
 * 파일 입력
 * ------------------------------------------------------------------ */
function acceptFile(file: File) {
  state.file = file;
  el.fileLine.classList.remove("hidden");
  el.fileLine.textContent = `${file.name} · ${humanSize(file.size)} · ${file.type || "형식 미상"}`;
  el.runBtn.disabled = state.phase === "working";
}

el.dropzone.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  const f = el.fileInput.files?.[0];
  if (f) acceptFile(f);
});
["dragover", "dragenter"].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("dragover");
  }),
);
el.dropzone.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) acceptFile(f);
});

el.modelSelect.addEventListener("change", updateModelNote);

/* ------------------------------------------------------------------ *
 * 워커
 * ------------------------------------------------------------------ */
const worker = new Worker(new URL("./transcriber.worker.ts", import.meta.url), {
  type: "module",
});

let resolveReady: (() => void) | null = null;
let resolveResult: ((r: { chunks: WhisperChunk[]; text: string; elapsedSec: number }) => void) | null =
  null;
let rejectActive: ((err: Error) => void) | null = null;

worker.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "log":
      log(msg.message);
      break;
    case "download": {
      setBar(msg.overall);
      const done = msg.files.filter((f: { progress: number }) => f.progress >= 100).length;
      setStatus(
        `모델 다운로드 중 ${msg.overall.toFixed(0)}% · 파일 ${done}/${msg.files.length} (최초 1회, 이후 캐시)`,
      );
      break;
    }
    case "ready":
      log(`워커 준비 완료 (device=${msg.device})`);
      resolveReady?.();
      resolveReady = null;
      break;
    case "result":
      resolveResult?.({ chunks: msg.chunks as WhisperChunk[], text: msg.text, elapsedSec: msg.elapsedSec });
      resolveResult = null;
      break;
    case "error":
      log(`오류: ${msg.message}`);
      rejectActive?.(new Error(msg.message));
      rejectActive = null;
      break;
  }
});

function loadModel(modelKey: ModelKey, device: DeviceKind): Promise<void> {
  return new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectActive = reject;
    worker.postMessage({ type: "load", modelKey, device });
  });
}

function runTranscribe(
  audio: Float32Array,
  language: string,
): Promise<{ chunks: WhisperChunk[]; text: string; elapsedSec: number }> {
  return new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectActive = reject;
    // audio 버퍼 소유권 이전 (복사 비용 제거)
    worker.postMessage({ type: "transcribe", audio, language }, [audio.buffer]);
  });
}

/* ------------------------------------------------------------------ *
 * 실행
 * ------------------------------------------------------------------ */
el.runBtn.addEventListener("click", run);

async function run() {
  if (!state.file || state.phase === "working") return;

  state.phase = "working";
  el.runBtn.disabled = true;
  el.progressWrap.classList.remove("hidden");
  el.resultPanel.classList.add("hidden");
  el.logBody.textContent = "";
  setBar(0);

  const modelKey = el.modelSelect.value as ModelKey;
  const language = el.langSelect.value;
  const file = state.file;

  try {
    setStatus("오디오 준비 중…");
    const { pcm, durationSec } = await fileToPcm16k(file, log);
    log(`오디오 길이 ${durationSec.toFixed(1)}초, 샘플 ${pcm.length.toLocaleString()}개`);

    setStatus("모델 로드 중…");
    await loadModel(modelKey, state.device);

    setBar(100);
    setStatus(
      state.device === "webgpu"
        ? "전사 중… (GPU) 길이에 따라 수십 초~수 분 소요"
        : "전사 중… (CPU/WASM) 상당히 오래 걸릴 수 있습니다",
    );

    const { chunks, text, elapsedSec } = await runTranscribe(
      pcm,
      language === "auto" ? "" : language,
    );
    log(`전사 완료: ${elapsedSec.toFixed(1)}초, 세그먼트 ${chunks.length}개`);

    const cues = chunksToCues(chunks, { totalDuration: durationSec });
    state.cues = cues;

    if (cues.length === 0) {
      setStatus("인식된 음성이 없습니다. 다른 파일이나 모델을 시도해 보세요.", true);
      state.phase = "error";
      el.runBtn.disabled = false;
      return;
    }

    renderResult(file, cues, text);
    setStatus(`완료 · 자막 ${cues.length}줄 · 전사 ${elapsedSec.toFixed(1)}초`);
    state.phase = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`실패: ${message}`, true);
    log(`실패: ${message}`);
    state.phase = "error";
  } finally {
    el.runBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * 결과 렌더
 * ------------------------------------------------------------------ */
let mediaUrl: string | null = null;
let trackUrl: string | null = null;

function renderResult(
  file: File,
  cues: ReturnType<typeof chunksToCues>,
  _rawText: string,
) {
  el.resultPanel.classList.remove("hidden");
  el.subsArea.value = toSRT(cues);

  // 미디어 미리보기 + 자막 트랙
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  if (trackUrl) URL.revokeObjectURL(trackUrl);
  el.mediaMount.innerHTML = "";

  const isVideo = file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm)$/i.test(file.name);
  mediaUrl = URL.createObjectURL(file);
  trackUrl = URL.createObjectURL(new Blob([toVTT(cues)], { type: "text/vtt" }));

  const media = document.createElement(isVideo ? "video" : "audio") as
    | HTMLVideoElement
    | HTMLAudioElement;
  media.controls = true;
  media.src = mediaUrl;
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = "생성된 자막";
  track.srclang = "ko";
  track.default = true;
  track.src = trackUrl;
  media.appendChild(track);
  el.mediaMount.appendChild(media);
}

el.resultPanel.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const dl = target.dataset.dl;
  const name = state.file ? baseName(state.file.name) : "subtitle";

  if (dl === "srt") download(`${name}.srt`, el.subsArea.value, "text/plain");
  if (dl === "vtt") download(`${name}.vtt`, toVTT(state.cues), "text/vtt");
  if (dl === "txt") download(`${name}.txt`, toPlainText(state.cues), "text/plain");
  if (target.hasAttribute("data-copy")) {
    navigator.clipboard.writeText(el.subsArea.value).then(
      () => setStatus("클립보드에 복사했습니다."),
      () => setStatus("복사 실패 — 텍스트를 직접 선택해 주세요.", true),
    );
  }
});

/* ------------------------------------------------------------------ *
 * 초기화
 * ------------------------------------------------------------------ */
(async function init() {
  await renderBadges();
  renderModelOptions();
  log("준비 완료. 파일을 선택하세요.");
})();
