import "./style.css";
import { MODELS, type DeviceKind, type ModelKey } from "./models";
import { toSRT, toVTT, toPlainText, type Cue } from "./subtitle";
import {
  runPipeline,
  fmtDuration,
  fmtEta,
  WINDOW_SEC,
  type PipelineOptions,
  type ProgressInfo,
} from "./pipeline";
import { makeSignature, peekProgress } from "./progress-store";

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */
const state: {
  file: File | null;
  running: boolean;
  cancelRequested: boolean;
  device: DeviceKind;
  webgpu: boolean;
  cues: Cue[];
} = {
  file: null,
  running: false,
  cancelRequested: false,
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
    <div class="resume-note hidden" id="resumeNote"></div>
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
    <div class="run-row">
      <button class="primary" id="runBtn" disabled>자막 생성</button>
    </div>
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
    <h2>3. 결과 <span id="resultMeta" class="result-meta"></span></h2>
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
    모든 연산은 이 브라우저에서 수행됩니다 · Whisper (Transformers.js) · ${WINDOW_SEC / 60}분 구간 스트리밍 ·
    <a href="https://github.com/5Sori-git/ClosedCaptionCreator" target="_blank" rel="noopener">GitHub</a>
  </footer>
`;

const el = {
  badges: document.querySelector<HTMLDivElement>("#badges")!,
  dropzone: document.querySelector<HTMLDivElement>("#dropzone")!,
  fileInput: document.querySelector<HTMLInputElement>("#fileInput")!,
  fileLine: document.querySelector<HTMLDivElement>("#fileLine")!,
  resumeNote: document.querySelector<HTMLDivElement>("#resumeNote")!,
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
  resultMeta: document.querySelector<HTMLSpanElement>("#resultMeta")!,
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
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
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

function relTime(ts: number): string {
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const h = Math.round(diffMin / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

/* ------------------------------------------------------------------ *
 * 환경 배지
 * ------------------------------------------------------------------ */
async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function renderBadges() {
  state.webgpu = await detectWebGPU();
  state.device = state.webgpu ? "webgpu" : "wasm";
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;

  const badges = [
    state.webgpu
      ? { text: "WebGPU 사용 가능 — 빠름", cls: "good" }
      : { text: "WebGPU 없음 — WASM 모드(느림)", cls: "warn" },
    isolated
      ? { text: "cross-origin isolated ✓", cls: "good" }
      : { text: "isolation 미적용 — ffmpeg 싱글스레드", cls: "warn" },
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
  el.modelSelect.value = state.webgpu ? "turbo" : "small";
  updateModelNote();
}

function updateModelNote() {
  const key = el.modelSelect.value as ModelKey;
  let note = MODELS[key].note;
  if (key === "turbo" && !state.webgpu) {
    note += " ⚠ 현재 WebGPU가 없어 매우 느립니다. small 을 권장합니다.";
  }
  el.modelNote.textContent = note;
}

/* ------------------------------------------------------------------ *
 * 재개 안내
 * ------------------------------------------------------------------ */
function refreshResumeNote() {
  const saved = peekProgress();
  if (!saved) {
    el.resumeNote.classList.add("hidden");
    return;
  }
  el.resumeNote.classList.remove("hidden");
  el.resumeNote.textContent =
    `저장된 진행 상태가 있습니다 (${saved.pct.toFixed(0)}% 완료, ${relTime(saved.updatedAt)}). ` +
    `같은 파일·같은 옵션으로 "자막 생성"을 누르면 이어서 진행할지 물어봅니다.`;
}

/* ------------------------------------------------------------------ *
 * 파일 입력
 * ------------------------------------------------------------------ */
function acceptFile(file: File) {
  state.file = file;
  el.fileLine.classList.remove("hidden");
  el.fileLine.textContent = `${file.name} · ${humanSize(file.size)} · ${file.type || "형식 미상"}`;
  el.runBtn.disabled = state.running;
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
 * 미디어 미리보기
 * ------------------------------------------------------------------ */
let mediaUrl: string | null = null;
let trackUrl: string | null = null;
let trackEl: HTMLTrackElement | null = null;

function mountMedia(file: File) {
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  el.mediaMount.innerHTML = "";

  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm)$/i.test(file.name);
  mediaUrl = URL.createObjectURL(file);

  const media = document.createElement(isVideo ? "video" : "audio") as HTMLMediaElement;
  media.controls = true;
  media.src = mediaUrl;
  trackEl = document.createElement("track");
  trackEl.kind = "subtitles";
  trackEl.label = "생성된 자막";
  trackEl.srclang = "ko";
  trackEl.default = true;
  media.appendChild(trackEl);
  el.mediaMount.appendChild(media);
}

function updateTrack(cues: Cue[]) {
  if (!trackEl) return;
  if (trackUrl) URL.revokeObjectURL(trackUrl);
  trackUrl = URL.createObjectURL(new Blob([toVTT(cues)], { type: "text/vtt" }));
  trackEl.src = trackUrl;
}

/* ------------------------------------------------------------------ *
 * 진행률 / 예상 시간 (1초 티커로 메시지 사이를 보간)
 * ------------------------------------------------------------------ */
let lastProg: (ProgressInfo & { at: number }) | null = null;
let ticker: number | null = null;
let phaseAt = 0;

function renderProgress() {
  if (!lastProg) return;
  if (Date.now() - phaseAt < 2000) return; // 방금 표시한 단계 메시지를 잠깐 유지

  const { processedSec, totalSec, etaSec, speed, cuesCount, at } = lastProg;
  const ageSec = (Date.now() - at) / 1000;
  const projected =
    speed && totalSec > 0 ? Math.min(totalSec, processedSec + speed * ageSec) : processedSec;

  if (totalSec > 0) {
    const pct = (projected / totalSec) * 100;
    setBar(pct);
    let s = `전사 중 ${pct.toFixed(0)}% · ${fmtDuration(projected)} / ${fmtDuration(totalSec)}`;
    if (etaSec != null) s += ` · 남은 시간 ${fmtEta(Math.max(0, etaSec - ageSec))}`;
    else s += " · 남은 시간 계산 중…";
    if (speed) s += ` · ${speed.toFixed(1)}x`;
    s += ` · 자막 ${cuesCount}줄`;
    setStatus(s);
  } else {
    setStatus(`전사 중 · ${fmtDuration(projected)} 처리 · 자막 ${cuesCount}줄`);
  }
}

/* ------------------------------------------------------------------ *
 * 실행 / 중지
 * ------------------------------------------------------------------ */
el.runBtn.addEventListener("click", () => {
  if (state.running) {
    state.cancelRequested = true;
    el.runBtn.disabled = true;
    setStatus("중지 요청됨 — 현재 구간을 마치고 멈춥니다…");
    return;
  }
  run();
});

async function run() {
  if (!state.file) return;

  const file = state.file;
  const modelKey = el.modelSelect.value as ModelKey;
  const langValue = el.langSelect.value;
  const language = langValue === "auto" ? "" : langValue;

  // 재개 여부 결정
  let resume = false;
  const sig = makeSignature(file, modelKey, language, WINDOW_SEC);
  const saved = peekProgress();
  if (saved && saved.sig === sig) {
    resume = window.confirm(
      `저장된 진행 상태(${saved.pct.toFixed(0)}% 완료)가 있습니다.\n` +
        `확인 = 이어서 진행 / 취소 = 처음부터 다시`,
    );
  }

  state.running = true;
  state.cancelRequested = false;
  el.runBtn.textContent = "중지";
  el.runBtn.disabled = false;
  el.progressWrap.classList.remove("hidden");
  el.resultPanel.classList.add("hidden");
  el.logBody.textContent = "";
  setBar(0);
  setStatus("시작하는 중…");

  lastProg = null;
  phaseAt = Date.now();
  if (ticker) clearInterval(ticker);
  ticker = window.setInterval(renderProgress, 1000);

  mountMedia(file);

  const options: PipelineOptions = { file, modelKey, device: state.device, language, resume };

  try {
    const result = await runPipeline(options, {
      onLog: log,
      onModelDownload: (pct, detail) => {
        setBar(pct);
        setStatus(detail);
      },
      onPhase: (label) => {
        phaseAt = Date.now();
        setStatus(label);
      },
      onProgress: (p) => {
        lastProg = { ...p, at: Date.now() };
        renderProgress();
      },
      onWindow: ({ cues }) => {
        state.cues = cues;
        el.subsArea.value = toSRT(cues);
        el.resultPanel.classList.remove("hidden");
        updateTrack(cues);
        el.resultMeta.textContent = `(진행 중 · ${cues.length}줄)`;
      },
      shouldCancel: () => state.cancelRequested,
    });

    state.cues = result.cues;
    el.subsArea.value = toSRT(result.cues);
    updateTrack(result.cues);
    el.resultPanel.classList.remove("hidden");
    el.resultMeta.textContent = `· 자막 ${result.cues.length}줄 · ${fmtDuration(result.totalSec)}`;

    if (result.canceled) {
      setStatus(
        `중지됨 · 자막 ${result.cues.length}줄까지 저장. 같은 파일·옵션으로 다시 실행하면 이어서 진행합니다.`,
      );
    } else if (result.cues.length === 0) {
      setStatus("인식된 음성이 없습니다. 다른 파일이나 모델을 시도해 보세요.", true);
    } else {
      setBar(100);
      setStatus(
        `완료 · 자막 ${result.cues.length}줄 · 소요 ${fmtDuration(result.elapsedSec)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`실패: ${message}`, true);
    log(`실패: ${message}`);
  } finally {
    state.running = false;
    state.cancelRequested = false;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    lastProg = null;
    el.runBtn.textContent = "자막 생성";
    el.runBtn.disabled = false;
    refreshResumeNote();
  }
}

/* ------------------------------------------------------------------ *
 * 결과 다운로드
 * ------------------------------------------------------------------ */
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
  refreshResumeNote();
  log("준비 완료. 파일을 선택하세요.");
})();
