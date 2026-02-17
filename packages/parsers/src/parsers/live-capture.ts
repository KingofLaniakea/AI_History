import type { LiveCaptureRequest, NormalizedConversation } from "@ai-history/core-types";

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

export function liveCaptureToConversation(request: LiveCaptureRequest): NormalizedConversation {
  const turns = request.turns
    .map((turn) => {
      const base =
        request.source === "gemini" ? stripGeminiUiPrefixes(turn.contentMarkdown) : turn.contentMarkdown.trim();
      let contentMarkdown =
        request.source === "gemini" && turn.role === "assistant" ? stripGeminiBoilerplate(base) : base.trim();
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
