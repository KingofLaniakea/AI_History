import { fetchAttachmentAsDataUrl, probeAttachmentUrl } from "./attachment-fetch";
import { findTrackedAttachmentHintUrls } from "./attachment-hints";
import { captureByUrl, captureCurrentTab } from "./capture-runner";
import { emitCaptureProgress } from "./progress";

export function registerRuntimeMessageRouter(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "AI_HISTORY_CAPTURE_PROGRESS") {
      const runId = String(message.runId || "").trim();
      if (runId) {
        emitCaptureProgress({
          runId,
          phase: message.phase === "files" ? "files" : "content",
          percent: Number(message.percent || 0),
          status: String(message.status || ""),
          processed: Number(message.processed || 0) || 0,
          total: Number(message.total || 0) || 0,
          failed: Number(message.failed || 0) || 0
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "AI_HISTORY_PROBE_ATTACHMENT") {
      const url = String(message.url || "").trim();
      void probeAttachmentUrl(url)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            ok: false,
            url,
            method: "GET",
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

    if (message?.type === "AI_HISTORY_FETCH_ATTACHMENT") {
      const url = String(message.url || "").trim();
      void fetchAttachmentAsDataUrl(url)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return true;
    }

    if (message?.type === "AI_HISTORY_LOOKUP_ATTACHMENT_HINTS") {
      const fileId = String(message.fileId || "").trim();
      const senderTabId = typeof sender?.tab?.id === "number" ? sender.tab.id : -1;
      const urls = fileId ? findTrackedAttachmentHintUrls(fileId, senderTabId) : [];
      sendResponse({
        ok: true,
        urls
      });
      return;
    }

    if (message?.type === "CAPTURE_CURRENT_TAB") {
      const runId = String(message.runId || "").trim() || `run_${Date.now()}`;
      void captureCurrentTab(runId)
        .then((result) => sendResponse({ ok: true, message: result.message, warning: result.warning, runId }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "CAPTURE_URL") {
      const url = String(message.url || "").trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        sendResponse({ ok: false, error: "请输入有效的 http(s) 链接" });
        return;
      }

      const runId = String(message.runId || "").trim() || `run_${Date.now()}`;
      void captureByUrl(url, runId)
        .then((result) => sendResponse({ ok: true, message: result.message, warning: result.warning, runId }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
  });
}
