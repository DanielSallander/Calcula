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

    // Extract selection from grid state
    let selection: SelectionInfo | null = null;
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
    let ribbonTabs: RibbonTabInfo[] = [];

    if (registry?.getRibbonTabs) {
      const tabs = registry.getRibbonTabs() as any[];
      // Also check which tab button is active in the DOM
      const tabButtons = document.querySelectorAll<HTMLButtonElement>(
        "[data-ribbon-content]"
      );
      // Tab buttons are the siblings before [data-ribbon-content]
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

// Re-export the type for use in evaluate callbacks
type RibbonTabInfo_Inner = RibbonTabInfo;
type SelectionInfo_Inner = SelectionInfo;
