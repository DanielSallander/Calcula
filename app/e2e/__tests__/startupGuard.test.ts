//! FILENAME: app/e2e/__tests__/startupGuard.test.ts
// PURPOSE: Pin the DETECTOR and the WORDING of the startup guard -- the thing
//          that turns "a cold launch never mounted" from N product failures into
//          one named run failure (BUG-0082, open-decisions §32).
//
// WHY EVERY ARM IS ASSERTED. This guard exists because an instrument lied in the
// direction of "your code is broken": 12 soak failures, 18 visual failures, all
// of them `waitForSelector` timeouts, none of them about the product. Its value
// is entirely in (a) firing when the frontend did not mount, (b) NOT firing when
// the frontend merely took a long time, and (c) the sentence a reader acts on.
// All three are checkable without launching anything, so all three are checked.
//
// THE TIMING TESTS USE A VIRTUAL CLOCK. `waitForMount` takes `now` and `sleep`
// as options precisely so its two bounds can be exercised deterministically --
// a guard whose stall window is only ever tested by waiting 45 real seconds is a
// guard nobody re-tests after they change it.
//
// A NODE unit test of the harness (vitest picks up e2e/**/*.test.ts); it
// launches nothing and touches no app.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import {
  STARTUP_FAILED_MARKER,
  clearStartupFailure,
  describeMountSuccess,
  documentIsPending,
  describeStartupFailure,
  isExpectedOrigin,
  mountBounds,
  progressKey,
  readStartupFailure,
  recordStartupFailure,
  startupFailureBanner,
  startupGuardDisabled,
  waitForMount,
  type MountFailure,
  type MountOutcome,
  type StartupProbe,
} from "../startupGuard";
import { pickAppPage } from "../startupBarrier";
import CollectionGuard from "../collectionGuard";

const VITE = 5173;

/** A page reading, with the healthy values as the baseline. */
function probe(over: Partial<StartupProbe> = {}): StartupProbe {
  return {
    rootChildCount: 1,
    spreadsheetPresent: true,
    tauriBridgePresent: true,
    calcImportPresent: true,
    url: "http://localhost:5173/",
    readyState: "complete",
    title: "app",
    resourceCount: 250,
    networkResponses: 100,
    // The healthy baseline: no root error boundary on screen.
    bootErrorText: null,
    ...over,
  };
}

/** The live BUG-0082 state, as measured: complete, loaded, and empty. */
const stalledProbe = (over: Partial<StartupProbe> = {}): StartupProbe =>
  probe({
    rootChildCount: 0,
    spreadsheetPresent: false,
    calcImportPresent: false,
    readyState: "complete",
    resourceCount: 250,
    ...over,
  });

/**
 * Run the barrier against a scripted page on a VIRTUAL clock: only `sleep`
 * advances time, so a 4-minute cap is exercised in microseconds and the result
 * is deterministic.
 */
async function runBarrier(
  script: (elapsedMs: number) => StartupProbe | null,
  bounds: {
    capMs?: number;
    stallMs?: number;
    serverSilentMs?: number;
    pollMs?: number;
  } = {},
): Promise<MountOutcome> {
  let t = 0;
  return waitForMount({
    readProbe: async () => {
      const p = script(t);
      return { probe: p, survey: { pageCount: p ? 1 : 0, urls: p ? [p.url] : [] } };
    },
    capMs: bounds.capMs ?? 900_000,
    stallMs: bounds.stallMs ?? 45_000,
    serverSilentMs: bounds.serverSilentMs ?? 300_000,
    pollMs: bounds.pollMs ?? 1_000,
    vitePort: VITE,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  });
}

const asFailure = (o: MountOutcome): MountFailure => {
  expect(o.ok, "expected this outcome to be a FAILURE").toBe(false);
  return o as MountFailure;
};

// ===========================================================================
// The detector
// ===========================================================================

