import type { NormalizedConversation, NormalizedTurn, SourcePlatform } from "@ai-history/core-types";
import { buildImportedConversation } from "../common/conversation-builders";
import {
  detectSourceFromHtml,
  parseTurnsByRoleAttributeRegex,
  parseTurnsByTextMarkers,
  stripHtml
} from "../common/text-markers";
import type { ImportPayload, Parser } from "../contracts";
import { normalizeRole, toText } from "../utils";

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
    const roleAttrTurns = parseTurnsByRoleAttributeRegex(html);
    const textTurns = parseTurnsByTextMarkers(stripHtml(html));
    const sourceConversationId = payload.filename.startsWith("http://") || payload.filename.startsWith("https://")
      ? payload.filename
      : null;

    const turns = domTurns.length >= 2 ? domTurns : roleAttrTurns.length >= 2 ? roleAttrTurns : textTurns;
    if (!turns.length) {
      return [];
    }

    const now = new Date().toISOString();

    return [
      buildImportedConversation({
        source,
        sourceConversationId,
        title: payload.filename.startsWith("http") ? payload.filename : payload.filename.replace(/\.(html|htm)$/i, ""),
        createdAt: now,
        updatedAt: now,
        turns,
        importedFrom: payload.filename,
        meta: {
          parser: "html"
        }
      })
    ];
  }
};
