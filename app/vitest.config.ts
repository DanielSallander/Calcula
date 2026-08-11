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
    // actually gated.
    //
    // THE E2E HARNESS IS INCLUDED TOO, and only as *.test.ts. Playwright owns
    // *.spec.ts / *.scenario.ts under app/e2e and every project matches on
    // those, so a *.test.ts file there is unambiguously a NODE unit test of the
    // harness itself. It is included because the harness had no unit tier at
    // all, which is how the trace minimiser shipped with a bug that made it
    // discard its own answer: nothing could exercise it without launching the
    // whole app.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "extensions/**/*.{test,spec}.{ts,tsx}",
      "e2e/**/*.test.ts",
    ],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // The api/lib barrel pulls in every extension; a cold dynamic import of it
    // can exceed vitest's 5s default inside jsdom.
    testTimeout: 30000,
  },
});
