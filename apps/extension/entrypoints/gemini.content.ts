import { registerCaptureFlow } from "./content/capture-runtime";
import { runGeminiCaptureFlow } from "./content/flows/gemini-flow";

const GEMINI_CAPTURE_DEBUG_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const GEMINI_CAPTURE_BIND_KEY = "__AI_HISTORY_GEMINI_CAPTURE_BOUND__";

export default defineContentScript({
  matches: ["https://gemini.google.com/*", "https://bard.google.com/*"],
  runAt: "document_idle",
  main() {
    registerCaptureFlow({
      bindKey: GEMINI_CAPTURE_BIND_KEY,
      source: "gemini",
      version: GEMINI_CAPTURE_DEBUG_VERSION,
      runCapture: runGeminiCaptureFlow
    });
  }
});
