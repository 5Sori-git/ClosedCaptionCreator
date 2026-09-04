/**
 * Whisper 파이프라인의 청크 타임스탬프 -> 자막 큐 -> SRT / VTT 문자열.
 * 한국어 기준으로 한 줄 길이·표시 시간 규칙을 가볍게 적용한다.
 */

export interface WhisperChunk {
  /** [start, end] 초. end 가 null 인 경우가 있음(마지막 청크 등). */
  timestamp: [number, number | null];
  text: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface CueOptions {
  /** 한 줄 최대 글자 수 (이보다 길면 최대 2줄로 줄바꿈). */
  maxCharsPerLine: number;
  /** 최소 표시 시간(초). 너무 짧은 큐는 이만큼 늘린다. */
  minDuration: number;
  /** 최대 표시 시간(초). */
  maxDuration: number;
  /** 전체 오디오 길이(초). 마지막 큐의 end 보정에 사용. */
  totalDuration: number;
}

export const DEFAULT_CUE_OPTIONS: CueOptions = {
  maxCharsPerLine: 20,
  minDuration: 1.0,
  maxDuration: 6.0,
  totalDuration: 0,
};

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 긴 한 줄을 공백 우선, 없으면 글자 수 기준으로 최대 2줄로 나눈다. */
function wrap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const mid = Math.floor(text.length / 2);
  let splitAt = -1;
  // 중앙에서 가장 가까운 공백 탐색
  for (let offset = 0; offset < text.length; offset++) {
    for (const i of [mid - offset, mid + offset]) {
      if (i > 0 && i < text.length && text[i] === " ") {
        splitAt = i;
        break;
      }
    }
    if (splitAt !== -1) break;
  }
  if (splitAt === -1) splitAt = mid;

  const first = text.slice(0, splitAt).trim();
  const second = text.slice(splitAt).trim();
  return `${first}\n${second}`;
}

export function chunksToCues(chunks: WhisperChunk[], options: Partial<CueOptions> = {}): Cue[] {
  const opts = { ...DEFAULT_CUE_OPTIONS, ...options };
  const cues: Cue[] = [];

  for (const chunk of chunks) {
    const text = clean(chunk.text);
    if (!text) continue;

    let start = Math.max(0, chunk.timestamp[0] ?? 0);
    let end = chunk.timestamp[1] ?? start + opts.minDuration;

    if (!Number.isFinite(end) || end <= start) {
      end = start + opts.minDuration;
    }

    const prev = cues[cues.length - 1];

    // 앞 큐와 시간이 겹치면 앞 큐를 잘라 정리
    if (prev && start < prev.end) {
      if (start > prev.start) prev.end = start;
      else start = prev.end;
    }

    // 아주 짧고 짧은 텍스트면 앞 큐에 병합
    if (prev && end - start < 0.4 && text.length <= 6) {
      prev.text = wrap(clean(`${stripLines(prev.text)} ${text}`), opts.maxCharsPerLine);
      prev.end = Math.max(prev.end, end);
      continue;
    }

    cues.push({ start, end, text: wrap(text, opts.maxCharsPerLine) });
  }

  // 표시 시간 보정
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    const hardCap = next ? next.start : opts.totalDuration || cue.end + opts.maxDuration;

    if (cue.end - cue.start < opts.minDuration) {
      cue.end = Math.min(cue.start + opts.minDuration, Math.max(hardCap, cue.start + 0.3));
    }
    if (cue.end - cue.start > opts.maxDuration) {
      cue.end = cue.start + opts.maxDuration;
    }
  }

  return cues;
}

function stripLines(text: string): string {
  return text.replace(/\n/g, " ");
}

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, "0");
}

function formatTimestamp(seconds: number, msSeparator: "," | "."): string {
  const s = Math.max(0, seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${msSeparator}${pad(ms, 3)}`;
}

export function toSRT(cues: Cue[]): string {
  return (
    cues
      .map((cue, i) => {
        const time = `${formatTimestamp(cue.start, ",")} --> ${formatTimestamp(cue.end, ",")}`;
        return `${i + 1}\n${time}\n${cue.text}\n`;
      })
      .join("\n")
      .trimEnd() + "\n"
  );
}

export function toVTT(cues: Cue[]): string {
  const body = cues
    .map((cue) => {
      const time = `${formatTimestamp(cue.start, ".")} --> ${formatTimestamp(cue.end, ".")}`;
      return `${time}\n${cue.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`.trimEnd() + "\n";
}

export function toPlainText(cues: Cue[]): string {
  return cues.map((c) => stripLines(c.text)).join("\n") + "\n";
}
