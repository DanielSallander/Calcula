//! FILENAME: app/e2e/__tests__/webview2ArgsSingleSource.test.ts
// PURPOSE: No launch path may build its own WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
//
// `webview2Args.mjs` is the single definition, and its own header explains that
// the last drift "cost the whole golden corpus its meaning twice over". What that
// header could not do is NOTICE a new launcher — and one existed the whole time:
// `e2e/launch-with-cdp.ps1` set `--remote-debugging-port=N` and nothing else, so
// every manual launch through it recorded through the DISPLAY's colour profile and
// with an accelerated 2D canvas. Both flags are load-bearing:
//
//   --force-color-profile=sRGB        a hard-coded #217346 lands as
//                                     rgb(63,112,75) instead of rgb(33,115,70)
//   --disable-accelerated-2d-canvas   decides whether DOM overlay text rasterizes
//                                     LCD or grayscale: ~2,900 differing pixels
//                                     against a 200-pixel budget
//
// A golden recorded through a launcher missing either is silently inconsistent
// with the corpus, and nothing downstream can tell.
//
// So this asserts the RULE rather than any one launcher: the only file allowed to
// assemble that variable is `webview2Args.mjs`. Everything else must import it.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const E2E_DIR = path.resolve(__dirname, "..");
const APP_DIR = path.resolve(E2E_DIR, "..");

/** Every file that could plausibly launch the app, recursively under app/. */
function launchCandidates(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "target", "results", "test-results", ".git"]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(p);
      } else if (/\.(ts|mjs|js|ps1|cjs)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(APP_DIR);
  return out;
}

const CANONICAL = path.join(E2E_DIR, "webview2Args.mjs");

describe("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS has one definition", () => {
  it("only webview2Args.mjs assembles the argument string", () => {
    const files = launchCandidates();
    expect(
      files.length,
      "the file walk found nothing, so this guard would pass vacuously",
    ).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === CANONICAL) continue;
      // The guard itself quotes the flag names; skip it.
      if (path.resolve(file) === path.resolve(__filename)) continue;

      const text = fs.readFileSync(file, "utf-8");
      if (!text.includes("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")) continue;

      // Assigning it is fine ONLY when the value comes from the shared helper.
      // Spelling `--remote-debugging-port=` inline is the drift itself.
      const codeLines = text
        .split(/\r?\n/)
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith("//") && !t.startsWith("#") && !t.startsWith("*");
        })
        .join("\n");

      if (codeLines.includes("--remote-debugging-port=")) {
        offenders.push(
          `${path.relative(APP_DIR, file)} spells the port flag inline instead of ` +
            `calling webview2BrowserArguments()`,
        );
      }
    }

    expect(
      offenders,
      "these launch paths build their own WebView2 argument string. Every one that " +
        "omits --force-color-profile=sRGB or --disable-accelerated-2d-canvas records " +
        "goldens that are silently inconsistent with the rest of the corpus, and " +
        "nothing downstream can detect it. Import `webview2BrowserArguments` from " +
        "e2e/webview2Args.mjs instead.",
    ).toEqual([]);
  });

  it("the canonical definition still carries BOTH deterministic flags", () => {
    // Non-vacuity for the test above: if someone emptied the flag list, every
    // launcher would agree with a definition that pins nothing.
    const src = fs.readFileSync(CANONICAL, "utf-8");
    expect(src).toContain("--force-color-profile=sRGB");
    expect(src).toContain("--disable-accelerated-2d-canvas");
    // ...and it must NOT acquire --force-device-scale-factor, which was added,
    // MEASURED and removed: it makes CSS equal physical, so the viewport becomes
    // 2560x1600 and every golden's SIZE is invalidated. The measurement is
    // recorded in that file and must not be redone.
    const code = src
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(
      code.includes("--force-device-scale-factor"),
      "device scale factor is ASSERTED by captureEnvironment.ts, never forced — " +
        "forcing it unpins the layout to fix the hairline",
    ).toBe(false);
  });
});
