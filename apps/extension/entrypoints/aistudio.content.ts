import { createCapturePayload, extractAiStudioTurns, materializeAttachmentsOrThrow } from "./lib/extractor";

export default defineContentScript({
  matches: ["https://aistudio.google.com/*"],
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "AI_HISTORY_CAPTURE") {
        return;
      }

      void (async () => {
        const turns = extractAiStudioTurns();
        if (!turns.length) {
          sendResponse({ ok: false, error: "未提取到会话内容" });
          return;
        }

        const finalizedTurns = await materializeAttachmentsOrThrow("ai_studio", turns);
        sendResponse({
          ok: true,
          payload: createCapturePayload("ai_studio", finalizedTurns)
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
});
