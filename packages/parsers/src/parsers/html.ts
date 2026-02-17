import type { NormalizedConversation, NormalizedTurn, SourcePlatform } from "@ai-history/core-types";
import type { ImportPayload, Parser } from "../contracts";
import { normalizeRole, toText } from "../utils";

function detectSourceFromHtml(html: string): SourcePlatform {
  const lower = html.toLowerCase();

  if (lower.includes("aistudio.google.com") || lower.includes("ai studio")) {
    return "ai_studio";
  }

  if (lower.includes("gemini.google.com") || lower.includes("bard.google.com") || lower.includes("gemini")) {
    return "gemini";
  }

  return "chatgpt";
}

function stripHtml(input: string): string {
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseByMarkers(text: string): NormalizedTurn[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const turns: NormalizedTurn[] = [];
  let currentRole: NormalizedTurn["role"] | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentRole || buffer.length === 0) {
      buffer = [];
      return;
    }

    const contentMarkdown = buffer.join("\n").trim();
    if (contentMarkdown) {
      turns.push({
        role: currentRole,
        contentMarkdown
      });
    }

    buffer = [];
  };

  const markerPatterns: Array<{ regex: RegExp; role: NormalizedTurn["role"] }> = [
    { regex: /^(user|你|human)[:：]?$/i, role: "user" },
    { regex: /^(assistant|chatgpt|gemini|ai|模型|助手)[:：]?$/i, role: "assistant" },
    { regex: /^##\s*(user|你|human)\b/i, role: "user" },
    { regex: /^##\s*(assistant|chatgpt|gemini|ai)\b/i, role: "assistant" }
  ];

  for (const line of lines) {
    const marker = markerPatterns.find((pattern) => pattern.regex.test(line));
    if (marker) {
      flush();
      currentRole = marker.role;
      continue;
    }

    if (!currentRole) {
      continue;
    }

    buffer.push(line);
  }

  flush();

  return turns;
}

function parseByRoleAttributeRegex(html: string): NormalizedTurn[] {
  const regex = new RegExp(
    "data-message-author-role\\s*=\\s*['\\\"]?(user|assistant|system|tool)['\\\"]?[^>]*>([\\s\\S]*?)<\\/[^>]+>",
    "gi"
  );
  const turns: NormalizedTurn[] = [];

  for (const match of html.matchAll(regex)) {
    const role = match[1] as NormalizedTurn["role"];
    const raw = match[2] ?? "";
    const contentMarkdown = stripHtml(raw).trim();
    if (!contentMarkdown) {
      continue;
    }

    turns.push({
      role,
      contentMarkdown
    });
  }

  return turns;
}

function parseFromDom(html: string): NormalizedTurn[] {
  if (typeof DOMParser === "undefined") {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");

  const candidates = Array.from(
    doc.querySelectorAll(
      [
        "[data-message-author-role]",
        "[data-author-role]",
        "[data-role]",
        "[data-testid*='conversation-turn']",
        "article[data-role]"
      ].join(",")
    )
  );

  const turns: NormalizedTurn[] = [];

  for (const node of candidates) {
    const roleRaw =
      node.getAttribute("data-message-author-role") ||
      node.getAttribute("data-author-role") ||
      node.getAttribute("data-role") ||
      node.getAttribute("data-testid") ||
      node.className;

    const role = normalizeRole(roleRaw);
    const contentMarkdown = toText(node.textContent ?? "").trim();

    if (!contentMarkdown || contentMarkdown.length < 2) {
      continue;
    }

    turns.push({
      role,
      contentMarkdown
    });
  }

  return turns;
}

export const htmlParser: Parser = {
  id: "generic",
  canParse(payload) {
    const filename = payload.filename.toLowerCase();
    const mime = payload.mime.toLowerCase();
    const text = payload.text?.slice(0, 300).toLowerCase() ?? "";

    if (mime.includes("text/html")) {
      return 96;
    }

    if (filename.endsWith(".html") || filename.endsWith(".htm")) {
      return 95;
    }

    if (text.includes("<html") || text.includes("<!doctype html")) {
      return 90;
    }

    if (filename.startsWith("http://") || filename.startsWith("https://")) {
      return 70;
    }

    return 0;
  },
  async parse(payload) {
    const html = payload.text ?? "";
    if (!html.trim()) {
      return [];
    }

    const source = payload.sourceHint ?? detectSourceFromHtml(html);
    const domTurns = parseFromDom(html);
    const roleAttrTurns = parseByRoleAttributeRegex(html);
    const textTurns = parseByMarkers(stripHtml(html));
    const sourceConversationId = payload.filename.startsWith("http://") || payload.filename.startsWith("https://")
      ? payload.filename
      : null;

    const turns = domTurns.length >= 2 ? domTurns : roleAttrTurns.length >= 2 ? roleAttrTurns : textTurns;
    if (!turns.length) {
      return [];
    }

    const now = new Date().toISOString();

    return [
      {
        source,
        sourceConversationId,
        title: payload.filename.startsWith("http") ? payload.filename : payload.filename.replace(/\.(html|htm)$/i, ""),
        createdAt: now,
        updatedAt: now,
        turns,
        meta: {
          importedFrom: payload.filename,
          parser: "html"
        }
      } satisfies NormalizedConversation
    ];
  }
};