describe("waitForMount -- the healthy directions", () => {
  it("passes at once when the frontend is already mounted", async () => {
    const outcome = await runBarrier(() => probe());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.elapsedMs).toBe(0);
      expect(outcome.samples).toBe(1);
    }
  });

  it("DOES NOT FIRE on a mount that is merely slow -- the whole point of the design", async () => {
    // BUG-0082 measured ONE cold mount at ~55s. A guard that turned that sample
    // into a deadline would flake on any colder machine, so the bound is a STALL
    // window over progress signals, not a mount deadline. Here the page takes
    // 100 SECONDS -- nearly twice the worst sample ever measured, and more than
    // twice the 45s stall window -- while continuing to load resources. It must
    // pass.
    const outcome = await runBarrier((t) =>
      t >= 100_000
        ? probe({ resourceCount: 2_000 })
        : probe({ rootChildCount: 0, spreadsheetPresent: false, resourceCount: t / 100 }),
    );
    expect(outcome.ok, "a slow but progressing launch must not be called dead").toBe(true);
    if (outcome.ok) expect(outcome.elapsedMs).toBe(100_000);
  });

  it("DOES NOT FIRE on the measured 218s of silence while the document is LOADING", async () => {
    // THE MEASUREMENT THIS ARM EXISTS FOR (§32). With app/node_modules/.vite
    // deleted, the page loaded two resources at ~12s and the NEXT one at ~231s:
    // 218 seconds in which nothing whatsoever changed, because the browser was
    // blocked on a single /src/main.tsx request while Vite re-optimised its
    // dependencies. Every signal a network-only stall window can see was flat.
    // What was NOT flat -- what said "still waiting" the whole time -- is
    // `document.readyState`, which sat at "interactive" rather than "complete".
    // A guard without that distinction fails this launch at 57s.
    const outcome = await runBarrier((t) =>
      t < 218_000
        ? probe({
            rootChildCount: 0,
            spreadsheetPresent: false,
            calcImportPresent: false,
            readyState: "interactive",
            resourceCount: 2,
          })
        : probe({ resourceCount: 250 }),
    );
    expect(
      outcome.ok,
      "a page still waiting on the dev server is not a page that failed to mount",
    ).toBe(true);
  });

  it("counts the page's own resource count ALONE as progress", () => {
    // During a cold Vite transform nothing else moves for tens of seconds: the
    // URL, readyState and #root are all constant and only the resource count
    // changes. If that did not count as progress the guard would fire on every
    // healthy cold start.
    const a = probe({ rootChildCount: 0, resourceCount: 10 });
    const b = probe({ rootChildCount: 0, resourceCount: 11 });
    expect(progressKey(a)).not.toBe(progressKey(b));
    expect(progressKey(a)).toBe(progressKey(probe({ rootChildCount: 0, resourceCount: 10 })));
  });
});

