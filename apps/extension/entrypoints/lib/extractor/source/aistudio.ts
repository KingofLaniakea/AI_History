type SourceRole = "user" | "assistant" | "system" | "tool";

export interface AiStudioExtractorDeps<Turn extends { role: SourceRole }> {
  normalizeText: (raw: string) => string;
  leafNodes: (root: ParentNode, selector: string) => Element[];
  buildTurn: (node: Element) => Turn | null;
  dedupeTurns: (turns: Turn[]) => Turn[];
  parseByRoleMarkers: (raw: string) => Turn[];
}

function scoreAiStudioRoot(root: Element, normalizeText: (raw: string) => string): number {
  const turnCount = root.querySelectorAll(
    "[data-role='user'], [data-role='assistant'], [data-role='model'], ms-chat-turn, [data-testid*='chat-turn'], [class*='chat-turn']"
  ).length;

  const text = normalizeText((root as HTMLElement).innerText || "");
  let noisePenalty = 0;
  if (/skip to main content|settings|get api key|developer_guide|documentation/i.test(text)) {
    noisePenalty += 8;
  }
  return turnCount * 5 - noisePenalty;
}

function pickAiStudioRoot(doc: Document, normalizeText: (raw: string) => string): Element {
  const candidates = [
    doc.querySelector("main"),
    doc.querySelector("[role='main']"),
    doc.querySelector("[data-testid*='conversation']"),
    doc.querySelector("[class*='conversation']")
  ].filter((node): node is Element => Boolean(node));

  if (candidates.length === 0) {
    return doc.body;
  }

  return candidates.sort((a, b) => scoreAiStudioRoot(b, normalizeText) - scoreAiStudioRoot(a, normalizeText))[0] ?? doc.body;
}

export function extractAiStudioTurnsWith<Turn extends { role: SourceRole }>(
  doc: Document,
  deps: AiStudioExtractorDeps<Turn>
): Turn[] {
  const root = pickAiStudioRoot(doc, deps.normalizeText);
  const selector = [
    "[data-role='user']",
    "[data-role='assistant']",
    "[data-role='model']",
    "[data-message-author-role]",
    "ms-chat-turn",
    "[data-testid*='chat-turn']",
    "[class*='chat-turn']",
    "[class*='conversation-turn']"
  ].join(",");

  const candidates = deps.leafNodes(root, selector).filter((node) => {
    const element = node as HTMLElement;
    return !element.closest("nav, header, aside, [role='navigation']");
  });

  const turns = candidates
    .map((node) => deps.buildTurn(node))
    .filter((v): v is Turn => Boolean(v));

  const deduped = deps.dedupeTurns(turns);
  if (deduped.some((turn) => turn.role === "user") && deduped.length >= 2) {
    return deduped;
  }

  return deps.dedupeTurns(deps.parseByRoleMarkers((root as HTMLElement).innerText || ""));
}
