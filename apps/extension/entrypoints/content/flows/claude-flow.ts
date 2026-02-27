import {
  beginCaptureSessionWindow,
  createCapturePayload,
  extractClaudeTurns,
  materializeAttachmentsOrThrow,
  type CaptureTurn,
  warmupSourceLazyResources
} from "../../lib/extractor";
import type { CaptureFlowRunner } from "../capture-runtime";

interface AttachmentSummary {
  attachmentCount: number;
  failedCount: number;
}

function summarizeAttachments(turns: CaptureTurn[]): AttachmentSummary {
  let attachmentCount = 0;
  let failedCount = 0;
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) {
      attachmentCount += 1;
      if (attachment.status === "failed") {
        failedCount += 1;
      }
    }
  }
  return { attachmentCount, failedCount };
}

export const runClaudeCaptureFlow: CaptureFlowRunner = async ({ emitProgress }) => {
  beginCaptureSessionWindow();
  emitProgress("content", 5, "正在加载页面内容");
  await warmupSourceLazyResources("claude");
  emitProgress("content", 40, "正在解析对话");
  const turns = extractClaudeTurns();
  if (!turns.length) {
    throw new Error("未提取到会话内容");
  }

  emitProgress("content", 100, "对话内容已提取");
  const totalAttachments = turns.reduce((sum, turn) => sum + (turn.attachments?.length ?? 0), 0);
  emitProgress("files", 0, totalAttachments > 0 ? "正在下载附件" : "无附件", {
    processed: 0,
    total: totalAttachments,
    failed: 0
  });

  let finalizedTurns = turns;
  let attachmentStageError = "";
  try {
    finalizedTurns = await materializeAttachmentsOrThrow("claude", turns, {
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
    console.warn("[AI_HISTORY] claude attachment stage failed, fallback to content-only import", error);
    emitProgress("files", 100, "附件阶段失败，已降级为仅导入文本", {
      processed: 0,
      total: totalAttachments,
      failed: totalAttachments
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
    warnings.push(`附件下载失败 ${summary.failedCount}/${summary.attachmentCount}`);
  }

  return {
    payload: createCapturePayload("claude", finalizedTurns),
    warning: warnings.length > 0 ? warnings.join("；") : undefined
  };
};