describe("waitForMount -- the firing directions", () => {
  it("FIRES on the measured BUG-0082 state: complete, loaded, #root empty, nothing moving", async () => {
    // Reproduced live 2026-08-15: readyState "complete", 250 resources loaded,
    // #root empty, and the state unchanged for the following ten minutes.
    const f = asFailure(await runBarrier(() => stalledProbe()));
    expect(f.kind).toBe("never-mounted-stalled");
    expect(f.elapsedMs).toBe(45_000);
    expect(f.quietMs).toBe(45_000);
  });

  it("FIRES on a document that stays PENDING past the (much longer) server window", async () => {
    // The patient arm is patient, not infinite: a dev server that never answers
    // still has to be named, and named as a SERVER problem rather than as a
    // frontend one.
    const f = asFailure(
      await runBarrier(() =>
        probe({
          rootChildCount: 0,
          spreadsheetPresent: false,
          readyState: "interactive",
          resourceCount: 2,
        }),
      ),
    );
    expect(f.kind).toBe("dev-server-not-answering");
    expect(f.elapsedMs).toBe(300_000);
  });

  it("names a launch that is STILL moving at the cap differently from a stall", async () => {
    // "Still going after fifteen minutes" is a different bug from "stopped", and
    // a guard that reported both as the same thing would send the reader to the
    // wrong question.
    const outcome = await runBarrier((t) =>
      probe({ rootChildCount: 0, spreadsheetPresent: false, resourceCount: t }),
    );
    const f = asFailure(outcome);
    expect(f.kind).toBe("never-mounted-cap");
    expect(f.elapsedMs).toBeGreaterThanOrEqual(900_000);
  });

  it("FIRES when there is no page at all, and says so rather than calling it empty", async () => {
    const f = asFailure(await runBarrier(() => null));
    expect(f.kind).toBe("no-page");
    expect(f.probe).toBeNull();
  });

  it("FIRES on a page parked off the app's own origin", async () => {
    const f = asFailure(
      await runBarrier(() =>
        probe({ rootChildCount: 0, url: "about:blank", readyState: "complete" }),
      ),
    );
    expect(f.kind).toBe("wrong-origin");
  });

  it("FIRES when the app mounted but window.__TAURI__ is absent", async () => {
    // The documented signature of a launch without src-tauri/tauri.e2e.conf.json:
    // the app is up and EVERY spec fails, one identical failure at a time.
    const f = asFailure(await runBarrier(() => probe({ tauriBridgePresent: false })));
    expect(f.kind).toBe("no-tauri-bridge");
    expect(f.probe?.rootChildCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // THE SEAM BETWEEN THE TWO FIXES THAT LANDED TOGETHER.
  //
  // BUG-0083 put a `RootErrorBoundary` above all five React roots. Its failure
  // panel is a CHILD OF `#root`, and `#root` having children was this barrier's
  // only mount signal -- so without these cases a boot-time throw sails through
  // the guard and every spec then times out on the spreadsheet selector: N
  // product-looking failures for one systemic fact, which is the exact
  // misreporting BUG-0082 exists to prevent, arriving through the other fix.
  // -------------------------------------------------------------------------

  it("FIRES when React mounted the ROOT ERROR BOUNDARY instead of the app", async () => {
    const f = asFailure(
      await runBarrier(() =>
        probe({
          rootChildCount: 1,
          spreadsheetPresent: false,
          bootErrorText: "Calcula could not start\nTypeError: nope",
        }),
      ),
    );
    expect(f.kind).toBe("boot-error");
    // The point of the case: `#root` is NOT empty, so the old signal said "up".
    expect(f.probe?.rootChildCount).toBeGreaterThan(0);
  });

  it("reports the boot error rather than the missing bridge when both are true", async () => {
    // A crash early enough to precede the bridge would otherwise be reported as
    // a launcher misconfiguration, sending the reader to the wrong file.
    const f = asFailure(
      await runBarrier(() =>
        probe({ tauriBridgePresent: false, bootErrorText: "boom" }),
      ),
    );
    expect(f.kind).toBe("boot-error");
  });

  it("does NOT fire for an ordinary healthy mount", async () => {
    const out = await runBarrier(() => probe());
    expect(out.ok).toBe(true);
  });

  it("a page that changes URL forever still ends at the cap, not never", async () => {
    // The stall window is reset by progress, so a reload loop is invisible to
    // it. The absolute cap is what stops the barrier waiting for ever -- and a
    // barrier with no upper bound is the hang this programme keeps deleting.
    const f = asFailure(
      await runBarrier((t) => probe({ rootChildCount: 0, url: `http://localhost:5173/?${t}` })),
    );
    expect(f.kind).toBe("never-mounted-cap");
    expect(f.elapsedMs).toBeLessThanOrEqual(901_000);
  });
});

// ---------------------------------------------------------------------------
// THE OFF SWITCH.
//
// `STARTUP_GUARD=off` disables the ENTIRE barrier from one env read, and it had
// no test of any kind. This programme has already paid for an unchecked
// suppression once -- a walker exclusion list that named a bug id and never
// checked the ledger, so it outlived its bug and blinded the walker for months.
// An off switch nothing exercises is the same shape: it cannot be shown to
// work, and more importantly it cannot be shown NOT to fire by accident.
// ---------------------------------------------------------------------------

describe("startupGuardDisabled -- the escape hatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is OFF by default: an absent variable leaves the guard armed", () => {
    expect(startupGuardDisabled({})).toBe(false);
  });

  it("disables only on the exact string, and says so LOUDLY", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(startupGuardDisabled({ STARTUP_GUARD: "off" })).toBe(true);
    // A silent disable is indistinguishable from a guard that ran and passed,
    // which is the exact confusion BUG-0082 cost three sessions to resolve.
    expect(err).toHaveBeenCalled();
    const said = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("DISABLED");
    expect(said).toContain("BUG-0082");
  });

  it("FAILS SAFE on anything else -- the guard stays armed", () => {
    // Every one of these is a plausible way for someone to think they are
    // configuring the guard. All of them must leave it ON: the cost of a
    // spurious guard run is a wait, the cost of a spuriously disabled one is
    // the 18-product-failure report this whole mechanism exists to prevent.
    for (const v of ["OFF", "Off", "1", "true", "yes", "on", "", "0", "false"]) {
      expect(startupGuardDisabled({ STARTUP_GUARD: v }), v).toBe(false);
    }
  });
});

