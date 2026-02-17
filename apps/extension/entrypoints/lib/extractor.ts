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
  /^(skip to main content|home|settings|menu_open|menu|share|compare_arrows|add|more_vert|edit|chevron_right|chevron_left|trending_flat|developer_guide|documentation|expand_more|expand to view model thoughts|model thoughts|token(s)?|get api key|application)$/i;

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
  const displayNodes = Array.from(
    root.querySelectorAll(".katex-display, [class*='katex-display'], math[display='block'], [data-display='block']")
  );

  for (const node of displayNodes) {
    const latex = readLatex(node);
    if (!latex) {
      continue;
    }
    node.replaceWith(doc.createTextNode(`\n$$${latex}$$\n`));
  }

  const inlineNodes = Array.from(root.querySelectorAll(".katex, math, [data-tex], [data-latex]"));
  for (const node of inlineNodes) {
    if (node.closest(".katex-display, [class*='katex-display'], math[display='block'], [data-display='block']")) {
      continue;
    }
    const latex = readLatex(node);
    if (!latex) {
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
    .replace(/<(p|div|section|article|blockquote|ul|ol|table|thead|tbody|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/(th|td)>/gi, " | ")
    .replace(/<(th|td)\b[^>]*>/gi, " | ");

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
  if (/\/backend-api\/files\/|\/api\/files\/|\/files\//i.test(url)) {
    return true;
  }
  if (/[?&](download|filename|attachment)=/i.test(url)) {
    return true;
  }
  return false;
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

function isNavigationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
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
  const addFileIdCandidates = (raw: string, mimeHint: string | null = null) => {
    for (const fileId of extractFileIdsFromString(raw)) {
      for (const url of buildBackendFileUrlCandidates(fileId)) {
        addAttachmentCandidate(found, url, mimeHint);
      }
    }
  };

  for (const img of Array.from(node.querySelectorAll("img[src]"))) {
    const src = toAbsoluteUrl(img.getAttribute("src") || "");
    if (!src || isUiAsset(src) || !looksLikeImageUrl(src)) {
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
        looksLikeOpaqueFileId(raw)
      ) {
        addFileIdCandidates(raw, null);
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
      addFileIdCandidates(raw, null);
    }
    const text = ((fileNode as HTMLElement).innerText || fileNode.textContent || "").trim();
    if (text) {
      addFileIdCandidates(text, null);
    }
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
  const attachments = extractAttachments(node);
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
  const seen = new Set<string>();
  const out: CaptureTurn[] = [];

  for (const turn of turns) {
    const cleaned = normalizeMarkdownText(turn.contentMarkdown);
    if (!cleaned) {
      continue;
    }

    const key = `${turn.role}:${normalizeForDedupe(cleaned)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
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
  const nodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
  const turns = nodes
    .map((node) => {
      const role = (node.getAttribute("data-message-author-role") || "assistant") as CaptureTurn["role"];
      return buildTurn(node, role);
    })
    .filter((v): v is CaptureTurn => Boolean(v));
  return dedupeTurns(turns);
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

function looksLikeOpaqueFileId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 8 || trimmed.length > 128) {
    return false;
  }
  if (/^file-[a-z0-9-]{6,}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-f0-9]{24,64}$/i.test(trimmed)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-z0-9][a-z0-9_-]{12,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return true;
  }
  return false;
}

function extractFileIdsFromString(raw: string): string[] {
  const out = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const add = (value: string) => {
    const decoded = safeDecodeURIComponent(value.trim());
    if (!decoded || !looksLikeOpaqueFileId(decoded)) {
      return;
    }
    out.add(decoded);
  };

  const filePrefixMatches = trimmed.match(/\bfile-[a-z0-9-]{6,}\b/gi) || [];
  for (const match of filePrefixMatches) {
    add(match);
  }

  for (const match of trimmed.matchAll(/file-service:\/\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/\/backend-api\/files\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  if (looksLikeOpaqueFileId(trimmed)) {
    add(trimmed);
  }

  return Array.from(out);
}

function maybeFileIdFromString(raw: string): string | null {
  return extractFileIdsFromString(raw)[0] ?? null;
}

function buildBackendFileUrlCandidates(fileId: string): string[] {
  const normalized = fileId.trim();
  if (!normalized) {
    return [];
  }
  const encoded = encodeURIComponent(normalized);
  const rawCandidates = [
    `/backend-api/files/${encoded}/download`,
    `/backend-api/files/${encoded}/download?download=1`,
    `/backend-api/files/${encoded}`,
    `/backend-api/files/${encoded}?download=1`,
    `/backend-api/files/${encoded}/content`
  ];
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
    lower.includes("/backend-api/files/")
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
  const kind = inferAttachmentKind(absolute, labelHint);
  const isBackendFile = absolute.toLowerCase().includes("/backend-api/files/");
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

function extractAttachmentsFromApiMessage(message: Record<string, unknown>): CaptureAttachment[] {
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

    let localMime: string | null = null;
    const localFileIds = new Set<string>();
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          continue;
        }

        if (/mime|content[_-]?type/i.test(key) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+/i.test(trimmed)) {
          localMime = trimmed.split(";")[0]?.trim().toLowerCase() ?? null;
        }

        if (isLikelyAttachmentUrl(trimmed)) {
          addAttachmentCandidate(found, trimmed, localMime);
        }

        const keySuggestsFile =
          /(^|_)(file|asset|attachment|upload|document)(_|$)/i.test(key) ||
          /(^|_)id($|_)/i.test(key);
        const ids = extractFileIdsFromString(trimmed);
        if (ids.length > 0 && (keySuggestsFile || looksLikeOpaqueFileId(trimmed) || /file-service:\/\//i.test(trimmed))) {
          for (const id of ids) {
            localFileIds.add(id);
          }
        } else {
          const inlineId = maybeFileIdFromString(trimmed);
          if (inlineId) {
            localFileIds.add(inlineId);
          }
        }
      } else {
        stack.push(value);
      }
    }

    for (const fileId of localFileIds) {
      for (const candidate of buildBackendFileUrlCandidates(fileId)) {
        addAttachmentCandidate(found, candidate, localMime);
      }
    }
  }

  return Array.from(found.values());
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
  for (const item of all) {
    const key = item.originalUrl.trim();
    if (!key) {
      continue;
    }
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
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
  return lower.startsWith("blob:") || lower.includes("/backend-api/files/") || lower.includes("googleusercontent.com/gg/");
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

interface BackgroundAttachmentFetchResponse {
  ok?: boolean;
  dataUrl?: string;
  error?: string;
  status?: number;
}

async function fetchDataUrlViaBackground(url: string): Promise<string | null> {
  if (!isHttpUrl(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_FETCH_ATTACHMENT",
      url
    })) as BackgroundAttachmentFetchResponse;
    if (result?.ok && typeof result.dataUrl === "string" && result.dataUrl.startsWith("data:")) {
      return result.dataUrl;
    }
    return null;
  } catch {
    return null;
  }
}

function extractBackendFileIdFromUrl(rawUrl: string): string | null {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  const directMatch = absolute.match(/\/backend-api\/files\/([^/?#]+)/i);
  if (directMatch?.[1]) {
    return safeDecodeURIComponent(directMatch[1]);
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
    for (const candidate of buildBackendFileUrlCandidates(backendFileId)) {
      add(candidate);
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

  const candidates = buildInlineFetchCandidates(targetUrl);
  for (const candidate of candidates) {
    try {
      const backgroundDataUrl = await fetchDataUrlViaBackground(candidate);
      if (backgroundDataUrl) {
        const kind = inferAttachmentKind(backgroundDataUrl, "");
        return {
          ...attachment,
          kind,
          originalUrl: backgroundDataUrl,
          mime: attachment.mime || inferAttachmentMime(kind, backgroundDataUrl),
          status: "remote_only"
        };
      }

      const response = await fetch(candidate, {
        credentials: "include",
        redirect: "follow",
        headers: {
          Accept: "*/*"
        }
      });
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

  if (targetUrl.toLowerCase().includes("/backend-api/files/") || forceAttempt) {
    console.info("[AI_HISTORY] failed to inline protected attachment", targetUrl, candidates);
  }

  return attachment;
}

async function extractConversationApiPayload(conversationId: string): Promise<Record<string, unknown> | null> {
  const requestUrls = [
    `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
    `/backend-api/conversation/${encodeURIComponent(conversationId)}?tree=true`
  ];

  for (const requestUrl of requestUrls) {
    try {
      const response = await fetch(requestUrl, {
        credentials: "include"
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as unknown;
      if (isRecord(payload)) {
        return payload;
      }
    } catch {
      // try next endpoint
    }
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
  return null;
}

interface ChatGptApiTurn {
  role: CaptureTurn["role"];
  attachments: CaptureAttachment[];
}

async function fetchChatGptApiTurns(doc: Document): Promise<ChatGptApiTurn[]> {
  const conversationId = parseChatGptConversationId(doc.location.href);
  if (!conversationId) {
    return [];
  }

  try {
    const payload = await extractConversationApiPayload(conversationId);
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

      const text = normalizeMarkdownText(extractApiMessageText(message));
      if (text.length < 2 && role !== "user") {
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

async function inlineProtectedAttachmentsForTurns(turns: CaptureTurn[]): Promise<CaptureTurn[]> {
  const out: CaptureTurn[] = [];
  for (const turn of turns) {
    const attachments = turn.attachments ?? [];
    if (!attachments.length) {
      out.push(turn);
      continue;
    }
    const normalized: CaptureAttachment[] = [];
    for (const attachment of attachments) {
      const inlined = await maybeInlineProtectedAttachment(attachment);
      normalized.push(inlined);
    }
    out.push({
      ...turn,
      attachments: mergeTurnAttachments([], normalized)
    });
  }
  return out;
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
  }
  return false;
}

function shouldRequireAttachmentDownload(source: CaptureSource, turn: CaptureTurn, attachment: CaptureAttachment): boolean {
  if (turn.role !== "user") {
    return false;
  }

  const url = attachment.originalUrl.trim();
  if (!url || isDataUrl(url)) {
    return false;
  }
  if (keepAsLinkOnlyBySource(source, attachment)) {
    return false;
  }

  if (isVirtualAttachmentUrl(url)) {
    return true;
  }

  if (attachment.kind === "image" || attachment.kind === "pdf" || attachment.kind === "file") {
    return true;
  }

  return looksLikeFileUrl(url) || looksLikeImageUrl(url) || looksLikePdfUrl(url);
}

export async function materializeAttachmentsOrThrow(
  source: CaptureSource,
  turns: CaptureTurn[]
): Promise<CaptureTurn[]> {
  if (!turns.length) {
    return turns;
  }

  const output: CaptureTurn[] = [];
  const failures: string[] = [];

  for (const turn of turns) {
    const attachments = turn.attachments ?? [];
    if (!attachments.length) {
      output.push(turn);
      continue;
    }

    const normalized: CaptureAttachment[] = [];
    for (const attachment of attachments) {
      const required = shouldRequireAttachmentDownload(source, turn, attachment);
      const inlined = await maybeInlineProtectedAttachment(attachment, required);
      normalized.push(inlined);

      if (required && !isDataUrl(inlined.originalUrl)) {
        const reason = isVirtualAttachmentUrl(attachment.originalUrl)
          ? "仅提取到文件名，未拿到真实文件链接"
          : "插件下载失败";
        failures.push(`${attachmentDisplayName(attachment)}（${reason}）`);
      }
    }

    output.push({
      ...turn,
      attachments: mergeTurnAttachments([], normalized)
    });
  }

  if (failures.length > 0) {
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
  if (!apiTurns.length) {
    return turns;
  }

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

  const mergedTurns = turns.map((turn) => {
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

  const inlined = await inlineProtectedAttachmentsForTurns(mergedTurns);
  return dedupeTurns(inlined);
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
