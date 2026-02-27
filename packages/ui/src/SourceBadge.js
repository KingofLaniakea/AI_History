import React from "react";

export function SourceBadge({ source }) {
  const labels = {
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    ai_studio: "AI Studio",
    claude: "Claude"
  };
  return React.createElement("span", { className: `source-badge source-${source}` }, labels[source] || source);
}
