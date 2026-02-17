import type { NormalizedConversation, NormalizedTurn } from "@ai-history/core-types";
import type { ImportPayload, Parser } from "../contracts";
import { nonEmpty, normalizeRole, parseJsonSafe, toIsoString, toText } from "../utils";

const GEMINI_BOILERPLATE_MARKERS = [
  "如果你想让我保存或删除我们对话中关于你的信息",
  "你需要先开启过往对话记录",
  "你也可以手动添加或更新你给gemini的指令",
  "从而定制gemini的回复",
  "ifyouwantmetosaveordeleteinformationfromourconversations",
  "youneedtoturnonchathistory",
  "youcanalsomanuallyaddorupdateyourinstructionsforgemini"
];

function normalizeForGeminiFilter(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function stripGeminiBoilerplate(text: string): string {
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

function stripGeminiUiPrefixes(text: string): string {
  return text
    .replace(/^you said\s*/i, "")
    .replace(/^gemini said\s*/i, "")
    .replace(/^显示思路\s*id_?\s*/i, "")
    .trim();
}

function extractTurns(messageLike: unknown): NormalizedTurn[] {
  if (!Array.isArray(messageLike)) {
    return [];
  }

  return messageLike
    .map((m) => {
      const row = m as Record<string, unknown>;
      const role = normalizeRole(row.role ?? row.author ?? row.sender ?? row.type);
      const text = toText(row.text ?? row.content ?? row.parts ?? row.candidates ?? row.message);
      const base = stripGeminiUiPrefixes(text);
      const contentMarkdown = role === "assistant" ? stripGeminiBoilerplate(base) : base;
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

  return {
    source: "gemini",
    sourceConversationId: String(item.id ?? item.uuid ?? item.conversationId ?? "") || null,
    title: String(item.title ?? item.name ?? item.subject ?? "Untitled Gemini Conversation"),
    createdAt: toIsoString(item.createdAt ?? item.create_time),
    updatedAt: toIsoString(item.updatedAt ?? item.update_time),
    turns,
    meta: {
      importedFrom: filename
    }
  };
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
