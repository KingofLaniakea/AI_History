import type { CaptureAttachment } from "../types";

const FILE_LIKE_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "csv",
  "txt",
  "zip",
  "rar",
  "7z",
  "json",
  "md",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "svg",
  "mp3",
  "mp4",
  "wav"
];

export function isFileLikeExtension(ext: string): boolean {
  const normalized = ext.trim().toLowerCase();
  return FILE_LIKE_EXTENSIONS.includes(normalized);
}

function dataUrlMime(url: string): string {
  if (!url.startsWith("data:")) {
    return "";
  }
  const match = url.match(/^data:([^;,]+)[;,]/i);
  return (match?.[1] || "").toLowerCase();
}

function extractUrlExtension(url: string): string {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  return clean.split(".").pop()?.toLowerCase() ?? "";
}

function looksLikeCloudDriveFileUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("drive.google.com/file/") ||
    lower.includes("drive.google.com/open") ||
    lower.includes("docs.google.com/document/") ||
    lower.includes("docs.google.com/presentation/") ||
    lower.includes("docs.google.com/spreadsheets/")
  );
}

export function looksLikePdfUrl(url: string): boolean {
  const dataMime = dataUrlMime(url);
  if (dataMime === "application/pdf") {
    return true;
  }
  const lower = url.toLowerCase();
  return lower.includes(".pdf") || lower.includes("format=pdf") || lower.includes("mime=application/pdf");
}

export function looksLikeImageUrl(url: string): boolean {
  const dataMime = dataUrlMime(url);
  if (dataMime.startsWith("image/")) {
    return true;
  }
  const lower = url.toLowerCase();
  if (/\/backend-api\/estuary\/content/i.test(lower)) {
    return true;
  }
  if (
    lower.includes("format=png") ||
    lower.includes("format=jpg") ||
    lower.includes("format=jpeg") ||
    lower.includes("format=webp") ||
    lower.includes("format=gif") ||
    lower.includes("format=bmp") ||
    lower.includes("format=svg") ||
    lower.includes("mime=image/")
  ) {
    return true;
  }
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(extractUrlExtension(url));
}

export function looksLikeFileUrl(url: string): boolean {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  const maybeExt = clean.split(".").pop()?.toLowerCase() ?? "";
  if (isFileLikeExtension(maybeExt)) {
    return true;
  }
  if (looksLikeImageUrl(url) || looksLikePdfUrl(url)) {
    return true;
  }
  if (looksLikeCloudDriveFileUrl(url)) {
    return true;
  }
  if (/googleusercontent\.com\/gg\//i.test(url)) {
    return true;
  }
  if (/\/backend-api\/files\/|\/backend-api\/estuary\/content|\/api\/files\/|\/files\//i.test(url)) {
    return true;
  }
  if (/\/prompts\//i.test(url)) {
    return true;
  }
  if (/[?&](download|filename|attachment)=/i.test(url)) {
    return true;
  }
  return false;
}

export function isLikelyOaiAttachmentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower.includes("oaiusercontent.com")) {
    return false;
  }
  if (
    /web-sandbox\.oaiusercontent\.com\/\?(?:[^#]*&)?app=chatgpt(?:[&#]|$)/i.test(lower) ||
    /connector_openai_deep_research\./i.test(lower)
  ) {
    return false;
  }
  if (
    /\/backend-api\/files\//i.test(lower) ||
    /\/(?:download|content|files?)\//i.test(lower) ||
    /[?&](download|filename|attachment|response-content-disposition)=/i.test(lower) ||
    /oaiusercontent\.com\/[^?#]*file[-_][a-z0-9-]{4,}/i.test(lower)
  ) {
    return true;
  }
  return looksLikeFileUrl(lower) || looksLikePdfUrl(lower) || looksLikeImageUrl(lower);
}

export function inferAttachmentKind(url: string, label: string): CaptureAttachment["kind"] {
  const dataMime = dataUrlMime(url);
  if (dataMime === "application/pdf") {
    return "pdf";
  }
  if (dataMime.startsWith("image/")) {
    return "image";
  }
  const lowerLabel = label.toLowerCase();
  const lowerUrl = url.toLowerCase();
  if (/\/backend-api\/estuary\/content/i.test(lowerUrl)) {
    if (lowerLabel.includes(".pdf") || lowerLabel.includes("pdf") || lowerUrl.includes("format=pdf") || lowerUrl.includes("mime=application/pdf")) {
      return "pdf";
    }
    if (
      /\.(png|jpg|jpeg|webp|gif|bmp|svg)\b/i.test(lowerLabel) ||
      lowerUrl.includes("format=png") ||
      lowerUrl.includes("format=jpg") ||
      lowerUrl.includes("format=jpeg") ||
      lowerUrl.includes("format=webp") ||
      lowerUrl.includes("format=gif") ||
      lowerUrl.includes("format=bmp") ||
      lowerUrl.includes("format=svg") ||
      lowerUrl.includes("mime=image/")
    ) {
      return "image";
    }
    return "file";
  }
  if (lowerLabel.includes(".pdf") || lowerLabel.includes("pdf") || looksLikePdfUrl(url)) {
    return "pdf";
  }
  if (looksLikeImageUrl(url)) {
    return "image";
  }
  if (looksLikeCloudDriveFileUrl(url)) {
    return "file";
  }
  return "file";
}

export function inferAttachmentMime(kind: CaptureAttachment["kind"], url: string): string | null {
  const dataMime = dataUrlMime(url);
  if (dataMime) {
    return dataMime;
  }
  if (kind === "pdf" || looksLikePdfUrl(url)) {
    return "application/pdf";
  }
  if (!looksLikeImageUrl(url)) {
    return null;
  }
  const ext = extractUrlExtension(url);
  if (ext === "png") {
    return "image/png";
  }
  if (ext === "jpg" || ext === "jpeg") {
    return "image/jpeg";
  }
  if (ext === "webp") {
    return "image/webp";
  }
  if (ext === "gif") {
    return "image/gif";
  }
  if (ext === "bmp") {
    return "image/bmp";
  }
  if (ext === "svg") {
    return "image/svg+xml";
  }
  return null;
}

export function inferKindFromMimeHint(mimeHint: string | null | undefined): CaptureAttachment["kind"] | null {
  const normalized = (mimeHint || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("application/pdf")) {
    return "pdf";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  return null;
}

export function attachmentKindScore(kind: CaptureAttachment["kind"]): number {
  if (kind === "pdf") {
    return 2;
  }
  if (kind === "image") {
    return 1;
  }
  return 0;
}
