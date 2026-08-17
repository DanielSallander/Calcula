/**
 * FILENAME: app/e2e/volatilePersistedState.ts
 * PURPOSE: Put the app's PERSISTED UI state back to factory defaults at the
 *          START of every run, so no run can inherit the residue of another.
 *
 * WHY THIS EXISTS, AND WHY IT IS AT THE START RATHER THAN THE END.
 *
 * On 2026-08-16 a journey run wedged part-way through `shapes-hometab.spec.ts`
 * test 8. That test customises the Home-tab ribbon layout and restores it in a
 * `finally`, and the `finally` DID run — but the app was already unresponsive,
 * so `restoreDefaultHomeLayout(page).catch(() => {})` swallowed its own failure
 * and the injected `rowBreak` stayed in `localStorage`. The NEXT project (visual)
 * then failed `ribbon-core-default-ribbon.png`, because the Cells group rendered
 * three rows and `deleteColumn` was clipped out of the capture.
 *
 * The lesson is structural, not local: **cleanup-on-exit cannot be relied on
 * when the failure mode is "the app died".** A `finally` needs a working app to
 * do its work, and the cases that leave residue are exactly the cases where
 * there isn't one. Making the teardown "more robust" cannot fix that. Resetting
 * on the way IN can, because the reset runs when the app is known-healthy — it
 * sits immediately after `assertAppMounted`, the harness's own last gate before
 * the first test.
 *
 * IT IS A NAMESPACE SWEEP, NOT A LIST, and that is deliberate. An audit of the
 * persisted surface found ~25 keys, of which the one that actually bit was NOT
 * the most dangerous. Latent worse ones:
 *
 *   calcula.appearance.skinId      a dark skin repaints EVERY pixel of EVERY
 *                                  golden in every later project
 *   calcula-panel-placements       an extra ribbon tab AND a ~320px narrower
 *                                  grid area -> every grid golden fails on SIZE
 *   calcula-task-pane              a re-docked or resized pane moves the grid's
 *                                  left edge (NOT the 1218 -> 898 px class:
 *                                  `isOpen` is deliberately not persisted)
 *   calcula.locale                 `src/api/locale.ts` pushes a saved override
 *                                  into the BACKEND on first read, silently
 *                                  changing the formula argument separator for
 *                                  a whole run
 *   ext.<extensionId>.<key>        the generic public settings API — an
 *                                  open-ended namespace nothing enumerates
 *
 * A hand-maintained list would have to win a race against every new preference
 * anyone adds, and that last family cannot be enumerated even in principle. So
 * this clears by PREFIX and reports what it cleared, which fails safe in the
 * direction that matters: a key nobody remembered is still reset.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: anything outside the app's own storage
 * namespaces, and any file under %APPDATA% (see `script-security.json` handling
 * in global-setup — that one is backed up and restored rather than wiped,
 * because it is also a real user's setting).
 */
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Storage-key prefixes the application owns.
 *
 * Every writer found in the audit uses one of these. `calcula` appears with
 * three different separators because the convention drifted (`.` in
 * `src/api/*`, `-` in the zustand `persist` stores, `:` in QuickAccess and the
 * log filter), and a sweep that knew only about `calcula.` would have missed
 * `calcula-panel-placements` — one of the worst offenders.
 */
export const APP_STORAGE_PREFIXES = [
  "calcula.",
  "calcula-",
  "calcula:",
  "ext.",
] as const;

/** Parse a persisted JSON value; `undefined` when absent, raw when not JSON. */
function parsed(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a non-JSON value is still a value; let the predicate judge it
  }
}

/** The `state` slice of a zustand/persist envelope, or `{}`. */
function zustandState(raw: string | undefined): Record<string, unknown> {
  const v = parsed(raw) as { state?: Record<string, unknown> } | undefined;
  return v?.state ?? {};
}

