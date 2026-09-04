import { defineConfig } from "vite";

// GitHub Pages 프로젝트 사이트 경로: https://5sori-git.github.io/ClosedCaptionCreator/
const base = process.env.GITHUB_ACTIONS ? "/ClosedCaptionCreator/" : "/";

export default defineConfig({
  base,
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // onnxruntime-web / ffmpeg 는 자체 wasm 로더를 쓰므로 Vite 사전번들에서 제외
    exclude: ["@huggingface/transformers", "@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    // 로컬 개발에서도 cross-origin isolation 을 켜서 배포 환경과 동일하게 테스트
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
