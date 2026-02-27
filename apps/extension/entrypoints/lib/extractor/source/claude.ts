import type { CaptureTurn } from "../types";

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dedupeTurns(turns: CaptureTurn[]): CaptureTurn[] {
  const out: CaptureTurn[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const content = normalizeText(turn.contentMarkdown);
    if (!content) {
      continue;
    }
    const key = `${turn.role}|${content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      ...turn,
      contentMarkdown: content
    });
  }
  return out;
}

function inferRole(node: Element): CaptureTurn["role"] | null {
  const roleAttr = (node.getAttribute("data-message-author-role") || node.getAttribute("data-role") || "").toLowerCase();
  if (roleAttr.includes("assistant") || roleAttr.includes("claude") || roleAttr.includes("model")) {
    return "assistant";
  }
  if (roleAttr.includes("user") || roleAttr.includes("human")) {
    return "user";
  }

  const hint = `${node.tagName.toLowerCase()} ${String((node as HTMLElement).className || "")} ${(node.getAttribute("class") || "")}`.toLowerCase();
  if (/assistant|claude|model/.test(hint)) {
    return "assistant";
  }
  if (/user|human|prompt/.test(hint)) {
    return "user";
  }
  return null;
}

function parseByRoleMarkers(text: string): CaptureTurn[] {
  const lines = text.split(/\r?\n/);
  const turns: CaptureTurn[] = [];
  let role: CaptureTurn["role"] | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!role) {
      buffer = [];
      return;
    }
    const contentMarkdown = normalizeText(buffer.join("\n"));
    if (!contentMarkdown) {
      buffer = [];
      return;
    }
    turns.push({ role, contentMarkdown, thoughtMarkdown: null });
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(you|user|human)\s*[:：]?$/i.test(trimmed)) {
      flush();
      role = "user";
      continue;
    }
    if (/^(assistant|claude|ai)\s*[:：]?$/i.test(trimmed)) {
      flush();
      role = "assistant";
      continue;
    }
    buffer.push(line);
  }
  flush();
  return dedupeTurns(turns);
}

export function extractClaudeTurns(doc: Document = document): CaptureTurn[] {
  const root = doc.querySelector("main") || doc.querySelector("[role='main']") || doc.body;

  const selector = [
    "[data-message-author-role]",
    "[data-role='user']",
    "[data-role='assistant']",
    "[class*='conversation-turn']",
    "[class*='message']",
    "article"
  ].join(",");

  const nodes = Array.from(root.querySelectorAll(selector));
  const turns = nodes
    .map((node) => {
      const role = inferRole(node);
      if (!role) {
        return null;
      }
      const contentMarkdown = normalizeText((node as HTMLElement).innerText || "");
      if (!contentMarkdown) {
        return null;
      }
      return {
        role,
        contentMarkdown,
        thoughtMarkdown: null
      } as CaptureTurn;
    })
    .filter((turn): turn is CaptureTurn => Boolean(turn));

  const deduped = dedupeTurns(turns);
  if (deduped.length > 0 && deduped.some((turn) => turn.role === "user")) {
    return deduped;
  }

  const markerTurns = parseByRoleMarkers((root as HTMLElement).innerText || "");
  if (markerTurns.length > 0) {
    return markerTurns;
  }

  const plainText = normalizeText((root as HTMLElement).innerText || "");
  if (plainText.length >= 20) {
    return [
      {
        role: "assistant",
        contentMarkdown: plainText,
        thoughtMarkdown: null
      }
    ];
  }

  return [];
}
