//! FILENAME: app/e2e/invariants/stateSnapshot.ts
// PURPOSE: Captures a dual snapshot of logical (backend) and visual (DOM) state
//          for invariant checking during monkey testing.

import type { Page } from "@playwright/test";

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
  isEditing: boolean;
}

export interface VisualState {
  ribbonTabs: RibbonTabInfo[];
  visibleDialogCount: number;
  nameBoxValue: string;
  formulaBarValue: string;
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

/** Accumulated errors since last snapshot - managed by the runner */
let pendingConsoleErrors: string[] = [];
let pendingJsExceptions: string[] = [];

/**
 * Install listeners on the page that accumulate console errors and JS exceptions.
 * Call once at the start of a test run.
 */
export function installErrorTracking(page: Page): void {
  pendingConsoleErrors = [];
  pendingJsExceptions = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter out known noisy errors that aren't real bugs
      if (isKnownNoise(text)) return;
      pendingConsoleErrors.push(text);
    }
  });

  page.on("pageerror", (error) => {
    pendingJsExceptions.push(error.message);
  });
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
    const [slicers, charts, tables] = await Promise.all([
      tauri.core.invoke("get_all_slicers").catch(() => []),
      tauri.core.invoke("get_charts").catch(() => []),
      tauri.core.invoke("get_all_tables", {}).catch(() => []),
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
      activeSheet: gridState?.activeSheet ?? 0,
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

    return {
      ribbonTabs,
      visibleDialogCount,
      nameBoxValue: nameBox?.value ?? "",
      formulaBarValue: formulaBar?.value ?? formulaBar?.textContent ?? "",
    };
  });
}
