//! FILENAME: app/e2e/__tests__/appGoneMessage.test.ts
// PURPOSE: Pin the WORDING the harness uses when it cannot reach the
//          application, because the wording is the whole point of the guard.
// CONTEXT: MEASURED 2026-08-11: a full ordered `--project=functional` pass was
//          killed at test 166 of ~550 by another launcher, and the run carried
//          on to produce ~380 one-millisecond "failures" that read as a
//          catastrophic product regression. Nothing said the app was gone.
//
//          `describeUnreachableApp` is the sentence that fixes that, and it has
//          to distinguish TWO situations that need different responses:
//          "the application is gone" (nothing after this is a result) versus
//          "the app is up but its debugging port is not answering" (usually a
//          `tauri dev` rebuild in flight). A guard whose message nobody checks
//          decays back into "connect failed" on the first refactor, so the three
//          arms are asserted here rather than trusted.
//
// This is a NODE unit test of the harness (vitest picks up e2e/**/*.test.ts);
// it launches nothing and touches no app.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeUnreachableApp } from "../fixtures";

describe("describeUnreachableApp", () => {
  it("names the application as GONE when no app.exe exists, and voids what follows", () => {
    const msg = describeUnreachableApp(0, new Error("connect ECONNREFUSED"), 9222, 3);
    expect(msg).toContain("CANNOT REACH THE APPLICATION on CDP port 9222 after 3 attempts");
    expect(msg).toContain("NO app.exe IS RUNNING");
    expect(
      msg,
      "the reader must be told that the results after this point are not test results — " +
        "that is the entire reason this message exists",
    ).toContain("Nothing reported after this point is a test result");
    expect(msg).toContain("connect ECONNREFUSED");
  });

  it("says something DIFFERENT when the app is up but the port is not answering", () => {
    const msg = describeUnreachableApp(2, new Error("boom"), 9223, 3);
    expect(msg).toContain("2 app.exe process(es) are running");
    expect(msg).toContain("CDP port 9223 is not answering");
    expect(msg).toContain("tauri dev");
    expect(
      msg,
      "an app that is up must NOT be reported as gone — the two situations have " +
        "different fixes and conflating them is how the previous version misled",
    ).not.toContain("NO app.exe IS RUNNING");
  });

  it("admits it does not know when the process list could not be read", () => {
    const msg = describeUnreachableApp(-1, "plain string cause", 9222, 3);
    expect(msg).toContain("could not query the process list");
    expect(msg).toContain("plain string cause");
    expect(msg).not.toContain("NO app.exe IS RUNNING");
  });
});

// ---------------------------------------------------------------------------
// The marker file has ONE path. This is the other half of the mechanism, and it
// is the half that was quietly broken.
// ---------------------------------------------------------------------------
//
// The banner only appears if all three stages agree on where the marker lives:
// `global-setup.ts` CLEARS it, `fixtures.ts` WRITES it, `global-teardown.ts`
// READS it. All three used to compute `results/APP-DIED.txt` independently --
// `fixtures.ts` even exported its constant with the comment "Exported so the
// teardown cannot look in a different place", while the teardown looked in a
// different place anyway. Three copies that happen to agree is not one source
// of truth, and the failure mode is silent: move `results/` and the marker is
// still written, nobody reads it, and the run ends with "N failed" again --
// exactly the lie this file exists to stop telling.
describe("the app-died marker has a single source of truth", () => {
  const E2E_ROOT = join(process.cwd(), "e2e");
  const STAGES = ["fixtures.ts", "global-setup.ts", "global-teardown.ts"];

  it("is defined in exactly one module", () => {
    const owner = readFileSync(join(E2E_ROOT, "appDiedMarker.ts"), "utf-8");
    expect(owner).toContain('path.join(HERE, "results", "APP-DIED.txt")');
  });

  it.each(STAGES)("%s takes the path from that module and never rebuilds it", (file) => {
    const src = readFileSync(join(E2E_ROOT, file), "utf-8");
    expect(src, `${file} must import APP_DIED_MARKER`).toContain("APP_DIED_MARKER");
    expect(
      src.includes('"APP-DIED.txt"'),
      `${file} re-derives the marker path instead of importing it. A second ` +
        `source of truth here silently disarms the banner: the marker gets ` +
        `written and nothing reads it.`,
    ).toBe(false);
  });
});
