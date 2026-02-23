import { inferSourceFromUrl, type CapturePayload } from "./lib/extractor";

const BRIDGE_BASE = "http://127.0.0.1:48765";
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 15000;
const CONTENT_SCRIPT_VERSION = "2026-02-23-r9-real-attachments";

interface CaptureProgressPayload {
  runId: string;
  phase: "content" | "files";
  percent: number;
  status: string;
  processed?: number;
  total?: number;
  failed?: number;
}

function emitCaptureProgress(progress: CaptureProgressPayload): void {
  try {
    chrome.runtime.sendMessage({
      type: "CAPTURE_PROGRESS",
      ...progress
    });
  } catch {
    // no listeners
  }
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

interface ImportLiveResult {
  imported?: number;
  skipped?: number;
  conflicts?: number;
}

async function submitCapture(payload: CapturePayload): Promise<ImportLiveResult> {
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

interface CaptureScriptResponse {
  ok?: boolean;
  payload?: CapturePayload;
  error?: string;
  warning?: string;
}

interface CaptureResultEnvelope {
  payload: CapturePayload;
  warning: string;
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

async function requestCapture(tabId: number, tabUrl: string, captureRunId = ""): Promise<CaptureResultEnvelope> {
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

interface CaptureRunResult {
  message: string;
  warning?: string;
}

async function captureCurrentTab(captureRunId = ""): Promise<CaptureRunResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("没有可抓取的活动标签页");
  }

  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "content",
      percent: 2,
      status: "已开始抓取"
    });
  }

  const { payload, warning } = await requestCapture(tab.id, tab.url, captureRunId);
  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "content",
      percent: 100,
      status: "对话内容抓取完成"
    });
  }
  const importResult = await submitCapture(payload);
  console.info("[AI_HISTORY] submit capture result", {
    source: payload.source,
    title: payload.title,
    imported: Number(importResult.imported || 0),
    skipped: Number(importResult.skipped || 0),
    conflicts: Number(importResult.conflicts || 0)
  });
  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "files",
      percent: 100,
      status: warning ? `抓取完成（有告警）` : "抓取流程完成"
    });
  }
  return {
    message: `已导入：${payload.title}（导入 ${Number(importResult.imported || 0)}）`,
    warning: warning || undefined
  };
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

async function captureByUrl(url: string, captureRunId = ""): Promise<CaptureRunResult> {
  const source = inferSourceFromUrl(url);
  const tab = await chrome.tabs.create({ url, active: false });

  if (!tab.id) {
    throw new Error("无法创建用于抓取的标签页");
  }

  try {
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "content",
        percent: 2,
        status: "正在打开链接"
      });
    }
    await waitForTabComplete(tab.id);
    const { payload, warning } = await requestCapture(tab.id, url, captureRunId);
    payload.source = source;
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "content",
        percent: 100,
        status: "对话内容抓取完成"
      });
    }
    const importResult = await submitCapture(payload);
    console.info("[AI_HISTORY] submit capture result", {
      source: payload.source,
      title: payload.title,
      imported: Number(importResult.imported || 0),
      skipped: Number(importResult.skipped || 0),
      conflicts: Number(importResult.conflicts || 0)
    });
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "files",
        percent: 100,
        status: warning ? "抓取完成（有告警）" : "抓取流程完成"
      });
    }
    return {
      message: `链接抓取成功：${payload.title}（导入 ${Number(importResult.imported || 0)}）`,
      warning: warning || undefined
    };
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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isGenericMimeType(mime: string): boolean {
  const normalized = mime.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream" ||
    normalized === "application/binary" ||
    normalized === "unknown/unknown"
  );
}

function safeDecodeURIComponent(value: string): string {
  const normalized = value.replace(/\+/g, "%20");
  try {
    return decodeURIComponent(normalized);
  } catch {
    return value;
  }
}

