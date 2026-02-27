import type { NormalizedConversation, NormalizedTurn } from "@ai-history/core-types";
import { buildImportedConversation } from "../common/conversation-builders";
import type { ImportPayload, Parser } from "../contracts";
import { nonEmpty, normalizeRole, parseJsonSafe, toIsoString, toText } from "../utils";

interface ChatGptNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: {
    id?: string;
    create_time?: number;
    author?: { role?: string };
    recipient?: string;
    metadata?: Record<string, unknown>;
    content?: {
      content_type?: string;
      parts?: unknown[];
      text?: string;
    };
  };
}

interface ChatGptConversation {
  id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, ChatGptNode>;
}

function flattenMapping(mapping: Record<string, ChatGptNode> = {}): NormalizedTurn[] {
  const nodes = Object.values(mapping)
    .map((node) => ({
      role: normalizeRole(node.message?.author?.role),
      contentMarkdown: toText(node.message?.content?.parts ?? node.message?.content?.text ?? ""),
      timestamp: toIsoString(node.message?.create_time)
    }))
    .filter((turn) => turn.contentMarkdown.trim().length > 0)
    .filter(nonEmpty);

  return nodes;
}

export const chatGptParser: Parser = {
  id: "chatgpt",
  canParse(payload) {
    const filename = payload.filename.toLowerCase();
    if (payload.sourceHint === "chatgpt") {
      return 100;
    }

    if (filename.includes("conversations") && filename.endsWith(".json")) {
      return 95;
    }

    if (filename.includes("chatgpt") && filename.endsWith(".json")) {
      return 80;
    }

    return 0;
  },
  async parse(payload: ImportPayload) {
    const parsed = parseJsonSafe(payload.text);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => {
        const conv = item as ChatGptConversation;
        const turns = flattenMapping(conv.mapping);

        if (turns.length === 0) {
          return null;
        }

        return buildImportedConversation({
          source: "chatgpt",
          sourceConversationId: conv.id ?? null,
          title: conv.title?.trim() || "Untitled ChatGPT Conversation",
          createdAt: toIsoString(conv.create_time),
          updatedAt: toIsoString(conv.update_time),
          turns,
          importedFrom: payload.filename
        });
      })
      .filter(nonEmpty);
  }
};
