import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@api", replacement: path.resolve(__dirname, "./src/api") },
      { find: "@core", replacement: path.resolve(__dirname, "./src/core") },
      { find: "@shell", replacement: path.resolve(__dirname, "./src/shell") },
      // Real monaco crashes jsdom and is too slow to import in tests
      {
        find: "@monaco-editor/react",
        replacement: path.resolve(__dirname, "./test-stubs/monaco-editor-react.tsx"),
      },
      {
        find: /^monaco-editor\/esm\/.*\?worker$/,
        replacement: path.resolve(__dirname, "./test-stubs/monaco-worker.ts"),
      },
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(__dirname, "./test-stubs/monaco-editor.ts"),
      },
    ],
  },
  test: {
    // Match .test/.spec in both .ts and .tsx so component/spec unit tests are
    // actually gated. E2E Playwright specs live under app/e2e (outside src/ and
    // extensions/), so they are not picked up here.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "extensions/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // The api/lib barrel pulls in every extension; a cold dynamic import of it
    // can exceed vitest's 5s default inside jsdom.
    testTimeout: 30000,
  },
});
