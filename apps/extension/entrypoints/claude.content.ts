import { registerCaptureFlow } from "./content/capture-runtime";
import { runClaudeCaptureFlow } from "./content/flows/claude-flow";

const CLAUDE_CAPTURE_DEBUG_VERSION = "2026-02-27-r31-react-handler-prime-for-word";
const CLAUDE_CAPTURE_BIND_KEY = "__AI_HISTORY_CLAUDE_CAPTURE_BOUND__";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  runAt: "document_idle",
  main() {
    registerCaptureFlow({
      bindKey: CLAUDE_CAPTURE_BIND_KEY,
      source: "claude",
      version: CLAUDE_CAPTURE_DEBUG_VERSION,
      runCapture: runClaudeCaptureFlow
    });
  }
});