describe("documentIsPending", () => {
  it("treats only a NON-complete readyState as still waiting", () => {
    expect(documentIsPending(probe({ readyState: "complete" }))).toBe(false);
    expect(documentIsPending(probe({ readyState: "interactive" }))).toBe(true);
    expect(documentIsPending(probe({ readyState: "loading" }))).toBe(true);
  });

  it("does NOT claim the patient arm for a page it could not read", () => {
    // An unreadable page is not evidence of pending work. Claiming the longer
    // window on it would be the same overreach as calling an unreadable page
    // empty -- it would turn "we know nothing" into five extra minutes of wait.
    expect(documentIsPending(probe({ readyState: "(unreadable)" }))).toBe(false);
  });
});

describe("isExpectedOrigin", () => {
  it("accepts the dev origins and the packaged ones", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:5173/index.html",
      "tauri://localhost/",
      "http://tauri.localhost/",
      "https://tauri.localhost/",
    ]) {
      expect(isExpectedOrigin(url, VITE), url).toBe(true);
    }
  });

  it("rejects the shapes a dead launch actually shows", () => {
    for (const url of [
      "about:blank",
      "chrome-error://chromewebdata/",
      "data:text/html,<h1>nope</h1>",
      "http://localhost:5174/",
      "(unreadable)",
    ]) {
      expect(isExpectedOrigin(url, VITE), url).toBe(false);
    }
  });
});

describe("pickAppPage", () => {
  const read = (p: { rootChildCount: number; url: string }) => p;

  it("prefers the page that actually mounted", () => {
    // A Script Editor window left open by a previous session is a second page;
    // judging THAT one would report the wrong page's state.
    const editor = { rootChildCount: 0, url: "http://localhost:5173/script-editor" };
    const app = { rootChildCount: 7, url: "http://localhost:5173/" };
    expect(pickAppPage([editor, app], read, VITE)).toBe(app);
  });

  it("falls back to a page on the app's origin, then to the first page", () => {
    const blank = { rootChildCount: 0, url: "about:blank" };
    const vite = { rootChildCount: 0, url: "http://localhost:5173/" };
    expect(pickAppPage([blank, vite], read, VITE)).toBe(vite);
    expect(pickAppPage([blank], read, VITE)).toBe(blank);
    expect(pickAppPage([], read, VITE)).toBeNull();
  });
});

