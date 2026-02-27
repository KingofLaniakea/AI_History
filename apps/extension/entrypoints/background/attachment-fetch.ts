import { ATTACHMENT_FETCH_TIMEOUT_MS, MAX_ATTACHMENT_BYTES } from "./constants";

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

export type AttachmentFetchResponse = {
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

export async function fetchAttachmentAsDataUrl(url: string): Promise<AttachmentFetchResponse> {
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

export async function probeAttachmentUrl(url: string): Promise<{
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
