import type { CaptureSource } from "../types";

interface WarmupScrollableConfig {
  downSteps: number;
  downWaitMs: number;
  upWaitMs: number;
}

export interface WarmupSourceDeps {
  ensureRuntimeNetworkTracker: () => void;
  warmupScrollableArea: (doc: Document, config: WarmupScrollableConfig) => Promise<void>;
  warmupChatGptLazyResources: (doc: Document) => Promise<void>;
}

export async function warmupAiStudioLazyResourcesWith(
  doc: Document,
  deps: Pick<WarmupSourceDeps, "warmupScrollableArea">
): Promise<void> {
  await deps.warmupScrollableArea(doc, {
    downSteps: 40,
    downWaitMs: 130,
    upWaitMs: 80
  });
}

export async function warmupSourceLazyResourcesWith(
  source: CaptureSource,
  doc: Document,
  deps: WarmupSourceDeps
): Promise<void> {
  deps.ensureRuntimeNetworkTracker();
  if (source === "ai_studio") {
    await warmupAiStudioLazyResourcesWith(doc, deps);
    return;
  }

  if (source === "chatgpt") {
    await deps.warmupChatGptLazyResources(doc);
    return;
  }

  await deps.warmupScrollableArea(doc, {
    downSteps: 40,
    downWaitMs: 95,
    upWaitMs: 55
  });
}
