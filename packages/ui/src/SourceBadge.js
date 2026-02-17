import { jsx as _jsx } from "react/jsx-runtime";
import React from "react";
const LABELS = {
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    ai_studio: "AI Studio"
};
export function SourceBadge({ source }) {
    return _jsx("span", { className: `source-badge source-${source}`, children: LABELS[source] });
}
