export type CaptureSource = "chatgpt" | "gemini" | "ai_studio";

export interface CaptureAttachment {
  kind: "image" | "pdf" | "file";
  originalUrl: string;
  mime?: string | null;
  status?: "remote_only" | "cached" | "failed" | null;
}

export interface CaptureTurn {
  role: "user" | "assistant" | "system" | "tool";
  contentMarkdown: string;
  thoughtMarkdown?: string | null;
  attachments?: CaptureAttachment[] | null;
  model?: string | null;
  timestamp?: string | null;
}

export interface CapturePayload {
  source: CaptureSource;
  pageUrl: string;
  title: string;
  turns: CaptureTurn[];
  capturedAt: string;
  version: string;
}

const NOISE_LINE_REGEX =
  /^(skip to main content|home|settings|menu_open|menu|share|compare_arrows|add|more_vert|edit|chevron_right|chevron_left|trending_flat|developer_guide|documentation|expand_more|expand to view model thoughts|model thoughts|token(s)?|get api key|application|content_copy|thumb_up|thumb_down|volume_up|flag|restart_alt|stop|send|mic|attach_file|photo_camera|light_mode|dark_mode|edit_note|arrow_drop_down|arrow_drop_up|close|check|done|info|warning|error|search|filter_list|sort|visibility|visibility_off)$/i;

const GEMINI_BOILERPLATE_MARKERS = [
  "如果你想让我保存或删除我们对话中关于你的信息",
  "你需要先开启过往对话记录",
  "你也可以手动添加或更新你给gemini的指令",
  "从而定制gemini的回复",
  "ifyouwantmetosaveordeleteinformationfromourconversations",
  "youneedtoturnonchathistory",
  "youcanalsomanuallyaddorupdateyourinstructionsforgemini"
];

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

const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const NETWORK_TRACKER_KEY = "__AI_HISTORY_NETWORK_TRACKER__";
const MAX_TRACKED_NETWORK_RECORDS = 2400;
const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TrackedNetworkRecord {
  url: string;
  method: string;
  startedAt: number;
  status: number;
  ok: boolean;
}

interface NetworkTrackerState {
  installed: boolean;
  records: TrackedNetworkRecord[];
}

type TrackerWindow = Window & {
  [NETWORK_TRACKER_KEY]?: NetworkTrackerState;
};

let captureWindowStartMs = 0;

export function beginCaptureSessionWindow(): void {
  ensureRuntimeNetworkTracker();
  captureWindowStartMs = performance.now();
}

function activeCaptureWindowStartMs(): number {
  return Number.isFinite(captureWindowStartMs) && captureWindowStartMs > 0 ? captureWindowStartMs : 0;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return toAbsoluteUrl(input) || input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url || "";
  }
  return String(input || "");
}

function trackerState(): NetworkTrackerState {
  const globalWindow = window as TrackerWindow;
  if (!globalWindow[NETWORK_TRACKER_KEY]) {
    globalWindow[NETWORK_TRACKER_KEY] = {
      installed: false,
      records: []
    };
  }
  return globalWindow[NETWORK_TRACKER_KEY]!;
}

function pushTrackedNetworkRecord(record: TrackedNetworkRecord): void {
  if (!record.url) {
    return;
  }
  const state = trackerState();
  state.records.push(record);
  if (state.records.length > MAX_TRACKED_NETWORK_RECORDS) {
    const overflow = state.records.length - MAX_TRACKED_NETWORK_RECORDS;
    state.records.splice(0, overflow);
  }
}

function ensureRuntimeNetworkTracker(): void {
  const state = trackerState();
  if (state.installed) {
    return;
  }
  state.installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const method = (init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"))
      .toString()
      .toUpperCase();
    const requestedUrl = resolveRequestUrl(input);
    try {
      const response = await originalFetch(input, init);
      pushTrackedNetworkRecord({
        url: response.url || requestedUrl,
        method,
        startedAt,
        status: response.status,
        ok: response.ok
      });
      return response;
    } catch (error) {
      pushTrackedNetworkRecord({
        url: requestedUrl,
        method,
        startedAt,
        status: 0,
        ok: false
      });
      throw error;
    }
  }) as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    const self = this as XMLHttpRequest & { __aihMethod?: string; __aihUrl?: string };
    self.__aihMethod = (method || "GET").toString().toUpperCase();
    self.__aihUrl = toAbsoluteUrl(String(url || "")) || String(url || "");
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
    const self = this as XMLHttpRequest & { __aihMethod?: string; __aihUrl?: string };
    const startedAt = performance.now();
    const finalize = () => {
      pushTrackedNetworkRecord({
        url: self.responseURL || self.__aihUrl || "",
        method: (self.__aihMethod || "GET").toUpperCase(),
        startedAt,
        status: Number(self.status || 0),
        ok: Number(self.status || 0) >= 200 && Number(self.status || 0) < 400
      });
      self.removeEventListener("loadend", finalize);
    };
    self.addEventListener("loadend", finalize);
    originalSend.call(this, body ?? null);
  };
}

function getTrackedNetworkRecords(sinceMs = 0): TrackedNetworkRecord[] {
  ensureRuntimeNetworkTracker();
  const state = trackerState();
  if (sinceMs <= 0) {
    return state.records.slice();
  }
  return state.records.filter((record) => record.startedAt >= sinceMs);
}

function decodeHtml(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

function fixDanglingMathDelimiters(text: string): string {
  const lines = text.split("\n");
  const fixedLines = lines.map((line) => {
    const trimmed = line.trim();
    const hasLatexSignals = /\\[a-zA-Z]+|[_^{}]/.test(trimmed);
    const blockCount = (line.match(/\$\$/g) || []).length;

    if (blockCount === 1 && hasLatexSignals) {
      if (trimmed.endsWith("$$") && !trimmed.startsWith("$$")) {
        const expr = trimmed.slice(0, -2).trim();
        return line.replace(trimmed, `$$${expr}$$`);
      }
      if (trimmed.startsWith("$$") && !trimmed.endsWith("$$")) {
        const expr = trimmed.slice(2).trim();
        return line.replace(trimmed, `$$${expr}$$`);
      }
    }

    return line;
  });

  let result = fixedLines.join("\n");
  const totalBlockDelimiters = (result.match(/\$\$/g) || []).length;
  if (totalBlockDelimiters % 2 === 1) {
    result += "\n$$";
  }

  return result;
}

function fixMatrixRows(text: string): string {
  return text.replace(/\\begin\{pmatrix\}([\s\S]*?)\\end\{pmatrix\}/g, (_match, body: string) => {
    const normalizedBody = body.replace(/\\\s+(?=[^\s\\])/g, "\\\\ ");
    const rows = normalizedBody
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        if (/[^\\]\\$/.test(line)) {
          return `${line.slice(0, -1)}\\\\`;
        }
        return line;
      });

    const fixedRows = rows.map((row, index) => {
      if (index < rows.length - 1 && !/\\\\\s*$/.test(row)) {
        return `${row} \\\\`;
      }
      return row;
    });

    return `\\begin{pmatrix}\n${fixedRows.join("\n")}\n\\end{pmatrix}`;
  });
}

function wrapStandaloneLatexBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inDisplayMath = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const delimiterCount = (line.match(/\$\$/g) || []).length;

    if (!inDisplayMath && /^\s*\\begin\{[a-zA-Z*]+\}/.test(line)) {
      const block: string[] = [line];
      let endFound = /\\end\{[a-zA-Z*]+\}/.test(line);

      while (!endFound && i + 1 < lines.length) {
        i += 1;
        const nextLine = lines[i] ?? "";
        block.push(nextLine);
        if (/\\end\{[a-zA-Z*]+\}/.test(nextLine)) {
          endFound = true;
        }
      }

      out.push("$$");
      out.push(...block);
      out.push("$$");
      continue;
    }

    out.push(line);
    if (delimiterCount % 2 === 1) {
      inDisplayMath = !inDisplayMath;
    }
  }

  return out.join("\n");
}

function readLatex(node: Element): string {
  const annotation = node.querySelector("annotation");
  if (annotation?.textContent) {
    return decodeHtml(annotation.textContent).trim();
  }

  const attrs = [
    node.getAttribute("data-tex"),
    node.getAttribute("data-latex"),
    node.getAttribute("aria-label")
  ]
    .filter((v): v is string => Boolean(v))
    .map((v) => decodeHtml(v).trim())
    .filter(Boolean);
  if (attrs.length > 0) {
    return attrs[0];
  }

  return "";
}

function replaceMathWithLatex(root: Element, doc: Document): void {
  const displaySelectors = [
    ".katex-display", "[class*='katex-display']",
    "math[display='block']", "[data-display='block']",
    "mjx-container[display='true']", "mjx-container[jax='CHTML'][display='true']",
    "[class*='math-display']", "[class*='formula-display']"
  ].join(", ");

  const displayNodes = Array.from(root.querySelectorAll(displaySelectors));
  for (const node of displayNodes) {
    const latex = readLatex(node);
    if (!latex) {
      continue;
    }
    node.replaceWith(doc.createTextNode(`\n$$${latex}$$\n`));
  }

  const inlineSelectors = [
    ".katex", "math", "[data-tex]", "[data-latex]",
    "mjx-container", "[class*='math-inline']", "[class*='formula']"
  ].join(", ");

  const inlineNodes = Array.from(root.querySelectorAll(inlineSelectors));
  for (const node of inlineNodes) {
    if (node.closest(displaySelectors)) {
      continue;
    }
    const latex = readLatex(node);
    if (!latex) {
      // Fallback: use textContent for math elements that have no annotation
      const text = (node.textContent || "").trim();
      if (text && node.tagName.toLowerCase() !== "div") {
        node.replaceWith(doc.createTextNode(`$${text}$`));
      }
      continue;
    }
    node.replaceWith(doc.createTextNode(`$${latex}$`));
  }
}

