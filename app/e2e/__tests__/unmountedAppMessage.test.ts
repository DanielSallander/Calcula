//! FILENAME: app/e2e/__tests__/unmountedAppMessage.test.ts
// PURPOSE: Pin the WORDING the harness uses when the application is reachable
//          but the frontend never mounted -- the second way a run can be dead on
//          arrival, and the one that had no sentence at all.
//
// CONTEXT (BUG-0082). `describeUnreachableApp` covers "the app is gone" and "the
// app is up but CDP is not answering". Neither fits the state measured three
// times on 2026-08-15: the app running, CDP answering, the page LOADED from Vite
// -- and `#root` empty, because `/src/main.tsx` was fetched and never evaluated.
//
// The run that made the cost obvious was `--project=visual`: 18 tests, 18
// failures, every one a `waitForSelector` timeout, and ZERO goldens actually
// compared. "18 failed" in the visual project reads as the entire golden corpus
// breaking. The sentence below is what stops the next reader spending an hour on
// the wrong question, so it is asserted rather than trusted.
//
// A NODE unit test of the harness (vitest picks up e2e/**/*.test.ts); it
// launches nothing and touches no app.

import { describe, it, expect } from "vitest";
import { describeUnmountedApp } from "../fixtures";

describe("describeUnmountedApp", () => {
  it("calls an empty #root a STARTUP failure and voids what follows", () => {
    const msg = describeUnmountedApp(0, false, "http://localhost:5173/", [], new Error("boom"));
    expect(msg).toContain("THE APPLICATION IS REACHABLE BUT THE SPREADSHEET NEVER APPEARED");
    expect(msg).toContain("#root IS EMPTY");
    expect(
      msg,
      "the reader must be told this is not a product failure and that the " +
        "results after it are not results -- that is the whole point",
    ).toContain("NOT a product failure");
    expect(msg).toContain("Re-launch and re-run");
    expect(msg).toContain("http://localhost:5173/");
    expect(msg).toContain("boom");
  });

  it("distinguishes 'main.tsx never started' from 'main.tsx started and threw'", () => {
    // The discriminator measured live on the third occurrence: __calcImport is
    // installed early in main.tsx, so its absence dates the failure.
    const never = describeUnmountedApp(0, false, "u", [], "x");
    const threw = describeUnmountedApp(0, true, "u", [], "x");
    expect(never).toContain("never got as far as");
    expect(never).toContain("BUG-0082");
    expect(threw).toContain("began running and threw");
    expect(threw).not.toContain("never got as far as");
  });

  it("says something DIFFERENT when the app DID mount", () => {
    // A mounted app missing this one container is a product question, and must
    // not be dressed up as a startup failure -- that would send the next reader
    // to re-launch when they should be reading the product.
    const msg = describeUnmountedApp(3, true, "u", [], "x");
    expect(msg).toContain("the frontend DID mount");
    expect(msg).toContain("that is a product");
    expect(msg).not.toContain("#root IS EMPTY");
    expect(msg).not.toContain("Re-launch and re-run");
  });

  // -------------------------------------------------------------------------
  // The fourth arm. BUG-0083's root error boundary renders INTO `#root`, so a
  // crashed boot arrives here as `rootChildCount > 0` and the arm above would
  // describe it as "the frontend DID mount and this container is missing" --
  // technically true, and useless: the reader is sent to hunt a missing
  // container when the page is showing them the stack trace already.
  // -------------------------------------------------------------------------

  it("names the root error boundary when it is on screen", () => {
    const msg = describeUnmountedApp(1, true, "u", [], "x", "TypeError: x is null");
    expect(msg).toContain("ROOT ERROR BOUNDARY");
    expect(msg).toContain("TypeError: x is null");
    // It must NOT be described as a missing container...
    expect(msg).not.toContain("the frontend DID mount");
    // ...nor as a startup failure, which is what BUG-0082's arm would say.
    expect(msg).not.toContain("#root IS EMPTY");
  });

  it("says a boot crash is ONE product failure, not N test results", () => {
    const msg = describeUnmountedApp(1, true, "u", [], "x", "boom");
    expect(msg).toContain("ONE failure");
    expect(msg).toContain("product failure");
  });

  it("keeps the ordinary arms unchanged when no boundary is present", () => {
    // The new parameter defaults to null, so every existing caller and every
    // arm above must behave exactly as before.
    expect(describeUnmountedApp(0, false, "u", [], "x")).toContain("#root IS EMPTY");
    expect(describeUnmountedApp(3, true, "u", [], "x")).toContain("the frontend DID mount");
    expect(describeUnmountedApp(-1, false, "u", [], "x")).toContain("UNKNOWN");
  });

  it("carries the console tail, and SAYS SO when there is none", () => {
    const withTail = describeUnmountedApp(0, false, "u", [
      "error: Failed to fetch dynamically imported module",
      "pageerror: SyntaxError",
    ], "x");
    expect(withTail).toContain("last console output");
    expect(withTail).toContain("Failed to fetch dynamically imported module");
    expect(withTail).toContain("SyntaxError");

    const withoutTail = describeUnmountedApp(0, false, "u", [], "x");
    expect(
      withoutTail,
      "silence about the console reads as 'the console was clean'; the absence " +
        "of evidence has to be stated as an absence",
    ).toContain("NO console output");
  });

  it("reports an unreadable page as UNKNOWN rather than inventing a mount state", () => {
    // -1 is what the fixture substitutes when the page cannot be evaluated at
    // all. Calling that "#root IS EMPTY" would be a claim about a page nothing
    // could read -- the same overreach as reporting a suite green for tests it
    // never collected.
    const msg = describeUnmountedApp(-1, false, "(unreadable)", [], "x");
    expect(msg).toContain("(unreadable)");
    expect(msg).toContain("UNKNOWN");
    expect(msg).not.toContain("has -1 child");
    expect(msg).not.toContain("#root IS EMPTY");
    expect(msg).not.toContain("the frontend DID mount");
  });
});
