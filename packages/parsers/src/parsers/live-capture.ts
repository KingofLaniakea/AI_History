import type { LiveCaptureRequest, NormalizedConversation } from "@ai-history/core-types";
import { normalizeGeminiCapturedText } from "../common/gemini-text";

export function liveCaptureToConversation(request: LiveCaptureRequest): NormalizedConversation {
  const turns = request.turns
    .map((turn) => {
      let contentMarkdown =
        request.source === "gemini"
          ? normalizeGeminiCapturedText(turn.contentMarkdown, turn.role)
          : turn.contentMarkdown.trim();
      const hasAttachments = Boolean(turn.attachments && turn.attachments.length > 0);
      if (!contentMarkdown && hasAttachments) {
        contentMarkdown = "（仅附件消息）";
      }
      if (!contentMarkdown) {
        return null;
      }
      return {
        ...turn,
        contentMarkdown,
        thoughtMarkdown: request.source === "gemini" ? null : turn.thoughtMarkdown ?? null
      };
    })
    .filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));

  return {
    source: request.source,
    sourceConversationId: request.pageUrl,
    title: request.title,
    createdAt: request.capturedAt,
    updatedAt: request.capturedAt,
    turns,
    meta: {
      pageUrl: request.pageUrl,
      capturedBy: "extension",
      schemaVersion: request.version
    }
  };
}