function htmlToMarkdownish(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (root) {
    replaceMathWithLatex(root, doc);

    // Remove Material Design icon elements before text extraction
    for (const icon of Array.from(root.querySelectorAll(
      ".material-icons, .material-symbols-outlined, .material-symbols-rounded, [class*='icon-button'], [aria-hidden='true']"
    ))) {
      icon.remove();
    }

    // Convert tables to Markdown before regex-based conversion
    for (const table of Array.from(root.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      const mdRows: string[] = [];
      for (let ri = 0; ri < rows.length; ri++) {
        const cells = Array.from(rows[ri].querySelectorAll("th, td"));
        const line = "| " + cells.map(c => (c.textContent || "").trim().replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
        mdRows.push(line);
        if (ri === 0) {
          mdRows.push("| " + cells.map(() => "---").join(" | ") + " |");
        }
      }
      const mdText = "\n" + mdRows.join("\n") + "\n";
      table.replaceWith(doc.createTextNode(mdText));
    }
  }

  let text = (root?.innerHTML || html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "");

  text = text.replace(
    /<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, labelHtml: string) => {
      const absoluteHref = toAbsoluteUrl(href) || href;
      const label = decodeHtml(stripHtmlTags(labelHtml)).replace(/\s+/g, " ").trim() || absoluteHref;
      return `[${label}](${absoluteHref})`;
    }
  );

  text = text.replace(
    /<img\b[^>]*src=(['"])(.*?)\1[^>]*>/gi,
    (match: string, _quote: string, src: string) => {
      const absoluteSrc = toAbsoluteUrl(src) || src;
      const altMatch = match.match(/\balt=(['"])(.*?)\1/i);
      const alt = altMatch?.[2] || "image";
      return `![${alt}](${absoluteSrc})`;
    }
  );

  text = text.replace(/<pre\b[^>]*>/gi, "\n```\n").replace(/<\/pre>/gi, "\n```\n");
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => {
    const plain = decodeHtml(stripHtmlTags(code)).trim();
    return plain ? `\`${plain}\`` : "";
  });

  text = text
    .replace(/<h1\b[^>]*>/gi, "\n# ")
    .replace(/<h2\b[^>]*>/gi, "\n## ")
    .replace(/<h3\b[^>]*>/gi, "\n### ")
    .replace(/<h4\b[^>]*>/gi, "\n#### ")
    .replace(/<h5\b[^>]*>/gi, "\n##### ")
    .replace(/<h6\b[^>]*>/gi, "\n###### ");

  text = text
    .replace(/<(strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(strong|b)>/gi, "**")
    .replace(/<(em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(em|i)>/gi, "*");

  text = text.replace(/<li\b[^>]*>/gi, "\n- ");

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|ul|ol|table|thead|tbody|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<(p|div|section|article|blockquote|ul|ol|table|thead|tbody|tr)\b[^>]*>/gi, "\n");

  return decodeHtml(stripHtmlTags(text));
}

function normalizeMarkdownText(text: string): string {
  const cleaned = decodeHtml(text)
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n");

  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (NOISE_LINE_REGEX.test(trimmed)) {
        return false;
      }
      if (/^more_vert(\s+more_vert)*$/i.test(trimmed)) {
        return false;
      }
      if (/^chevron_right(\s+chevron_right)*$/i.test(trimmed)) {
        return false;
      }
      if (/^chevron_left(\s+chevron_left)*$/i.test(trimmed)) {
        return false;
      }
      return true;
    });

  const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const fixedMatrix = fixMatrixRows(normalized);
  const wrappedLatex = wrapStandaloneLatexBlocks(fixedMatrix);
  return fixDanglingMathDelimiters(wrappedLatex);
}

function normalizeForDedupe(content: string): string {
  return content
    .replace(/^you said\s*/i, "")
    .replace(/^显示思路\s*gemini said\s*/i, "")
    .replace(/^gemini said\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeForGeminiFilter(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function extractExtFromFileName(name: string): string {
  const clean = name.trim().toLowerCase();
  const noQuery = clean.split("?")[0]?.split("#")[0] ?? clean;
  return noQuery.split(".").pop() ?? "";
}

function findLikelyInlineFileNames(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const out = new Set<string>();
  for (const line of lines) {
    const match = line.match(/[a-z0-9._-]+\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|tsv|md|txt|png|jpg|jpeg|webp|gif|bmp|svg)\b/i);
    if (match?.[0]) {
      out.add(match[0]);
    }
  }
  return Array.from(out);
}

function isFileLikeExtension(ext: string): boolean {
  const normalized = ext.trim().toLowerCase();
  return FILE_LIKE_EXTENSIONS.includes(normalized);
}

function looksLikeAttachmentFileNameLabel(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 260) {
    return false;
  }
  const ext = extractExtFromFileName(trimmed);
  if (!ext || !isFileLikeExtension(ext)) {
    return false;
  }
  if (/\s{2,}/.test(trimmed)) {
    return false;
  }
  return /[a-z0-9]/i.test(trimmed);
}

function isImageExtension(ext: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(ext);
}

function isDataUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("data:");
}

function isVirtualAttachmentUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("aihistory://upload/");
}

function decodeVirtualAttachmentName(url: string): string {
  if (!isVirtualAttachmentUrl(url)) {
    return "";
  }
  const raw = url.slice("aihistory://upload/".length).split("?")[0] ?? "";
  if (!raw) {
    return "未命名文件";
  }
  try {
    const decoded = decodeURIComponent(raw);
    return decoded || raw;
  } catch {
    return raw;
  }
}

function stripGeminiBoilerplate(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const kept = paragraphs.filter((paragraph) => {
    const normalized = normalizeForGeminiFilter(paragraph);
    if (!normalized) {
      return false;
    }
    return !GEMINI_BOILERPLATE_MARKERS.some((marker) => normalized.includes(marker));
  });
  return kept.join("\n\n").trim();
}

function stripGeminiUiPrefixes(text: string): string {
  return text
    .replace(/^you said\s*/i, "")
    .replace(/^gemini said\s*/i, "")
    .replace(/^显示思路\s*id_?\s*/i, "")
    .trim();
}

function extractUrlExtension(url: string): string {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  return clean.split(".").pop()?.toLowerCase() ?? "";
}

function looksLikePdfUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes(".pdf") || lower.includes("format=pdf") || lower.includes("mime=application/pdf");
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

function looksLikeImageUrl(url: string): boolean {
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

function looksLikeFileUrl(url: string): boolean {
  const clean = url.split("?")[0]?.split("#")[0] ?? url;
  const maybeExt = clean.split(".").pop()?.toLowerCase() ?? "";
  if (FILE_LIKE_EXTENSIONS.includes(maybeExt)) {
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

function isLikelyOaiAttachmentUrl(url: string): boolean {
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
    /[?&](download|filename|attachment|response-content-disposition)=/i.test(lower)
  ) {
    return true;
  }
  return looksLikeFileUrl(lower) || looksLikePdfUrl(lower) || looksLikeImageUrl(lower);
}

function inferAttachmentKind(url: string, label: string): CaptureAttachment["kind"] {
  const lowerLabel = label.toLowerCase();
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

function inferAttachmentMime(kind: CaptureAttachment["kind"], url: string): string | null {
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

function inferKindFromMimeHint(mimeHint: string | null | undefined): CaptureAttachment["kind"] | null {
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

function extractUrlsFromElement(node: Element): string[] {
  const candidates = new Set<string>();
  const attrs = node.getAttributeNames();
  for (const name of attrs) {
    const raw = node.getAttribute(name) || "";
    if (!raw) {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (
      name === "href" ||
      name === "src" ||
      name.toLowerCase().includes("url") ||
      name.toLowerCase().includes("href") ||
      name.toLowerCase().includes("src") ||
      name.toLowerCase().includes("download")
    ) {
      const absolute = toAbsoluteUrl(trimmed);
      if (absolute) {
        candidates.add(absolute);
      }
    }

    const matches = trimmed.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const match of matches) {
      const absolute = toAbsoluteUrl(match);
      if (absolute) {
        candidates.add(absolute);
      }
    }
  }

  const textMatches = ((node.textContent || "").match(/https?:\/\/[^\s"'<>]+/gi) || []).map((item) =>
    toAbsoluteUrl(item)
  );
  for (const item of textMatches) {
    if (item) {
      candidates.add(item);
    }
  }

  return Array.from(candidates);
}

export function extractDriveApiAttachments(): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources) {
      const url = entry.name;
      const match = url.match(/googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media/i);
      if (!match) {
        continue;
      }
      if (found.has(url)) {
        continue;
      }
      found.set(url, {
        kind: "file",
        originalUrl: url,
        mime: null,
        status: "remote_only"
      });
    }
  } catch {
    // ignore
  }
  return Array.from(found.values());
}

export function applyDriveAttachments(turns: CaptureTurn[]): CaptureTurn[] {
  const driveAttachments = extractDriveApiAttachments();
  if (!driveAttachments.length) {
    return turns;
  }
  const firstUserIdx = turns.findIndex((t) => t.role === "user");
  if (firstUserIdx < 0) {
    return turns;
  }
  return turns.map((turn, idx) => {
    if (idx !== firstUserIdx) {
      return turn;
    }
    return {
      ...turn,
      attachments: mergeTurnAttachments(turn.attachments, driveAttachments)
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickScrollableElement(doc: Document): HTMLElement | null {
  const candidates = Array.from(doc.querySelectorAll("main, [role='main'], [class*='scroll'], [class*='conversation'], [class*='content']"))
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .filter((node) => node.scrollHeight - node.clientHeight > 180);
  if (!candidates.length) {
    return null;
  }
  candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return candidates[0] ?? null;
}

function pickChatGptConversationScroller(doc: Document): HTMLElement | null {
  const main = doc.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    return null;
  }

  const messageNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
  const ancestorCandidates = new Map<HTMLElement, number>();
  for (const messageNode of messageNodes) {
    let current: HTMLElement | null = messageNode instanceof HTMLElement ? messageNode : null;
    let depth = 0;
    while (current && current !== main && depth < 10) {
      const diff = current.scrollHeight - current.clientHeight;
      if (diff > 120) {
        const score = ancestorCandidates.get(current) || 0;
        ancestorCandidates.set(current, score + 1);
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  if (ancestorCandidates.size > 0) {
    const ranked = Array.from(ancestorCandidates.entries())
      .filter(([node]) => !node.closest("aside, nav, [role='navigation'], [role='complementary']"))
      .filter(([node]) => {
        const hint = `${node.className || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
        return !/sidebar|drawer|panel|file|asset/.test(hint);
      })
      .sort((a, b) => {
        const scoreDiff = b[1] - a[1];
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return (b[0].scrollHeight - b[0].clientHeight) - (a[0].scrollHeight - a[0].clientHeight);
      });
    if (ranked[0]?.[0]) {
      return ranked[0][0];
    }
  }

  const candidates = Array.from(
    main.querySelectorAll(
      [
        "[data-testid*='conversation']",
        "[data-testid*='thread']",
        "[class*='conversation']",
        "[class*='thread']",
        "[class*='message']",
        "[class*='overflow-y-auto']",
        "[data-message-author-role]"
      ].join(",")
    )
  )
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .filter((node) => node.scrollHeight - node.clientHeight > 120)
    .filter((node) => !node.closest("aside, nav, [role='navigation'], [role='complementary']"))
    .filter((node) => {
      const hint = `${node.className || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
      return !/sidebar|drawer|panel|file|asset/.test(hint);
    });

  if (!candidates.length) {
    return main.scrollHeight - main.clientHeight > 120 ? main : null;
  }

  candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  return candidates[0] ?? null;
}

interface WarmupConfig {
  downSteps: number;
  downWaitMs: number;
  upWaitMs: number;
}

async function warmupScrollableArea(doc: Document, config: WarmupConfig): Promise<void> {
  const scroller = pickScrollableElement(doc);
  if (!scroller) {
    const originY = window.scrollY;
    const maxY = Math.max(0, document.body.scrollHeight - window.innerHeight);
    if (maxY <= 24) {
      await sleep(180);
      return;
    }
    const steps = Math.max(4, Math.min(10, Math.ceil(maxY / 900)));
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      window.scrollTo(0, Math.round(maxY * ratio));
      await sleep(90);
    }
    for (let index = steps; index >= 0; index -= 1) {
      const ratio = index / steps;
      window.scrollTo(0, Math.round(maxY * ratio));
      await sleep(55);
    }
    window.scrollTo(0, originY);
    await sleep(120);
    return;
  }

  const originTop = scroller.scrollTop;
  const maxRounds = config.downSteps;
  let lastHeight = scroller.scrollHeight;

  for (let round = 0; round < maxRounds; round++) {
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll < 24) {
      break;
    }

    const steps = Math.min(5, Math.max(2, Math.ceil(maxScroll / 900)));
    for (let i = 1; i <= steps; i++) {
      scroller.scrollTop = Math.round(maxScroll * (i / steps));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(config.downWaitMs);
    }

    await sleep(config.downWaitMs * 2);

    const newHeight = scroller.scrollHeight;
    if (newHeight <= lastHeight) {
      break;
    }
    lastHeight = newHeight;
  }

  const scrollBackSteps = 5;
  const currentTop = scroller.scrollTop;
  for (let i = scrollBackSteps; i >= 0; i--) {
    scroller.scrollTop = Math.round(originTop + (currentTop - originTop) * (i / scrollBackSteps));
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(config.upWaitMs);
  }
  scroller.scrollTop = originTop;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(180);
}

function isVisibleElement(node: HTMLElement): boolean {
  if (!node.isConnected) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function collectChatGptFileTileButtons(doc: Document): HTMLButtonElement[] {
  const main = doc.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    return [];
  }

  const sourceRoots = Array.from(main.querySelectorAll("[data-message-author-role='user']"));
  const roots: ParentNode[] = sourceRoots.length > 0 ? sourceRoots : [main];
  const out: HTMLButtonElement[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const buttons = Array.from(root.querySelectorAll("button[aria-label], button[title]"));
    for (const button of buttons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      if (button.disabled || !isVisibleElement(button)) {
        continue;
      }
      if (button.closest("form, textarea, [contenteditable='true']")) {
        continue;
      }
      const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
      if (!looksLikeAttachmentFileNameLabel(label)) {
        continue;
      }
      const dedupeKey = `${label.toLowerCase()}::${Math.round(button.getBoundingClientRect().top)}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      out.push(button);
    }
  }

  return out.slice(0, 6);
}

function dismissTransientAttachmentLayer(doc: Document): void {
  const closeButton = doc.querySelector(
    [
      "button[aria-label='Close']",
      "button[aria-label='关闭']",
      "button[aria-label='关 闭']",
      "button[data-testid*='close']"
    ].join(",")
  );
  if (closeButton instanceof HTMLButtonElement && !closeButton.disabled) {
    closeButton.click();
  }

  const escapeDown = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  const escapeUp = new KeyboardEvent("keyup", { key: "Escape", bubbles: true });
  doc.dispatchEvent(escapeDown);
  doc.dispatchEvent(escapeUp);
}

async function primeChatGptFileTileRequests(doc: Document = document): Promise<void> {
  ensureRuntimeNetworkTracker();
  const buttons = collectChatGptFileTileButtons(doc);
  if (!buttons.length) {
    return;
  }

  for (const button of buttons) {
    try {
      button.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(60);
      button.click();
      await sleep(240);
      dismissTransientAttachmentLayer(doc);
      await sleep(120);
    } catch {
      // continue with next button
    }
  }
}

async function warmupChatGptLazyResources(doc: Document = document): Promise<void> {
  ensureRuntimeNetworkTracker();
  const scroller = pickChatGptConversationScroller(doc);
  if (!scroller) {
    await warmupScrollableArea(doc, {
      downSteps: 16,
      downWaitMs: 90,
      upWaitMs: 55
    });
    await primeChatGptFileTileRequests(doc);
    return;
  }

  const originTop = scroller.scrollTop;
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (maxScroll < 60) {
    await sleep(120);
    return;
  }

  const startAt = Math.min(originTop + Math.max(0, Math.round(scroller.clientHeight * 0.6)), maxScroll);
  const stepSize = Math.max(280, Math.round(scroller.clientHeight * 0.85));
  const maxSteps = Math.min(46, Math.max(8, Math.ceil(maxScroll / stepSize)));

  scroller.scrollTop = startAt;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(120);

  let previousTop = scroller.scrollTop;
  let stableRounds = 0;
  for (let index = 0; index < maxSteps; index += 1) {
    const target = Math.min(maxScroll, previousTop + stepSize);
    if (Math.abs(target - previousTop) < 8) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }
    scroller.scrollTop = target;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(130);
    const currentTop = scroller.scrollTop;
    if (Math.abs(currentTop - previousTop) < 6) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }
    previousTop = currentTop;
    if (maxScroll - currentTop <= 12 || stableRounds >= 3) {
      break;
    }
  }

  await sleep(180);
  const returnSteps = 7;
  const currentTop = scroller.scrollTop;
  for (let i = returnSteps; i >= 0; i -= 1) {
    scroller.scrollTop = Math.round(originTop + (currentTop - originTop) * (i / returnSteps));
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(65);
  }

  scroller.scrollTop = originTop;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(180);
  await primeChatGptFileTileRequests(doc);
}

export async function warmupAiStudioLazyResources(doc: Document = document): Promise<void> {
  await warmupScrollableArea(doc, {
    downSteps: 40,
    downWaitMs: 130,
    upWaitMs: 80
  });
}

export async function warmupSourceLazyResources(
  source: CaptureSource,
  doc: Document = document
): Promise<void> {
  ensureRuntimeNetworkTracker();
  if (source === "ai_studio") {
    await warmupAiStudioLazyResources(doc);
    return;
  }

  if (source === "chatgpt") {
    await warmupChatGptLazyResources(doc);
    return;
  }

  await warmupScrollableArea(doc, {
    downSteps: 40,
    downWaitMs: 95,
    upWaitMs: 55
  });
}

function isNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const lower = parsed.toString().toLowerCase();
    if (host.includes("oaiusercontent.com") && !isLikelyOaiAttachmentUrl(lower)) {
      return true;
    }
    if (
      /\/backend-api\/files\/|\/backend-api\/estuary\/content|\/api\/files\/|\/files\/|\/prompts\/|googleusercontent\.com\/gg\//i.test(lower) ||
      looksLikeFileUrl(lower) ||
      looksLikeImageUrl(lower) ||
      looksLikePdfUrl(lower)
    ) {
      return false;
    }
    return (
      host.includes("gemini.google.com") ||
      host.includes("bard.google.com") ||
      host.includes("chatgpt.com") ||
      host.includes("aistudio.google.com")
    );
  } catch {
    return false;
  }
}

function sanitizeGeminiTurn(turn: CaptureTurn): CaptureTurn | null {
  const base = stripGeminiUiPrefixes(turn.contentMarkdown);
  const stripped = turn.role === "assistant" ? stripGeminiBoilerplate(base) : base;
  let contentMarkdown = normalizeMarkdownText(stripped);
  const hasAttachments = Boolean(turn.attachments && turn.attachments.length > 0);
  if (!contentMarkdown && hasAttachments) {
    contentMarkdown = "（仅附件消息）";
  }
  if (!contentMarkdown || contentMarkdown.length < 2) {
    return null;
  }

  return {
    ...turn,
    contentMarkdown,
    thoughtMarkdown: null
  };
}

function toAbsoluteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed, location.href).toString();
  } catch {
    return "";
  }
}

function isUiAsset(url: string): boolean {
  return /avatar|icon|logo|sprite|favicon/i.test(url);
}

function extractAttachments(node: ParentNode): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const contextPostIds = collectLikelyPostIdsFromDocument(document);
  const contextConversationIds = collectLikelyConversationIdsFromDocument(document);
  const addFileIdCandidates = (
    raw: string,
    mimeHint: string | null = null,
    options: ExtractFileIdOptions = {}
  ) => {
    for (const fileId of extractFileIdsFromString(raw, options)) {
      for (const url of buildBackendFileUrlCandidates(fileId, contextPostIds, contextConversationIds)) {
        addAttachmentCandidate(found, url, mimeHint);
      }
    }
  };

  for (const img of Array.from(node.querySelectorAll("img[src]"))) {
    const src = toAbsoluteUrl(img.getAttribute("src") || "");
    if (!src || isUiAsset(src)) {
      continue;
    }
    if (/drive-thirdparty\.googleusercontent\.com\/\d+\/type\//i.test(src)) {
      continue;
    }
    if (!looksLikeImageUrl(src)) {
      continue;
    }
    if (!found.has(src)) {
      found.set(src, {
        kind: "image",
        originalUrl: src,
        mime: inferAttachmentMime("image", src),
        status: "remote_only"
      });
    }
  }

  for (const a of Array.from(node.querySelectorAll("a[href]"))) {
    const href = toAbsoluteUrl(a.getAttribute("href") || "");
    if (!href || /^javascript:/i.test(href)) {
      continue;
    }
    if (isNavigationUrl(href)) {
      continue;
    }
    const label = (a.textContent || "").trim();
    const kind = inferAttachmentKind(href, label);
    if (kind === "file" && !looksLikeFileUrl(href)) {
      continue;
    }

    if (!found.has(href)) {
      found.set(href, {
        kind,
        originalUrl: href,
        mime: inferAttachmentMime(kind, href),
        status: "remote_only"
      });
    }
  }

  const attachmentCandidates = Array.from(
    node.querySelectorAll(
      [
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[data-testid*='file']",
        "[aria-label*='attachment']",
        "[aria-label*='file']",
        "[aria-label*='文件']",
        "[role='group'][aria-label]",
        "[class*='attachment']",
        "[class*='uploaded']",
        "[class*='file-chip']"
      ].join(",")
    )
  );
  for (const candidate of attachmentCandidates) {
    const label = ((candidate as HTMLElement).innerText || candidate.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const urls = extractUrlsFromElement(candidate);
    for (const url of urls) {
      if (!url || /^javascript:/i.test(url) || isNavigationUrl(url)) {
        continue;
      }
      const kind = inferAttachmentKind(url, label);
      if (kind === "file" && !looksLikeFileUrl(url)) {
        continue;
      }
      if (!found.has(url)) {
        found.set(url, {
          kind,
          originalUrl: url,
          mime: inferAttachmentMime(kind, url),
          status: "remote_only"
        });
      }
    }

    for (const attrName of candidate.getAttributeNames()) {
      const raw = candidate.getAttribute(attrName) || "";
      if (!raw) {
        continue;
      }
      if (
        /file|asset|attachment|upload|document|id/i.test(attrName) ||
        /file-service:\/\//i.test(raw) ||
        /\/backend-api\/files\//i.test(raw) ||
        /\/backend-api\/estuary\/content/i.test(raw) ||
        looksLikeOpaqueFileId(raw)
      ) {
        const allowUuid = /\/backend-api\/estuary\/content|\/backend-api\/files\//i.test(raw);
        addFileIdCandidates(raw, null, { allowUuid });
      }
    }
    addFileIdCandidates(label, null);
  }

  const fileLabelNodes = Array.from(
    node.querySelectorAll(
      [
        "button[aria-label]",
        "button[title]",
        "[role='group'][aria-label]",
        "[data-default-action='true']"
      ].join(",")
    )
  );
  for (const fileLabelNode of fileLabelNodes) {
    const label = (
      fileLabelNode.getAttribute("aria-label") ||
      fileLabelNode.getAttribute("title") ||
      ((fileLabelNode as HTMLElement).innerText || fileLabelNode.textContent || "")
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!looksLikeAttachmentFileNameLabel(label)) {
      continue;
    }

    const scopes: Element[] = [];
    let current: Element | null = fileLabelNode;
    let depth = 0;
    while (current && depth < 4) {
      scopes.push(current);
      current = current.parentElement;
      depth += 1;
    }

    for (const scope of scopes) {
      const urls = extractUrlsFromElement(scope);
      for (const url of urls) {
        if (!url || /^javascript:/i.test(url) || isNavigationUrl(url)) {
          continue;
        }
        addAttachmentCandidate(found, url, null, label);
      }
      for (const attrName of scope.getAttributeNames()) {
        const raw = scope.getAttribute(attrName) || "";
        if (!raw) {
          continue;
        }
        if (
          /file|asset|attachment|upload|document|pointer|download|id/i.test(attrName) ||
          /file-service:\/\//i.test(raw) ||
          /\/backend-api\/files\//i.test(raw) ||
          /\/backend-api\/estuary\/content/i.test(raw) ||
          looksLikeOpaqueFileId(raw)
        ) {
          const allowUuid = /\/backend-api\/estuary\/content|\/backend-api\/files\//i.test(raw);
          addFileIdCandidates(raw, null, { allowUuid });
        }
      }
      const scopeText = ((scope as HTMLElement).innerText || scope.textContent || "").trim();
      if (scopeText && (looksLikeAttachmentFileNameLabel(scopeText) || /file[-_]|backend-api|estuary|download/i.test(scopeText))) {
        addFileIdCandidates(scopeText, null, { allowUuid: /backend-api|estuary/i.test(scopeText) });
      }
    }

    addFileIdCandidates(label, null);
  }

  const fileIdNodes = Array.from(
    node.querySelectorAll(
      [
        "[data-file-id]",
        "[data-asset-id]",
        "[data-attachment-id]",
        "[data-upload-id]",
        "[data-testid*='file']",
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[data-asset-pointer]"
      ].join(",")
    )
  );
  for (const fileNode of fileIdNodes) {
    for (const attrName of fileNode.getAttributeNames()) {
      const raw = fileNode.getAttribute(attrName) || "";
      if (!raw) {
        continue;
      }
      addFileIdCandidates(raw, null, { allowUuid: true });
    }
    const text = ((fileNode as HTMLElement).innerText || fileNode.textContent || "").trim();
    if (text) {
      addFileIdCandidates(text, null, { allowUuid: true });
    }
  }

  const reactPayloads = collectReactPayloadObjects(node);
  for (const payload of reactPayloads) {
    const derived = extractAttachmentsFromApiMessage(payload, 800);
    for (const attachment of derived) {
      addAttachmentCandidate(found, attachment.originalUrl, attachment.mime ?? null);
    }
  }

  return Array.from(found.values());
}

function trimTrailingPunctuationFromUrl(url: string): string {
  return url.replace(/[),.;!?]+$/g, "");
}

function extractAttachmentsFromMarkdownText(markdown: string): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const text = markdown.trim();
  if (!text) {
    return [];
  }

  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const alt = (match[1] || "").trim();
    const url = trimTrailingPunctuationFromUrl((match[2] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null, alt);
  }

  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const label = (match[1] || "").trim();
    const url = trimTrailingPunctuationFromUrl((match[2] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null, label);
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = trimTrailingPunctuationFromUrl((match[0] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null);
  }

  return Array.from(found.values());
}

function splitThoughts(raw: string): { contentMarkdown: string; thoughtMarkdown: string | null } {
  const text = normalizeMarkdownText(raw);
  if (!text) {
    return { contentMarkdown: "", thoughtMarkdown: null };
  }

  const lower = text.toLowerCase();
  const hasThoughtMarkers =
    lower.includes("model thoughts") ||
    lower.includes("expand to view model thoughts") ||
    lower.startsWith("thoughts\n");

  if (!hasThoughtMarkers) {
    return { contentMarkdown: text, thoughtMarkdown: null };
  }

  const lines = text.split("\n");
  const thoughtLines: string[] = [];
  const contentLines: string[] = [];

  let inThoughtSection = false;
  for (const line of lines) {
    const normalized = line.trim();
    const lowerLine = normalized.toLowerCase();
    if (
      lowerLine === "thoughts" ||
      lowerLine === "model thoughts" ||
      lowerLine === "expand to view model thoughts"
    ) {
      inThoughtSection = true;
      continue;
    }

    if (inThoughtSection && /^user[:：]?$/i.test(lowerLine)) {
      inThoughtSection = false;
      contentLines.push(line);
      continue;
    }

    if (inThoughtSection) {
      thoughtLines.push(line);
    } else {
      contentLines.push(line);
    }
  }

  const thoughtMarkdown = normalizeMarkdownText(thoughtLines.join("\n"));
  const contentMarkdown = normalizeMarkdownText(contentLines.join("\n"));
  if (!contentMarkdown && thoughtMarkdown) {
    // Avoid empty bubbles if only thought text is available.
    return { contentMarkdown: thoughtMarkdown, thoughtMarkdown: null };
  }
  return { contentMarkdown, thoughtMarkdown: thoughtMarkdown || null };
}

function extractNodeTextAndThought(node: Element): { contentMarkdown: string; thoughtMarkdown: string | null } {
  const cloned = node.cloneNode(true) as Element;
  const thoughtNodes = Array.from(
    cloned.querySelectorAll("[data-testid*='thought'], [class*='thought'], [aria-label*='thought']")
  );

  const extractedThoughts: string[] = [];
  for (const thoughtNode of thoughtNodes) {
    const text = normalizeMarkdownText(
      htmlToMarkdownish((thoughtNode as HTMLElement).innerHTML || thoughtNode.textContent || "")
    );
    if (text) {
      extractedThoughts.push(text);
    }
    thoughtNode.remove();
  }

  const richText = htmlToMarkdownish((cloned as HTMLElement).innerHTML || cloned.textContent || "");
  const plainText = (cloned as HTMLElement).innerText || cloned.textContent || "";
  const base = normalizeMarkdownText(richText || plainText);
  const split = splitThoughts(base);
  const thoughtMarkdown = normalizeMarkdownText([split.thoughtMarkdown || "", ...extractedThoughts].join("\n\n")) || null;
  return {
    contentMarkdown: split.contentMarkdown,
    thoughtMarkdown
  };
}

function leafNodes(root: ParentNode, selector: string): Element[] {
  const nodes = Array.from(root.querySelectorAll(selector));
  return nodes.filter((node) => !Array.from(node.children).some((child) => (child as Element).matches(selector)));
}

function roleFromAttrs(node: Element): CaptureTurn["role"] | null {
  const attrs = `${node.getAttribute("data-message-author-role") || ""} ${node.getAttribute("data-role") || ""} ${
    node.getAttribute("aria-label") || ""
  } ${node.getAttribute("data-testid") || ""} ${String((node as HTMLElement).className || "")}`.toLowerCase();

  if (/user|human|prompt|query/.test(attrs)) {
    return "user";
  }
  if (/assistant|model|ai|response|bot/.test(attrs)) {
    return "assistant";
  }
  if (/system/.test(attrs)) {
    return "system";
  }
  if (/tool|function/.test(attrs)) {
    return "tool";
  }

  return null;
}

function buildTurn(node: Element, fallbackRole: CaptureTurn["role"] | null = null): CaptureTurn | null {
  const role = fallbackRole ?? roleFromAttrs(node);
  if (!role) {
    return null;
  }

  const { contentMarkdown, thoughtMarkdown } = extractNodeTextAndThought(node);
  const directAttachments = extractAttachments(node);
  const textAttachments = extractAttachmentsFromMarkdownText(contentMarkdown);
  const attachments = mergeTurnAttachments(directAttachments, textAttachments) ?? [];
  let finalContent = contentMarkdown;
  if ((!finalContent || finalContent.length < 2) && attachments.length > 0) {
    finalContent = "（仅附件消息）";
  }

  if (!finalContent || finalContent.length < 2) {
    return null;
  }

  return {
    role,
    contentMarkdown: finalContent,
    thoughtMarkdown,
    attachments: attachments.length > 0 ? attachments : null
  };
}

function dedupeTurns(turns: CaptureTurn[]): CaptureTurn[] {
  const indexByKey = new Map<string, number>();
  const out: CaptureTurn[] = [];

  for (const turn of turns) {
    const cleaned = normalizeMarkdownText(turn.contentMarkdown);
    if (!cleaned) {
      continue;
    }

    const key = `${turn.role}:${normalizeForDedupe(cleaned)}`;
    const existingIndex = indexByKey.get(key);
    if (typeof existingIndex === "number") {
      const previous = out[existingIndex];
      if (!previous) {
        continue;
      }
      out[existingIndex] = {
        ...previous,
        contentMarkdown: previous.contentMarkdown || cleaned,
        thoughtMarkdown: previous.thoughtMarkdown || turn.thoughtMarkdown || null,
        model: previous.model || turn.model || null,
        timestamp: previous.timestamp || turn.timestamp || null,
        attachments: mergeTurnAttachments(previous.attachments, turn.attachments)
      };
      continue;
    }
    indexByKey.set(key, out.length);
    out.push({
      ...turn,
      contentMarkdown: cleaned
    });
  }

  return out;
}

function parseByRoleMarkers(text: string): CaptureTurn[] {
  const normalized = normalizeMarkdownText(text);
  if (!normalized) {
    return [];
  }

  const rolePattern = /(?:^|\n)(User|You|Assistant|Model|用户|我|AI)\s*[:：]?\s*(?=\n|$)/gi;
  const matches = Array.from(normalized.matchAll(rolePattern));
  if (matches.length < 2) {
    return [];
  }

  const turns: CaptureTurn[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]!;
    const start = (current.index || 0) + current[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index || normalized.length : normalized.length;

    const roleName = current[1].toLowerCase();
    const role: CaptureTurn["role"] = roleName === "assistant" || roleName === "model" || roleName === "ai" ? "assistant" : "user";
    const contentMarkdown = normalizeMarkdownText(normalized.slice(start, end));
    if (!contentMarkdown || contentMarkdown.length < 2) {
      continue;
    }
    turns.push({ role, contentMarkdown });
  }

  return turns;
}

function canonicalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (
      parsed.hostname.includes("chatgpt.com") ||
      parsed.hostname.includes("gemini.google.com") ||
      parsed.hostname.includes("bard.google.com") ||
      parsed.hostname.includes("aistudio.google.com")
    ) {
      parsed.search = "";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function titleFromTurns(turns: CaptureTurn[]): string {
  const user = turns.find((turn) => turn.role === "user");
  if (!user) {
    return "Untitled Conversation";
  }
  return user.contentMarkdown.replace(/\s+/g, " ").slice(0, 60);
}

function normalizeTitle(raw: string, fallback: string): string {
  const cleaned = normalizeMarkdownText(
    raw
      .replace(/\s*\|\s*Google AI Studio$/i, "")
      .replace(/\s*-\s*Gemini$/i, "")
      .replace(/\s*-\s*ChatGPT$/i, "")
      .trim()
  );
  if (!cleaned || /^(google gemini|gemini|chatgpt|google ai studio)$/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function deriveTitle(source: CaptureSource, doc: Document, turns: CaptureTurn[]): string {
  const fallback = titleFromTurns(turns);
  const root = (doc.querySelector("main") as HTMLElement | null) || doc.body;

  if (source === "gemini") {
    const heading =
      root.querySelector("h1, h2, [data-test-id='conversation-title'], [aria-label*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  if (source === "ai_studio") {
    const heading =
      root.querySelector("h1, h2, [data-testid='prompt-title'], [aria-label*='title'], [class*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  return normalizeTitle(doc.title || "", fallback);
}

export function extractChatGptTurns(doc: Document = document): CaptureTurn[] {
  const main = doc.querySelector("main") || doc.body;
  const primaryNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
  const primaryTurns = primaryNodes
    .map((node) => {
      const role = (node.getAttribute("data-message-author-role") || "assistant") as CaptureTurn["role"];
      return buildTurn(node, role);
    })
    .filter((v): v is CaptureTurn => Boolean(v));
  if (primaryTurns.length > 0) {
    return dedupeTurns(primaryTurns);
  }

  const fallbackNodes = Array.from(
    main.querySelectorAll(
      [
        "article",
        "[data-testid*='conversation-turn']",
        "[data-testid*='message']",
        "[class*='conversation-turn']",
        "[class*='message']"
      ].join(",")
    )
  );
  const fallbackTurns = fallbackNodes
    .map((node) => buildTurn(node, roleFromAttrs(node)))
    .filter((v): v is CaptureTurn => Boolean(v));
  if (fallbackTurns.length > 0) {
    return dedupeTurns(fallbackTurns);
  }

  const markerTurns = parseByRoleMarkers((main as HTMLElement).innerText || "");
  if (markerTurns.length > 0) {
    return dedupeTurns(markerTurns);
  }

  const plainText = normalizeMarkdownText((main as HTMLElement).innerText || "");
  if (plainText.length >= 20) {
    return dedupeTurns([
      {
        role: "assistant",
        contentMarkdown: plainText
      }
    ]);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseChatGptConversationId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/c\/([a-z0-9-]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function collectChatGptConversationApiUrls(_conversationId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const absolute = toAbsoluteUrl(raw) || raw;
    if (!absolute || seen.has(absolute)) {
      return;
    }
    try {
      const parsed = new URL(absolute, location.href);
      const lower = parsed.toString().toLowerCase();
      if (!/\/backend-api\/conversation(s)?\//i.test(lower)) {
        return;
      }
      seen.add(parsed.toString());
      out.push(parsed.toString());
    } catch {
      // ignore invalid urls
    }
  };

  const windowStart = activeCaptureWindowStartMs();
  const tracked = getTrackedNetworkRecords(windowStart);
  for (const item of tracked.slice(-1200)) {
    if (item.method !== "GET" && item.method !== "POST") {
      continue;
    }
    if (!item.ok && item.status > 0) {
      continue;
    }
    add(item.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1200)) {
      if (windowStart > 0 && entry.startTime + 5 < windowStart) {
        continue;
      }
      const name = String(entry.name || "").trim();
      if (!name) {
        continue;
      }
      add(name);
    }
  } catch {
    // ignore
  }

  const result = out.slice(0, 20);
  if (result.length > 0) {
    console.info("[AI_HISTORY] discovered chatgpt conversation api urls", result.slice(0, 6));
  }
  return result;
}

function extractChatGptResourceAttachments(doc: Document = document): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const postIds = collectLikelyPostIdsFromDocument(doc);
  const conversationIds = collectLikelyConversationIdsFromDocument(doc);
  const windowStart = activeCaptureWindowStartMs();
  const trackAndAdd = (rawUrl: string) => {
    const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
    if (!absolute) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(absolute, location.href);
    } catch {
      return;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("chatgpt.com") && !host.includes("oaiusercontent.com")) {
      return;
    }

    const lower = parsed.toString().toLowerCase();
    if (isUiAsset(lower)) {
      return;
    }

    const isAttachmentSignal =
      lower.includes("/backend-api/estuary/content") ||
      lower.includes("/backend-api/files/") ||
      (host.includes("oaiusercontent.com") && isLikelyOaiAttachmentUrl(lower));

    if (!isAttachmentSignal) {
      return;
    }

    addAttachmentCandidate(found, parsed.toString(), null);

    const estuaryFileId = extractEstuaryFileIdFromUrl(parsed.toString());
    if (estuaryFileId) {
      for (const candidate of buildBackendFileUrlCandidates(estuaryFileId, postIds, conversationIds)) {
        addAttachmentCandidate(found, candidate, null);
      }
    }
  };

  const tracked = getTrackedNetworkRecords(windowStart);
  for (const item of tracked.slice(-1400)) {
    if (item.method !== "GET" && item.method !== "POST") {
      continue;
    }
    if (!item.ok && item.status > 0) {
      continue;
    }
    trackAndAdd(item.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1400)) {
      if (windowStart > 0 && entry.startTime + 5 < windowStart) {
        continue;
      }
      const name = String(entry.name || "").trim();
      if (!name) {
        continue;
      }
      trackAndAdd(name);
    }
  } catch {
    // ignore
  }

  return Array.from(found.values());
}

function attachmentMatchesInlineFileNames(attachment: CaptureAttachment, fileNames: string[]): boolean {
  if (!fileNames.length) {
    return false;
  }
  const attachmentName = attachmentDisplayName(attachment).trim().toLowerCase();
  const attachmentMime = (attachment.mime || "").toLowerCase();
  const attachmentExt = extractExtFromFileName(attachment.originalUrl);
  for (const name of fileNames) {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName && attachmentName && normalizedName === attachmentName) {
      return true;
    }
    const ext = extractExtFromFileName(name);
    if (!ext) {
      continue;
    }
    if (
      ext === "pdf" &&
      (attachment.kind === "pdf" || attachmentMime.includes("application/pdf") || attachmentExt === "pdf")
    ) {
      return true;
    }
    if (
      isImageExtension(ext) &&
      (attachment.kind === "image" || attachmentMime.startsWith("image/") || isImageExtension(attachmentExt))
    ) {
      return true;
    }
    if (!isImageExtension(ext) && ext !== "pdf" && attachment.kind === "file") {
      return true;
    }
    if (attachmentExt && attachmentExt === ext) {
      return true;
    }
  }
  return false;
}

function applyChatGptResourceAttachmentFallback(
  turns: CaptureTurn[],
  doc: Document = document
): CaptureTurn[] {
  if (!turns.length) {
    return turns;
  }

  const resourceAttachments = extractChatGptResourceAttachments(doc);
  if (!resourceAttachments.length) {
    return turns;
  }

  const existing = new Set<string>();
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) {
      existing.add(attachment.originalUrl.trim());
    }
  }

  const pool = resourceAttachments.filter((attachment) => {
    const key = attachment.originalUrl.trim();
    return Boolean(key) && !existing.has(key);
  });
  if (!pool.length) {
    return turns;
  }
  const uniquePool = mergeTurnAttachments([], pool) ?? [];
  if (!uniquePool.length) {
    return turns;
  }

  const preferredTargets = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user" || turn.role === "assistant")
    .filter(({ turn }) => {
      const hasVirtual = (turn.attachments ?? []).some((attachment) =>
        isVirtualAttachmentUrl(attachment.originalUrl)
      );
      const hasFileNameHint = findLikelyInlineFileNames(turn.contentMarkdown || "").length > 0;
      return hasVirtual || hasFileNameHint;
    })
    .map(({ index }) => index);

  const fallbackTargets = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user" || turn.role === "assistant")
    .map(({ index }) => index);

  const out = turns.map((turn) => ({
    ...turn,
    attachments: mergeTurnAttachments([], turn.attachments ?? [])
  }));

  let remaining = uniquePool.slice();
  for (const targetIndex of preferredTargets) {
    if (!remaining.length) {
      break;
    }
    const target = out[targetIndex];
    if (!target) {
      continue;
    }
    const names = findLikelyInlineFileNames(target.contentMarkdown || "");
    const matched = names.length > 0
      ? remaining.filter((attachment) => attachmentMatchesInlineFileNames(attachment, names))
      : remaining.slice();
    if (!matched.length) {
      continue;
    }
    const consumed = new Set(matched.map((item) => item.originalUrl));
    remaining = remaining.filter((item) => !consumed.has(item.originalUrl));
    target.attachments = mergeTurnAttachments(target.attachments, matched);
  }

  if (remaining.length > 0) {
    const fallbackIndex = preferredTargets[0] ??
      (fallbackTargets.length > 0 ? fallbackTargets[fallbackTargets.length - 1]! : Math.max(0, turns.length - 1));
    const fallbackTarget = out[fallbackIndex];
    if (fallbackTarget) {
      fallbackTarget.attachments = mergeTurnAttachments(fallbackTarget.attachments, remaining);
    }
  }

  console.info("[AI_HISTORY] chatgpt resource attachment fallback merged", {
    added: uniquePool.length,
    remaining: remaining.length,
    sample: uniquePool.slice(0, 6).map((item) => item.originalUrl.slice(0, 220))
  });

  return out;
}

function roleFromApiValue(raw: unknown): CaptureTurn["role"] | null {
  if (typeof raw !== "string") {
    return null;
  }
  const lower = raw.toLowerCase();
  if (lower.includes("assistant") || lower.includes("model") || lower === "ai") {
    return "assistant";
  }
  if (lower.includes("user") || lower.includes("human")) {
    return "user";
  }
  if (lower.includes("system")) {
    return "system";
  }
  if (lower.includes("tool") || lower.includes("function")) {
    return "tool";
  }
  return null;
}

function extractApiMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (isRecord(content)) {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      const joined = parts
        .map((part) => (typeof part === "string" ? part : ""))
        .filter(Boolean)
        .join("\n");
      if (joined.trim()) {
        return joined;
      }
    }
    if (typeof content.text === "string" && content.text.trim()) {
      return content.text;
    }
  }

  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  return "";
}

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeLikelyPostId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^file[-_]/i.test(trimmed)) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^msg_[a-z0-9_-]{6,}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9][a-z0-9_-]{16,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return trimmed;
  }
  return null;
}

function normalizeLikelyConversationId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9][a-z0-9_-]{20,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return trimmed;
  }
  return null;
}

function extractLikelyPostIdsFromString(raw: string): string[] {
  const out = new Set<string>();
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const add = (value: string) => {
    const normalized = normalizeLikelyPostId(safeDecodeURIComponent(value));
    if (normalized) {
      out.add(normalized);
    }
  };

  try {
    const absolute = toAbsoluteUrl(text);
    if (absolute) {
      const parsed = new URL(absolute);
      const postId = parsed.searchParams.get("post_id") || parsed.searchParams.get("postId");
      if (postId) {
        add(postId);
      }
      const messageId = parsed.searchParams.get("message_id") || parsed.searchParams.get("messageId");
      if (messageId) {
        add(messageId);
      }
    }
  } catch {
    // ignore
  }

  for (const match of text.matchAll(/(?:post[_-]?id|message[_-]?id)\s*[:=/"'\s]+([a-z0-9_-]{6,}|[0-9a-f-]{36})/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }
  for (const match of text.matchAll(/\b(msg_[a-z0-9_-]{6,})\b/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  return Array.from(out);
}

function extractLikelyConversationIdsFromString(raw: string): string[] {
  const out = new Set<string>();
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const add = (value: string) => {
    const normalized = normalizeLikelyConversationId(safeDecodeURIComponent(value));
    if (normalized) {
      out.add(normalized);
    }
  };

  const fromPath = parseChatGptConversationId(text);
  if (fromPath) {
    add(fromPath);
  }

  try {
    const absolute = toAbsoluteUrl(text);
    if (absolute) {
      const parsed = new URL(absolute);
      const direct = parsed.searchParams.get("conversation_id") || parsed.searchParams.get("conversationId");
      if (direct) {
        add(direct);
      }
      const scoped =
        parsed.searchParams.get("ck_context_scopes_for_conversation_id") ||
        parsed.searchParams.get("context_conversation_id");
      if (scoped) {
        add(scoped);
      }
    }
  } catch {
    // ignore
  }

  for (const match of text.matchAll(
    /(?:conversation[_-]?id|ck_context_scopes_for_conversation_id)\s*[:=/"'\s]+([a-z0-9_-]{20,}|[0-9a-f-]{36})/gi
  )) {
    if (match[1]) {
      add(match[1]);
    }
  }

  return Array.from(out);
}

let cachedLikelyPostIdsByPage: { page: string; ids: string[]; trackerSize: number } | null = null;
let cachedLikelyConversationIdsByPage: { page: string; ids: string[]; trackerSize: number } | null = null;

function collectLikelyPostIdsFromDocument(doc: Document = document): string[] {
  const page = canonicalizePageUrl(doc.location.href);
  const trackerSize = getTrackedNetworkRecords(0).length;
  if (
    cachedLikelyPostIdsByPage &&
    cachedLikelyPostIdsByPage.page === page &&
    cachedLikelyPostIdsByPage.trackerSize === trackerSize
  ) {
    return cachedLikelyPostIdsByPage.ids;
  }

  const out = new Set<string>();
  const addFromRaw = (raw: string) => {
    for (const id of extractLikelyPostIdsFromString(raw)) {
      out.add(id);
    }
  };

  addFromRaw(doc.location.href);

  const nodes = Array.from(
    doc.querySelectorAll(
      [
        "[data-post-id]",
        "[data-message-id]",
        "[data-id]",
        "[id]",
        "[data-testid*='attachment']",
        "[data-testid*='file']",
        "[data-testid*='upload']"
      ].join(",")
    )
  ).slice(0, 240);

  for (const node of nodes) {
    for (const attr of node.getAttributeNames()) {
      const value = node.getAttribute(attr) || "";
      if (!value) {
        continue;
      }
      if (/post|message|attachment|upload|file|id/i.test(attr)) {
        addFromRaw(value);
      }
    }
    const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
    if (text && /post|message|attachment|upload|file|id|msg_/i.test(text)) {
      addFromRaw(text);
    }
  }

  const scripts = Array.from(doc.querySelectorAll("script")).slice(-120);
  for (const script of scripts) {
    const text = (script.textContent || "").replace(/\\\//g, "/");
    if (!text || !/post_id|postId|message_id|messageId|msg_|backend-api\/files\//i.test(text)) {
      continue;
    }
    addFromRaw(text);
  }

  const tracked = getTrackedNetworkRecords(0);
  for (const record of tracked.slice(-800)) {
    const url = (record.url || "").trim();
    if (!url || !/post_id|postId|message_id|messageId|msg_|backend-api\/files\//i.test(url)) {
      continue;
    }
    addFromRaw(url);
  }

  const ids = Array.from(out).slice(0, 8);
  cachedLikelyPostIdsByPage = { page, ids, trackerSize };
  return ids;
}

function collectLikelyConversationIdsFromDocument(doc: Document = document): string[] {
  const page = canonicalizePageUrl(doc.location.href);
  const trackerSize = getTrackedNetworkRecords(0).length;
  if (
    cachedLikelyConversationIdsByPage &&
    cachedLikelyConversationIdsByPage.page === page &&
    cachedLikelyConversationIdsByPage.trackerSize === trackerSize
  ) {
    return cachedLikelyConversationIdsByPage.ids;
  }

  const out = new Set<string>();
  const addFromRaw = (raw: string) => {
    for (const id of extractLikelyConversationIdsFromString(raw)) {
      out.add(id);
    }
  };

  addFromRaw(doc.location.href);

  const fromCurrentPath = parseChatGptConversationId(doc.location.href);
  if (fromCurrentPath) {
    out.add(fromCurrentPath);
  }

  const nodes = Array.from(
    doc.querySelectorAll(
      [
        "[data-conversation-id]",
        "[data-conversationid]",
        "[data-testid*='conversation']",
        "[data-testid*='attachment']",
        "[data-testid*='file']"
      ].join(",")
    )
  ).slice(0, 220);

  for (const node of nodes) {
    for (const attr of node.getAttributeNames()) {
      const value = node.getAttribute(attr) || "";
      if (!value) {
        continue;
      }
      if (/conversation|context|scope|id/i.test(attr)) {
        addFromRaw(value);
      }
    }
    const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
    if (text && /conversation|context|scope|id|\/c\//i.test(text)) {
      addFromRaw(text);
    }
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-260)) {
      const name = String(entry.name || "").trim();
      if (!name || !/conversation|ck_context_scopes_for_conversation_id|\/c\//i.test(name)) {
        continue;
      }
      addFromRaw(name);
    }
  } catch {
    // ignore
  }

  const tracked = getTrackedNetworkRecords(0);
  for (const record of tracked.slice(-800)) {
    const url = (record.url || "").trim();
    if (!url || !/conversation|ck_context_scopes_for_conversation_id|\/c\//i.test(url)) {
      continue;
    }
    addFromRaw(url);
  }

  const ids = Array.from(out).slice(0, 6);
  cachedLikelyConversationIdsByPage = { page, ids, trackerSize };
  return ids;
}

function looksLikeOpaqueFileId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 8 || trimmed.length > 128) {
    return false;
  }
  if (UUID_LIKE_REGEX.test(trimmed)) {
    return false;
  }
  if (/^msg_[a-z0-9_-]{6,}$/i.test(trimmed)) {
    return false;
  }
  if (/^file[-_][a-z0-9-]{6,}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-f0-9]{24,64}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-z0-9][a-z0-9_-]{12,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return true;
  }
  return false;
}

interface ExtractFileIdOptions {
  allowUuid?: boolean;
}

function extractFileIdsFromString(raw: string, options: ExtractFileIdOptions = {}): string[] {
  const out = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const allowUuid = options.allowUuid === true;

  const add = (value: string) => {
    const decoded = safeDecodeURIComponent(value.trim());
    if (!decoded) {
      return;
    }
    if (!looksLikeOpaqueFileId(decoded) && !(allowUuid && UUID_LIKE_REGEX.test(decoded))) {
      return;
    }
    out.add(decoded);
  };

  const filePrefixMatches = trimmed.match(/\bfile[-_][a-z0-9-]{6,}\b/gi) || [];
  for (const match of filePrefixMatches) {
    add(match);
  }

  for (const match of trimmed.matchAll(/file-service:\/\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/\/backend-api\/files\/download\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/\/backend-api\/files\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/[?&](?:id|file_id|fileId)=([^&#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  if (looksLikeOpaqueFileId(trimmed) || (allowUuid && UUID_LIKE_REGEX.test(trimmed))) {
    add(trimmed);
  }

  return Array.from(out);
}

function maybeFileIdFromString(raw: string, options: ExtractFileIdOptions = {}): string | null {
  return extractFileIdsFromString(raw, options)[0] ?? null;
}

function buildBackendFileUrlCandidates(
  fileId: string,
  postIds: string[] = [],
  conversationIds: string[] = []
): string[] {
  const normalized = fileId.trim();
  if (!normalized) {
    return [];
  }
  const encoded = encodeURIComponent(normalized);
  const normalizedPostId = postIds
    .map((raw) => normalizeLikelyPostId(raw) || "")
    .find(Boolean);
  const normalizedConversationId = conversationIds
    .map((raw) => normalizeLikelyConversationId(raw) || "")
    .find(Boolean);
  const rawCandidates = [
    `/backend-api/estuary/content?id=${encoded}`,
    `/backend-api/files/download/${encoded}`,
    `/backend-api/files/${encoded}/download`,
    `/backend-api/files/${encoded}`,
    `/backend-api/files/${encoded}/content`
  ];
  if (normalizedPostId) {
    const encodedPostId = encodeURIComponent(normalizedPostId);
    rawCandidates.push(`/backend-api/files/download/${encoded}?post_id=${encodedPostId}`);
  }
  if (normalizedConversationId) {
    const encodedConversationId = encodeURIComponent(normalizedConversationId);
    rawCandidates.push(
      `/backend-api/files/download/${encoded}?conversation_id=${encodedConversationId}`,
      `/backend-api/files/download/${encoded}?ck_context_scopes_for_conversation_id=${encodedConversationId}`
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const absolute = toAbsoluteUrl(candidate);
    if (!absolute || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

function isLikelyAttachmentUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("data:") ||
    lower.startsWith("/backend-api/files/") ||
    lower.includes("/backend-api/files/") ||
    lower.startsWith("/backend-api/estuary/content") ||
    lower.includes("/backend-api/estuary/content")
  );
}

function addAttachmentCandidate(
  found: Map<string, CaptureAttachment>,
  rawUrl: string,
  mimeHint: string | null,
  labelHint = ""
): void {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  if (!absolute || isNavigationUrl(absolute)) {
    return;
  }
  const lowerAbsolute = absolute.toLowerCase();
  if (lowerAbsolute.includes("/backend-api/estuary/content")) {
    const estuaryId = extractEstuaryFileIdFromUrl(absolute);
    if (!estuaryId) {
      return;
    }
  }
  if (lowerAbsolute.includes("/backend-api/files/")) {
    const backendId = extractBackendFileIdFromUrl(absolute);
    if (!backendId) {
      return;
    }
  }
  const kindFromMime = inferKindFromMimeHint(mimeHint);
  const kind = kindFromMime || inferAttachmentKind(absolute, labelHint);
  const isBackendFile =
    lowerAbsolute.includes("/backend-api/files/") ||
    lowerAbsolute.includes("/backend-api/estuary/content");
  if (isBackendFile && /\/simple(?:[/?]|$)/i.test(absolute)) {
    return;
  }
  if (
    kind === "file" &&
    !looksLikeFileUrl(absolute) &&
    !absolute.startsWith("blob:") &&
    !absolute.startsWith("data:") &&
    !isBackendFile
  ) {
    return;
  }
  if (found.has(absolute)) {
    return;
  }
  found.set(absolute, {
    kind,
    originalUrl: absolute,
    mime: mimeHint || inferAttachmentMime(kind, absolute),
    status: "remote_only"
  });
}

function extractAttachmentsFromApiMessage(
  message: Record<string, unknown>,
  maxVisitedObjects = 2200
): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const stack: unknown[] = [message];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push(item);
      }
      continue;
    }
    if (!isRecord(node)) {
      continue;
    }
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);
    if (visited.size > maxVisitedObjects) {
      break;
    }
    const nodeKeys = Object.keys(node).join(" ").toLowerCase();
    const nodeLooksLikeAttachmentRecord = /(file|asset|attachment|upload|document|mime|filename|download|pointer|blob|content_type|contenttype)/i.test(
      nodeKeys
    );

    let localMime: string | null = null;
    const localFileIds = new Set<string>();
    const localPostIds = new Set<string>();
    const localConversationIds = new Set<string>();
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          continue;
        }

        if (/mime|content[_-]?type/i.test(key) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+/i.test(trimmed)) {
          localMime = trimmed.split(";")[0]?.trim().toLowerCase() ?? null;
        }

        if (/post[_-]?id|message[_-]?id|node[_-]?id|turn[_-]?id|id/i.test(key)) {
          for (const postId of extractLikelyPostIdsFromString(trimmed)) {
            localPostIds.add(postId);
          }
        }
        if (/conversation|context|scope/i.test(key)) {
          for (const conversationId of extractLikelyConversationIdsFromString(trimmed)) {
            localConversationIds.add(conversationId);
          }
        }

        if (isLikelyAttachmentUrl(trimmed)) {
          addAttachmentCandidate(found, trimmed, localMime);
        }

        const keySuggestsFile =
          /(^|_)(file|asset|attachment|upload|document|pointer|blob)(_|$)/i.test(key) ||
          /(file|asset|attachment|upload|document)[_-]?id$/i.test(key);
        const allowUuid = keySuggestsFile || (nodeLooksLikeAttachmentRecord && /(^id$|[_-]id$)/i.test(key));
        const ids = extractFileIdsFromString(trimmed, { allowUuid });
        if (ids.length > 0 && (keySuggestsFile || allowUuid || looksLikeOpaqueFileId(trimmed) || /file-service:\/\//i.test(trimmed))) {
          for (const id of ids) {
            localFileIds.add(id);
          }
        } else {
          const inlineId = maybeFileIdFromString(trimmed, { allowUuid });
          if (inlineId) {
            localFileIds.add(inlineId);
          }
        }
      } else {
        stack.push(value);
      }
    }

    for (const fileId of localFileIds) {
      for (const candidate of buildBackendFileUrlCandidates(
        fileId,
        Array.from(localPostIds),
        Array.from(localConversationIds)
      )) {
        addAttachmentCandidate(found, candidate, localMime);
      }
    }
  }

  return Array.from(found.values());
}

function pushIfRecordUnique(
  value: unknown,
  out: Record<string, unknown>[],
  seen: Set<object>
): void {
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);
  out.push(value);
}

function ownPropertyNamesSafe(value: object): string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function collectReactPayloadObjects(root: ParentNode): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<object>();

  const nodes: Element[] = [];
  if (root instanceof Element) {
    nodes.push(root);
  }
  const selectorNodes = Array.from(
    root.querySelectorAll(
      [
        "[data-testid*='file']",
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[class*='attachment']",
        "[class*='file']",
        "[aria-label*='attachment']",
        "[aria-label*='file']",
        "a",
        "button"
      ].join(",")
    )
  ).slice(0, 120);
  nodes.push(...selectorNodes);

  for (const node of nodes) {
    let current: Element | null = node;
    let depth = 0;
    while (current && depth < 4) {
      const names = ownPropertyNamesSafe(current as unknown as object);
      for (const key of names) {
        if (key.startsWith("__reactProps$")) {
          const value = (current as unknown as Record<string, unknown>)[key];
          pushIfRecordUnique(value, out, seen);
          continue;
        }
        if (key.startsWith("__reactFiber$")) {
          const fiber = (current as unknown as Record<string, unknown>)[key];
          if (!isRecord(fiber)) {
            continue;
          }
          pushIfRecordUnique(fiber.memoizedProps, out, seen);
          pushIfRecordUnique(fiber.pendingProps, out, seen);
          if (isRecord(fiber.return)) {
            pushIfRecordUnique(fiber.return.memoizedProps, out, seen);
            pushIfRecordUnique(fiber.return.pendingProps, out, seen);
          }
          if (isRecord(fiber.alternate)) {
            pushIfRecordUnique(fiber.alternate.memoizedProps, out, seen);
            pushIfRecordUnique(fiber.alternate.pendingProps, out, seen);
          }
        }
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  return out;
}

function mergeTurnAttachments(
  existing: CaptureAttachment[] | null | undefined,
  incoming: CaptureAttachment[] | null | undefined
): CaptureAttachment[] | null {
  const all = [...(existing ?? []), ...(incoming ?? [])];
  if (!all.length) {
    return null;
  }
  const deduped = new Map<string, CaptureAttachment>();
  const semanticKey = (attachment: CaptureAttachment): string => {
    const raw = attachment.originalUrl.trim();
    if (!raw) {
      return "";
    }
    const backendFileId = extractBackendFileIdFromUrl(raw) || extractEstuaryFileIdFromUrl(raw);
    if (backendFileId) {
      return `fileid:${backendFileId.toLowerCase()}`;
    }
    if (isDataUrl(raw)) {
      return `${attachment.kind}:data:${raw.slice(0, 128)}`;
    }
    return `${attachment.kind}:url:${raw}`;
  };
  for (const item of all) {
    const urlKey = item.originalUrl.trim();
    if (!urlKey) {
      continue;
    }
    const normalizedSemantic = semanticKey(item);
    const key = normalizedSemantic || `url:${urlKey}`;
    if (deduped.has(key)) {
      const previous = deduped.get(key)!;
      const previousKindScore = previous.kind === "file" ? 0 : 1;
      const currentKindScore = item.kind === "file" ? 0 : 1;
      if (currentKindScore > previousKindScore) {
        deduped.set(key, item);
        continue;
      }
      if (!previous.mime && item.mime) {
        deduped.set(key, { ...previous, mime: item.mime });
      }
      continue;
    }
    deduped.set(key, item);
  }
  return deduped.size > 0 ? Array.from(deduped.values()) : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件内容失败"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("文件读取结果不是字符串"));
    };
    reader.readAsDataURL(blob);
  });
}

function shouldInlineProtectedAttachment(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.startsWith("blob:") ||
    lower.includes("/backend-api/files/") ||
    lower.includes("/backend-api/estuary/content") ||
    lower.includes("googleusercontent.com/gg/") ||
    isLikelyOaiAttachmentUrl(lower) ||
    lower.includes("/prompts/")
  );
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

interface BackgroundAttachmentFetchResponse {
  ok?: boolean;
  dataUrl?: string;
  error?: string;
  status?: number;
  tried?: string[];
}

interface BackgroundAttachmentProbeResponse {
  ok?: boolean;
  url?: string;
  method?: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
  error?: string;
}

async function fetchDataUrlViaBackground(url: string): Promise<BackgroundAttachmentFetchResponse | null> {
  if (!isHttpUrl(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_FETCH_ATTACHMENT",
      url
    })) as BackgroundAttachmentFetchResponse;
    if (result?.ok && typeof result.dataUrl === "string" && result.dataUrl.startsWith("data:")) {
      return result;
    }
    if (
      url.toLowerCase().includes("/backend-api/files/") ||
      url.toLowerCase().includes("/backend-api/estuary/content")
    ) {
      console.info("[AI_HISTORY] background attachment fetch failed", {
        url: url.slice(0, 220),
        status: result?.status ?? 0,
        error: result?.error ?? "",
        tried: (result?.tried ?? []).slice(0, 6)
      });
    }
    return result ?? null;
  } catch {
    return null;
  }
}

async function probeAttachmentUrlViaBackground(url: string): Promise<BackgroundAttachmentProbeResponse | null> {
  if (!isHttpUrl(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_PROBE_ATTACHMENT",
      url
    })) as BackgroundAttachmentProbeResponse;
    return result ?? null;
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function extractBackendFileIdFromUrl(rawUrl: string): string | null {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  const downloadMatch = absolute.match(/\/backend-api\/files\/download\/([^/?#]+)/i);
  if (downloadMatch?.[1]) {
    return safeDecodeURIComponent(downloadMatch[1]);
  }
  const directMatch = absolute.match(/\/backend-api\/files\/([^/?#]+)/i);
  if (directMatch?.[1]) {
    const candidate = safeDecodeURIComponent(directMatch[1]);
    if (candidate.toLowerCase() === "download") {
      return null;
    }
    return candidate;
  }
  return null;
}

function extractEstuaryFileIdFromUrl(rawUrl: string): string | null {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  try {
    const parsed = new URL(absolute, location.href);
    if (!/\/backend-api\/estuary\/content/i.test(parsed.pathname)) {
      return null;
    }
    const candidates = [
      parsed.searchParams.get("id") || "",
      parsed.searchParams.get("file_id") || "",
      parsed.searchParams.get("fileId") || ""
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalized = maybeFileIdFromString(candidate, { allowUuid: true });
      if (normalized) {
        return normalized;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildInlineFetchCandidates(rawUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const absolute = toAbsoluteUrl(candidate) || candidate;
    if (!absolute || seen.has(absolute)) {
      return;
    }
    seen.add(absolute);
    out.push(absolute);
  };

  add(rawUrl);

  const backendFileId = extractBackendFileIdFromUrl(rawUrl);
  if (backendFileId) {
    const encoded = encodeURIComponent(backendFileId);
    const base = toAbsoluteUrl(`/backend-api/files/${encoded}`) || rawUrl;
    add(base);
    add(`${base}/download`);
  }

  const estuaryFileId = extractEstuaryFileIdFromUrl(rawUrl);
  if (estuaryFileId) {
    const postIds = collectLikelyPostIdsFromDocument(document);
    const conversationIds = collectLikelyConversationIdsFromDocument(document);
    for (const candidate of buildBackendFileUrlCandidates(estuaryFileId, postIds, conversationIds)) {
      add(candidate);
    }

    const fallbackEstuary = toAbsoluteUrl(`/backend-api/estuary/content?id=${encodeURIComponent(estuaryFileId)}`);
    if (fallbackEstuary) {
      add(fallbackEstuary);
    }
  }

  return out;
}

async function maybeInlineProtectedAttachment(
  attachment: CaptureAttachment,
  forceAttempt = false
): Promise<CaptureAttachment> {
  const targetUrl = attachment.originalUrl.trim();
  if (!targetUrl || (!forceAttempt && !shouldInlineProtectedAttachment(targetUrl))) {
    return attachment;
  }

  const candidates = buildInlineFetchCandidates(targetUrl).slice(0, 12);
  const exhaustedBackendIds = new Set<string>();
  for (const candidate of candidates) {
    const backendFileId = extractBackendFileIdFromUrl(candidate);
    if (backendFileId && exhaustedBackendIds.has(backendFileId)) {
      continue;
    }

    try {
      const backgroundResult = await fetchDataUrlViaBackground(candidate);
      const backgroundDataUrl =
        backgroundResult?.ok && typeof backgroundResult.dataUrl === "string" ? backgroundResult.dataUrl : null;
      if (backgroundDataUrl) {
        const kind = inferAttachmentKind(backgroundDataUrl, "");
        console.info("[AI_HISTORY] inlined attachment from background fetch", {
          candidate,
          kind
        });
        return {
          ...attachment,
          kind,
          originalUrl: backgroundDataUrl,
          mime: attachment.mime || inferAttachmentMime(kind, backgroundDataUrl),
          status: "remote_only"
        };
      }

      if (backendFileId && (backgroundResult?.tried?.length ?? 0) > 0) {
        exhaustedBackendIds.add(backendFileId);
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      let response: Response;
      try {
        response = await fetch(candidate, {
          credentials: "include",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            Accept: "*/*"
          }
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (
        contentType.includes("application/json") ||
        contentType.startsWith("text/html")
      ) {
        continue;
      }

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const parsed = Number(contentLengthHeader);
        if (Number.isFinite(parsed) && parsed > MAX_INLINE_ATTACHMENT_BYTES) {
          continue;
        }
      }

      const blob = await response.blob();
      if (!blob.size || blob.size > MAX_INLINE_ATTACHMENT_BYTES) {
        continue;
      }

      const dataUrl = await blobToDataUrl(blob);
      if (!dataUrl.startsWith("data:")) {
        continue;
      }

      const kind = inferAttachmentKind(dataUrl, "");
      const mime = (blob.type || attachment.mime || inferAttachmentMime(kind, dataUrl) || null) as string | null;
      console.info("[AI_HISTORY] inlined attachment from page fetch", {
        candidate,
        kind
      });
      return {
        ...attachment,
        kind,
        originalUrl: dataUrl,
        mime,
        status: "remote_only"
      };
    } catch {
      // try next candidate
    }
  }

  if (
    targetUrl.toLowerCase().includes("/backend-api/files/") ||
    targetUrl.toLowerCase().includes("/backend-api/estuary/content") ||
    forceAttempt
  ) {
    console.info("[AI_HISTORY] failed to inline protected attachment", targetUrl, candidates);
  }

  return attachment;
}

async function extractConversationApiPayload(conversationId: string): Promise<Record<string, unknown> | null> {
  const discoveredUrls = collectChatGptConversationApiUrls(conversationId);
  const requestUrls = [...discoveredUrls, `/backend-api/conversation/${encodeURIComponent(conversationId)}`];
  if (discoveredUrls.length === 0) {
    requestUrls.push(`/backend-api/conversation/${encodeURIComponent(conversationId)}?tree=true`);
  }
  const uniqueRequestUrls = Array.from(new Set(requestUrls.map((item) => toAbsoluteUrl(item) || item)));
  const attempts: Array<{ url: string; status: number; ok: boolean; error?: string }> = [];

  for (const requestUrl of uniqueRequestUrls) {
    try {
      const response = await fetch(requestUrl, {
        credentials: "include"
      });
      attempts.push({
        url: requestUrl,
        status: response.status,
        ok: response.ok
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as unknown;
      if (isRecord(payload)) {
        return payload;
      }
      attempts.push({
        url: requestUrl,
        status: response.status,
        ok: false,
        error: "payload-not-object"
      });
    } catch {
      attempts.push({
        url: requestUrl,
        status: 0,
        ok: false,
        error: "fetch-error"
      });
    }
  }

  if (attempts.length > 0) {
    console.info("[AI_HISTORY] chatgpt conversation api unavailable", attempts);
  }

  return null;
}

function extractConversationMapping(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(payload.mapping)) {
    return payload.mapping;
  }
  const conversation = payload.conversation;
  if (isRecord(conversation) && isRecord(conversation.mapping)) {
    return conversation.mapping;
  }
  const data = payload.data;
  if (isRecord(data) && isRecord(data.mapping)) {
    return data.mapping;
  }
  if (isRecord(data) && isRecord(data.conversation) && isRecord(data.conversation.mapping)) {
    return data.conversation.mapping;
  }
  return null;
}

interface ChatGptApiTurn {
  role: CaptureTurn["role"];
  attachments: CaptureAttachment[];
}

async function fetchChatGptApiTurns(doc: Document): Promise<ChatGptApiTurn[]> {
  const conversationIds = new Set<string>();
  const fromUrl = parseChatGptConversationId(doc.location.href);
  if (fromUrl) {
    conversationIds.add(fromUrl);
  }
  for (const id of collectLikelyConversationIdsFromDocument(doc)) {
    if (id) {
      conversationIds.add(id);
    }
  }
  if (conversationIds.size === 0) {
    return [];
  }

  try {
    let payload: Record<string, unknown> | null = null;
    for (const conversationId of Array.from(conversationIds).slice(0, 8)) {
      payload = await extractConversationApiPayload(conversationId);
      if (payload) {
        break;
      }
    }
    if (!payload) {
      return [];
    }

    const mapping = extractConversationMapping(payload);
    if (!mapping) {
      return [];
    }

    const items: Array<{ turn: ChatGptApiTurn; createdAt: number }> = [];
    for (const node of Object.values(mapping)) {
      if (!isRecord(node) || !isRecord(node.message)) {
        continue;
      }
      const message = node.message;
      const author = isRecord(message.author) ? message.author : null;
      const role = roleFromApiValue(author?.role ?? message.role);
      if (!role) {
        continue;
      }

      const attachments = extractAttachmentsFromApiMessage(message);
      if (!attachments.length) {
        continue;
      }

      const createdRaw = message.create_time;
      const createdAt =
        typeof createdRaw === "number"
          ? createdRaw
          : typeof createdRaw === "string"
            ? Number(createdRaw) || 0
            : 0;
      items.push({
        turn: {
          role,
          attachments
        },
        createdAt
      });
    }

    items.sort((a, b) => a.createdAt - b.createdAt);
    return items.map((item) => item.turn);
  } catch (error) {
    console.warn("[AI_HISTORY] failed to enrich chatgpt attachments from conversation api", error);
    return [];
  }
}

function attachmentDisplayName(attachment: CaptureAttachment): string {
  const virtualName = decodeVirtualAttachmentName(attachment.originalUrl);
  if (virtualName) {
    return virtualName;
  }

  const raw = attachment.originalUrl.trim();
  if (!raw) {
    return "未命名附件";
  }
  if (isDataUrl(raw)) {
    return attachment.kind === "pdf" ? "PDF 文件" : attachment.kind === "image" ? "图片文件" : "文件";
  }
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop() || "";
    if (segment && !/^(content|download)$/i.test(segment)) {
      return safeDecodeURIComponent(segment);
    }
    const estuaryId =
      parsed.searchParams.get("id") || parsed.searchParams.get("file_id") || parsed.searchParams.get("fileId") || "";
    if (estuaryId) {
      const base = safeDecodeURIComponent(estuaryId).trim();
      if (base) {
        const mime = (attachment.mime || "").toLowerCase();
        let ext = "";
        if (attachment.kind === "pdf" || mime.includes("application/pdf")) {
          ext = ".pdf";
        } else if (attachment.kind === "image" || mime.startsWith("image/")) {
          ext = ".jpg";
        }
        return `${base}${ext}`;
      }
    }
    if (segment) {
      return safeDecodeURIComponent(segment);
    }
  } catch {
    // ignored
  }

  return raw.slice(0, 64);
}

function keepAsLinkOnlyBySource(source: CaptureSource, attachment: CaptureAttachment): boolean {
  const url = attachment.originalUrl.trim();
  if (!url) {
    return true;
  }
  if (source === "gemini" || source === "ai_studio") {
    if (looksLikeCloudDriveFileUrl(url)) {
      return true;
    }
    if (/googleapis\.com\/drive\/v3\/files\//i.test(url)) {
      return true;
    }
  }
  return false;
}

function shouldRequireAttachmentDownload(source: CaptureSource, turn: CaptureTurn, attachment: CaptureAttachment): boolean {
  if (turn.role !== "user" && turn.role !== "assistant") {
    return false;
  }

  const url = attachment.originalUrl.trim();
  const lower = url.toLowerCase();
  if (!url || isDataUrl(url)) {
    return false;
  }
  if (keepAsLinkOnlyBySource(source, attachment)) {
    return false;
  }

  if (isVirtualAttachmentUrl(url)) {
    return true;
  }

  if (lower.includes("oaiusercontent.com") && !isLikelyOaiAttachmentUrl(lower)) {
    return false;
  }

  const hasDownloadableSignal =
    looksLikeFileUrl(url) ||
    looksLikeImageUrl(url) ||
    looksLikePdfUrl(url) ||
    lower.includes("/backend-api/files/") ||
    lower.includes("googleusercontent.com/gg/");

  if (!hasDownloadableSignal) {
    return false;
  }

  if (attachment.kind === "image" || attachment.kind === "pdf" || attachment.kind === "file") {
    return true;
  }

  return hasDownloadableSignal;
}

function detectUnresolvedUserUploadFromText(turn: CaptureTurn, attachments: CaptureAttachment[]): string[] {
  if (turn.role !== "user") {
    return [];
  }

  const names = findLikelyInlineFileNames(turn.contentMarkdown || "");
  if (!names.length) {
    return [];
  }

  const known = new Set(
    attachments
      .map((attachment) => attachmentDisplayName(attachment).trim().toLowerCase())
      .filter(Boolean)
  );
  const hasAnyDownloadableAttachment = attachments.some((attachment) => {
    const url = attachment.originalUrl.trim();
    if (!url || isVirtualAttachmentUrl(url)) {
      return false;
    }
    return isDataUrl(url) || looksLikeFileUrl(url) || looksLikePdfUrl(url) || looksLikeImageUrl(url);
  });
  if (names.length === 1 && hasAnyDownloadableAttachment) {
    return [];
  }
  const unresolved: string[] = [];
  const downloadableCount = attachments.filter((attachment) => {
    const url = attachment.originalUrl.trim();
    if (!url || isVirtualAttachmentUrl(url)) {
      return false;
    }
    if (isDataUrl(url)) {
      return true;
    }
    if (looksLikeFileUrl(url) || looksLikePdfUrl(url) || looksLikeImageUrl(url)) {
      return true;
    }
    return false;
  }).length;

  for (const name of names) {
    const lowered = name.trim().toLowerCase();
    if (known.has(lowered)) {
      continue;
    }
    const ext = extractExtFromFileName(name);
    if (!ext) {
      continue;
    }
    unresolved.push(name);
  }

  if (unresolved.length > 0 && downloadableCount >= unresolved.length) {
    return [];
  }

  return unresolved;
}

function stripVirtualPlaceholdersWhenRealAttachmentExists(
  attachments: CaptureAttachment[]
): CaptureAttachment[] {
  if (attachments.length < 2) {
    return attachments;
  }

  const real = attachments.filter((attachment) => !isVirtualAttachmentUrl(attachment.originalUrl));
  if (!real.length) {
    return attachments;
  }

  const realNames = new Set(
    real
      .map((attachment) => attachmentDisplayName(attachment).trim().toLowerCase())
      .filter(Boolean)
  );

  const stripped = attachments.filter((attachment) => {
    if (!isVirtualAttachmentUrl(attachment.originalUrl)) {
      return true;
    }
    const virtualName = attachmentDisplayName(attachment).trim().toLowerCase();
    if (!virtualName) {
      return false;
    }
    return !realNames.has(virtualName);
  });

  if (!stripped.some((attachment) => !isVirtualAttachmentUrl(attachment.originalUrl))) {
    return attachments;
  }

  return stripped;
}

function isGenericDerivedAttachmentName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) {
    return true;
  }
  if (lower === "content" || lower === "download") {
    return true;
  }
  if (/^file[_-][a-z0-9]+(?:\.[a-z0-9]{2,6})?$/i.test(lower)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]{2,6})?$/i.test(lower)) {
    return true;
  }
  return false;
}

function isBackendAttachmentUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.includes("/backend-api/files/") || lower.includes("/backend-api/estuary/content");
}

function stripRedundantFailedAttachments(attachments: CaptureAttachment[]): CaptureAttachment[] {
  if (attachments.length < 2) {
    return attachments;
  }
  const cached = attachments.filter((attachment) => attachment.status === "cached");
  if (!cached.length) {
    return attachments;
  }
  const cachedKinds = new Set(cached.map((attachment) => attachment.kind));
  return attachments.filter((attachment) => {
    if (attachment.status !== "failed") {
      return true;
    }
    if (!isBackendAttachmentUrl(attachment.originalUrl)) {
      return true;
    }
    const name = attachmentDisplayName(attachment);
    if (!isGenericDerivedAttachmentName(name)) {
      return true;
    }
    if (cachedKinds.has(attachment.kind)) {
      return false;
    }
    if (attachment.kind === "file" && cachedKinds.size > 0) {
      return false;
    }
    return true;
  });
}

async function logAttachmentProbeOnFailure(
  source: CaptureSource,
  turn: CaptureTurn,
  attachments: CaptureAttachment[],
  unresolved: string[],
  reason: "unresolved_name" | "download_failed" = "unresolved_name"
): Promise<void> {
  const candidates = attachments
    .map((attachment) => attachment.originalUrl.trim())
    .filter((url) => isHttpUrl(url))
    .slice(0, 10);

  const probes = await Promise.all(candidates.map((url) => probeAttachmentUrlViaBackground(url)));
  const results = probes
    .filter((item): item is BackgroundAttachmentProbeResponse => Boolean(item))
    .map((item) => ({
      url: item.url ?? "",
      ok: Boolean(item.ok),
      method: item.method ?? "",
      status: item.status ?? 0,
      contentType: item.contentType ?? "",
      contentLength: item.contentLength ?? 0,
      error: item.error ?? ""
    }));

  console.groupCollapsed("[AI_HISTORY][PROBE] unresolved attachment diagnostics");
  console.info("source", source);
  console.info("reason", reason);
  console.info("unresolved_names", unresolved);
  console.info(
    "turn_preview",
    (turn.contentMarkdown || "")
      .replace(/\s+/g, " ")
      .slice(0, 180)
  );
  console.table(
    attachments.map((attachment) => ({
      kind: attachment.kind,
      url: attachment.originalUrl.slice(0, 220),
      isData: isDataUrl(attachment.originalUrl),
      isVirtual: isVirtualAttachmentUrl(attachment.originalUrl)
    }))
  );
  if (results.length > 0) {
    console.table(results);
  } else {
    console.info("probe_results", "empty");
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const hints = resources
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean)
      .filter((name) => /prompts|backend-api|googleusercontent|files|upload|download/i.test(name))
      .slice(-25);
    console.info("resource_hints", hints);
  } catch {
    // ignore
  }
  console.groupEnd();
}

export interface AttachmentMaterializeProgress {
  phase: "files";
  processed: number;
  total: number;
  failed: number;
}

interface MaterializeAttachmentOptions {
  continueOnFailure?: boolean;
  onProgress?: (progress: AttachmentMaterializeProgress) => void;
}

export function countMaterializableAttachments(turns: CaptureTurn[]): number {
  return turns.reduce((sum, turn) => {
    const stripped = stripVirtualPlaceholdersWhenRealAttachmentExists(turn.attachments ?? []);
    const deduped = mergeTurnAttachments([], stripped) ?? [];
    return sum + deduped.length;
  }, 0);
}

export async function materializeAttachmentsOrThrow(
  source: CaptureSource,
  turns: CaptureTurn[],
  options: MaterializeAttachmentOptions = {}
): Promise<CaptureTurn[]> {
  if (!turns.length) {
    return turns;
  }

  const output: CaptureTurn[] = [];
  const failures: string[] = [];
  let probeLogged = false;
  const enableProbe = !options.continueOnFailure;
  const turnAttachmentWork = turns.map((turn) => {
    const stripped = stripVirtualPlaceholdersWhenRealAttachmentExists(turn.attachments ?? []);
    return mergeTurnAttachments([], stripped) ?? [];
  });
  const allAttachments = turnAttachmentWork.reduce((sum, items) => sum + items.length, 0);
  let processedAttachments = 0;
  let failedAttachments = 0;
  options.onProgress?.({
    phase: "files",
    processed: 0,
    total: allAttachments,
    failed: 0
  });

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    const attachments = turnAttachmentWork[turnIndex] ?? [];

    if (!attachments.length) {
      output.push(turn);
      continue;
    }

    const normalized: CaptureAttachment[] = [];
    const pendingFailureReasonByUrl = new Map<string, string>();
    for (const attachment of attachments) {
      const required = shouldRequireAttachmentDownload(source, turn, attachment);
      const inlined = await maybeInlineProtectedAttachment(attachment, required);
      let finalized = inlined;
      if (isDataUrl(inlined.originalUrl)) {
        finalized = {
          ...inlined,
          status: "cached"
        };
      }

      if (required && !isDataUrl(inlined.originalUrl)) {
        const reason = isVirtualAttachmentUrl(attachment.originalUrl)
          ? "仅提取到文件名，未拿到真实文件链接"
          : "插件下载失败";
        finalized = {
          ...inlined,
          status: "failed"
        };
        pendingFailureReasonByUrl.set(finalized.originalUrl.trim(), reason);
      }
      normalized.push(finalized);
      processedAttachments += 1;
    }

    const deduped = mergeTurnAttachments([], normalized) ?? [];
    const cleaned = stripRedundantFailedAttachments(deduped);
    const retainedFailed = cleaned.filter((attachment) => attachment.status === "failed");
    for (const failed of retainedFailed) {
      const reason = pendingFailureReasonByUrl.get(failed.originalUrl.trim()) || "插件下载失败";
      failures.push(`${attachmentDisplayName(failed)}（${reason}）`);
      failedAttachments += 1;
    }
    options.onProgress?.({
      phase: "files",
      processed: processedAttachments,
      total: allAttachments,
      failed: failedAttachments
    });

    output.push({
      ...turn,
      attachments: mergeTurnAttachments([], cleaned)
    });

    if (source === "chatgpt" || source === "ai_studio") {
      const unresolved = detectUnresolvedUserUploadFromText(turn, cleaned);
      if (unresolved.length > 0) {
        for (const name of unresolved) {
          failures.push(`${name}（仅识别到文件名，未抓到可下载链接）`);
        }
        if (enableProbe && !probeLogged) {
          probeLogged = true;
          await logAttachmentProbeOnFailure(source, turn, cleaned, unresolved, "unresolved_name");
        }
      }
    }

    if (enableProbe && retainedFailed.length > 0 && !probeLogged) {
      probeLogged = true;
      await logAttachmentProbeOnFailure(
        source,
        turn,
        retainedFailed,
        retainedFailed.map((attachment) => attachmentDisplayName(attachment)),
        "download_failed"
      );
    }
  }

  if (failures.length > 0) {
    if (options.continueOnFailure) {
      console.warn("[AI_HISTORY] attachment materialization has failures but continues", {
        source,
        failed: failures.length,
        sample: failures.slice(0, 3)
      });
      return dedupeTurns(output);
    }
    const preview = failures.slice(0, 3).join("；");
    const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : "";
    throw new Error(`附件下载失败：${preview}${more}`);
  }

  return dedupeTurns(output);
}

export async function enrichChatGptTurnsWithApiAttachments(
  turns: CaptureTurn[],
  doc: Document = document
): Promise<CaptureTurn[]> {
  if (!turns.length) {
    return turns;
  }

  const apiTurns = await fetchChatGptApiTurns(doc);
  let mergedTurns = turns;
  if (apiTurns.length > 0) {
    const apiBuckets: Record<CaptureTurn["role"], CaptureAttachment[][]> = {
      user: [],
      assistant: [],
      system: [],
      tool: []
    };
    for (const turn of apiTurns) {
      if (turn.attachments.length > 0) {
        apiBuckets[turn.role].push(turn.attachments);
      }
    }

    const cursor: Record<CaptureTurn["role"], number> = {
      user: 0,
      assistant: 0,
      system: 0,
      tool: 0
    };

    mergedTurns = turns.map((turn) => {
      const bucket = apiBuckets[turn.role];
      if (!bucket || cursor[turn.role] >= bucket.length) {
        return turn;
      }
      const attachments = bucket[cursor[turn.role]] ?? [];
      cursor[turn.role] += 1;
      return {
        ...turn,
        attachments: mergeTurnAttachments(turn.attachments, attachments)
      };
    });
  }

  const withResourceFallback = applyChatGptResourceAttachmentFallback(mergedTurns, doc);
  return dedupeTurns(withResourceFallback);
}

export function extractGeminiTurns(doc: Document = document): CaptureTurn[] {
  const root = doc.querySelector("main") || doc.querySelector("[role='main']") || doc.body;

  const selector = [
    "user-query",
    "model-response",
    "[data-test-id='user-query']",
    "[data-test-id='user-message']",
    "[data-test-id='model-response']",
    "[data-test-id='conversation-turn']",
    "[class*='user-query']",
    "[class*='model-response']",
    "[class*='response-content']"
  ].join(",");

  const candidates = leafNodes(root, selector);
  const turns: CaptureTurn[] = [];
  for (const node of candidates) {
    let role = roleFromAttrs(node);
    const hint = `${node.tagName.toLowerCase()} ${(node.getAttribute("data-test-id") || "").toLowerCase()} ${String(
      (node as HTMLElement).className || ""
    ).toLowerCase()}`;
    if (!role) {
      if (/user-query|user-message|query-input/.test(hint)) {
        role = "user";
      } else if (/model-response|response-content|response/.test(hint)) {
        role = "assistant";
      }
    }

    const turn = buildTurn(node, role);
    if (!turn) {
      continue;
    }
    const sanitized = sanitizeGeminiTurn(turn);
    if (sanitized) {
      turns.push(sanitized);
    }
  }

  const deduped = dedupeTurns(turns);
  if (deduped.some((turn) => turn.role === "user") && deduped.length >= 2) {
    return deduped;
  }

  return dedupeTurns(
    parseByRoleMarkers((root as HTMLElement).innerText || "")
      .map((turn) => sanitizeGeminiTurn(turn))
      .filter((turn): turn is CaptureTurn => Boolean(turn))
  );
}

function scoreAiStudioRoot(root: Element): number {
  const turnCount = root.querySelectorAll(
    "[data-role='user'], [data-role='assistant'], [data-role='model'], ms-chat-turn, [data-testid*='chat-turn'], [class*='chat-turn']"
  ).length;

  const text = normalizeMarkdownText((root as HTMLElement).innerText || "");
  let noisePenalty = 0;
  if (/skip to main content|settings|get api key|developer_guide|documentation/i.test(text)) {
    noisePenalty += 8;
  }
  return turnCount * 5 - noisePenalty;
}

function pickAiStudioRoot(doc: Document): Element {
  const candidates = [
    doc.querySelector("main"),
    doc.querySelector("[role='main']"),
    doc.querySelector("[data-testid*='conversation']"),
    doc.querySelector("[class*='conversation']")
  ].filter((node): node is Element => Boolean(node));

  if (candidates.length === 0) {
    return doc.body;
  }

  return candidates.sort((a, b) => scoreAiStudioRoot(b) - scoreAiStudioRoot(a))[0] ?? doc.body;
}

export function extractAiStudioTurns(doc: Document = document): CaptureTurn[] {
  const root = pickAiStudioRoot(doc);
  const selector = [
    "[data-role='user']",
    "[data-role='assistant']",
    "[data-role='model']",
    "[data-message-author-role]",
    "ms-chat-turn",
    "[data-testid*='chat-turn']",
    "[class*='chat-turn']",
    "[class*='conversation-turn']"
  ].join(",");

  const candidates = leafNodes(root, selector).filter((node) => {
    const element = node as HTMLElement;
    return !element.closest("nav, header, aside, [role='navigation']");
  });

  const turns = candidates
    .map((node) => buildTurn(node))
    .filter((v): v is CaptureTurn => Boolean(v));

  const deduped = dedupeTurns(turns);
  if (deduped.some((turn) => turn.role === "user") && deduped.length >= 2) {
    return deduped;
  }

  return dedupeTurns(parseByRoleMarkers((root as HTMLElement).innerText || ""));
}

export function inferSourceFromUrl(url: string): CaptureSource {
  if (url.includes("aistudio.google.com")) {
    return "ai_studio";
  }
  if (url.includes("gemini.google.com") || url.includes("bard.google.com")) {
    return "gemini";
  }
  return "chatgpt";
}

export function createCapturePayload(source: CaptureSource, turns: CaptureTurn[]): CapturePayload {
  return {
    source,
    pageUrl: canonicalizePageUrl(location.href),
    title: deriveTitle(source, document, turns),
    turns,
    capturedAt: new Date().toISOString(),
    version: "1.2.0"
  };
}
