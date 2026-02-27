import type { NormalizedConversation, NormalizedTurn } from "@ai-history/core-types";
import { buildImportedConversation } from "../common/conversation-builders";
import type { ImportPayload, Parser } from "../contracts";
import { nonEmpty, normalizeRole, parseJsonSafe, toIsoString, toText } from "../utils";

function parseTurns(raw: unknown): NormalizedTurn[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      const msg = item as Record<string, unknown>;
      const role = normalizeRole(msg.role ?? msg.author ?? msg.sender);
      const contentMarkdown = toText(msg.content ?? msg.text ?? msg.parts ?? msg.data);
      if (!contentMarkdown.trim()) {
        return null;
      }

      return {
        role,
        contentMarkdown,
        timestamp: toIsoString(msg.timestamp ?? msg.time ?? msg.createdAt),
        model: typeof msg.model === "string" ? msg.model : null
      } satisfies NormalizedTurn;
    })
    .filter(nonEmpty);
}

function toConversation(item: Record<string, unknown>, filename: string): NormalizedConversation | null {
  const turns = parseTurns(item.messages ?? item.turns ?? item.history ?? item.prompts);

  if (!turns.length) {
    return null;
  }

  return buildImportedConversation({
    source: "ai_studio",
    sourceConversationId: String(item.id ?? item.uuid ?? item.conversationId ?? "") || null,
    title: String(item.title ?? item.name ?? "Untitled AI Studio Conversation"),
    createdAt: toIsoString(item.createdAt ?? item.create_time),
    updatedAt: toIsoString(item.updatedAt ?? item.update_time),
    turns,
    importedFrom: filename
  });
}

export const aiStudioParser: Parser = {
  id: "ai_studio",
  canParse(payload) {
    const filename = payload.filename.toLowerCase();

    if (payload.sourceHint === "ai_studio") {
      return 100;
    }

    if (
      filename.includes("ai studio") ||
      filename.includes("aistudio") ||
      filename.includes("google-ai-studio") ||
      filename.includes("ai-studio")
    ) {
      return 92;
    }

    if (filename.includes("prompt") && filename.endsWith(".json")) {
      return 40;
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
        .map((row) => toConversation(row as Record<string, unknown>, payload.filename))
        .filter(nonEmpty);
    }

    if (typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.conversations)) {
        return obj.conversations
          .map((row) => toConversation(row as Record<string, unknown>, payload.filename))
          .filter(nonEmpty);
      }

      const single = toConversation(obj, payload.filename);
      return single ? [single] : [];
    }

    return [];
  }
};