/**
 * THE KEYS WHOSE VALUE CHANGES WHAT A LATER CAPTURE LOOKS LIKE.
 *
 * ONE CATALOGUE, TWO CONSUMERS — deliberately. This module's reset uses it to
 * decide whether what it swept was routine or a real leak, and
 * `e2e/journeys/zz-persisted-residue.spec.ts` uses it to assert at the end of a
 * run. They were briefly two lists and immediately disagreed, which is the
 * ordinary fate of a duplicated fact.
 *
 * `isClean` receives the RAW stored string, or `undefined` when the key is
 * absent. **Absent is always clean** — this reset deletes these keys and the app
 * then falls back to exactly the defaults cited below.
 *
 * WHY IT ASKS "IS THE VALUE DEFAULT" AND NOT "IS THE KEY PRESENT". Two of these
 * belong to `zustand/persist` stores, which write themselves the moment the
 * store hydrates — no user action required. The first draft of the guard
 * asserted absence and failed on a CLEAN app over `calcula-task-pane` holding
 * `{"width":320,"dockMode":"docked"}`, which is precisely `initialState`. A
 * check that reds a clean run is one somebody switches off.
 */
export const GOLDEN_AFFECTING_KEYS: Array<{
  key: string;
  consequence: string;
  isClean: (raw: string | undefined) => boolean;
}> = [
  {
    key: "calcula.appearance.skinId",
    consequence:
      "a non-default skin repaints EVERY pixel of EVERY golden in every later project",
    // Written only by an explicit user choice (src/core/theme/skinLoader.ts:20).
    // Absent means `resolveEffectiveSkinId` falls back to BUILTIN_DEFAULT_SKIN_ID
    // = LIGHT_SKIN_ID (src/core/theme/builtInSkins.ts:13).
    isClean: (raw) => raw === undefined || raw === "light" || raw === '"light"',
  },
  {
    key: "calcula-panel-placements",
    consequence:
      "a moved panel adds a ribbon tab AND narrows [data-grid-area] by ~320px, so every grid golden fails on SIZE",
    // zustand/persist writes itself; default slice is `placements: {}`
    // (src/shell/registries/usePanelPlacementStore.ts:32).
    isClean: (raw) => {
      if (raw === undefined) return true;
      const placements = zustandState(raw).placements;
      return !placements || Object.keys(placements as object).length === 0;
    },
  },
  {
    key: "calcula.appearance.a11y",
    consequence: "high-contrast forces black text into every capture",
    // `readUserA11y` treats absent as `{}` (src/api/appearancePolicy.ts:135-142);
    // `setUserAccessibility` only writes on an explicit toggle (:164).
    isClean: (raw) => {
      if (raw === undefined) return true;
      const v = parsed(raw);
      return !!v && typeof v === "object" && Object.values(v as object).every((x) => !x);
    },
  },
  {
    key: "calcula.homeTab.layout",
    consequence:
      "a customised ribbon changes the Cells/Number group layout — this is the one that cost the 2026-08-16 run",
    // Written only by the Customize dialog
    // (extensions/BuiltIn/HomeTab/homeTabConfig.ts:363).
    isClean: (raw) => raw === undefined,
  },
  {
    key: "calcula-task-pane",
    consequence:
      "a re-docked or resized task pane moves the grid's left edge in every later capture",
    // zustand/persist writes this unprompted. `partialize` persists ONLY
    // {width, dockMode} — `isOpen` is deliberately NOT persisted
    // (src/shell/TaskPane/useTaskPaneStore.ts:219-224), so an open pane cannot
    // survive a reload. Defaults: DEFAULT_WIDTH = 320 (:77), dockMode "docked" (:89).
    isClean: (raw) => {
      if (raw === undefined) return true;
      const s = zustandState(raw);
      const width = s.width === undefined || s.width === 320;
      const dock = s.dockMode === undefined || s.dockMode === "docked";
      return width && dock;
    },
  },
  {
    key: "calcula.extensions.disabled",
    consequence: "a disabled extension removes a whole ribbon group from every golden",
    // src/shell/registries/extensionDisabledStore.ts:8 — absent or empty = all enabled.
    isClean: (raw) => {
      if (raw === undefined) return true;
      const v = parsed(raw);
      if (Array.isArray(v)) return v.length === 0;
      return !!v && typeof v === "object" && Object.keys(v as object).length === 0;
    },
  },
  {
    key: "calcula.locale",
    consequence:
      "src/api/locale.ts pushes a saved override into the BACKEND on first read, silently changing the formula argument separator for the whole next run",
    // extensions/Settings/SettingsView.tsx:49 reads it as `|| "system"`.
    isClean: (raw) => raw === undefined || raw === "system" || raw === '"system"',
  },
];

