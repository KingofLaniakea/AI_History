import type { NormalizedConversation, NormalizedTurn, SourcePlatform } from "@ai-history/core-types";

interface BuildImportedConversationInput {
  source: SourcePlatform;
  sourceConversationId?: string | null;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  turns: NormalizedTurn[];
  importedFrom: string;
  meta?: Record<string, unknown>;
}

export function buildImportedConversation(input: BuildImportedConversationInput): NormalizedConversation {
  return {
    source: input.source,
    sourceConversationId: input.sourceConversationId ?? null,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    turns: input.turns,
    meta: {
      importedFrom: input.importedFrom,
      ...(input.meta || {})
    }
  };
}
