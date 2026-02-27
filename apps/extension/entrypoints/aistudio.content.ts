import { registerCaptureFlow } from "./content/capture-runtime";
import { runAiStudioCaptureFlow } from "./content/flows/aistudio-flow";

const AI_STUDIO_CAPTURE_DEBUG_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const AI_STUDIO_CAPTURE_BIND_KEY = "__AI_HISTORY_AISTUDIO_CAPTURE_BOUND__";

export default defineContentScript({
  matches: ["https://aistudio.google.com/*"],
  runAt: "document_idle",
  main() {
    registerCaptureFlow({
      bindKey: AI_STUDIO_CAPTURE_BIND_KEY,
      source: "ai_studio",
      version: AI_STUDIO_CAPTURE_DEBUG_VERSION,
      runCapture: runAiStudioCaptureFlow
    });
  }
});
