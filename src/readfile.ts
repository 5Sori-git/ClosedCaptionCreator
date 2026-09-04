/**
 * File/Blob -> Uint8Array 를 최대한 견고하게 읽는다.
 *
 * @ffmpeg/util 의 fetchFile 은 내부적으로 FileReader 를 쓰는데,
 * OneDrive 클라우드 자리표시자 / 이동·잠금된 파일 등에서
 * "File could not be read! Code=-1" 같은 불투명한 오류만 던진다.
 * 여기서는 Blob.arrayBuffer() 를 먼저 시도하고, 실패하면 FileReader 로
 * 폴백한 뒤, 그래도 안 되면 사람이 읽을 수 있는 메시지로 바꿔 던진다.
 */

function friendlyMessage(file: File, cause: unknown): string {
  const name = (cause as { name?: string })?.name ?? "";
  const base = `"${file.name}" 파일을 읽지 못했습니다`;

  if (name === "NotFoundError") {
    return `${base}. 파일이 이동/삭제/이름 변경됐거나, OneDrive 등 클라우드에 "요청 시 다운로드" 상태일 수 있습니다. 탐색기에서 파일을 우클릭해 "이 디바이스에 항상 유지"로 받아두거나, 동기화되지 않는 폴더(예: C:\\Temp)로 복사한 뒤 다시 시도하세요.`;
  }
  if (name === "NotReadableError") {
    return `${base}. 다른 프로그램이 파일을 잠그고 있거나(녹화 중, 편집기에서 열림), 백신 실시간 검사가 막고 있을 수 있습니다. 해당 프로그램을 닫고 다시 시도하세요.`;
  }
  if (name === "SecurityError") {
    return `${base}. 브라우저 보안 정책으로 접근이 차단됐습니다. 파일을 다른 폴더로 복사한 뒤 다시 시도하세요.`;
  }
  if (file.size > 1.5 * 1024 * 1024 * 1024) {
    return `${base}. 파일이 매우 커서(${(file.size / 1024 / 1024 / 1024).toFixed(1)}GB) 브라우저 메모리로 한 번에 읽지 못했을 수 있습니다. 더 짧게 자른 파일로 시도하세요.`;
  }
  const detail = cause instanceof Error ? ` (${cause.name}: ${cause.message})` : "";
  return `${base}. 클라우드 자리표시자/이동/잠금 여부를 확인하고, 파일을 로컬 폴더로 복사한 뒤 다시 시도하세요.${detail}`;
}

function viaFileReader(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader unknown error"));
    reader.readAsArrayBuffer(file);
  });
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  let buffer: ArrayBuffer;
  try {
    // 최신 경로: 보통 FileReader 보다 견고하고 오류도 구체적
    buffer = await file.arrayBuffer();
  } catch (primary) {
    try {
      buffer = await viaFileReader(file);
    } catch {
      throw new Error(friendlyMessage(file, primary));
    }
  }

  if (buffer.byteLength === 0) {
    throw new Error(
      `"${file.name}" 파일이 비어 있습니다(0바이트). 클라우드에서 아직 다운로드되지 않았거나 손상된 파일일 수 있습니다.`,
    );
  }
  return new Uint8Array(buffer);
}
