# ClosedCaptionCreator

음성 · 영상 파일을 **브라우저에서 완전히 로컬로** 전사해 자막(SRT / VTT / TXT)을 만드는 웹앱.
파일은 서버로 업로드되지 않으며, 모든 연산은 사용자의 브라우저에서 수행됩니다.

- **STT 엔진**: OpenAI Whisper (via [Transformers.js](https://github.com/huggingface/transformers.js))
- **가속**: WebGPU (미지원 시 WASM 폴백)
- **영상 오디오 추출**: `ffmpeg.wasm`
- **배포**: GitHub Pages (정적)

## 동작 방식 — 시간 창(window) 스트리밍

파일 전체를 메모리에 올리지 않고 **10분 구간씩** 잘라서 처리하므로, 길이/크기 제한이 사실상 없다.

```
파일 선택
  → ffmpeg.wasm 에 WORKERFS 로 마운트 (Blob 지연 로딩, 힙 복사 없음)
  → 전체 길이 probe
  → for 각 10분 구간 [i·W, (i+1)·W):
       ffmpeg 로 그 구간만 16kHz mono float32 PCM 추출 (앞뒤 4초 여유)
       Web Worker 에서 Whisper 추론 (WebGPU / WASM)
       세그먼트 타임스탬프에 오프셋 → 수용 밴드 안의 조각만 채택(경계 중복 제거)
       부분 자막 즉시 표시 + localStorage 에 진행 저장
  → SRT / VTT / TXT + 미리보기
```

- **최대 메모리 ≈ 한 구간분**(10분이면 PCM ~38MB). 3시간이든 10시간이든 동일.
- **재개**: 탭이 죽거나 새로고침해도, 같은 파일·옵션으로 다시 실행하면 마지막 구간부터 이어감.
- **중지**: 실행 중 "중지"를 누르면 현재 구간을 마치고 멈추며, 진행은 저장된다.
- 처리 **시간만** 길이에 비례한다.

모델 가중치는 최초 1회 Hugging Face CDN 에서 내려받아 브라우저 캐시에 저장됩니다(레포에 포함되지 않음).

## 모델 선택

| 키    | 모델                                  | 용량   | 용도                              |
| ----- | ------------------------------------- | ------ | --------------------------------- |
| base  | `onnx-community/whisper-base`         | ~80MB  | 저사양/구형 기기 테스트           |
| small | `onnx-community/whisper-small`        | ~250MB | WebGPU 없이도 쓸 만한 한국어 하한 |
| turbo | `onnx-community/whisper-large-v3-turbo` | ~800MB | 한국어 고정확도 (WebGPU 권장)     |

WebGPU 가 감지되면 기본값은 `turbo`, 아니면 `small` 입니다.

## 로컬 개발

```bash
npm install
npm run dev
```

Vite dev 서버는 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 헤더를 붙여
배포 환경과 동일하게 cross-origin isolation 이 켜진 상태로 테스트합니다.

```bash
npm run build     # tsc 타입체크 + vite build → dist/
npm run preview   # dist/ 미리보기 (COOP/COEP 헤더 포함)
```

## GitHub Pages 배포

1. 이 레포를 `main` 에 푸시.
2. GitHub 레포 **Settings → Pages → Build and deployment → Source: `GitHub Actions`** 로 설정.
3. `.github/workflows/deploy.yml` 이 `npm run build` 후 `dist/` 를 Pages 에 배포.
4. 배포 URL: `https://5sori-git.github.io/ClosedCaptionCreator/`

`GITHUB_ACTIONS` 환경변수가 있으면 `vite.config.ts` 의 `base` 가 `/ClosedCaptionCreator/` 로 설정됩니다.

### GitHub Pages 와 헤더 문제

정적 호스트인 GitHub Pages 는 `COOP`/`COEP` 응답 헤더를 설정할 수 없어
`SharedArrayBuffer`(멀티스레드 WASM)를 쓸 수 없습니다.
`public/coi-serviceworker.js` 가 클라이언트 측에서 이 헤더를 주입해
cross-origin isolation 을 활성화합니다(최초 방문 시 자동 새로고침 1회 발생).

WebGPU 경로는 `SharedArrayBuffer` 없이도 동작하므로, isolation 이 실패해도
전사 자체는 가능합니다(영상 오디오 추출은 싱글스레드 코어로 폴백).

## 브라우저 요구사항

- **권장**: 최신 Chrome / Edge (WebGPU 지원, 데스크톱)
- WebGPU 미지원 시 자동으로 WASM 모드로 동작 (수 배 느림, `small` 권장)
- HTTPS(또는 localhost) 필수 — 서비스워커/WebGPU 는 secure context 요구

## 크기 / 길이 제한

- **파일 크기**: WORKERFS 지연 마운트라 파일을 통째로 읽지 않음 → 사실상 디스크 용량까지.
- **길이**: 제한 없음. 10분 구간 스트리밍이라 메모리는 일정하고, **처리 시간만** 길이에 비례.
  - WebGPU + turbo: 대략 실시간의 5~15배 (1시간 ≈ 5~12분)
  - WASM + small: 대략 실시간의 0.5~1배 (1시간 ≈ 1~2시간+)
- ffmpeg 코어(`@ffmpeg/core` ~30MB)를 unpkg 에서 1회 로드 → 오프라인/차단 환경에서는 실패.

## 한계 / TODO

- 화자 분리(diarization) 미지원
- 단어 단위 타임스탬프 옵션 미노출 (현재 세그먼트 단위)
- 실시간 마이크 입력 미지원 (파일 기반)
- 번역 자막 미지원
- silero-VAD 전처리 미적용 (무음 구간 환각 가능 → 보수적 임계값으로만 완화)
- 구간 경계(10분)에 걸친 문장은 드물게 잘릴 수 있음 (4초 겹침으로 완화)

## 라이선스

앱 코드: MIT. `public/coi-serviceworker.js` 는 [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT) 를 포함.