/** A key that was found holding a NON-default value — a real inherited leak. */
export interface DisturbedKey {
  key: string;
  value: string;
  consequence: string;
}

/** Result of one reset, for logging and for the guard's assertions. */
export interface VolatileStateReset {
  /** Keys that were present and have been removed. */
  cleared: string[];
  /**
   * The subset of `cleared` that was NOT at its default — i.e. genuine residue
   * inherited from an earlier run, as opposed to a self-writing store's own
   * defaults. Only this warrants an alarm; `cleared` alone does not.
   */
  disturbed: DisturbedKey[];
  /** True when the page had to be reloaded to make the reset stick. */
  reloaded: boolean;
}

/**
 * Remove every app-owned key from `localStorage` and `sessionStorage`.
 *
 * Returns the keys it removed so the caller can say so out loud: a run that
 * silently repairs inherited residue teaches nobody that the residue happened.
 */
export async function resetVolatilePersistedState(page: Page): Promise<VolatileStateReset> {
  // Read the VALUES as well as the names. Without them the caller can only say
  // "cleared N keys", which cannot distinguish a store writing its own defaults
  // (every run, uninteresting) from residue a dead run left behind (rare, the
  // whole point). An alarm that fires every run is one nobody reads.
  const removed = await page.evaluate((prefixes: readonly string[]) => {
    const out: Record<string, string> = {};
    const sweep = (store: Storage): void => {
      // Collect first, delete after: removing while iterating by index skips
      // entries, which is how a "clean" sweep leaves half the keys behind.
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
      }
      for (const k of keys) {
        if (out[k] === undefined) out[k] = store.getItem(k) ?? "";
        store.removeItem(k);
      }
    };
    try { sweep(window.localStorage); } catch { /* storage unavailable */ }
    try { sweep(window.sessionStorage); } catch { /* storage unavailable */ }
    return out;
  }, APP_STORAGE_PREFIXES as unknown as string[]);

  const cleared = Object.keys(removed);
  const disturbed: DisturbedKey[] = GOLDEN_AFFECTING_KEYS.filter(
    (k) => removed[k.key] !== undefined && !k.isClean(removed[k.key]),
  ).map((k) => ({ key: k.key, value: removed[k.key], consequence: k.consequence }));

  if (cleared.length === 0) return { cleared, disturbed, reloaded: false };

  // THE RELOAD IS NOT OPTIONAL, and this is the part that is easy to get wrong.
  //
  // Removing the key is not enough: the stores that own these values are ALIVE
  // in the running page, and several of them write back on change or on
  // shutdown. Measured on 2026-08-16 — clearing `calcula.homeTab.layout` while
  // the app was running left the ribbon customised AND the key re-saved from
  // the in-memory layout, so the very next run inherited it again. Reloading
  // rebuilds every store from the now-absent keys, which is what actually
  // returns the UI to defaults.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 90_000,
  });

  return { cleared, disturbed, reloaded: true };
}

/**
 * Connect over CDP, find the app page, and reset it. Used by `global-setup`,
 * which has no Playwright fixtures available to it.
 *
 * Never throws: a run must not be blocked from starting because the tidy-up
 * could not connect. It reports instead — the residue guard is what turns a
 * failure to reset into a visible failure, not this.
 */
export async function resetVolatilePersistedStateOverCdp(
  cdpPort: number,
): Promise<VolatileStateReset | null> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = browser.contexts()[0];
    if (!context) return null;
    // The main window is the one carrying the grid; a Script Editor window may
    // also be open (same reasoning as `fixtures.ts`'s page selection).
    const pages = context.pages();
    let page: Page | undefined = pages[0];
    for (const candidate of pages) {
      const isMain = await candidate
        .waitForSelector("[data-focus-container='spreadsheet']", { state: "visible", timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      if (isMain) { page = candidate; break; }
    }
    if (!page) return null;
    return await resetVolatilePersistedState(page);
  } catch {
    return null;
  } finally {
    // `connectOverCDP` owns only the connection, never the browser: closing it
    // detaches, it does not shut the app down.
    await browser?.close().catch(() => {});
  }
}
