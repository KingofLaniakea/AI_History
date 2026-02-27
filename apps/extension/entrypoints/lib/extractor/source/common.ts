import {
  isLikelyOaiAttachmentUrl,
  looksLikeFileUrl,
  looksLikeImageUrl,
  looksLikePdfUrl
} from "../attachments/classify";
import type {
  CaptureAttachment,
  CaptureTurn
} from "../types";

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

export type TurnRole = CaptureTurn["role"];

export interface BuildTurnOptions {
  extractAttachments?: (node: ParentNode) => CaptureAttachment[];
  extractAttachmentsFromMarkdownText?: (markdown: string) => CaptureAttachment[];
  mergeTurnAttachments?: (
    current: CaptureAttachment[] | null | undefined,
    incoming: CaptureAttachment[] | null | undefined
  ) => CaptureAttachment[] | null;
}

export interface DedupeTurnsOptions {
  mergeTurnAttachments?: (
    current: CaptureAttachment[] | null | undefined,
    incoming: CaptureAttachment[] | null | undefined
  ) => CaptureAttachment[] | null;
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

function mergeAttachmentArrays(
  current: CaptureAttachment[] | null | undefined,
  incoming: CaptureAttachment[] | null | undefined
): CaptureAttachment[] | null {
  const out = [...(current || []), ...(incoming || [])];
  if (!out.length) {
    return null;
  }
  const seen = new Set<string>();
  const deduped: CaptureAttachment[] = [];
  for (const attachment of out) {
    const key = `${attachment.kind}|${attachment.originalUrl}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attachment);
  }
  return deduped.length ? deduped : null;
}

export function decodeHtml(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

export function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ");
}

export function fixDanglingMathDelimiters(text: string): string {
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

export function fixMatrixRows(text: string): string {
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

export function wrapStandaloneLatexBlocks(text: string): string {
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

export function readLatex(node: Element): string {
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

export function replaceMathWithLatex(root: Element, doc: Document): void {
  const displaySelectors = [
    ".katex-display",
    "[class*='katex-display']",
    "math[display='block']",
    "[data-display='block']",
    "mjx-container[display='true']",
    "mjx-container[jax='CHTML'][display='true']",
    "[class*='math-display']",
    "[class*='formula-display']"
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
    ".katex",
    "math",
    "[data-tex]",
    "[data-latex]",
    "mjx-container",
    "[class*='math-inline']",
    "[class*='formula']"
  ].join(", ");

  const inlineNodes = Array.from(root.querySelectorAll(inlineSelectors));
  for (const node of inlineNodes) {
    if (node.closest(displaySelectors)) {
      continue;
    }
    const latex = readLatex(node);
    if (!latex) {
      const text = (node.textContent || "").trim();
      if (text && node.tagName.toLowerCase() !== "div") {
        node.replaceWith(doc.createTextNode(`$${text}$`));
      }
      continue;
    }
    node.replaceWith(doc.createTextNode(`$${latex}$`));
  }
}

export function htmlToMarkdownish(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (root) {
    replaceMathWithLatex(root, doc);

    for (
      const icon of Array.from(
        root.querySelectorAll(
          ".material-icons, .material-symbols-outlined, .material-symbols-rounded, [class*='icon-button'], [aria-hidden='true']"
        )
      )
    ) {
      icon.remove();
    }

    for (const table of Array.from(root.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      const mdRows: string[] = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (!row) {
          continue;
        }
        const cells = Array.from(row.querySelectorAll("th, td"));
        const line =
          "| " +
          cells
            .map((cell) => (cell.textContent || "").trim().replace(/\|/g, "\\|").replace(/\n/g, " "))
            .join(" | ") +
          " |";
        mdRows.push(line);
        if (rowIndex === 0) {
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

export function normalizeMarkdownText(text: string): string {
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

export function normalizeForDedupe(content: string): string {
  return content
    .replace(/^you said\s*/i, "")
    .replace(/^显示思路\s*gemini said\s*/i, "")
    .replace(/^gemini said\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeForGeminiFilter(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

export function stripGeminiBoilerplate(text: string): string {
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

export function stripGeminiUiPrefixes(text: string): string {
  return text
    .replace(/^you said\s*/i, "")
    .replace(/^gemini said\s*/i, "")
    .replace(/^显示思路\s*id_?\s*/i, "")
    .trim();
}

export function splitThoughts(raw: string): { contentMarkdown: string; thoughtMarkdown: string | null } {
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
    return { contentMarkdown: thoughtMarkdown, thoughtMarkdown: null };
  }
  return { contentMarkdown, thoughtMarkdown: thoughtMarkdown || null };
}

export function extractNodeTextAndThought(node: Element): {
  contentMarkdown: string;
  thoughtMarkdown: string | null;
} {
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

export function leafNodes(root: ParentNode, selector: string): Element[] {
  const nodes = Array.from(root.querySelectorAll(selector));
  return nodes.filter((node) => !Array.from(node.children).some((child) => (child as Element).matches(selector)));
}

export function roleFromAttrs(node: Element): TurnRole | null {
  const attrs = `${node.getAttribute("data-message-author-role") || ""} ${node.getAttribute("data-role") || ""} ${
    node.getAttribute("aria-label") || ""
  } ${node.getAttribute("data-testid") || ""} ${String((node as HTMLElement).className || "")}`.toLowerCase();

  if (/user|human|prompt|query/.test(attrs)) {
    return "user";
  }
  if (/assistant|claude|model|ai|response|bot/.test(attrs)) {
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

export function buildTurn(
  node: Element,
  fallbackRole: TurnRole | null = null,
  options: BuildTurnOptions = {}
): CaptureTurn | null {
  const role = fallbackRole ?? roleFromAttrs(node);
  if (!role) {
    return null;
  }

  const { contentMarkdown, thoughtMarkdown } = extractNodeTextAndThought(node);
  const directAttachments = options.extractAttachments ? options.extractAttachments(node) : [];
  const textAttachments = options.extractAttachmentsFromMarkdownText
    ? options.extractAttachmentsFromMarkdownText(contentMarkdown)
    : [];
  const mergeAttachments = options.mergeTurnAttachments || mergeAttachmentArrays;
  const attachments = mergeAttachments(directAttachments, textAttachments) ?? [];
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

export function dedupeTurns(turns: CaptureTurn[], options: DedupeTurnsOptions = {}): CaptureTurn[] {
  const indexByKey = new Map<string, number>();
  const out: CaptureTurn[] = [];
  const mergeAttachments = options.mergeTurnAttachments || mergeAttachmentArrays;

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
        attachments: mergeAttachments(previous.attachments, turn.attachments)
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

export function parseByRoleMarkers(text: string): CaptureTurn[] {
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
    const current = matches[i];
    if (!current) {
      continue;
    }
    const start = (current.index || 0) + current[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]?.index || normalized.length : normalized.length;

    const roleName = current[1].toLowerCase();
    const role: TurnRole = roleName === "assistant" || roleName === "model" || roleName === "ai" ? "assistant" : "user";
    const contentMarkdown = normalizeMarkdownText(normalized.slice(start, end));
    if (!contentMarkdown || contentMarkdown.length < 2) {
      continue;
    }
    turns.push({ role, contentMarkdown });
  }

  return turns;
}

export function sanitizeGeminiTurn(turn: CaptureTurn): CaptureTurn | null {
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

export function isNavigationUrl(url: string): boolean {
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