function sanitizeFileName(name: string): string {
  const trimmed = name.trim().replace(/^["']+|["']+$/g, "");
  const normalized = trimmed.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_");
  return normalized.trim().slice(0, 240);
}

function extractFileExtension(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!clean || !clean.includes(".")) {
    return "";
  }
  const ext = clean.split(".").pop() ?? "";
  if (!ext || ext.length > 10 || !/^[a-z0-9]+$/.test(ext)) {
    return "";
  }
  return ext;
}

function inferMimeFromFileName(name: string): string | null {
  const ext = extractFileExtension(name);
  if (!ext) {
    return null;
  }
  const map: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return map[ext] ?? null;
}

function parseContentDispositionFileName(raw: string): string | null {
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^filename\*=/i.test(trimmed)) {
      continue;
    }
    const value = trimmed.replace(/^filename\*=/i, "").trim();
    const stripped = value.replace(/^["']+|["']+$/g, "");
    const encoded = stripped.includes("''") ? stripped.split("''").slice(1).join("''") : stripped;
    const decoded = sanitizeFileName(safeDecodeURIComponent(encoded));
    if (decoded) {
      return decoded;
    }
  }

  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^filename=/i.test(trimmed)) {
      continue;
    }
    const value = trimmed.replace(/^filename=/i, "").trim();
    const decoded = sanitizeFileName(safeDecodeURIComponent(value));
    if (decoded) {
      return decoded;
    }
  }
  return null;
}

function extractFileNameFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const directNameParams = ["filename", "file", "name"];
  for (const key of directNameParams) {
    const value = parsed.searchParams.get(key);
    if (!value) {
      continue;
    }
    const decoded = sanitizeFileName(safeDecodeURIComponent(value));
    if (decoded) {
      return decoded;
    }
  }

  const responseContentDisposition = parsed.searchParams.get("response-content-disposition");
  if (responseContentDisposition) {
    const fileName = parseContentDispositionFileName(responseContentDisposition);
    if (fileName) {
      return fileName;
    }
  }

  const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const decodedSegment = sanitizeFileName(safeDecodeURIComponent(lastSegment));
  if (decodedSegment && decodedSegment.includes(".")) {
    return decodedSegment;
  }
  return null;
}

function buildDataUrl(mime: string, base64: string, fileName?: string | null): string {
  const safeName = fileName ? sanitizeFileName(fileName) : "";
  if (safeName) {
    const encodedName = encodeURIComponent(safeName);
    return `data:${mime};name=${encodedName};base64,${base64}`;
  }
  return `data:${mime};base64,${base64}`;
}

type AttachmentFetchResponse = {
  ok: boolean;
  dataUrl?: string;
  mime?: string;
  filename?: string;
  size?: number;
  status?: number;
  error?: string;
  tried?: string[];
};

