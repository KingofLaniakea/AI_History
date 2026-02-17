import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ai-history/core-types": path.resolve(__dirname, "../../packages/core-types/src/index.ts"),
      "@ai-history/parsers": path.resolve(__dirname, "../../packages/parsers/src/index.ts"),
      "@ai-history/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts")
    }
  },
  server: {
    port: 1420,
    strictPort: true
  }
});
