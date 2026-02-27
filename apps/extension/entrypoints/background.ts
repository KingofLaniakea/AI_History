import { inferSourceFromUrl, type CapturePayload } from "./lib/extractor";

const BRIDGE_BASE = "http://127.0.0.1:48765";
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 15000;
const CONTENT_SCRIPT_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const MAX_RECENT_ATTACHMENT_REQUESTS = 3200;

interface TrackedAttachmentRequest {
  url: string;
  startedAt: number;
  tabId: number;
  method: string;
}

const trackedAttachmentRequests: TrackedAttachmentRequest[] = [];
let attachmentHintWebRequestListenerInstalled = false;

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

function isLikelyAttachmentHintUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("/backend-api/files/") ||
    lower.includes("/backend-api/estuary/content") ||
    (lower.includes("oaiusercontent.com") &&
      (
        /[?&](download|filename|attachment|response-content-disposition)=/i.test(lower) ||
        /(?:^|[/?&])file[_-][a-z0-9-]{6,}/i.test(lower)
      ))
  );
}

function extractFileIdFromTrackedUrl(rawUrl: string): string | null {
  const absolute = rawUrl.trim();
  if (!absolute) {
    return null;
  }
  const directDownloadMatch = absolute.match(/\/backend-api\/files\/download\/([^/?#]+)/i);
  if (directDownloadMatch?.[1]) {
    return safeDecodeURIComponent(directDownloadMatch[1]).trim() || null;
  }
  const directFileMatch = absolute.match(/\/backend-api\/files\/([^/?#]+)/i);
  if (directFileMatch?.[1]) {
    const candidate = safeDecodeURIComponent(directFileMatch[1]).trim();
    if (candidate && candidate.toLowerCase() !== "download") {
      return candidate;
    }
  }
  try {
    const parsed = new URL(absolute);
    const byQuery = (
      parsed.searchParams.get("id") ||
      parsed.searchParams.get("file_id") ||
      parsed.searchParams.get("fileId") ||
      ""
    ).trim();
    if (byQuery) {
      return safeDecodeURIComponent(byQuery).trim() || null;
    }
  } catch {
    // ignore
  }
  const fromText = absolute.match(/\bfile[_-][a-z0-9-]{6,}\b/i)?.[0];
  if (fromText) {
    return fromText;
  }
  return null;
}

function pushTrackedAttachmentRequest(url: string, tabId: number, method: string): void {
  const normalizedUrl = url.trim();
  if (!normalizedUrl || !isLikelyAttachmentHintUrl(normalizedUrl)) {
    return;
  }
  trackedAttachmentRequests.push({
    url: normalizedUrl,
    startedAt: Date.now(),
    tabId,
    method: method.toUpperCase()
  });
  if (trackedAttachmentRequests.length > MAX_RECENT_ATTACHMENT_REQUESTS) {
    trackedAttachmentRequests.splice(0, trackedAttachmentRequests.length - MAX_RECENT_ATTACHMENT_REQUESTS);
  }
}

function findTrackedAttachmentHintUrls(fileId: string, tabId: number): string[] {
  const expected = fileId.trim().toLowerCase();
  if (!expected) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const cutoff = Date.now() - 8 * 60 * 1000;
  for (let index = trackedAttachmentRequests.length - 1; index >= 0; index -= 1) {
    const item = trackedAttachmentRequests[index]!;
    if (item.startedAt < cutoff) {
      break;
    }
    if (item.tabId >= 0 && tabId >= 0 && item.tabId !== tabId) {
      continue;
    }
    const candidateId = extractFileIdFromTrackedUrl(item.url);
    if (!candidateId || candidateId.trim().toLowerCase() !== expected) {
      continue;
    }
    if (seen.has(item.url)) {
      continue;
    }
    seen.add(item.url);
    out.push(item.url);
    if (out.length >= 24) {
      break;
    }
  }
  return out;
}

function ensureAttachmentHintWebRequestListener(): void {
  if (attachmentHintWebRequestListenerInstalled) {
    return;
  }
  attachmentHintWebRequestListenerInstalled = true;
  if (!chrome.webRequest?.onBeforeRequest) {
    return;
  }
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = String(details.url || "").trim();
      const tabId = typeof details.tabId === "number" ? details.tabId : -1;
      const method = String(details.method || "GET").toUpperCase();
      pushTrackedAttachmentRequest(url, tabId, method);
    },
    {
      urls: [
        "https://chatgpt.com/*",
        "https://*.oaiusercontent.com/*"
      ]
    }
  );
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

function toAbsoluteHttpUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (isHttpUrl(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.startsWith("backend-api/") ? `/${trimmed}` : trimmed;
  if (!normalized.startsWith("/")) {
    return null;
  }
  try {
    const absolute = new URL(normalized, baseUrl).toString();
    return isHttpUrl(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

function extractUrlCandidatesFromText(raw: string, baseUrl: string): string[] {
  const text = raw.replace(/\\\//g, "/");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const normalized = toAbsoluteHttpUrl(value, baseUrl);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    if (match[0]) {
      add(match[0]);
    }
  }
  for (const match of text.matchAll(/\/backend-api\/[^\s"'<>\\]+/gi)) {
    if (match[0]) {
      add(match[0]);
    }
  }
  return out;
}

function collectRedirectUrlCandidatesFromPayload(payload: unknown, baseUrl: string): string[] {
  const out: string[] = [];
  const seenUrls = new Set<string>();
  const visited = new Set<object>();
  const queue: unknown[] = [payload];
  const priorityKeys = [
    "download_url",
    "downloadUrl",
    "download_link",
    "downloadLink",
    "signed_download_url",
    "signedDownloadUrl",
    "signed_url",
    "signedUrl",
    "presigned_url",
    "presignedUrl",
    "file_url",
    "fileUrl",
    "content_url",
    "contentUrl",
    "retrieval_url",
    "retrievalUrl",
    "href",
    "url",
    "link"
  ];
  const keyHintRegex = /(url|link|href|download|signed|presign|content|asset|file|path)/i;

  const add = (value: string) => {
    const normalized = toAbsoluteHttpUrl(value, baseUrl);
    if (!normalized || seenUrls.has(normalized)) {
      return;
    }
    seenUrls.add(normalized);
    out.push(normalized);
  };

  for (let index = 0; index < queue.length && index < 2600; index += 1) {
    const node = queue[index];
    if (!node) {
      continue;
    }
    if (typeof node === "string") {
      add(node);
      for (const candidate of extractUrlCandidatesFromText(node, baseUrl)) {
        add(candidate);
      }
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        queue.push(item);
      }
      continue;
    }
    if (typeof node !== "object") {
      continue;
    }
    if (visited.has(node as object)) {
      continue;
    }
    visited.add(node as object);
    const record = node as Record<string, unknown>;

    for (const key of priorityKeys) {
      const value = record[key];
      if (typeof value === "string") {
        add(value);
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        if (keyHintRegex.test(key)) {
          add(value);
        }
        if (value.includes("http://") || value.includes("https://") || value.includes("/backend-api/")) {
          for (const candidate of extractUrlCandidatesFromText(value, baseUrl)) {
            add(candidate);
          }
        }
        continue;
      }
      queue.push(value);
    }
  }

  return out;
}

function pickRedirectUrlFromPayload(payload: unknown, baseUrl: string, tried: string[]): string | null {
  const triedSet = new Set(tried);
  for (const candidate of collectRedirectUrlCandidatesFromPayload(payload, baseUrl)) {
    if (!triedSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function fetchAttachmentAsDataUrl(url: string): Promise<AttachmentFetchResponse> {
  if (!isHttpUrl(url)) {
    return { ok: false, error: "仅支持 http(s) 下载" };
  }

  const tried: string[] = [url];
  const triedRequestKeys = new Set<string>();

  const doFetch = async (
    targetUrl: string,
    init: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    } = {}
  ): Promise<AttachmentFetchResponse | null> => {
    const method = (init.method || "GET").toUpperCase() as "GET" | "POST";
    const requestKey = `${method} ${targetUrl}`;
    if (triedRequestKeys.has(requestKey)) {
      return null;
    }
    triedRequestKeys.add(requestKey);
    if (!tried.includes(targetUrl)) {
      tried.push(targetUrl);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method,
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "*/*",
          ...(init.headers || {})
        },
        body: method === "POST" ? (init.body ?? "{}") : undefined
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    let normalizedMime = normalizeMimeType(contentType);

    if (!response.ok) {
      if (normalizedMime.includes("application/json")) {
        try {
          const payload = (await response.json()) as unknown;
          const redirectUrl = pickRedirectUrlFromPayload(payload, response.url || targetUrl, tried);
          if (redirectUrl) {
            return doFetch(redirectUrl);
          }
        } catch {
          // ignore
        }
      }
      if (
        (response.status === 422 || response.status === 405 || response.status === 400) &&
        method === "GET" &&
        /\/backend-api\/(?:files\/download\/|files\/[^/?#]+\/download|estuary\/content)/i.test(targetUrl)
      ) {
        const postResult = await doFetch(targetUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, */*;q=0.8"
          },
          body: "{}"
        });
        if (postResult) {
          return postResult;
        }
      }

      // Fallback: some APIs return URL hints in text even on non-2xx.
      try {
        const text = await response.text();
        const textCandidates = extractUrlCandidatesFromText(text, response.url || targetUrl);
        for (const candidate of textCandidates) {
          if (!tried.includes(candidate)) {
            const result = await doFetch(candidate);
            if (result) {
              return result;
            }
          }
        }
      } catch {
        // ignore
      }
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        tried
      };
    }

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
      const redirectUrl = pickRedirectUrlFromPayload(payload, response.url || targetUrl, tried);
      if (redirectUrl && isHttpUrl(redirectUrl)) {
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
  ensureAttachmentHintWebRequestListener();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    if (message?.type === "AI_HISTORY_LOOKUP_ATTACHMENT_HINTS") {
      const fileId = String(message.fileId || "").trim();
      const senderTabId = typeof sender?.tab?.id === "number" ? sender.tab.id : -1;
      const urls = fileId ? findTrackedAttachmentHintUrls(fileId, senderTabId) : [];
      sendResponse({
        ok: true,
        urls
      });
      return;
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