async function fetchAttachmentAsDataUrl(url: string): Promise<AttachmentFetchResponse> {
  if (!isHttpUrl(url)) {
    return { ok: false, error: "仅支持 http(s) 下载" };
  }

  const tried: string[] = [url];

  const doFetch = async (targetUrl: string): Promise<AttachmentFetchResponse | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "*/*" }
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return null;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    let normalizedMime = normalizeMimeType(contentType);
    const contentDisposition = response.headers.get("content-disposition") || "";
    const fileNameFromHeader = parseContentDispositionFileName(contentDisposition);
    const fileNameFromUrl = extractFileNameFromUrl(response.url || targetUrl);
    const resolvedFileName = fileNameFromHeader || fileNameFromUrl || null;
    const inferredMimeFromName = resolvedFileName ? inferMimeFromFileName(resolvedFileName) : null;

    // If JSON, try to extract a download_url / url field and follow it once
    if (normalizedMime.includes("application/json")) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
      const redirectUrl =
        typeof payload?.download_url === "string"
          ? payload.download_url
          : typeof payload?.url === "string"
            ? payload.url
            : null;
      if (redirectUrl && isHttpUrl(redirectUrl) && !tried.includes(redirectUrl)) {
        tried.push(redirectUrl);
        return doFetch(redirectUrl);
      }
      return null;
    }

    // Skip HTML responses
    if (normalizedMime.startsWith("text/html")) {
      return null;
    }

    if (inferredMimeFromName) {
      if (isGenericMimeType(normalizedMime)) {
        normalizedMime = inferredMimeFromName;
      } else if (normalizedMime === "text/plain" && inferredMimeFromName !== "text/plain") {
        normalizedMime = inferredMimeFromName;
      }
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: response.status,
        error: `附件超过大小限制（${Math.round(contentLength / 1024 / 1024)}MB）`,
        tried
      };
    }

    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) {
      return null;
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        status: response.status,
        error: `附件超过大小限制（${Math.round(buffer.byteLength / 1024 / 1024)}MB）`,
        tried
      };
    }

    const mime = normalizedMime || "application/octet-stream";
    const base64 = arrayBufferToBase64(buffer);
    return {
      ok: true,
      dataUrl: buildDataUrl(mime, base64, resolvedFileName),
      mime,
      filename: resolvedFileName ?? undefined,
      size: buffer.byteLength,
      status: response.status,
      tried
    };
  };

  try {
    const result = await doFetch(url);
    if (result) {
      return result;
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tried
    };
  }

  return {
    ok: false,
    error: "未找到可下载的真实附件链接",
    tried
  };
}

async function probeAttachmentUrl(url: string): Promise<{
  ok: boolean;
  url: string;
  method: "HEAD" | "GET";
  status?: number;
  contentType?: string;
  contentLength?: number;
  error?: string;
}> {
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      url,
      method: "GET",
      error: "仅支持 http(s)"
    };
  }

  const readMeta = (response: Response) => {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentLength = Number(response.headers.get("content-length") || 0);
    return {
      status: response.status,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : 0
    };
  };

  try {
    const head = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers: {
        Accept: "*/*"
      }
    });
    const headMeta = readMeta(head);
    if (head.ok) {
      return {
        ok: true,
        url: head.url || url,
        method: "HEAD",
        ...headMeta
      };
    }
  } catch {
    // fallback GET
  }

  try {
    const get = await fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      headers: {
        Accept: "*/*",
        Range: "bytes=0-1023"
      }
    });
    const getMeta = readMeta(get);
    return {
      ok: get.ok,
      url: get.url || url,
      method: "GET",
      ...getMeta,
      error: get.ok ? undefined : `HTTP ${get.status}`
    };
  } catch (error) {
    return {
      ok: false,
      url,
      method: "GET",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AI_HISTORY_CAPTURE_PROGRESS") {
      const runId = String(message.runId || "").trim();
      if (runId) {
        emitCaptureProgress({
          runId,
          phase: message.phase === "files" ? "files" : "content",
          percent: Number(message.percent || 0),
          status: String(message.status || ""),
          processed: Number(message.processed || 0) || 0,
          total: Number(message.total || 0) || 0,
          failed: Number(message.failed || 0) || 0
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "AI_HISTORY_PROBE_ATTACHMENT") {
      const url = String(message.url || "").trim();
      void probeAttachmentUrl(url)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            ok: false,
            url,
            method: "GET",
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

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
      const runId = String(message.runId || "").trim() || `run_${Date.now()}`;
      void captureCurrentTab(runId)
        .then((result) => sendResponse({ ok: true, message: result.message, warning: result.warning, runId }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "CAPTURE_URL") {
      const url = String(message.url || "").trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        sendResponse({ ok: false, error: "请输入有效的 http(s) 链接" });
        return;
      }

      const runId = String(message.runId || "").trim() || `run_${Date.now()}`;
      void captureByUrl(url, runId)
        .then((result) => sendResponse({ ok: true, message: result.message, warning: result.warning, runId }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
  });
});
