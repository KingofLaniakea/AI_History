import { registerCaptureFlow } from "./content/capture-runtime";
import { runChatGptCaptureFlow } from "./content/flows/chatgpt-flow";

const CHATGPT_CAPTURE_DEBUG_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const CHATGPT_CAPTURE_BIND_KEY = "__AI_HISTORY_CHATGPT_CAPTURE_BOUND__";

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  runAt: "document_idle",
  main() {
    console.info("[AI_HISTORY] chatgpt content ready", {
      version: CHATGPT_CAPTURE_DEBUG_VERSION
    });

    registerCaptureFlow({
      bindKey: CHATGPT_CAPTURE_BIND_KEY,
      source: "chatgpt",
      version: CHATGPT_CAPTURE_DEBUG_VERSION,
      runCapture: runChatGptCaptureFlow
    });
  }
});
