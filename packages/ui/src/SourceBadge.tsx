import React from "react";
import type { SourcePlatform } from "@ai-history/core-types";

const LABELS: Record<SourcePlatform, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  ai_studio: "AI Studio"
};

export function SourceBadge({ source }: { source: SourcePlatform }) {
  return <span className={`source-badge source-${source}`}>{LABELS[source]}</span>;
}
