export interface CaptureProgressPayload {
  runId: string;
  phase: "content" | "files";
  percent: number;
  status: string;
  processed?: number;
  total?: number;
  failed?: number;
}

export function emitCaptureProgress(progress: CaptureProgressPayload): void {
  try {
    chrome.runtime.sendMessage({
      type: "CAPTURE_PROGRESS",
      ...progress
    });
  } catch {
    // no listeners
  }
}
