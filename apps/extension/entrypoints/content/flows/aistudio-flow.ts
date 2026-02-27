import {
  applyDriveAttachments,
  beginCaptureSessionWindow,
  createCapturePayload,
  extractAiStudioTurns,
  materializeAttachmentsOrThrow,
  warmupSourceLazyResources
} from "../../lib/extractor";
import type { CaptureFlowRunner } from "../capture-runtime";

export const runAiStudioCaptureFlow: CaptureFlowRunner = async ({ emitProgress }) => {
  beginCaptureSessionWindow();
  emitProgress("content", 5, "正在加载页面内容");
  await warmupSourceLazyResources("ai_studio");
  emitProgress("content", 45, "正在解析对话");
  const turns = extractAiStudioTurns();
  if (!turns.length) {
    throw new Error("未提取到会话内容");
  }

  emitProgress("content", 70, "正在关联附件线索");
  const withDrive = applyDriveAttachments(turns);
  emitProgress("content", 100, "对话内容已提取");
  const totalAttachments = withDrive.reduce((sum, turn) => sum + (turn.attachments?.length ?? 0), 0);
  emitProgress("files", 0, totalAttachments > 0 ? "正在下载附件" : "无附件", {
    processed: 0,
    total: totalAttachments,
    failed: 0
  });
  let finalizedTurns = withDrive;
  let attachmentStageError = "";
  try {
    finalizedTurns = await materializeAttachmentsOrThrow("ai_studio", withDrive, {
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
    console.warn("[AI_HISTORY] ai_studio attachment stage failed, fallback to content-only import", error);
    emitProgress("files", 100, "附件阶段失败，已降级为仅导入文本", {
      processed: 0,
      total: totalAttachments,
      failed: totalAttachments
    });
  }
  const failedCount = finalizedTurns.reduce(
    (sum, turn) => sum + (turn.attachments?.filter((attachment) => attachment.status === "failed").length ?? 0),
    0
  );
  const finalTotal = finalizedTurns.reduce((sum, turn) => sum + (turn.attachments?.length ?? 0), 0);
  emitProgress("files", 100, failedCount > 0 ? `附件完成，失败 ${failedCount}` : "附件下载完成", {
    processed: finalTotal,
    total: finalTotal,
    failed: failedCount
  });
  const warnings: string[] = [];
  if (attachmentStageError) {
    warnings.push(`附件阶段异常：${attachmentStageError}`);
  }
  if (failedCount > 0) {
    warnings.push(`附件下载失败 ${failedCount}/${finalTotal}`);
  }
  return {
    payload: createCapturePayload("ai_studio", finalizedTurns),
    warning: warnings.length > 0 ? warnings.join("；") : undefined
  };
};
