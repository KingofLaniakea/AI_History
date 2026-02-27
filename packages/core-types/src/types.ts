export type SourcePlatform = "chatgpt" | "gemini" | "ai_studio" | "claude";

export type Role = "user" | "assistant" | "system" | "tool";
export type AttachmentKind = "image" | "pdf" | "file";
export type AttachmentStatus = "cached" | "failed" | "remote_only";

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  source: SourcePlatform;
  sourceConversationId: string | null;
  folderId: string | null;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  metaJson: string;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: Role;
  contentMarkdown: string;
  thoughtMarkdown: string | null;
  model: string | null;
  timestamp: string | null;
  tokenCount: number | null;
}

export interface AttachmentInput {
  kind: AttachmentKind;
  originalUrl: string;
  mime?: string | null;
  status?: AttachmentStatus | null;
}

export interface AttachmentRef {
  id: string;
  messageId: string;
  conversationId: string;
  kind: AttachmentKind;
  originalUrl: string;
  localPath: string | null;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  status: AttachmentStatus;
  error: string | null;
  createdAt: string;
}

export interface NormalizedTurn {
  role: Role;
  contentMarkdown: string;
  thoughtMarkdown?: string | null;
  attachments?: AttachmentInput[] | null;
  model?: string | null;
  timestamp?: string | null;
  tokenCount?: number | null;
}

export interface NormalizedConversation {
  source: SourcePlatform;
  sourceConversationId: string | null;
  title: string;
  summary?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  turns: NormalizedTurn[];
  meta?: Record<string, unknown>;
}

export interface LiveCaptureRequest {
  source: SourcePlatform;
  pageUrl: string;
  title: string;
  turns: NormalizedTurn[];
  capturedAt: string;
  version: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  conflicts: number;
}
