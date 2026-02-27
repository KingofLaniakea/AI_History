import type { NormalizedConversation, NormalizedTurn } from "@ai-history/core-types";
import { buildImportedConversation } from "../common/conversation-builders";
import { normalizeGeminiCapturedText } from "../common/gemini-text";
import type { ImportPayload, Parser } from "../contracts";
import { nonEmpty, normalizeRole, parseJsonSafe, toIsoString, toText } from "../utils";

function extractTurns(messageLike: unknown): NormalizedTurn[] {
  if (!Array.isArray(messageLike)) {
    return [];
  }

  return messageLike
    .map((m) => {
      const row = m as Record<string, unknown>;
      const role = normalizeRole(row.role ?? row.author ?? row.sender ?? row.type);
      const text = toText(row.text ?? row.content ?? row.parts ?? row.candidates ?? row.message);
      const contentMarkdown = normalizeGeminiCapturedText(text, role);
      if (!contentMarkdown) {
        return null;
      }

      return {
        role,
        contentMarkdown,
        thoughtMarkdown: null,
        timestamp: toIsoString(row.time ?? row.timestamp ?? row.createdAt),
        model: typeof row.model === "string" ? row.model : null
      } satisfies NormalizedTurn;
    })
    .filter(nonEmpty);
}

function parseConversationLike(item: Record<string, unknown>, filename: string): NormalizedConversation | null {
  const turns = extractTurns(
    item.turns ?? item.messages ?? item.history ?? item.entries ?? item.chat_messages
  );

  if (!turns.length) {
    return null;
  }

  return buildImportedConversation({
    source: "gemini",
    sourceConversationId: String(item.id ?? item.uuid ?? item.conversationId ?? "") || null,
    title: String(item.title ?? item.name ?? item.subject ?? "Untitled Gemini Conversation"),
    createdAt: toIsoString(item.createdAt ?? item.create_time),
    updatedAt: toIsoString(item.updatedAt ?? item.update_time),
    turns,
    importedFrom: filename
  });
}

export const geminiParser: Parser = {
  id: "gemini",
  canParse(payload) {
    const filename = payload.filename.toLowerCase();
    if (payload.sourceHint === "gemini") {
      return 100;
    }

    if (filename.includes("gemini") && filename.endsWith(".json")) {
      return 90;
    }

    if (filename.includes("takeout") && filename.endsWith(".json")) {
      return 60;
    }

    return 0;
  },
  async parse(payload: ImportPayload) {
    const parsed = parseJsonSafe(payload.text);

    if (!parsed) {
      return [];
    }

    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => parseConversationLike(item as Record<string, unknown>, payload.filename))
        .filter(nonEmpty);
    }

    if (typeof parsed === "object") {
      const asObj = parsed as Record<string, unknown>;
      if (Array.isArray(asObj.conversations)) {
        return asObj.conversations
          .map((item) => parseConversationLike(item as Record<string, unknown>, payload.filename))
          .filter(nonEmpty);
      }

      const single = parseConversationLike(asObj, payload.filename);
      return single ? [single] : [];
    }

    return [];
  }
};
