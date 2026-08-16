//! FILENAME: app/e2e/pageState.ts
// PURPOSE: ONE reading of the page under test, and ONE definition of how a
//          crashed boot is recognised -- shared by the startup barrier
//          (`startupBarrier.ts`, before the first test) and by the fixture that
//          finds the same state late (`fixtures.ts`).
//
// WHY THIS FILE EXISTS AT ALL: THE GUARD KEYED ON A `data-testid`.
// -----------------------------------------------------------------------------
// BUG-0083's root error boundary renders INTO `#root`, so `#root` having
// children stopped meaning "the app is up". The barrier was taught to tell the
// two apart by querying `[data-testid='root-error-boundary']` -- and the pass
// that shipped it recorded the hole in its own note: "nothing verifies it
// survives a production `vite build`. A future strip step would silently return
// the guard to reading a crashed boot as healthy, with no test failing."
//
// A guard that can silently stop guarding is the exact shape this programme has
// been punished by most often (a lock-order census that was green because
// `.ok()` MOVES a guard; four cleanup calls that had never run). So the fix is
// two-sided and both sides are verified, not reasoned:
//
//   1. DETECTION NO LONGER DEPENDS ON THE ATTRIBUTE ALONE. The boundary is
//      recognised by `data-testid` OR by the pair that no attribute-stripping
//      build step touches: `role="alert"` (an accessibility contract, not a test
//      hook) carrying the failure report's own opening line. Either signal alone
//      is sufficient, and the probe REPORTS WHICH ONE FIRED, so a production
//      build that has quietly lost the attribute says so in the banner instead
//      of degrading in silence.
//   2. A TEST RUNS A REAL PRODUCTION BUILD AND LOOKS FOR THEM
//      (`e2e/__tests__/bootErrorMarkerSurvivesBuild.test.ts`). Measured: the
//      whole build of this one module through the real `vite.config.ts` in
//      production mode takes ~140 ms, and a `data-testid`-stripping plugin
//      inserted into that config makes it FAIL (verified by doing it: the
//      minified chunk went 2653 -> 2617 bytes and the attribute signal went
//      false while the role+text signal stayed true).
//
// A THIRD REASON THIS IS ONE FILE. The barrier and the fixture each had their
// own copy of the page reading, and the copies had already drifted (the fixture
// read four fields, the barrier ten, and only one of them trimmed the boundary
// text). Two copies that happen to agree are not one source of truth, and the
// failure mode of the drift is silent: the half that was not updated goes on
// reporting a crashed boot as a healthy mount.

// ---------------------------------------------------------------------------
// The signals
// ---------------------------------------------------------------------------

/** The three things that identify BUG-0083's failure panel on screen. */
export interface BootErrorSignals {
  /**
   * The boundary's test hook. First choice because it is unambiguous -- and
   * NOT trusted alone, because it is the one thing a build step might remove.
   */
  readonly testId: string;
  /**
   * The ARIA role the panel carries. A build step that strips this is breaking
   * accessibility, not test hooks, so it will not happen by accident.
   */
  readonly role: string;
  /**
   * A phrase from the panel's own text. Text is content: minifiers keep it,
   * attribute strippers never see it, and it survives a rename of the
   * component. Kept in sync with the product by
   * `e2e/__tests__/bootErrorSignals.test.ts`, which renders the REAL boundary
   * and runs the REAL probe over it.
   */
  readonly textSignature: string;
}

/**
 * The live values. `textSignature` is the opening line of
 * `formatFailureReport` (`Calcula - <surface> failed to start`), which the panel
 * always renders inside its `<pre>`.
 */
export const BOOT_ERROR_SIGNALS: BootErrorSignals = {
  testId: "root-error-boundary",
  role: "alert",
  textSignature: "failed to start",
};

/** Which signal actually identified the panel. Evidence, printed in the banner. */
export type BootErrorSignalName = "data-testid" | "role+text";

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

/**
 * One reading of the page. Every field is a FACT the page reported, or the
 * explicit "could not be read" value -- never an inference.
 */
