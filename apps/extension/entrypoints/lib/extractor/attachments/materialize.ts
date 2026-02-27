import type {
  CaptureAttachment,
  CaptureSource,
  CaptureTurn
} from "../types";
import {
  isLikelyOaiAttachmentUrl,
  looksLikeCloudDriveFileUrl,
  looksLikeFileUrl,
  looksLikeImageUrl,
  looksLikePdfUrl
} from "./classify";

export interface AttachmentMaterializeProgress {
  phase: "files";
  processed: number;
  total: number;
  failed: number;
}

export interface MaterializeAttachmentOptions {
  continueOnFailure?: boolean;
  onProgress?: (progress: AttachmentMaterializeProgress) => void;
}

export interface AttachmentMaterializeDeps {
  isDataUrl: (url: string) => boolean;
  isVirtualAttachmentUrl: (url: string) => boolean;
  attachmentDisplayName: (attachment: CaptureAttachment) => string;
  stripVirtualPlaceholdersWhenRealAttachmentExists: (attachments: CaptureAttachment[]) => CaptureAttachment[];
  stripRedundantFailedAttachments: (attachments: CaptureAttachment[]) => CaptureAttachment[];
  detectUnresolvedUserUploadFromText: (turn: CaptureTurn, attachments: CaptureAttachment[]) => string[];
  mergeTurnAttachments: (
    existing: CaptureAttachment[] | null | undefined,
    incoming: CaptureAttachment[] | null | undefined
  ) => CaptureAttachment[] | null;
  dedupeTurns: (turns: CaptureTurn[]) => CaptureTurn[];
  maybeInlineProtectedAttachment: (attachment: CaptureAttachment, required: boolean) => Promise<CaptureAttachment>;
  logAttachmentProbeOnFailure: (
    source: CaptureSource,
    turn: CaptureTurn,
    attachments: CaptureAttachment[],
    unresolved: string[],
    reason: "unresolved_name" | "download_failed"
  ) => Promise<void>;
}

function keepAsLinkOnlyBySource(source: CaptureSource, attachment: CaptureAttachment): boolean {
  const url = attachment.originalUrl.trim();
  if (!url) {
    return true;
  }
  if (source === "gemini" || source === "ai_studio" || source === "claude") {
    if (looksLikeCloudDriveFileUrl(url)) {
      return true;
    }
    if (/googleapis\.com\/drive\/v3\/files\//i.test(url)) {
      return true;
    }
  }
  return false;
}

function shouldRequireAttachmentDownload(
  source: CaptureSource,
  turn: CaptureTurn,
  attachment: CaptureAttachment,
  deps: AttachmentMaterializeDeps
): boolean {
  if (turn.role !== "user" && turn.role !== "assistant") {
    return false;
  }

  const url = attachment.originalUrl.trim();
  const lower = url.toLowerCase();
  if (!url || deps.isDataUrl(url)) {
    return false;
  }
  if (keepAsLinkOnlyBySource(source, attachment)) {
    return false;
  }

  if (deps.isVirtualAttachmentUrl(url)) {
    return false;
  }

  if (lower.includes("oaiusercontent.com") && !isLikelyOaiAttachmentUrl(lower)) {
    return false;
  }

  const hasDownloadableSignal =
    looksLikeFileUrl(url) ||
    looksLikeImageUrl(url) ||
    looksLikePdfUrl(url) ||
    lower.includes("/backend-api/files/") ||
    lower.includes("googleusercontent.com/gg/");

  if (!hasDownloadableSignal) {
    return false;
  }

  if (attachment.kind === "image" || attachment.kind === "pdf" || attachment.kind === "file") {
    return true;
  }

  return hasDownloadableSignal;
}

export function countMaterializableAttachmentsWith(
  turns: CaptureTurn[],
  deps: Pick<AttachmentMaterializeDeps, "stripVirtualPlaceholdersWhenRealAttachmentExists" | "mergeTurnAttachments">
): number {
  return turns.reduce((sum, turn) => {
    const stripped = deps.stripVirtualPlaceholdersWhenRealAttachmentExists(turn.attachments ?? []);
    const deduped = deps.mergeTurnAttachments([], stripped) ?? [];
    return sum + deduped.length;
  }, 0);
}

