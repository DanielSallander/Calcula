/**
 * Build Verification Test
 *
 * Runs `vite build` to ensure the full application compiles without errors.
 * This catches issues that unit tests miss:
 * - JSX syntax errors (e.g., unescaped `>` in text)
 * - Missing imports / broken module resolution
 * - TypeScript errors in non-tested files
 * - Invalid component tree structures
 */
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import path from "path";

describe("build verification", () => {
  // Generous timeout: the build runs WHILE the rest of the suite saturates
  // every core — a build that takes ~60s alone can exceed 120s under full
  // parallel load. This asserts correctness, not speed.
  it("vite build succeeds without errors", () => {
    const appDir = path.resolve(__dirname, "../..");
    try {
      execSync("npx vite build", {
        cwd: appDir,
        stdio: "pipe",
        timeout: 300_000,
      });
    } catch (err: unknown) {
      const error = err as { stderr?: Buffer; stdout?: Buffer };
      const stderr = error.stderr?.toString() ?? "";
      const stdout = error.stdout?.toString() ?? "";
      throw new Error(
        `Vite build failed.\n\nSTDERR:\n${stderr}\n\nSTDOUT:\n${stdout}`
      );
    }
  }, 300_000);
});