export interface RawPageState {
  /** `#root`'s child element count. -1 when the page could not be evaluated. */
  rootChildCount: number;
  /** The spreadsheet container the fixtures wait for. */
  spreadsheetPresent: boolean;
  /** `window.__TAURI__` -- the bridge `tauri.e2e.conf.json` re-enables. */
  tauriBridgePresent: boolean;
  /** `window.__calcImport` -- installed early in main.tsx, so it DATES the failure. */
  calcImportPresent: boolean;
  /** `document.location.href`, or "(unreadable)". */
  url: string;
  /** `document.readyState`, or "(unreadable)". */
  readyState: string;
  /** `document.title`. */
  title: string;
  /** `performance.getEntriesByType("resource").length`. -1 when unreadable. */
  resourceCount: number;
  /** The root error boundary's text when it is on screen, else `null`. */
  bootErrorText: string | null;
  /**
   * Which signal found it, or `null` when no panel was found. `"role+text"` on
   * a run means the `data-testid` was NOT there -- i.e. the exact silent
   * degradation this module exists to make loud.
   */
  bootErrorSignal: BootErrorSignalName | null;
  /**
   * Every `/node_modules/.vite/deps/...?v=<hash>` URL the page actually fetched,
   * read from its OWN resource timings.
   *
   * WHY A LIST OF URLS IS A DIAGNOSIS (BUG-0082's second mechanism, §32). Vite's
   * `?v=` identifies the optimiser run. Two hashes for `react.js` are two URLs,
   * so the browser holds two module instances, so hooks are registered against
   * one dispatcher and read through the other -- `Invalid hook call`, and a page
   * that never renders. Measured on this tree at 4 of 11 cold-cache launches
   * (see `depOptimizer.ts`), and with HMR off under `CALCULA_E2E=1` the page can
   * never recover, because Vite's repair is a `full-reload` nobody receives.
   *
   * The barrier turns this into `collectDuplicateDepVersions(...)` rather than
   * deciding here: the page reports FACTS, the guard draws conclusions.
   */
  depUrls: string[];
}

/**
 * Read the page. RUNS INSIDE THE BROWSER, so it is deliberately self-contained:
 * every value it needs arrives in `s`, because Playwright serialises this
 * function and any free identifier would be a `ReferenceError` in the page.
 */
export const readPageState = (s: BootErrorSignals): RawPageState => {
  // The two globals the harness reads. Their names are fixed by Tauri and by
  // main.tsx respectively, so the camelCase rule cannot apply to them.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const w = window as unknown as { __TAURI__?: unknown; __calcImport?: unknown };
  const root = document.getElementById("root");

  // TWO INDEPENDENT SIGNALS, tried in order of precision. The attribute is
  // exact; the fallback is what a `data-testid`-stripping production build
  // leaves behind, and it is checked against `role` AND text so an ordinary
  // in-app alert (a toast, a validation message) cannot be mistaken for a boot
  // crash and abort a healthy run.
  let el: Element | null = document.querySelector(`[data-testid='${s.testId}']`);
  let signal: BootErrorSignalName | null = el ? "data-testid" : null;
  if (!el) {
    const alerts = Array.from(document.querySelectorAll(`[role='${s.role}']`));
    for (const candidate of alerts) {
      if ((candidate.textContent ?? "").includes(s.textSignature)) {
        el = candidate;
        signal = "role+text";
        break;
      }
    }
  }

  return {
    rootChildCount: root ? root.childElementCount : -1,
    // Trimmed and capped because the panel carries the error and both stacks and
    // this string is printed in full.
    bootErrorText: el ? (el.textContent ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 4000) : null,
    bootErrorSignal: signal,
    spreadsheetPresent: document.querySelector("[data-focus-container='spreadsheet']") !== null,
    tauriBridgePresent: typeof w.__TAURI__ !== "undefined",
    calcImportPresent: typeof w.__calcImport !== "undefined",
    url: document.location.href,
    readyState: document.readyState,
    title: document.title,
    // The page's OWN count of completed subresources. Unlike the CDP counter it
    // is retroactive, so it sees everything that loaded before the barrier
    // attached -- which on a fast launch is everything.
    resourceCount: performance.getEntriesByType("resource").length,
    // ...and, from the same retroactive source, the pre-bundled dependency URLs.
    // Capped: a page holding more than 400 of them has already told the story,
    // and this value crosses the CDP boundary on every poll.
    depUrls: performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n.indexOf("/node_modules/.vite/deps/") !== -1)
      .slice(0, 400),
  };
};

/** What a page that could not be evaluated at all reports. */
export const UNREADABLE_PAGE_STATE: RawPageState = {
  rootChildCount: -1,
  // Not `""`: an unreadable page has NOT been shown to carry a boot error, and
  // an empty string would read as one that reported nothing.
  bootErrorText: null,
  bootErrorSignal: null,
  spreadsheetPresent: false,
  tauriBridgePresent: false,
  calcImportPresent: false,
  url: "(unreadable)",
  readyState: "(unreadable)",
  title: "(unreadable)",
  resourceCount: -1,
  depUrls: [],
};
