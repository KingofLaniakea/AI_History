import { defineConfig } from "wxt";

export default defineConfig({
  extensionApi: "chrome",
  modules: [],
  manifest: {
    name: "AI History Capture",
    description: "Capture ChatGPT/Gemini/AI Studio conversations directly into AI History desktop app",
    permissions: ["tabs", "scripting", "activeTab", "storage", "webRequest"],
    host_permissions: [
      "http://127.0.0.1:48765/*",
      "http://*/*",
      "https://*/*",
      "https://chatgpt.com/*",
      "https://gemini.google.com/*",
      "https://aistudio.google.com/*"
    ],
    action: {
      default_title: "AI History Capture",
      default_icon: {
        "16": "icon-16.png",
        "32": "icon-32.png",
        "48": "icon-48.png",
        "128": "icon-128.png"
      }
    },
    icons: {
      "16": "icon-16.png",
      "32": "icon-32.png",
      "48": "icon-48.png",
      "128": "icon-128.png"
    }
  }
});
