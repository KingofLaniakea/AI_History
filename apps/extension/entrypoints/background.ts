import { inferSourceFromUrl, type CapturePayload } from "./lib/extractor";

const BRIDGE_BASE = "http://127.0.0.1:48765";
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

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

  return null;
}

async function startSession(): Promise<{ token: string; expiresAt: string }> {
  const response = await fetch(`${BRIDGE_BASE}/v1/session/start`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`无法连接桌面应用，状态码 ${response.status}`);
  }

  return response.json();
}

async function submitCapture(payload: CapturePayload): Promise<void> {
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
}

async function sendCaptureMessage(tabId: number): Promise<CapturePayload> {
  const response = await chrome.tabs.sendMessage(tabId, { type: "AI_HISTORY_CAPTURE" });
  if (!response?.ok || !response.payload) {
    throw new Error(response?.error || "抓取失败，请确认页面已加载完整");
  }

  return response.payload as CapturePayload;
}

async function requestCapture(tabId: number, tabUrl: string): Promise<CapturePayload> {
  try {
    return await sendCaptureMessage(tabId);
  } catch (error) {
    const msg = String((error as Error)?.message || error || "");
    const noReceiver =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection");

    if (!noReceiver) {
      throw error;
    }

    const file = getContentScriptFile(tabUrl);
    if (!file) {
      throw new Error("当前链接不在支持范围内");
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file]
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    return sendCaptureMessage(tabId);
  }
}

async function captureCurrentTab(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("没有可抓取的活动标签页");
  }

  const payload = await requestCapture(tab.id, tab.url);
  await submitCapture(payload);
  return `已导入：${payload.title}`;
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 800);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function captureByUrl(url: string): Promise<string> {
  const source = inferSourceFromUrl(url);
  const tab = await chrome.tabs.create({ url, active: false });

  if (!tab.id) {
    throw new Error("无法创建用于抓取的标签页");
  }

  try {
    await waitForTabComplete(tab.id);
    const payload = await requestCapture(tab.id, url);
    payload.source = source;
    await submitCapture(payload);
    return `链接抓取成功：${payload.title}`;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeMimeType(raw: string): string {
  const normalized = raw.split(";")[0]?.trim().toLowerCase();
  return normalized || "application/octet-stream";
}

async function fetchAttachmentAsDataUrl(url: string): Promise<{
  ok: boolean;
  dataUrl?: string;
  mime?: string;
  size?: number;
  status?: number;
  error?: string;
}> {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "仅支持 http(s) 下载" };
  }

  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers: {
        Accept: "*/*"
      }
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`
      };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const normalizedMime = normalizeMimeType(contentType);
    if (normalizedMime.includes("application/json") || normalizedMime.startsWith("text/html")) {
      return {
        ok: false,
        status: response.status,
        error: `返回类型不是文件: ${normalizedMime || "unknown"}`
      };
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: response.status,
        error: `附件超过大小限制（${Math.round(contentLength / 1024 / 1024)}MB）`
      };
    }

    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) {
      return { ok: false, status: response.status, error: "附件内容为空" };
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: response.status,
        error: `附件超过大小限制（${Math.round(buffer.byteLength / 1024 / 1024)}MB）`
      };
    }

    const mime = normalizedMime || "application/octet-stream";
    const base64 = arrayBufferToBase64(buffer);
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${base64}`,
      mime,
      size: buffer.byteLength
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AI_HISTORY_FETCH_ATTACHMENT") {
      const url = String(message.url || "").trim();
      void fetchAttachmentAsDataUrl(url)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

    if (message?.type === "CAPTURE_CURRENT_TAB") {
      void captureCurrentTab()
        .then((text) => sendResponse({ ok: true, message: text }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "CAPTURE_URL") {
      const url = String(message.url || "").trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        sendResponse({ ok: false, error: "请输入有效的 http(s) 链接" });
        return;
      }

      void captureByUrl(url)
        .then((text) => sendResponse({ ok: true, message: text }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
  });
});
