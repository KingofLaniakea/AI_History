type SourceRole = "user" | "assistant" | "system" | "tool";

export interface GeminiExtractorDeps<Turn extends { role: SourceRole }> {
  leafNodes: (root: ParentNode, selector: string) => Element[];
  roleFromAttrs: (node: Element) => SourceRole | null;
  buildTurn: (node: Element, fallbackRole?: SourceRole | null) => Turn | null;
  sanitizeTurn: (turn: Turn) => Turn | null;
  dedupeTurns: (turns: Turn[]) => Turn[];
  parseByRoleMarkers: (raw: string) => Turn[];
}

export function extractGeminiTurnsWith<Turn extends { role: SourceRole }>(
  doc: Document,
  deps: GeminiExtractorDeps<Turn>
): Turn[] {
  const root = doc.querySelector("main") || doc.querySelector("[role='main']") || doc.body;

  const selector = [
    "user-query",
    "model-response",
    "[data-test-id='user-query']",
    "[data-test-id='user-message']",
    "[data-test-id='model-response']",
    "[data-test-id='conversation-turn']",
    "[class*='user-query']",
    "[class*='model-response']",
    "[class*='response-content']"
  ].join(",");

  const candidates = deps.leafNodes(root, selector);
  const turns: Turn[] = [];
  for (const node of candidates) {
    let role = deps.roleFromAttrs(node);
    const hint = `${node.tagName.toLowerCase()} ${(node.getAttribute("data-test-id") || "").toLowerCase()} ${String(
      (node as HTMLElement).className || ""
    ).toLowerCase()}`;
    if (!role) {
      if (/user-query|user-message|query-input/.test(hint)) {
        role = "user";
      } else if (/model-response|response-content|response/.test(hint)) {
        role = "assistant";
      }
    }

    const turn = deps.buildTurn(node, role);
    if (!turn) {
      continue;
    }
    const sanitized = deps.sanitizeTurn(turn);
    if (sanitized) {
      turns.push(sanitized);
    }
  }

  const deduped = deps.dedupeTurns(turns);
  if (deduped.some((turn) => turn.role === "user") && deduped.length >= 2) {
    return deduped;
  }

  return deps.dedupeTurns(
    deps
      .parseByRoleMarkers((root as HTMLElement).innerText || "")
      .map((turn) => deps.sanitizeTurn(turn))
      .filter((turn): turn is Turn => Boolean(turn))
  );
}
