import type { NormalizedConversation, SourcePlatform } from "@ai-history/core-types";

export interface ImportPayload {
  filename: string;
  mime: string;
  text?: string;
  bytes?: Uint8Array;
  sourceHint?: SourcePlatform;
}

export interface Parser {
  id: SourcePlatform | "generic";
  canParse(payload: ImportPayload): number;
  parse(payload: ImportPayload): Promise<NormalizedConversation[]>;
}
