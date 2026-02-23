import React from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { AttachmentRef } from "@ai-history/core-types";
import { api } from "../lib/api";
import type { Message } from "../lib/types";

const ROLE_LABEL: Record<Message["role"], string> = {
  user: "你",
  assistant: "AI",
  system: "系统",
  tool: "工具"
};

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

function containsHtml(text: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(text);
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
    return decodeHtmlEntities(annotation.textContent).trim();
  }

  const attrs = [
    node.getAttribute("data-tex"),
    node.getAttribute("data-latex"),
    node.getAttribute("aria-label")
  ]
    .filter((v): v is string => Boolean(v))
    .map((v) => decodeHtmlEntities(v).trim())
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
      const label = decodeHtmlEntities(stripHtmlTags(labelHtml)).replace(/\s+/g, " ").trim() || href;
      return `[${label}](${href})`;
    }
  );

  text = text.replace(
    /<img\b[^>]*src=(['"])(.*?)\1[^>]*>/gi,
    (match: string, _quote: string, src: string) => {
      const altMatch = match.match(/\balt=(['"])(.*?)\1/i);
      const alt = altMatch?.[2] || "image";
      return `![${alt}](${src})`;
    }
  );

  text = text.replace(/<pre\b[^>]*>/gi, "\n```\n").replace(/<\/pre>/gi, "\n```\n");
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => {
    const plain = decodeHtmlEntities(stripHtmlTags(code));
    return `\`${plain.trim()}\``;
  });

  text = text
    .replace(/<h1\b[^>]*>/gi, "\n# ")
    .replace(/<h2\b[^>]*>/gi, "\n## ")
    .replace(/<h3\b[^>]*>/gi, "\n### ")
    .replace(/<h4\b[^>]*>/gi, "\n#### ")
    .replace(/<h5\b[^>]*>/gi, "\n##### ")
    .replace(/<h6\b[^>]*>/gi, "\n###### ");

  text = text.replace(/<li\b[^>]*>/gi, "\n- ");

  text = text
    .replace(/<(strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(strong|b)>/gi, "**")
    .replace(/<(em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(em|i)>/gi, "*");

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|ul|ol|table|thead|tbody|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<(p|div|section|article|blockquote|ul|ol|table|thead|tbody|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/(th|td)>/gi, " | ")
    .replace(/<(th|td)\b[^>]*>/gi, " | ");

  return decodeHtmlEntities(stripHtmlTags(text));
}

function normalizeMarkdownText(raw: string): string {
  const decoded = decodeHtmlEntities(raw)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/^\s*you said\s*\n+/i, "")
    .replace(/^\s*gemini said\s*\n+/i, "")
    .replace(/^\s*显示思路\s*id_?\s*\n+/i, "")
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/[ \t]+\n/g, "\n");

  const rawLines = decoded.split("\n");
  const mergedLines: string[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i] ?? "";
    const trimmed = line.trim();
    const inlineBullet = trimmed.match(/^[•·●◦▪▫]\s*(.+)$/);
    if (inlineBullet) {
      mergedLines.push(`- ${inlineBullet[1].trim()}`);
      continue;
    }
    if (/^[•·●◦▪▫*-]\s*$/.test(trimmed)) {
      let next = i + 1;
      while (next < rawLines.length && !(rawLines[next] ?? "").trim()) {
        next += 1;
      }
      const candidate = (rawLines[next] ?? "").trim();
      if (candidate) {
        mergedLines.push(`- ${candidate.replace(/^[-*+]\s+/, "")}`);
        i = next;
      }
      continue;
    }
    mergedLines.push(line);
  }
  const bulletNormalized = mergedLines.join("\n");

  const lines = bulletNormalized.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const fixedMatrix = fixMatrixRows(normalized);
  const wrappedLatex = wrapStandaloneLatexBlocks(fixedMatrix);
  return fixDanglingMathDelimiters(wrappedLatex);
}

function toRenderableMarkdown(raw: string): string {
  const decoded = decodeHtmlEntities(raw);
  const source = containsHtml(decoded) ? htmlToMarkdownish(decoded) : decoded;
  return normalizeMarkdownText(source);
}

const VIRTUAL_ATTACHMENT_PREFIX = "aihistory://upload/";

function isVirtualAttachment(url: string): boolean {
  return url.toLowerCase().startsWith(VIRTUAL_ATTACHMENT_PREFIX);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isDataUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith("data:");
}

function parseDataUrlFileName(value: string): string {
  if (!isDataUrl(value)) {
    return "";
  }
  const meta = value.slice(5).split(",")[0] ?? "";
  const parts = meta.split(";").map((item) => item.trim());
  for (const part of parts) {
    if (part.toLowerCase().startsWith("name=")) {
      const raw = part.slice(5).trim().replace(/^["']+|["']+$/g, "");
      const decoded = decodeURIComponentSafe(raw);
      if (decoded) {
        return decoded;
      }
    }
  }
  return "";
}

function fallbackDataFileName(attachment: AttachmentRef): string {
  if (attachment.kind === "image") {
    if ((attachment.mime || "").toLowerCase().includes("png")) {
      return "image.png";
    }
    if ((attachment.mime || "").toLowerCase().includes("jpeg") || (attachment.mime || "").toLowerCase().includes("jpg")) {
      return "image.jpg";
    }
    return "image";
  }
  if (attachment.kind === "pdf") {
    return "document.pdf";
  }
  return "file";
}

function attachmentFileName(attachment: AttachmentRef): string {
  if (isVirtualAttachment(attachment.originalUrl)) {
    const raw = attachment.originalUrl.slice(VIRTUAL_ATTACHMENT_PREFIX.length).split("?")[0] ?? "";
    const decoded = decodeURIComponentSafe(raw).trim();
    return decoded || "未命名文件";
  }

  if (isDataUrl(attachment.originalUrl)) {
    const fromData = parseDataUrlFileName(attachment.originalUrl);
    if (fromData) {
      return fromData;
    }
    return fallbackDataFileName(attachment);
  }

  const href = resolveAttachmentHref(attachment);
  const clean = href.split("?")[0]?.split("#")[0] ?? href;
  const parts = clean.split("/");
  const rawName = parts[parts.length - 1] ?? "";
  const decodedName = decodeURIComponentSafe(rawName).trim();
  if (decodedName && decodedName.toLowerCase() !== "content" && decodedName.toLowerCase() !== "download") {
    return decodedName;
  }
  try {
    const parsed = new URL(href);
    const estuaryId = parsed.searchParams.get("id") || parsed.searchParams.get("file_id") || parsed.searchParams.get("fileId") || "";
    if (estuaryId) {
      const base = decodeURIComponentSafe(estuaryId);
      const ext = attachment.kind === "pdf" ? ".pdf" : attachment.kind === "image" ? ".jpg" : "";
      return `${base}${ext}`;
    }
  } catch {
    // ignore url parse failures
  }
  return decodedName || "未命名文件";
}

function resolveAttachmentHref(attachment: AttachmentRef): string {
  if (isVirtualAttachment(attachment.originalUrl)) {
    return "";
  }
  if (attachment.localPath) {
    if (/^https?:\/\//i.test(attachment.localPath)) {
      return attachment.localPath;
    }
    const normalized = attachment.localPath.replace(/\\/g, "/");
    const encoded = normalized.replace(/ /g, "%20");
    return encoded.startsWith("file://") ? encoded : `file://${encoded}`;
  }
  return attachment.originalUrl;
}

function resolveAttachmentPreviewSrc(attachment: AttachmentRef): string | null {
  if (attachment.kind !== "image") {
    return null;
  }
  if (attachment.status === "cached" && attachment.localPath) {
    return resolveAttachmentHref(attachment);
  }
  if (attachment.status === "cached" && isDataUrl(attachment.originalUrl)) {
    return attachment.originalUrl;
  }
  if (attachment.status !== "cached") {
    return null;
  }
  return null;
}

function resolvePdfPreviewSrc(attachment: AttachmentRef): string | null {
  if (attachment.kind !== "pdf") {
    return null;
  }
  if (attachment.status === "cached" && attachment.localPath) {
    return `${resolveAttachmentHref(attachment)}#page=1&view=FitH&toolbar=0`;
  }
  if (attachment.status === "cached" && isDataUrl(attachment.originalUrl)) {
    return `${attachment.originalUrl}#page=1&view=FitH&toolbar=0`;
  }
  if (attachment.status !== "cached") {
    return null;
  }
  return null;
}

function isHashLink(href: string): boolean {
  return href.startsWith("#");
}

function isRemoteHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function normalizeComparableUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.trim();
  }
}

function extractBackendFileId(url: string): string {
  const lowered = url.toLowerCase();
  const downloadMatch = lowered.match(/\/backend-api\/files\/download\/([^/?#]+)/i);
  if (downloadMatch?.[1]) {
    return decodeURIComponentSafe(downloadMatch[1]);
  }
  const directMatch = lowered.match(/\/backend-api\/files\/([^/?#]+)/i);
  if (directMatch?.[1] && directMatch[1] !== "download") {
    return decodeURIComponentSafe(directMatch[1]);
  }
  const estuaryMatch = lowered.match(/\/backend-api\/estuary\/content[^\s]*/i);
  if (estuaryMatch?.[0]) {
    try {
      const parsed = new URL(url);
      const id = parsed.searchParams.get("id") || "";
      return id ? decodeURIComponentSafe(id) : "";
    } catch {
      return "";
    }
  }
  return "";
}

function isBackendGeneratedAttachmentUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return /\/backend-api\/estuary\/content|\/backend-api\/files\//i.test(lowered);
}

function isGenericBackendAttachmentName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  if (!lowered) {
    return true;
  }
  return (
    lowered === "content" ||
    lowered === "download" ||
    /^file_[a-z0-9]+$/.test(lowered)
  );
}

function attachmentSemanticDisplayKey(attachment: AttachmentRef): string {
  const href = resolveAttachmentHref(attachment) || attachment.originalUrl;
  if (isVirtualAttachment(attachment.originalUrl)) {
    return `virtual:${attachmentFileName(attachment).toLowerCase()}`;
  }
  if (isDataUrl(attachment.originalUrl)) {
    return `data:${attachment.kind}:${(attachment.originalUrl || "").slice(0, 100)}`;
  }
  const fileId = extractBackendFileId(href);
  if (fileId) {
    return `fileid:${fileId.toLowerCase()}`;
  }
  return `url:${attachment.kind}:${href.toLowerCase()}`;
}

function looksLikeFileAttachment(url: string): boolean {
  const lowered = url.toLowerCase();
  if (isVirtualAttachment(url)) {
    return true;
  }
  if (/googleusercontent\.com\/gg\//i.test(lowered)) {
    return true;
  }
  if (
    /drive\.google\.com\/file\/|drive\.google\.com\/open|docs\.google\.com\/document\/|docs\.google\.com\/presentation\/|docs\.google\.com\/spreadsheets\//i.test(
      lowered
    )
  ) {
    return true;
  }
  if (/\/backend-api\/files\/|\/api\/files\/|\/files\//i.test(lowered)) {
    return true;
  }
  if (/[?&](download|filename|attachment)=/i.test(lowered)) {
    return true;
  }
  const clean = lowered.split("?")[0]?.split("#")[0] ?? lowered;
  const ext = clean.split(".").pop() ?? "";
  return [
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
  ].includes(ext);
}

function fileExtensionFromAttachment(attachment: AttachmentRef): string {
  const href = (resolveAttachmentHref(attachment) || attachment.originalUrl).toLowerCase();
  const clean = href.split("?")[0]?.split("#")[0] ?? href;
  return clean.split(".").pop() ?? "";
}

function attachmentLabel(attachment: AttachmentRef): string {
  if (attachment.kind === "image") {
    return "图片";
  }
  if (attachment.kind === "pdf") {
    return "PDF";
  }
  const ext = fileExtensionFromAttachment(attachment);
  if (ext === "docx") {
    return "DOCX";
  }
  if (ext === "doc") {
    return "DOC";
  }
  if (ext === "pptx") {
    return "PPTX";
  }
  if (ext === "ppt") {
    return "PPT";
  }
  if (ext === "xlsx") {
    return "XLSX";
  }
  if (ext === "xls") {
    return "XLS";
  }
  if (ext === "csv") {
    return "CSV";
  }
  if (ext === "md") {
    return "MD";
  }
  if (ext === "txt") {
    return "TXT";
  }
  if (ext === "json") {
    return "JSON";
  }
  return "文件";
}

function attachmentStatusLabel(attachment: AttachmentRef): string {
  if (isVirtualAttachment(attachment.originalUrl)) {
    return "仅记录文件名";
  }
  if (attachment.status === "cached") {
    return "已缓存";
  }
  if (attachment.status === "failed") {
    return "缓存失败";
  }
  return "链接";
}

function canOpenAttachment(attachment: AttachmentRef): boolean {
  const href = resolveAttachmentHref(attachment);
  return Boolean(href);
}

function normalizeLineForCompare(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[“”"'`]/g, "")
    .toLowerCase();
}

function stripAttachmentHeadlineLines(content: string, attachments: AttachmentRef[]): string {
  if (!attachments.length) {
    return content;
  }

  const knownNames = new Set(attachments.map((attachment) => normalizeLineForCompare(attachmentFileName(attachment))));
  const knownKinds = new Set(attachments.map((attachment) => normalizeLineForCompare(attachmentLabel(attachment))));
  const lines = content.replace(/\r/g, "").split("\n");

  let startIndex = 0;
  while (startIndex < lines.length) {
    const line = lines[startIndex] ?? "";
    const normalized = normalizeLineForCompare(line);
    if (!normalized) {
      startIndex += 1;
      continue;
    }
    if (knownNames.has(normalized) || knownKinds.has(normalized)) {
      startIndex += 1;
      continue;
    }
    break;
  }

  const cleaned = lines.slice(startIndex).join("\n").trim();
  return cleaned || content;
}

function renderRichContent(content: string, components: Components) {
  const markdown = toRenderableMarkdown(content);
  if (!markdown) {
    return <p className="muted">该消息无文本内容。</p>;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
}

export function MessageBubble({
  message,
  id,
  attachments
}: {
  message: Message;
  id: string;
  attachments: AttachmentRef[];
}) {
  const thoughtMarkdown = message.thoughtMarkdown ? toRenderableMarkdown(message.thoughtMarkdown) : "";
  const displayAttachments = React.useMemo(() => {
    const seen = new Set<string>();
    const filtered = attachments.filter((attachment) => {
      const href = resolveAttachmentHref(attachment) || attachment.originalUrl;
      const key = attachmentSemanticDisplayKey(attachment);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      if (attachment.kind !== "file") {
        if (
          message.role !== "user" &&
          attachment.kind === "pdf" &&
          attachment.status === "remote_only" &&
          !isVirtualAttachment(attachment.originalUrl) &&
          isRemoteHttpUrl(href)
        ) {
          return false;
        }
        return true;
      }
      if (
        message.role !== "user" &&
        attachment.status === "remote_only" &&
        !isVirtualAttachment(attachment.originalUrl) &&
        isRemoteHttpUrl(href)
      ) {
        return false;
      }
      if (attachment.status === "cached") {
        return true;
      }
      return looksLikeFileAttachment(href);
    });
    const hasCachedImage = filtered.some((attachment) => {
      if (attachment.kind !== "image") {
        return false;
      }
      return Boolean(resolveAttachmentPreviewSrc(attachment));
    });
    if (!hasCachedImage) {
      return filtered;
    }
    return filtered.filter((attachment) => {
      const href = resolveAttachmentHref(attachment) || attachment.originalUrl;
      if (attachment.kind !== "image") {
        return true;
      }
      if (attachment.status === "cached") {
        return true;
      }
      if (!isBackendGeneratedAttachmentUrl(href)) {
        return true;
      }
      const name = attachmentFileName(attachment);
      return !isGenericBackendAttachmentName(name);
    });
  }, [attachments, message.role]);
  const displayContent = React.useMemo(
    () => stripAttachmentHeadlineLines(message.contentMarkdown, displayAttachments),
    [message.contentMarkdown, displayAttachments]
  );
  const imageAttachmentUrlKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const attachment of displayAttachments) {
      if (attachment.kind !== "image") {
        continue;
      }
      const href = resolveAttachmentHref(attachment);
      if (href && isRemoteHttpUrl(href)) {
        keys.add(normalizeComparableUrl(href));
      }
      if (isRemoteHttpUrl(attachment.originalUrl)) {
        keys.add(normalizeComparableUrl(attachment.originalUrl));
      }
    }
    return keys;
  }, [displayAttachments]);
  const hasImageAttachment = displayAttachments.some((attachment) => attachment.kind === "image");

  const openExternalTarget = React.useCallback((target: string) => {
    void api.openExternal(target).catch((error) => {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`打开链接失败：${message}`);
    });
  }, []);

  const markdownComponents = React.useMemo<Components>(() => {
    return {
      a: ({ node: _node, href, children, onClick: _onClick, ...props }) => {
        const link = typeof href === "string" ? href : "";
        const hashLink = isHashLink(link);
        return (
          <a
            {...props}
            href={link || undefined}
            target={hashLink ? undefined : "_blank"}
            rel={hashLink ? undefined : "noreferrer"}
            onClick={(event) => {
              if (hashLink || !link) {
                return;
              }
              event.preventDefault();
              openExternalTarget(link);
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ node: _node, src, alt, ...props }) => {
        const imageSrc = typeof src === "string" ? src : "";
        if (!imageSrc) {
          return null;
        }
        if (isRemoteHttpUrl(imageSrc)) {
          const normalized = normalizeComparableUrl(imageSrc);
          if (hasImageAttachment && (imageAttachmentUrlKeys.has(normalized) || imageAttachmentUrlKeys.size > 0)) {
            return null;
          }
          return (
            <a
              href={imageSrc}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                openExternalTarget(imageSrc);
              }}
            >
              {alt ? `${alt}（外部图片，点击打开）` : "外部图片（点击打开）"}
            </a>
          );
        }
        return <img {...props} src={imageSrc} alt={alt ?? "image"} loading="lazy" />;
      }
    };
  }, [hasImageAttachment, imageAttachmentUrlKeys, openExternalTarget]);

  return (
    <article className={`message-bubble role-${message.role}`} id={id}>
      <header>
        <strong>{ROLE_LABEL[message.role]}</strong>
        {message.model ? <span className="muted">{message.model}</span> : null}
      </header>

      {renderRichContent(displayContent, markdownComponents)}

      {displayAttachments.length > 0 ? (
        <div className="attachment-list">
          {displayAttachments.map((attachment) => {
            const href = resolveAttachmentHref(attachment);
            const previewSrc = resolveAttachmentPreviewSrc(attachment);
            const pdfPreviewSrc = resolvePdfPreviewSrc(attachment);
            const fileName = attachmentFileName(attachment);
            const openable = canOpenAttachment(attachment);
            return (
              <div className="attachment-item" key={attachment.id}>
                <div className="attachment-topline">
                  <span className="attachment-kind">{attachmentLabel(attachment)}</span>
                  <span className={`attachment-status ${attachment.status}`}>
                    {attachmentStatusLabel(attachment)}
                  </span>
                </div>

                {attachment.kind === "image" ? (
                  previewSrc ? (
                    <img src={previewSrc} alt="attachment preview" loading="lazy" />
                  ) : (
                    <div className="attachment-preview-placeholder">图片未缓存</div>
                  )
                ) : null}

                {attachment.kind === "pdf" ? (
                  pdfPreviewSrc ? (
                    <iframe
                      className="attachment-pdf-preview"
                      src={pdfPreviewSrc}
                      title={`preview-${attachment.id}`}
                    />
                  ) : (
                    <div className="attachment-preview-placeholder">PDF 未缓存</div>
                  )
                ) : null}

                <div className="attachment-meta">
                  <strong title={fileName}>{fileName}</strong>
                  {openable ? (
                    <button
                      className="ghost attachment-open"
                      onClick={() => {
                        openExternalTarget(href);
                      }}
                    >
                      打开
                    </button>
                  ) : (
                    <span className="muted">无可用链接</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {thoughtMarkdown ? (
        <details className="thought-block" open>
          <summary>思路</summary>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={markdownComponents}
          >
            {thoughtMarkdown}
          </ReactMarkdown>
        </details>
      ) : null}
    </article>
  );
}