describe("mountBounds", () => {
  it("defaults to the measured bounds and takes overrides from the environment", () => {
    const d = mountBounds({} as NodeJS.ProcessEnv);
    expect(d.capMs).toBe(900_000);
    expect(d.stallMs).toBe(45_000);
    expect(d.serverSilentMs).toBe(300_000);
    expect(d.pollMs).toBe(1_000);

    const o = mountBounds({
      E2E_MOUNT_CAP_MS: "600000",
      E2E_MOUNT_STALL_MS: "90000",
      E2E_MOUNT_SERVER_SILENT_MS: "400000",
    } as NodeJS.ProcessEnv);
    expect(o.capMs).toBe(600_000);
    expect(o.stallMs).toBe(90_000);
    expect(o.serverSilentMs).toBe(400_000);
  });

  it("keeps the patient arm well clear of the stall window", () => {
    // The measured cost of getting this order wrong is a healthy launch failed
    // at 57s (§32: 218s of silence while the document was still LOADING).
    const d = mountBounds({} as NodeJS.ProcessEnv);
    expect(d.serverSilentMs).toBeGreaterThan(d.stallMs);
    expect(d.serverSilentMs).toBeGreaterThan(218_000);
    expect(d.capMs).toBeGreaterThan(d.serverSilentMs);
  });

  it("ignores nonsense rather than disabling itself with a zero bound", () => {
    // `E2E_MOUNT_STALL_MS=0` or a typo must not silently turn the guard into a
    // tripwire that fires on the first reading.
    const b = mountBounds({ E2E_MOUNT_CAP_MS: "0", E2E_MOUNT_STALL_MS: "soon" } as NodeJS.ProcessEnv);
    expect(b.capMs).toBe(900_000);
    expect(b.stallMs).toBe(45_000);
  });
});

// ===========================================================================
// The wording -- what the reader acts on
// ===========================================================================

function failureOf(kind: MountFailure["kind"], over: Partial<MountFailure> = {}): MountFailure {
  return {
    ok: false,
    kind,
    elapsedMs: 45_000,
    quietMs: 45_000,
    samples: 46,
    probe: probe({ rootChildCount: 0, spreadsheetPresent: false, calcImportPresent: false }),
    survey: { pageCount: 1, urls: ["http://localhost:5173/"] },
    ...over,
  };
}

