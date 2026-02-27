import type { CapturePayload } from "../lib/extractor/types";
import { CONTENT_SCRIPT_VERSION } from "./constants";

interface CaptureScriptResponse {
  ok?: boolean;
  payload?: CapturePayload;
  error?: string;
  warning?: string;
}

export interface CaptureResultEnvelope {
  payload: CapturePayload;
  warning: string;
}

function getContentScriptFile(url: string): string | null {
  if (url.includes("chatgpt.com")) {
    return "content-scripts/chatgpt.js";
  }

  if (url.includes("gemini.google.com") || url.includes("bard.google.com")) {
    return "content-scripts/gemini.js";
  }

  if (url.includes("aistudio.google.com")) {
    return "content-scripts/aistudio.js";
  }

  if (url.includes("claude.ai")) {
    return "content-scripts/claude.js";
  }

  return null;
}

async function sendCaptureMessage(tabId: number, captureRunId = ""): Promise<CaptureResultEnvelope> {
  const response = await chrome.tabs.sendMessage(tabId, { type: "AI_HISTORY_CAPTURE", captureRunId });
  const normalized = (response || {}) as CaptureScriptResponse;
  if (!normalized.ok || !normalized.payload) {
    throw new Error(normalized.error || "抓取失败，请确认页面已加载完整");
  }

  return {
    payload: normalized.payload as CapturePayload,
    warning: String(normalized.warning || "").trim()
  };
}

function isNoReceiverError(error: unknown): boolean {
  const msg = String((error as Error)?.message || error || "");
  return msg.includes("Receiving end does not exist") || msg.includes("Could not establish connection");
}

async function pingCaptureScriptVersion(tabId: number): Promise<string | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "AI_HISTORY_PING" });
    if (response?.ok && typeof response.version === "string") {
      return response.version;
    }
    return null;
  } catch {
    return null;
  }
}

async function injectContentScript(tabId: number, file: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file]
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function ensureCaptureScriptVersion(tabId: number, tabUrl: string): Promise<void> {
  const file = getContentScriptFile(tabUrl);
  if (!file) {
    throw new Error("当前链接不在支持范围内");
  }

  const existingVersion = await pingCaptureScriptVersion(tabId);
  if (existingVersion === CONTENT_SCRIPT_VERSION) {
    return;
  }

  await injectContentScript(tabId, file);

  const refreshedVersion = await pingCaptureScriptVersion(tabId);
  if (refreshedVersion !== CONTENT_SCRIPT_VERSION) {
    console.info("[AI_HISTORY] content script version mismatch", {
      expected: CONTENT_SCRIPT_VERSION,
      got: refreshedVersion || "unknown",
      tabUrl
    });
  }
}

export async function requestCapture(tabId: number, tabUrl: string, captureRunId = ""): Promise<CaptureResultEnvelope> {
  await ensureCaptureScriptVersion(tabId, tabUrl);
  try {
    return await sendCaptureMessage(tabId, captureRunId);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }

    const file = getContentScriptFile(tabUrl);
    if (!file) {
      throw new Error("当前链接不在支持范围内");
    }

    await injectContentScript(tabId, file);
    return sendCaptureMessage(tabId, captureRunId);
  }
}
