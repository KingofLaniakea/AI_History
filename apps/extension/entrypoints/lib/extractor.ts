export type {
  CaptureAttachment,
  CapturePayload,
  CaptureSource,
  CaptureTurn
} from "./extractor/types";

export { beginCaptureSessionWindow } from "./extractor/network/tracker";

export {
  applyDriveAttachments,
  extractDriveApiAttachments
} from "./extractor/attachments/collect";

export {
  countMaterializableAttachments,
  materializeAttachmentsOrThrow,
  type AttachmentMaterializeProgress
} from "./extractor/attachments/materialize";

export {
  warmupAiStudioLazyResources,
  warmupSourceLazyResources
} from "./extractor/warmup";

export {
  enrichChatGptTurnsWithApiAttachments,
  extractAiStudioTurns,
  extractChatGptTurns,
  extractGeminiTurns
} from "./extractor/source/chatgpt";

export { extractClaudeTurns } from "./extractor/source/claude";

export {
  createCapturePayload,
  inferSourceFromUrl
} from "./extractor/payload";