describe("describeStartupFailure", () => {
  it("every arm says this run has NO test results and is not a product failure", () => {
    for (const kind of [
      "cdp-unreachable",
      "no-page",
      "wrong-origin",
      "never-mounted-stalled",
      "never-mounted-cap",
      "no-tauri-bridge",
    ] as const) {
      const msg = describeStartupFailure(failureOf(kind));
      expect(msg, kind).toContain("NO TEST RESULTS");
      expect(msg, kind).toContain("NOT a product");
      expect(msg, kind).toContain("BUG-0082");
    }
  });

  // -------------------------------------------------------------------------
  // `boot-error` is deliberately ABSENT from the list above: it attributes the
  // other way, and a guard that misattributes is the thing this programme keeps
  // deleting. These cases pin BOTH halves -- that it claims the product, and
  // that it does not accidentally inherit the shared "not a product" sentence.
  // -------------------------------------------------------------------------

  it("the boot-error arm claims the product instead of exonerating it", () => {
    const msg = describeStartupFailure(
      failureOf("boot-error", {
        probe: probe({ rootChildCount: 1, bootErrorText: "TypeError: x is null" }),
      }),
    );
    expect(msg).toContain("NO TEST RESULTS");
    expect(msg).toContain("IS a product failure");
    // The exact sentence the other arms print would be a LIE here.
    expect(msg).not.toContain("NOT a product");
    // ...and re-running is the one instruction that cannot help a deterministic
    // boot throw, so it must not be given.
    expect(msg).not.toContain("Re-launch and re-run");
  });

  it("the boot-error arm prints what the boundary actually reported", () => {
    const msg = describeStartupFailure(
      failureOf("boot-error", {
        probe: probe({ rootChildCount: 1, bootErrorText: "Grid could not start\nTypeError: x is null" }),
      }),
    );
    expect(msg).toContain("ROOT ERROR BOUNDARY IS ON SCREEN");
    expect(msg).toContain("TypeError: x is null");
    expect(msg).toContain("BUG-0083");
  });

  it("does not mention the boundary at all when it is not on screen", () => {
    // A line that says "root error boundary: absent" on every ordinary failure
    // trains the reader to skip the one line that matters when it IS present.
    const msg = describeStartupFailure(failureOf("never-mounted-stalled"));
    expect(msg).not.toContain("ROOT ERROR BOUNDARY");
  });

  it("the stalled arm names the causes a reader can actually check", () => {
    const msg = describeStartupFailure(failureOf("never-mounted-stalled"));
    expect(msg).toContain("NEVER MOUNTED");
    expect(msg).toContain("finished loading and did not mount");
    // The mechanism reproduced live, named so the next reader does not re-derive it.
    expect(msg).toContain("useReducer");
    expect(msg).toContain("node_modules/.vite");
    expect(msg).toContain("__calcImport");
  });

  it("the pending arm blames the SERVER, not the frontend", () => {
    const msg = describeStartupFailure(
      failureOf("dev-server-not-answering", {
        probe: probe({ rootChildCount: 0, readyState: "interactive", resourceCount: 2 }),
      }),
    );
    expect(msg).toContain("waiting for the dev server");
    expect(msg).toContain("218 SECONDS");
    expect(msg).toContain("curl");
    expect(msg).not.toContain("useReducer");
  });

  it("the bridge arm names the missing config, because that is the fix", () => {
    const msg = describeStartupFailure(
      failureOf("no-tauri-bridge", { probe: probe({ tauriBridgePresent: false }) }),
    );
    expect(msg).toContain("tauri.e2e.conf.json");
    expect(msg).toContain("withGlobalTauri");
    expect(msg).not.toContain("NEVER MOUNTED");
  });

  it("carries the page's own state as EVIDENCE, not as prose", () => {
    const msg = describeStartupFailure(failureOf("never-mounted-stalled"));
    expect(msg).toContain("#root children:     0");
    expect(msg).toContain("window.__TAURI__:   present");
    expect(msg).toContain("window.__calcImport:ABSENT");
    expect(msg).toContain("network responses:  100");
    expect(msg).toContain("document.title:     app");
  });

  it("carries the console tail, and SAYS SO when there is none", () => {
    // On the live reproduction the console held the whole answer: "Invalid hook
    // call" and "Cannot read properties of null (reading 'useReducer')". Silence
    // about the console reads as "the console was clean", so the absence of
    // evidence has to be printed as an absence.
    const withTail = describeStartupFailure(
      failureOf("never-mounted-stalled", {
        consoleTail: [
          "error: Warning: Invalid hook call.",
          "pageerror: TypeError: Cannot read properties of null (reading 'useReducer')",
        ],
      }),
    );
    expect(withTail).toContain("last console output");
    expect(withTail).toContain("Invalid hook call");
    expect(withTail).toContain("useReducer");

    const withoutTail = describeStartupFailure(failureOf("never-mounted-stalled"));
    expect(withoutTail).toContain("NO output to attribute it with");
  });

  it("says the page was unreadable instead of claiming it was empty", () => {
    // -1 is "could not be evaluated". Calling that "0 children" would be a claim
    // about a page nothing could read.
    const msg = describeStartupFailure(
      failureOf("never-mounted-stalled", {
        probe: probe({ rootChildCount: -1, url: "(unreadable)" }),
      }),
    );
    expect(msg).toContain("(page unreadable)");
    expect(msg).not.toContain("#root children:     -1");
  });

  it("reports no page at all as an absence, and carries the underlying error", () => {
    const msg = describeStartupFailure(
      failureOf("cdp-unreachable", { probe: null, survey: null, cause: new Error("ECONNREFUSED") }),
    );
    expect(msg).toContain("no page/target could be read at all");
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).toContain("A guard that cannot");
  });
});

