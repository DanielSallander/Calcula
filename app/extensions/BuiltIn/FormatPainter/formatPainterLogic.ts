//! FILENAME: app/extensions/BuiltIn/FormatPainter/formatPainterLogic.ts
// PURPOSE: Core logic for the Format Painter tool: capture source styles, apply to target.
// CONTEXT: Called by the extension entry point. Uses the public API only (no deep core imports).

import type { Selection } from "../../../src/api/types";
import {
  getCell,
  setCellStyle,
  beginUndoTransaction,
  commitUndoTransaction,
  setClipboard,
  clearClipboard,
  emitAppEvent,
  AppEvents,
  restoreFocusToGrid,
  ExtensionRegistry,
  registerEditGuard,
  dispatchGridAction,
} from "../../../src/api";

import {
  isFormatPainterActive,
  isFormatPainterPersistent,
  getSourceStyles,
  getSourceDimensions,
  setFormatPainterActive,
  clearFormatPainterState,
  addCleanup,
  runAllCleanups,
} from "./formatPainterState";

// ============================================================================
// Paintbrush Cursor (SVG data URL)
// ============================================================================

const PAINTBRUSH_CURSOR_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23333' stroke-width='1.5'%3E%3Cpath d='M18.37 2.63a2 2 0 0 1 0 2.83L14 9.82l-1.17-1.17 4.37-4.37a1 1 0 0 1 1.41 0l.76.76zM12.13 9.35l-1.48-1.48-4.6 4.6a2 2 0 0 0-.5.9L4.5 17.5l4.13-1.05a2 2 0 0 0 .9-.5l4.6-4.6-2-2z'/%3E%3Cpath d='M4.5 17.5L2 22l4.5-2.5'/%3E%3C/svg%3E") 2 22, cell`;

// ============================================================================
// Capture Source Formatting
// ============================================================================

/**
 * Read the styleIndex of every cell in the source selection.
 * Returns a Map of "relRow,relCol" -> styleIndex.
 */
export async function captureSourceFormat(
  selection: Selection
): Promise<{ styles: Map<string, number>; width: number; height: number }> {
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  const width = maxCol - minCol + 1;
  const height = maxRow - minRow + 1;
  const styles = new Map<string, number>();

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const relR = r - minRow;
      const relC = c - minCol;
      try {
        const cell = await getCell(r, c);
        styles.set(`${relR},${relC}`, cell?.styleIndex ?? 0);
      } catch {
        styles.set(`${relR},${relC}`, 0);
      }
    }
  }

  return { styles, width, height };
}

// ============================================================================
// Apply Format to Target
// ============================================================================

/**
 * Apply the captured source styles to the target selection.
 * Uses tiling for range-to-range: source pattern repeats over the target.
 */
export async function applyFormatToTarget(target: Selection): Promise<void> {
  if (!isFormatPainterActive()) return;

  const sourceStyles = getSourceStyles();
  const { width: srcW, height: srcH } = getSourceDimensions();

  if (sourceStyles.size === 0 || srcW === 0 || srcH === 0) return;

  const minRow = Math.min(target.startRow, target.endRow);
  const maxRow = Math.max(target.startRow, target.endRow);
  const minCol = Math.min(target.startCol, target.endCol);
  const maxCol = Math.max(target.startCol, target.endCol);

  try {
    await beginUndoTransaction("Format Painter");

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const relR = (r - minRow) % srcH;
        const relC = (c - minCol) % srcW;
        const styleIndex = sourceStyles.get(`${relR},${relC}`);

        if (styleIndex !== undefined) {
          await setCellStyle(r, c, styleIndex);
        }
      }
    }

    await commitUndoTransaction();

    // Refresh style cache and grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));

    console.log(
      `[FormatPainter] Applied format to ${(maxRow - minRow + 1) * (maxCol - minCol + 1)} cells`
    );
  } catch (err) {
    console.error("[FormatPainter] Failed to apply format:", err);
  }

  // Deactivate in single-use mode
  if (!isFormatPainterPersistent()) {
    deactivateFormatPainter();
  }
}

// ============================================================================
// Cursor Management
// ============================================================================

function setCursorPaintbrush(): void {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (canvas) {
    canvas.style.setProperty("cursor", PAINTBRUSH_CURSOR_SVG, "important");
  }
}

function clearCursorOverride(): void {
  const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (canvas) {
    canvas.style.removeProperty("cursor");
  }
}

// ============================================================================
// Activation / Deactivation
// ============================================================================

/**
 * Activate the Format Painter tool.
 * @param persistent - True for persistent mode (stays active after applying once).
 * @param currentSelection - The current grid selection (source).
 */
export async function activateFormatPainter(
  persistent: boolean,
  currentSelection: Selection | null
): Promise<void> {
  // If already active, toggle off
  if (isFormatPainterActive()) {
    deactivateFormatPainter();
    return;
  }

  if (!currentSelection) {
    console.warn("[FormatPainter] No selection to capture format from.");
    return;
  }

  console.log(
    `[FormatPainter] Activating (${persistent ? "persistent" : "single-use"})`,
    currentSelection
  );

  // 1. Capture source styles
  const { styles, width, height } = await captureSourceFormat(currentSelection);

  // 2. Update state
  setFormatPainterActive(true, persistent, currentSelection, styles, width, height);

  // 3. Show marching ants around source
  dispatchGridAction(setClipboard("copy", { ...currentSelection }));

  // 4. Change cursor to paintbrush
  setCursorPaintbrush();

  // Keep cursor overridden on mouse move (core resets cursor on every move)
  const handleMouseMove = () => {
    if (isFormatPainterActive()) {
      setCursorPaintbrush();
    }
  };
  window.addEventListener("mousemove", handleMouseMove);
  addCleanup(() => window.removeEventListener("mousemove", handleMouseMove));

  // 5. Listen for selection changes and apply on mouseup (supports drag-to-select)
  let isFirstCallback = true;
  let pendingTarget: Selection | null = null;

  const unsubSelection = ExtensionRegistry.onSelectionChange(
    (newSelection: Selection | null) => {
      // Skip the first callback - it fires immediately with the current selection
      if (isFirstCallback) {
        isFirstCallback = false;
        return;
      }

      if (!isFormatPainterActive() || !newSelection) return;

      // Store as pending - apply will happen on mouseup
      pendingTarget = newSelection;
    }
  );
  addCleanup(unsubSelection);

  // Apply format when mouse is released (user finished dragging to select target)
  const handleMouseUp = () => {
    if (!isFormatPainterActive() || !pendingTarget) return;

    const target = pendingTarget;
    pendingTarget = null;
    applyFormatToTarget(target);
  };
  window.addEventListener("mouseup", handleMouseUp);
  addCleanup(() => window.removeEventListener("mouseup", handleMouseUp));

  // 6. Register edit guard to block editing while painter is active
  const unsubEditGuard = registerEditGuard(async () => {
    if (isFormatPainterActive()) {
      return { blocked: true, message: "Format Painter is active. Click a cell to apply formatting." };
    }
    return null;
  });
  addCleanup(unsubEditGuard);

  restoreFocusToGrid();
}

/**
 * Deactivate the Format Painter tool.
 */
export function deactivateFormatPainter(): void {
  if (!isFormatPainterActive()) return;

  console.log("[FormatPainter] Deactivating");

  // 1. Restore cursor
  clearCursorOverride();

  // 2. Clear marching ants
  dispatchGridAction(clearClipboard());

  // 3. Unregister all listeners and guards
  runAllCleanups();

  // 4. Reset state
  clearFormatPainterState();

  // 5. Restore focus
  restoreFocusToGrid();
}
