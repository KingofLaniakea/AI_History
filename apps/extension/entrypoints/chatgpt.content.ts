import {
  createCapturePayload,
  enrichChatGptTurnsWithApiAttachments,
  extractChatGptTurns,
  materializeAttachmentsOrThrow
} from "./lib/extractor";

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "AI_HISTORY_CAPTURE") {
        return;
      }

      void (async () => {
        const turns = extractChatGptTurns();
        console.info("[AI_HISTORY] chatgpt capture start", { turns: turns.length });
        if (!turns.length) {
          sendResponse({ ok: false, error: "未提取到会话内容" });
          return;
        }

        const enrichedTurns = await enrichChatGptTurnsWithApiAttachments(turns);
        const finalizedTurns = await materializeAttachmentsOrThrow("chatgpt", enrichedTurns);
        let attachmentCount = 0;
        let inlinedCount = 0;
        for (const turn of finalizedTurns) {
          for (const attachment of turn.attachments ?? []) {
            attachmentCount += 1;
            if (attachment.originalUrl.startsWith("data:")) {
              inlinedCount += 1;
            }
          }
        }
        console.info("[AI_HISTORY] chatgpt capture done", {
          turns: finalizedTurns.length,
          attachments: attachmentCount,
          inlined: inlinedCount
        });
        sendResponse({
          ok: true,
          payload: createCapturePayload("chatgpt", finalizedTurns)
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
