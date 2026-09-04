export type DeviceKind = "webgpu" | "wasm";

export interface ModelInfo {
  id: string;
  label: string;
  /** 대략적인 다운로드 용량 (사용자 안내용). */
  approxSize: string;
  note: string;
  /** WebGPU 없이 wasm 으로도 실용적으로 쓸 만한가. */
  wasmFriendly: boolean;
}

export const MODELS: Record<string, ModelInfo> = {
  base: {
    id: "onnx-community/whisper-base",
    label: "base · 빠름 / 저사양",
    approxSize: "약 80MB",
    note: "가장 가볍지만 한국어 정확도는 낮음. 저사양/구형 기기 테스트용.",
    wasmFriendly: true,
  },
  small: {
    id: "onnx-community/whisper-small",
    label: "small · 균형",
    approxSize: "약 250MB",
    note: "WebGPU 없이도 쓸 만한 한국어 하한선.",
    wasmFriendly: true,
  },
  turbo: {
    id: "onnx-community/whisper-large-v3-turbo",
    label: "large-v3-turbo · 정확 (WebGPU 권장)",
    approxSize: "약 800MB",
    note: "브라우저에서 한국어 고정확도의 현실적 최선. WebGPU 필요.",
    wasmFriendly: false,
  },
};

export type ModelKey = keyof typeof MODELS;

export function dtypeFor(modelKey: ModelKey, device: DeviceKind) {
  if (device === "wasm") {
    return "q8" as const;
  }
  // webgpu
  if (modelKey === "turbo") {
    return { encoder_model: "fp16", decoder_model_merged: "q4" } as const;
  }
  return "fp32" as const;
}