describe("describeMountSuccess", () => {
  it("records the timing on every healthy run -- the sample series §32 was missing", () => {
    const msg = describeMountSuccess({
      ok: true,
      elapsedMs: 3_200,
      samples: 4,
      probe: probe({ resourceCount: 250 }),
    });
    expect(msg).toContain("mounted after 3.2s");
    expect(msg).toContain("250 resources");
    expect(msg).not.toContain("SLOW");
  });

  it("calls out a mount that is close to the fixture's own ceiling", () => {
    const msg = describeMountSuccess({
      ok: true,
      elapsedMs: 55_000,
      samples: 56,
      probe: probe(),
    });
    expect(msg).toContain("SLOW");
    expect(msg).toContain("60s");
  });
});

// ===========================================================================
// The marker and the reporter arm -- one channel, the existing guard
// ===========================================================================

describe("the startup-failure marker", () => {
  afterEach(() => clearStartupFailure());

  it("round-trips, and reads as absent once cleared", () => {
    clearStartupFailure();
    expect(readStartupFailure()).toBeNull();
    recordStartupFailure("THE APPLICATION NEVER MOUNTED -- detail");
    expect(fs.existsSync(STARTUP_FAILED_MARKER)).toBe(true);
    expect(readStartupFailure()).toContain("THE APPLICATION NEVER MOUNTED");
    clearStartupFailure();
    expect(readStartupFailure()).toBeNull();
  });
});

describe("startupFailureBanner", () => {
  it("says how many of the numbers in the report are worth nothing", () => {
    const banner = startupFailureBanner("detail line", 18);
    expect(banner).toContain("WAS NOT MOUNTED");
    expect(banner).toContain("The 18 failure(s) in this report are NOT test results");
    expect(banner).toContain("detail line");
  });

  it("does NOT exonerate the product when the app was unmounted MID-run", () => {
    // The mid-run arm is reached after the barrier has already proved the app
    // mounted, so something unmounted it. A spec that reloads the frontend --
    // the journey project has several -- is a legitimate suspect, and a banner
    // that flatly said "not a product failure" would excuse a real regression.
    // That is the same lie this guard exists to stop, pointing the other way.
    const banner = startupFailureBanner("detail line", 18);
    expect(banner).toContain("product suspect");
    expect(banner).not.toContain("does not exonerate it.\n  NOT a product failure");
  });

  it("does not talk about '0 failures' when the barrier refused the run", () => {
    // Measured on the live proof: the barrier throwing in global-setup produces
    // a run with no results at all, and the first draft of this banner said
    // "The 0 failure(s) in this report are NOT test results" -- true, and
    // nonsense. The absence of results is the SUCCESS of the guard and has to
    // read that way.
    const banner = startupFailureBanner("detail line", 0);
    expect(banner).toContain("NO test results were produced");
    expect(banner).toContain("CORRECT outcome");
    expect(banner).not.toContain("0 failure(s)");
  });
});

describe("the collection guard's startup arm", () => {
  afterEach(() => clearStartupFailure());

  it("FAILS the run from the marker, before it spawns anything", async () => {
    // Deliberately exercised through the REAL reporter: the guard's value is
    // that it is one reporter with one handshake protecting it, so the arm has
    // to be reachable from the same onEnd the collection comparison uses. If it
    // ran after the `--list` spawn this test would take ~4s and hit the network
    // of processes; it returns immediately because the arm comes first.
    recordStartupFailure("THE APPLICATION NEVER MOUNTED -- proof");
    const guard = new CollectionGuard();
    const verdict = await guard.onEnd({ status: "passed" } as never);
    expect(verdict).toEqual({ status: "failed" });
  });

  it("says nothing when no startup failure was recorded", async () => {
    // The negative direction, through the same reporter: an absent marker must
    // not be turned into a verdict. `onBegin` is deliberately not called, so the
    // collection comparison short-circuits on its own `collected === null` path
    // (a run that aborted before collection) without spawning `--list`.
    clearStartupFailure();
    const guard = new CollectionGuard();
    expect(await guard.onEnd({ status: "passed" } as never)).toBeUndefined();
  });
});
