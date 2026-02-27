import type { CapturePayload } from "../lib/extractor/types";
import { BRIDGE_BASE } from "./constants";

export interface ImportLiveResult {
  imported?: number;
  skipped?: number;
  conflicts?: number;
}

export async function startSession(): Promise<{ token: string; expiresAt: string }> {
  const response = await fetch(`${BRIDGE_BASE}/v1/session/start`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`无法连接桌面应用，状态码 ${response.status}`);
  }

  return response.json();
}

export async function submitCapture(payload: CapturePayload): Promise<ImportLiveResult> {
  const { token } = await startSession();

  const response = await fetch(`${BRIDGE_BASE}/v1/import/live`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ai-history-token": token
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`导入失败（${response.status}） ${raw}`);
  }

  let result: ImportLiveResult = {};
  try {
    result = (await response.json()) as ImportLiveResult;
  } catch {
    // Keep compatibility with older bridge responses.
  }
  return result;
}
