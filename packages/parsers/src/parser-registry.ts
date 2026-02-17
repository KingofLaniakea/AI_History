import type { NormalizedConversation } from "@ai-history/core-types";
import type { ImportPayload, Parser } from "./contracts";
import { aiStudioParser } from "./parsers/aistudio";
import { chatGptParser } from "./parsers/chatgpt";
import { geminiParser } from "./parsers/gemini";
import { htmlParser } from "./parsers/html";
import { markdownParser } from "./parsers/markdown";

const allParsers: Parser[] = [chatGptParser, geminiParser, aiStudioParser, htmlParser, markdownParser];

export interface ParserSelection {
  parser: Parser;
  score: number;
}

export function selectParser(payload: ImportPayload): ParserSelection | null {
  const sorted = allParsers
    .map((parser) => ({ parser, score: parser.canParse(payload) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return sorted[0] ?? null;
}

export async function parseImportPayload(payload: ImportPayload): Promise<NormalizedConversation[]> {
  const selected = selectParser(payload);
  if (!selected) {
    return [];
  }

  return selected.parser.parse(payload);
}

export function getParsers(): Parser[] {
  return allParsers;
}