export async function materializeAttachmentsOrThrowWith(
  source: CaptureSource,
  turns: CaptureTurn[],
  options: MaterializeAttachmentOptions,
  deps: AttachmentMaterializeDeps
): Promise<CaptureTurn[]> {
  if (!turns.length) {
    return turns;
  }

  const output: CaptureTurn[] = [];
  const failures: string[] = [];
  let probeLogged = false;
  const enableProbe = !options.continueOnFailure;
  const turnAttachmentWork = turns.map((turn) => {
    const stripped = deps.stripVirtualPlaceholdersWhenRealAttachmentExists(turn.attachments ?? []);
    return deps.mergeTurnAttachments([], stripped) ?? [];
  });
  const allAttachments = turnAttachmentWork.reduce((sum, items) => sum + items.length, 0);
  let processedAttachments = 0;
  let failedAttachments = 0;
  options.onProgress?.({
    phase: "files",
    processed: 0,
    total: allAttachments,
    failed: 0
  });

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    const attachments = turnAttachmentWork[turnIndex] ?? [];

    if (!attachments.length) {
      output.push(turn);
      continue;
    }

    const normalized: CaptureAttachment[] = [];
    const pendingFailureReasonByUrl = new Map<string, string>();
    for (const attachment of attachments) {
      const required = shouldRequireAttachmentDownload(source, turn, attachment, deps);
      const inlined = await deps.maybeInlineProtectedAttachment(attachment, required);
      let finalized = inlined;
      if (deps.isDataUrl(inlined.originalUrl)) {
        finalized = {
          ...inlined,
          status: "cached"
        };
      }

      if (required && !deps.isDataUrl(inlined.originalUrl)) {
        const reason = deps.isVirtualAttachmentUrl(attachment.originalUrl)
          ? "仅提取到文件名，未拿到真实文件链接"
          : "插件下载失败";
        finalized = {
          ...inlined,
          status: "failed"
        };
        pendingFailureReasonByUrl.set(finalized.originalUrl.trim(), reason);
      }
      normalized.push(finalized);
      processedAttachments += 1;
    }

    const deduped = deps.mergeTurnAttachments([], normalized) ?? [];
    const cleaned = deps.stripRedundantFailedAttachments(deduped);
    const cleanedWithoutVirtual = deps.stripVirtualPlaceholdersWhenRealAttachmentExists(cleaned);
    const normalizedForOutput = cleanedWithoutVirtual.map((attachment) => {
      if (deps.isVirtualAttachmentUrl(attachment.originalUrl)) {
        pendingFailureReasonByUrl.set(
          attachment.originalUrl.trim(),
          "仅提取到文件名，未拿到真实文件链接"
        );
        return {
          ...attachment,
          status: "failed" as const
        };
      }
      return attachment;
    });
    const retainedFailed = normalizedForOutput.filter((attachment) => attachment.status === "failed");
    for (const failed of retainedFailed) {
      const reason = pendingFailureReasonByUrl.get(failed.originalUrl.trim()) || "插件下载失败";
      failures.push(`${deps.attachmentDisplayName(failed)}（${reason}）`);
      failedAttachments += 1;
    }
    options.onProgress?.({
      phase: "files",
      processed: processedAttachments,
      total: allAttachments,
      failed: failedAttachments
    });

    output.push({
      ...turn,
      attachments: deps.mergeTurnAttachments([], normalizedForOutput)
    });

    if (source === "chatgpt" || source === "ai_studio") {
      const unresolved = deps.detectUnresolvedUserUploadFromText(turn, normalizedForOutput);
      if (unresolved.length > 0) {
        for (const name of unresolved) {
          failures.push(`${name}（仅识别到文件名，未抓到可下载链接）`);
        }
        if (enableProbe && !probeLogged) {
          probeLogged = true;
          await deps.logAttachmentProbeOnFailure(source, turn, cleaned, unresolved, "unresolved_name");
        }
      }
    }

    if (enableProbe && retainedFailed.length > 0 && !probeLogged) {
      probeLogged = true;
      await deps.logAttachmentProbeOnFailure(
        source,
        turn,
        retainedFailed,
        retainedFailed.map((attachment) => deps.attachmentDisplayName(attachment)),
        "download_failed"
      );
    }
  }

  if (failures.length > 0) {
    if (options.continueOnFailure) {
      console.warn("[AI_HISTORY] attachment materialization has failures but continues", {
        source,
        failed: failures.length,
        sample: failures.slice(0, 3)
      });
      return deps.dedupeTurns(output);
    }
    const preview = failures.slice(0, 3).join("；");
    const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : "";
    throw new Error(`附件下载失败：${preview}${more}`);
  }

  return deps.dedupeTurns(output);
}
