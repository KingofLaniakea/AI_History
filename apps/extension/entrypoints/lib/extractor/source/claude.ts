import type { CaptureTurn } from "../types";
import {
  buildTurn,
  dedupeTurns,
  leafNodes,
  normalizeMarkdownText,
  parseByRoleMarkers,
  roleFromAttrs
} from "./common";

function parseByClaudeRoleMarkers(text: string): CaptureTurn[] {
  const lines = text.split(/\r?\n/);
  const turns: CaptureTurn[] = [];
  let role: CaptureTurn["role"] | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!role) {
      buffer = [];
      return;
    }
    const contentMarkdown = normalizeMarkdownText(buffer.join("\n"));
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

  const nodes = leafNodes(root, selector);
  const turns = nodes
    .map((node) => {
      const role = roleFromAttrs(node);
      return buildTurn(node, role);
    })
    .filter((turn): turn is CaptureTurn => Boolean(turn));

  const deduped = dedupeTurns(turns);
  if (deduped.length > 0 && deduped.some((turn) => turn.role === "user")) {
    return deduped;
  }

  const rawText = (root as HTMLElement).innerText || "";
  const markerTurns = dedupeTurns([
    ...parseByRoleMarkers(rawText),
    ...parseByClaudeRoleMarkers(rawText)
  ]);
  if (markerTurns.length > 0) {
    return markerTurns;
  }

  const plainText = normalizeMarkdownText(rawText);
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
