import type {
  CapturePayload,
  CaptureSource,
  CaptureTurn
} from "./types";

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (
      parsed.hostname.includes("chatgpt.com") ||
      parsed.hostname.includes("gemini.google.com") ||
      parsed.hostname.includes("bard.google.com") ||
      parsed.hostname.includes("aistudio.google.com") ||
      parsed.hostname.includes("claude.ai")
    ) {
      parsed.search = "";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function titleFromTurns(turns: CaptureTurn[]): string {
  const user = turns.find((turn) => turn.role === "user");
  if (!user) {
    return "Untitled Conversation";
  }
  return normalizeText(user.contentMarkdown).slice(0, 60) || "Untitled Conversation";
}

export function normalizeTitle(raw: string, fallback: string): string {
  const cleaned = normalizeText(
    raw
      .replace(/\s*\|\s*Google AI Studio$/i, "")
      .replace(/\s*-\s*Gemini$/i, "")
      .replace(/\s*-\s*ChatGPT$/i, "")
      .replace(/\s*-\s*Claude$/i, "")
      .trim()
  );
  if (!cleaned || /^(google gemini|gemini|chatgpt|google ai studio|claude)$/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function deriveTitle(source: CaptureSource, doc: Document, turns: CaptureTurn[]): string {
  const fallback = titleFromTurns(turns);
  const root = (doc.querySelector("main") as HTMLElement | null) || doc.body;

  if (source === "gemini") {
    const heading =
      root.querySelector("h1, h2, [data-test-id='conversation-title'], [aria-label*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  if (source === "ai_studio") {
    const heading =
      root.querySelector("h1, h2, [data-testid='prompt-title'], [aria-label*='title'], [class*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  if (source === "claude") {
    const heading =
      root.querySelector("h1, h2, [data-testid*='title'], [class*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  return normalizeTitle(doc.title || "", fallback);
}

export function inferSourceFromUrl(url: string): CaptureSource {
  if (url.includes("claude.ai")) {
    return "claude";
  }
  if (url.includes("aistudio.google.com")) {
    return "ai_studio";
  }
  if (url.includes("gemini.google.com") || url.includes("bard.google.com")) {
    return "gemini";
  }
  return "chatgpt";
}

export function createCapturePayload(source: CaptureSource, turns: CaptureTurn[]): CapturePayload {
  return {
    source,
    pageUrl: canonicalizePageUrl(location.href),
    title: deriveTitle(source, document, turns),
    turns,
    capturedAt: new Date().toISOString(),
    version: "1.2.0"
  };
}
