import type { NormalizedTurn, SourcePlatform } from "@ai-history/core-types";

export function detectSourceFromHtml(html: string): SourcePlatform {
  const lower = html.toLowerCase();

  if (lower.includes("aistudio.google.com") || lower.includes("ai studio")) {
    return "ai_studio";
  }

  if (lower.includes("claude.ai") || lower.includes("anthropic") || lower.includes("claude")) {
    return "claude";
  }

  if (lower.includes("gemini.google.com") || lower.includes("bard.google.com") || lower.includes("gemini")) {
    return "gemini";
  }

  return "chatgpt";
}

export function stripHtml(input: string): string {
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

export function parseTurnsByTextMarkers(text: string): NormalizedTurn[] {
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
    { regex: /^(assistant|chatgpt|gemini|claude|ai|模型|助手)[:：]?$/i, role: "assistant" },
    { regex: /^##\s*(user|你|human)\b/i, role: "user" },
    { regex: /^##\s*(assistant|chatgpt|gemini|claude|ai)\b/i, role: "assistant" }
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

export function parseTurnsByRoleAttributeRegex(html: string): NormalizedTurn[] {
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
