import { MAX_RECENT_ATTACHMENT_REQUESTS } from "./constants";

interface TrackedAttachmentRequest {
  url: string;
  startedAt: number;
  tabId: number;
  method: string;
}

const trackedAttachmentRequests: TrackedAttachmentRequest[] = [];
let attachmentHintWebRequestListenerInstalled = false;

function safeDecodeURIComponent(value: string): string {
  const normalized = value.replace(/\+/g, "%20");
  try {
    return decodeURIComponent(normalized);
  } catch {
    return value;
  }
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

export function findTrackedAttachmentHintUrls(fileId: string, tabId: number): string[] {
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

export function ensureAttachmentHintWebRequestListener(): void {
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
