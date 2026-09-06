/**
 * 긴 파일 전사의 중간 진행 상태를 localStorage 에 저장/복원한다.
 * 탭이 죽거나 새로고침해도 마지막으로 끝낸 구간부터 이어서 할 수 있게 한다.
 */
import type { WhisperChunk } from "./subtitle";

const KEY = "ccc:progress:v1";
const MAX_JSON_BYTES = 4_000_000; // localStorage 여유를 감안한 상한

export interface SavedProgress {
  sig: string;
  rawChunks: WhisperChunk[];
  nextIndex: number;
  totalSec: number;
  windowSec: number;
  updatedAt: number;
}

/** 같은 파일 + 같은 옵션인지 식별하는 서명. */
export function makeSignature(
  file: File,
  model: string,
  language: string,
  windowSec: number,
): string {
  return [file.name, file.size, file.lastModified, model, language || "auto", windowSec].join("|");
}

export function loadProgress(): SavedProgress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as SavedProgress;
    if (!p || typeof p.sig !== "string" || !Array.isArray(p.rawChunks)) return null;
    return p;
  } catch {
    return null;
  }
}

export function saveProgress(p: SavedProgress): void {
  try {
    const json = JSON.stringify(p);
    if (json.length > MAX_JSON_BYTES) return;
    localStorage.setItem(KEY, json);
  } catch {
    /* 용량 초과 / 프라이빗 모드 → 재개 불가일 뿐, 진행은 계속 */
  }
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

/** 저장된 진행이 있으면 완료율(%)과 시각을 돌려준다. */
export function peekProgress(): { pct: number; updatedAt: number; sig: string } | null {
  const p = loadProgress();
  if (!p) return null;
  const doneSec = p.nextIndex * p.windowSec;
  const pct = p.totalSec > 0 ? Math.min(100, (doneSec / p.totalSec) * 100) : 0;
  return { pct, updatedAt: p.updatedAt, sig: p.sig };
}
