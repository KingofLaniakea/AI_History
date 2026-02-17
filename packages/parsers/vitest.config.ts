import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../../tests/parsers/**/*.test.ts"]
  }
});
