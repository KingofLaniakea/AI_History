import type { NormalizedConversation, NormalizedTurn, Role } from "@ai-history/core-types";
import type { ImportPayload, Parser } from "../contracts";

function toRole(raw: string): Role {
  const normalized = raw.toLowerCase();
  if (normalized.includes("user") || normalized.includes("human")) {
    return "user";
  }

  if (normalized.includes("assistant") || normalized.includes("model") || normalized.includes("ai")) {
    return "assistant";
  }

  return "assistant";
}

function parseSections(text: string): NormalizedTurn[] {
  const sections = text.split(/\n(?=##\s+)/g);

  return sections
    .map((section) => {
      const lines = section.split("\n");
      const header = lines[0] ?? "";
      if (!header.startsWith("## ")) {
        return null;
      }

      const role = toRole(header.replace(/^##\s+/, ""));
      const contentMarkdown = lines.slice(1).join("\n").trim();
      if (!contentMarkdown) {
        return null;
      }

      return {
        role,
        contentMarkdown
      } satisfies NormalizedTurn;
    })
    .filter((turn): turn is NormalizedTurn => Boolean(turn));
}

export const markdownParser: Parser = {
  id: "generic",
  canParse(payload) {
    const filename = payload.filename.toLowerCase();
    if (filename.endsWith(".md") || filename.endsWith(".markdown")) {
      return 65;
    }

    return 0;
  },
  async parse(payload: ImportPayload) {
    const text = payload.text ?? "";
    if (!text.trim()) {
      return [];
    }

    const turns = parseSections(text);

    if (!turns.length) {
      return [];
    }

    const now = new Date().toISOString();

    return [
      {
        source: payload.sourceHint ?? "chatgpt",
        sourceConversationId: null,
        title: payload.filename.replace(/\.(md|markdown)$/i, "") || "Imported Markdown Conversation",
        createdAt: now,
        updatedAt: now,
        turns,
        meta: {
          importedFrom: payload.filename,
          parser: "markdown"
        }
      }
    ];
  }
};
