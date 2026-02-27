import { ensureAttachmentHintWebRequestListener } from "./background/attachment-hints";
import { registerRuntimeMessageRouter } from "./background/message-router";

export default defineBackground(() => {
  ensureAttachmentHintWebRequestListener();
  registerRuntimeMessageRouter();
});
