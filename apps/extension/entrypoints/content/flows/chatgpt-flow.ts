import {
  beginCaptureSessionWindow,
  countMaterializableAttachments,
  createCapturePayload,
  enrichChatGptTurnsWithApiAttachments,
  extractChatGptTurns,
  materializeAttachmentsOrThrow,
  type CaptureTurn,
  warmupSourceLazyResources
} from "../../lib/extractor";
import type { CaptureFlowRunner } from "../capture-runtime";

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

export const runChatGptCaptureFlow: CaptureFlowRunner = async ({ emitProgress }) => {
  beginCaptureSessionWindow();
  emitProgress("content", 5, "正在加载页面内容");
  await warmupSourceLazyResources("chatgpt");
  emitProgress("content", 25, "正在解析对话");
  const turns = extractChatGptTurns();
  if (!turns.length) {
    throw new Error("未提取到会话内容");
  }

  emitProgress("content", 45, "正在补齐会话元数据");
  const enrichedTurns = await enrichChatGptTurnsWithApiAttachments(turns);
  emitProgress("content", 100, "对话内容已提取");
  const estimatedAttachments = countMaterializableAttachments(enrichedTurns);
  emitProgress(
    "files",
    0,
    estimatedAttachments > 0 ? `正在准备附件下载（真实附件 ${estimatedAttachments}）` : "无附件",
    {
      processed: 0,
      total: estimatedAttachments,
      failed: 0
    }
  );
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

  const summary = summarizeAttachments(finalizedTurns);
  emitProgress("files", 100, summary.failedCount > 0 ? `附件完成，失败 ${summary.failedCount}` : "附件下载完成", {
    processed: summary.attachmentCount,
    total: summary.attachmentCount,
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

  return {
    payload: createCapturePayload("chatgpt", finalizedTurns),
    warning: warnings.length > 0 ? warnings.join("；") : undefined
  };
};
