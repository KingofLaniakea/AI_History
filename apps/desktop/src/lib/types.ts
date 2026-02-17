import type { AttachmentRef, Conversation, Folder, Message, NormalizedConversation } from "@ai-history/core-types";

export interface ConversationSummary extends Conversation {
  messageCount: number;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  tags: string[];
  attachments: AttachmentRef[];
}

export interface ImportConflict {
  fingerprint: string;
  incomingTitle: string;
  existingTitle: string;
}

export interface ImportBatch {
  conversations: NormalizedConversation[];
  strategy: "skip" | "overwrite" | "duplicate";
  folderId?: string | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  conflicts: number;
}

export interface UrlImportInput {
  url: string;
  sourceHint?: Conversation["source"];
  strategy: "skip" | "overwrite" | "duplicate";
  folderId?: string | null;
}

export interface SearchResult {
  conversation: ConversationSummary;
  snippet: string;
}

export interface ListConversationsInput {
  folderId?: string | null;
  source?: Conversation["source"] | "all";
}

export type { Folder, Message };
