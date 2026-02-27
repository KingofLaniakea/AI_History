import {
  beginCaptureSessionWindow,
  countMaterializableAttachments,
  createCapturePayload,
  enrichChatGptTurnsWithApiAttachments,
  extractChatGptTurns,
  materializeAttachmentsOrThrow,
  type CaptureTurn,
  warmupSourceLazyResources
} from "./lib/extractor";

const CHATGPT_CAPTURE_DEBUG_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const CHATGPT_CAPTURE_BIND_KEY = "__AI_HISTORY_CHATGPT_CAPTURE_BOUND__";

interface AttachmentSummary {
  attachmentCount: number;
  inlinedCount: number;
  failedCount: number;
}

function summarizeAttachments(turns: CaptureTurn[]): AttachmentSummary {
  let attachmentCount = 0;
  let inlinedCount = 0;
  let failedCount = 0;
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) {
      attachmentCount += 1;
      if (attachment.originalUrl.startsWith("data:")) {
        inlinedCount += 1;
      }
      if (attachment.status === "failed") {
        failedCount += 1;
      }
    }
  }
  return { attachmentCount, inlinedCount, failedCount };
}

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  runAt: "document_idle",
  main() {
    const globalWindow = window as Window & Record<string, unknown>;
    if (globalWindow[CHATGPT_CAPTURE_BIND_KEY]) {
      return;
    }
    globalWindow[CHATGPT_CAPTURE_BIND_KEY] = true;

    console.info("[AI_HISTORY] chatgpt content ready", {
      version: CHATGPT_CAPTURE_DEBUG_VERSION
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "AI_HISTORY_PING") {
        sendResponse({
          ok: true,
          source: "chatgpt",
          version: CHATGPT_CAPTURE_DEBUG_VERSION
        });
        return;
      }

      if (message?.type !== "AI_HISTORY_CAPTURE") {
        return;
      }

      void (async () => {
        const captureRunId = typeof message?.captureRunId === "string" ? message.captureRunId : "";
        const emitProgress = (
          phase: "content" | "files",
          percent: number,
          status: string,
          extra: Record<string, unknown> = {}
        ) => {
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

        beginCaptureSessionWindow();
        emitProgress("content", 5, "正在加载页面内容");
        await warmupSourceLazyResources("chatgpt");
        emitProgress("content", 25, "正在解析对话");
        const turns = extractChatGptTurns();
        console.info("[AI_HISTORY] chatgpt capture start", {
          version: CHATGPT_CAPTURE_DEBUG_VERSION,
          turns: turns.length
        });
        if (!turns.length) {
          sendResponse({ ok: false, error: "未提取到会话内容" });
          return;
        }

        emitProgress("content", 45, "正在补齐会话元数据");
        const enrichedTurns = await enrichChatGptTurnsWithApiAttachments(turns);
        emitProgress("content", 100, "对话内容已提取");
        const estimatedAttachments = countMaterializableAttachments(enrichedTurns);
        emitProgress("files", 0, estimatedAttachments > 0 ? `正在准备附件下载（真实附件 ${estimatedAttachments}）` : "无附件", {
          processed: 0,
          total: estimatedAttachments,
          failed: 0
        });
        let finalizedTurns = enrichedTurns;
        let attachmentStageError = "";
        try {
          finalizedTurns = await materializeAttachmentsOrThrow("chatgpt", enrichedTurns, {
            continueOnFailure: true,
            onProgress: ({ processed, total, failed }) => {
              const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
              emitProgress("files", percent, "正在下载附件", {
                processed,
                total,
                failed
              });
            }
          });
        } catch (error) {
          attachmentStageError = error instanceof Error ? error.message : String(error);
          console.warn("[AI_HISTORY] attachment stage failed, fallback to content-only import", error);
          emitProgress("files", 100, "附件阶段失败，已降级为仅导入文本", {
            processed: 0,
            total: estimatedAttachments,
            failed: estimatedAttachments
          });
        }

        let summary = summarizeAttachments(finalizedTurns);
        emitProgress("files", 100, summary.failedCount > 0 ? `附件完成，失败 ${summary.failedCount}` : "附件下载完成", {
          processed: summary.attachmentCount,
          total: summary.attachmentCount,
          failed: summary.failedCount
        });
        console.info("[AI_HISTORY] chatgpt capture done", {
          turns: finalizedTurns.length,
          attachments: summary.attachmentCount,
          inlined: summary.inlinedCount,
          failed: summary.failedCount
        });
        const warnings: string[] = [];
        if (attachmentStageError) {
          warnings.push(`附件阶段异常：${attachmentStageError}`);
        }
        if (summary.failedCount > 0) {
          const successCount = Math.max(0, summary.attachmentCount - summary.failedCount);
          warnings.push(`附件下载失败 ${summary.failedCount} 个，成功 ${successCount} 个`);
        }
        sendResponse({
          ok: true,
          payload: createCapturePayload("chatgpt", finalizedTurns),
          warning: warnings.length > 0 ? warnings.join("；") : undefined
        });
      })().catch((error) => {
        console.error("[AI_HISTORY] chatgpt capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return true;
    });
  }
});
