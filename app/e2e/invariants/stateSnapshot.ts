//! FILENAME: app/e2e/invariants/stateSnapshot.ts
// PURPOSE: Captures a dual snapshot of logical (backend) and visual (DOM) state
//          for invariant checking during monkey testing.

import type { ConsoleMessage, Page } from "@playwright/test";

// ============================================================================
// Snapshot Types
// ============================================================================

export interface RibbonTabInfo {
  label: string;
  isActive: boolean;
  /** Non-null for contextual tabs (e.g. "#217346") */
  accentColor: string | null;
}

export interface SlicerInfo {
  id: number;
  name: string;
  sheetIndex: number;
}

export interface ChartInfo {
  id: string;
  sheetIndex: number;
}

export interface TableInfo {
  id: number;
  name: string;
}

export interface PivotInfo {
  pivotId: number;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface TimelineInfo {
  id: number;
  name: string;
  sheetIndex: number;
}

export interface SparklineGroupInfo {
  id: string;
  cellCount: number;
}

export interface SelectionInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface LogicalState {
  slicers: SlicerInfo[];
  charts: ChartInfo[];
  tables: TableInfo[];
  pivots: PivotInfo[];
  timelines: TimelineInfo[];
  sparklineGroups: SparklineGroupInfo[];
  selection: SelectionInfo | null;
  activeSheet: number;
  /** Number of sheets in the workbook (1 if the query fails). */
  sheetCount: number;
  /**
   * The workbook's sheet NAMES, in index order (empty if the query fails).
   *
   * WHY A COUNT IS NOT ENOUGH. `sheet.rename` changes no count and no active
   * index, so with `sheetCount` alone a rename that silently did nothing and a
   * rename that worked produce byte-identical snapshots — and the walker's
   * coverage line would report the action as "ran" either way. That is exactly
   * the shape of BUG-0031, where `chart.select`/`chart.delete` were counted as
   * explored for the whole programme while doing nothing at all. The names are
   * the cheapest observation that distinguishes the two, and `get_sheets` is
   * already being invoked here.
   */
  sheetNames: string[];
  /**
   * The active sheet as the BACKEND reports it (`get_sheets().activeIndex`),
   * against `activeSheet` above, which is what the FRONTEND believes.
   *
   * They are supposed to be the same number and there was no way to notice when
   * they were not. `hide_sheet` returned a "recommended" active index without
   * performing the switch, every caller treated it as done, and the backend
   * stayed on the sheet that had just been hidden — so the tab strip said
   * Sheet1 while every cell read and write went to Sheet2 (BUG-0046). No digest
   * could see it: the backend was self-consistent, and the digest only ever
   * asks the backend.
   */
  backendActiveSheet: number;
  /** Per-sheet visibility, in index order ("visible" | "hidden" | "veryHidden"). */
  sheetVisibility: string[];
  isEditing: boolean;
}

/**
 * What is sitting on top of the ribbon, when anything is.
 *
 * WHY THIS IS A FIELD AND NOT A COMMENT. `visibleDialogCount` has been captured
 * since the beginning and NOTHING ever checked it — and it would not have
 * caught this anyway: the Customize Home Tab modal carries no `role="dialog"`,
 * so the count stays 0 while a `position: fixed`, `z-index: 1050` div covers
 * 100% of the viewport. The only reliable question is the one a user would ask:
 * IF I CLICKED THE RIBBON, WHAT WOULD I HIT? That is `elementFromPoint`, and it
 * is immune to both styled-components hashes and missing ARIA roles.
 */
export interface RibbonBlocker {
  tag: string;
  className: string;
  role: string | null;
  zIndex: string;
  /** First ~80 chars of the covering element's text — usually names it. */
  text: string;
}

export interface VisualState {
  ribbonTabs: RibbonTabInfo[];
  visibleDialogCount: number;
  nameBoxValue: string;
  formulaBarValue: string;
  /**
   * Non-null when a click on the ribbon's tab strip would land on something
   * else. A walk that continues in this state is issuing UI actions into a
   * backdrop — each one either silently doing nothing or burning the 30s
   * action timeout — and still reporting PASS. See BUG-0037.
   */
  ribbonBlockedBy: RibbonBlocker | null;
}

export interface StateSnapshot {
  logical: LogicalState;
  visual: VisualState;
  consoleErrors: string[];
  jsExceptions: string[];
  timestamp: number;
}

// ============================================================================
// Console/Error Tracking
// ============================================================================

/**
 * One console message or page error, as it arrived, with the walk step it
 * arrived during and how long into the run that was.
 *
 * WHY A RING AND NOT JUST THE ERRORS. S13 was a `no-console-errors` failure on
 * a fresh soak seed that never reproduced in sixteen replays. Everything that
 * could have explained it had been discarded before the bundle was written:
 *
 *   - the walker reports a refused/failed script mount with `console.warn`
 *     (`[walker] script mount refused/failed:`) and only `console.error` was
 *     captured, so the one line naming the cause was dropped on the floor;
 *   - `isKnownNoise()` dropped its matches with no record at all, so a
 *     mis-calibrated filter is indistinguishable from a quiet run;
 *   - nothing recorded WHEN anything happened, so a ten-second mount deadline
 *     and an instant failure produced identical evidence.
 *
 * An unreproducible failure with a complete bundle beats another sixteen
 * replays, so everything the page says is kept, in order, with timestamps.
 */
export interface ConsoleEntry {
  /** Walk step during which the message arrived (0 = before the first action). */
  step: number;
  /** Milliseconds since `installErrorTracking()`. */
  atMs: number;
  /** "error" | "warning" | "log" | "info" | "debug" | ... | "pageerror". */
  type: string;
  text: string;
  /** `url:line:col` the browser attributed the message to, when it reports one. */
  location: string | null;
  /** True when `isKnownNoise()` kept this out of the console-error invariant. */
  filtered: boolean;
}

export interface ConsoleLog {
  entries: ConsoleEntry[];
  /** Entries evicted by the ring — non-zero means `entries` is a TAIL. */
  dropped: number;
  capacity: number;
  /** Wall-clock start the `atMs` offsets are relative to. */
  startedAt: string;
}

/**
 * Ring capacity. A 150-action walk at 250ms settle produces a few hundred
 * console lines in Vite dev; 2000 keeps a whole ordinary walk verbatim, and
 * `dropped` says so out loud when it does not.
 */
const CONSOLE_RING_CAPACITY = 2000;

/** Accumulated errors since last snapshot - managed by the runner */
let pendingConsoleErrors: string[] = [];
let pendingJsExceptions: string[] = [];

/** Everything the page said, in order (see ConsoleEntry). */
let consoleRing: ConsoleEntry[] = [];
let consoleRingDropped = 0;
let trackingStartedAtMs = Date.now();
let trackingStartedAtIso = new Date().toISOString();

/** The step the runner is currently executing, stamped onto every entry. */
let currentStep = 0;

/** The live listener pair, so a re-install can detach it (see below). */
let attached: {
  page: Page;
  onConsole: (msg: ConsoleMessage) => void;
  onPageError: (error: Error) => void;
} | null = null;

/** Stamp subsequent console entries with the walk step they belong to. */
export function setWalkStep(step: number): void {
  currentStep = step;
}

function pushRingEntry(entry: ConsoleEntry): void {
  consoleRing.push(entry);
  while (consoleRing.length > CONSOLE_RING_CAPACITY) {
    consoleRing.shift();
    consoleRingDropped++;
  }
}

/**
 * Install listeners on the page that accumulate console errors and JS exceptions.
 * Call once at the start of a test run.
 *
 * IDEMPOTENT BY DETACHING FIRST. The shrinker builds a fresh runner for every
 * replay and every runner installs tracking, so without the detach a 30-replay
 * shrink finishes with 31 live listeners on one page — each pushing the same
 * message into the same buffer, which multiplies every console error by the
 * replay number and makes the ring's "N errors" meaningless.
 */
export function installErrorTracking(page: Page): void {
  if (attached) {
    try {
      attached.page.off("console", attached.onConsole);
      attached.page.off("pageerror", attached.onPageError);
    } catch {
      // Page already closed — the listeners went with it.
    }
    attached = null;
  }

  pendingConsoleErrors = [];
  pendingJsExceptions = [];
  consoleRing = [];
  consoleRingDropped = 0;
  currentStep = 0;
  trackingStartedAtMs = Date.now();
  trackingStartedAtIso = new Date().toISOString();

  const onConsole = (msg: ConsoleMessage): void => {
    const type = msg.type();
    const text = msg.text();
    // Filter out known noisy errors that aren't real bugs — but RECORD the
    // fact, so a filter that is swallowing a real defect is visible.
    const filtered = type === "error" && isKnownNoise(text);
    let location: string | null = null;
    try {
      const loc = msg.location();
      location = loc?.url
        ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`
        : null;
    } catch {
      location = null;
    }
    pushRingEntry({
      step: currentStep,
      atMs: Date.now() - trackingStartedAtMs,
      type,
      text,
      location,
      filtered,
    });
    if (type === "error" && !filtered) {
      pendingConsoleErrors.push(text);
    }
  };

  const onPageError = (error: Error): void => {
    // Capture the top stack frames alongside the message so monkey-found
    // crashes are root-causable. In Vite dev the frames reference the served
    // module URL + line (e.g. .../extensions/Controls/index.ts:125:30), which
    // pinpoints the throw site. Kept single-line to not disturb report layout.
    const frames = (error.stack ?? "")
      .split("\n")
      .slice(1, 6)
      .map((l) => l.trim())
      .filter(Boolean);
    const text = frames.length
      ? `${error.message} | ${frames.join(" | ")}`
      : error.message;
    pushRingEntry({
      step: currentStep,
      atMs: Date.now() - trackingStartedAtMs,
      type: "pageerror",
      text,
      location: null,
      filtered: false,
    });
    pendingJsExceptions.push(text);
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  attached = { page, onConsole, onPageError };
}

/** Drain accumulated errors (returns and clears the buffer). */
export function drainErrors(): { consoleErrors: string[]; jsExceptions: string[] } {
  const result = {
    consoleErrors: [...pendingConsoleErrors],
    jsExceptions: [...pendingJsExceptions],
  };
  pendingConsoleErrors = [];
  pendingJsExceptions = [];
  return result;
}

/** Everything the page has said since tracking was installed. */
export function getConsoleLog(): ConsoleLog {
  return {
    entries: [...consoleRing],
    dropped: consoleRingDropped,
    capacity: CONSOLE_RING_CAPACITY,
    startedAt: trackingStartedAtIso,
  };
}

function isKnownNoise(text: string): boolean {
  // WebView2 and Tauri often emit harmless noise
  const patterns = [
    "ResizeObserver loop",
    "net::ERR_",
    "Failed to load resource",
    "[ExtensionRegistry]", // warnings about registration order
  ];
  return patterns.some((p) => text.includes(p));
}

// ============================================================================
// Snapshot Capture
// ============================================================================

/**
 * Capture a complete state snapshot from the running application.
 * Queries both the Tauri backend (logical state) and the DOM (visual state).
 */
export async function captureSnapshot(page: Page): Promise<StateSnapshot> {
  const errors = drainErrors();

  const [logical, visual] = await Promise.all([
    captureLogicalState(page),
    captureVisualState(page),
  ]);

  return {
    logical,
    visual,
    consoleErrors: errors.consoleErrors,
    jsExceptions: errors.jsExceptions,
    timestamp: Date.now(),
  };
}

async function captureLogicalState(page: Page): Promise<LogicalState> {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    const gridState = (window as any).__CALCULA_GRID_STATE__;

    // Fetch backend state in parallel
    const [slicers, charts, tables, sheetsResult] = await Promise.all([
      tauri.core.invoke("get_all_slicers").catch(() => []),
      tauri.core.invoke("get_charts").catch(() => []),
      tauri.core.invoke("get_all_tables", {}).catch(() => []),
      tauri.core.invoke("get_sheets").catch(() => null),
    ]);

    // Pivot regions from frontend cache (no backend command for "get all pivots")
    const pivotApi = (window as any).__CALCULA_PIVOT__;
    const pivotRegions: any[] = pivotApi?.getCachedRegions?.() ?? [];

    // Timeline slicers from frontend cache
    const timelineApi = (window as any).__CALCULA_TIMELINE__;
    const timelines: any[] = timelineApi?.getAllTimelines?.() ?? [];

    // Sparkline groups from frontend store
    const sparkApi = (window as any).__CALCULA_SPARKLINES__;
    const sparkGroups: any[] = sparkApi?.getAllGroups?.() ?? [];

    // Extract selection from grid state
    let selection: any = null;
    if (gridState?.selection) {
      const sel = gridState.selection;
      selection = {
        startRow: sel.startRow ?? sel.row ?? 0,
        startCol: sel.startCol ?? sel.col ?? 0,
        endRow: sel.endRow ?? sel.row ?? 0,
        endCol: sel.endCol ?? sel.col ?? 0,
      };
    }

    return {
      slicers: (slicers as any[]).map((s: any) => ({
        id: s.id,
        name: s.name,
        sheetIndex: s.sheetIndex ?? s.sheet_index ?? 0,
      })),
      charts: (charts as any[]).map((c: any) => ({
        id: c.id,
        sheetIndex: c.sheetIndex ?? c.sheet_index ?? 0,
      })),
      tables: (tables as any[]).map((t: any) => ({
        id: t.id,
        name: t.name,
      })),
      pivots: pivotRegions.map((r: any) => ({
        pivotId: r.pivotId ?? r.pivot_id ?? 0,
        sheetIndex: r.sheetIndex ?? r.sheet_index ?? 0,
        startRow: r.startRow ?? 0,
        startCol: r.startCol ?? 0,
        endRow: r.endRow ?? 0,
        endCol: r.endCol ?? 0,
      })),
      timelines: timelines.map((t: any) => ({
        id: t.id,
        name: t.name,
        sheetIndex: t.sheetIndex ?? t.sheet_index ?? 0,
      })),
      sparklineGroups: sparkGroups.map((g: any) => ({
        id: g.id,
        cellCount: g.cells?.length ?? g.locationCells?.length ?? 1,
      })),
      selection,
      // MEASURED LIVE 2026-08-12: `gridState.activeSheet` DOES NOT EXIST. The
      // grid state object exposes `sheetContext.activeSheetIndex`; the key read
      // here has been `undefined` for the whole life of this file, so the `?? 0`
      // made every snapshot -- and therefore every failure bundle, every
      // minimized trace and every triage that reasoned from one -- report
      // `activeSheet: 0` no matter which sheet was active. Probed on a running
      // app sitting on Sheet2: `sheetContext.activeSheetIndex` was 1 and this
      // field said 0.
      //
      // A defaulted read of a misspelled key is indistinguishable from a
      // correct read of a true value, which is why it survived. The fallback
      // chain keeps the old key first so a future rename in the other direction
      // is picked up rather than silently zeroed.
      activeSheet:
        gridState?.activeSheet ??
        gridState?.sheetContext?.activeSheetIndex ??
        0,
      sheetCount: (sheetsResult as any)?.sheets?.length ?? 1,
      sheetNames: (((sheetsResult as any)?.sheets ?? []) as any[]).map((s: any) =>
        String(s?.name ?? "")
      ),
      backendActiveSheet: (sheetsResult as any)?.activeIndex ?? 0,
      sheetVisibility: (((sheetsResult as any)?.sheets ?? []) as any[]).map((s: any) =>
        String(s?.visibility ?? "visible")
      ),
      isEditing: gridState?.editing === true,
    };
  });
}

async function captureVisualState(page: Page): Promise<VisualState> {
  return page.evaluate(() => {
    // Read ribbon tabs from the registry (exposed on window by bootstrap.ts)
    const registry = (window as any).__CALCULA_EXTENSION_REGISTRY__;
    let ribbonTabs: any[] = [];

    if (registry?.getRibbonTabs) {
      const tabs = registry.getRibbonTabs() as any[];
      // Tab buttons are inside the first div child of ribbon container
      const headerContainer = document.querySelector(
        "[data-ribbon-content]"
      )?.parentElement?.querySelector("div");

      ribbonTabs = tabs.map((tab: any) => {
        // Find the DOM button for this tab to check active state
        const btn = headerContainer
          ? Array.from(headerContainer.querySelectorAll("button")).find(
              (b) => b.textContent?.trim() === tab.label
            )
          : null;
        const isActive = btn
          ? window.getComputedStyle(btn).fontWeight === "600"
          : false;

        return {
          label: tab.label,
          isActive,
          accentColor: tab.color ?? null,
        };
      });
    }

    // Count visible dialogs
    const visibleDialogCount = document.querySelectorAll(
      '[role="dialog"]:not([style*="display: none"])'
    ).length;

    // Read name box and formula bar
    const nameBox = document.querySelector<HTMLInputElement>(
      'input[aria-label="Name Box"]'
    );
    const formulaBar = document.querySelector<HTMLInputElement>(
      'input[aria-label="Formula Bar"], [data-testid="formula-bar"] input, [data-testid="formula-bar"] textarea'
    );

    // Is the ribbon's tab strip actually clickable? Hit-test the centre of a
    // real tab button and see what comes back. Anything that is neither the
    // button nor inside the tab strip is covering it.
    let ribbonBlockedBy: Record<string, unknown> | null = null;
    const tabStrip = document
      .querySelector("[data-ribbon-content]")
      ?.parentElement?.querySelector("div");
    const probeBtn = tabStrip?.querySelector("button");
    if (probeBtn) {
      const r = probeBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2
        );
        if (hit && hit !== probeBtn && !probeBtn.contains(hit) && !tabStrip!.contains(hit)) {
          const style = window.getComputedStyle(hit);
          ribbonBlockedBy = {
            tag: hit.tagName.toLowerCase(),
            className: typeof hit.className === "string" ? hit.className : "",
            role: hit.getAttribute("role"),
            zIndex: style.zIndex,
            text: (hit.textContent ?? "").trim().slice(0, 80),
          };
        }
      }
    }

    return {
      ribbonTabs,
      visibleDialogCount,
      nameBoxValue: nameBox?.value ?? "",
      formulaBarValue: formulaBar?.value ?? formulaBar?.textContent ?? "",
      ribbonBlockedBy: ribbonBlockedBy as VisualState["ribbonBlockedBy"],
    };
  });
}
