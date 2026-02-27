import type { CapturePayload } from "../lib/extractor/types";

export type CapturePhase = "content" | "files";

export interface CaptureProgressEmitter {
  (phase: CapturePhase, percent: number, status: string, extra?: Record<string, unknown>): void;
}

export interface CaptureFlowSuccess {
  payload: CapturePayload;
  warning?: string;
}

export interface CaptureFlowInput {
  captureRunId: string;
  emitProgress: CaptureProgressEmitter;
}

export type CaptureFlowRunner = (input: CaptureFlowInput) => Promise<CaptureFlowSuccess>;

interface RegisterCaptureFlowOptions {
  bindKey: string;
  source: "chatgpt" | "gemini" | "ai_studio" | "claude";
  version: string;
  runCapture: CaptureFlowRunner;
}

type CaptureMessage = {
  type?: string;
  captureRunId?: unknown;
};

function createProgressEmitter(captureRunId: string): CaptureProgressEmitter {
  return (phase, percent, status, extra = {}) => {
    if (!captureRunId) {
      return;
    }
    try {
      void chrome.runtime.sendMessage({
        type: "AI_HISTORY_CAPTURE_PROGRESS",
        runId: captureRunId,
        phase,
        percent,
        status,
        ...extra
      });
    } catch {
      // ignore
    }
  };
}

export function registerCaptureFlow(options: RegisterCaptureFlowOptions): void {
  const globalWindow = window as Window & Record<string, unknown>;
  if (globalWindow[options.bindKey]) {
    return;
  }
  globalWindow[options.bindKey] = true;

  chrome.runtime.onMessage.addListener((message: CaptureMessage, _sender, sendResponse) => {
    if (message?.type === "AI_HISTORY_PING") {
      sendResponse({
        ok: true,
        source: options.source,
        version: options.version
      });
      return;
    }

    if (message?.type !== "AI_HISTORY_CAPTURE") {
      return;
    }

    void (async () => {
      const captureRunId = typeof message?.captureRunId === "string" ? message.captureRunId : "";
      const emitProgress = createProgressEmitter(captureRunId);
      const result = await options.runCapture({
        captureRunId,
        emitProgress
      });
      sendResponse({
        ok: true,
        payload: result.payload,
        warning: result.warning
      });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    return true;
  });
}
