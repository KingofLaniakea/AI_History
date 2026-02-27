export type CaptureSource = "chatgpt" | "gemini" | "ai_studio" | "claude";

export interface CaptureAttachment {
  kind: "image" | "pdf" | "file";
  originalUrl: string;
  mime?: string | null;
  status?: "remote_only" | "cached" | "failed" | null;
}

export interface CaptureTurn {
  role: "user" | "assistant" | "system" | "tool";
  contentMarkdown: string;
  thoughtMarkdown?: string | null;
  attachments?: CaptureAttachment[] | null;
  model?: string | null;
  timestamp?: string | null;
}

export interface CapturePayload {
  source: CaptureSource;
  pageUrl: string;
  title: string;
  turns: CaptureTurn[];
  capturedAt: string;
  version: string;
}
