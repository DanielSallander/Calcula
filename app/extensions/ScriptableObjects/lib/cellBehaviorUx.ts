//! FILENAME: app/extensions/ScriptableObjects/lib/cellBehaviorUx.ts
// PURPOSE: UX for cell-behavior bindings (granular bricks phase 2): the grid
//          context-menu attach/edit/remove flow and the per-cell design-mode
//          badge. The binding store + dispatch live in @api/cellBehaviors; the
//          script lifecycle rides the ordinary object-script machinery.
// TRANSPARENCY: every behavior-attached cell shows a badge in Design Mode, and
//          bindings are plain persisted records — visible without running code.

import type { ExtensionContext } from "@api/contract";
import type { Selection } from "@api";
import {
  ExtensionRegistry,
  gridExtensions,
  ObjectScriptManager,
  emitAppEvent,
  onAppEvent,
  AppEvents,
  getDesignMode,
  onDesignModeChange,
  registerRowGutterWidget,
} from "@api";
import {
  attachCellBehavior,
  removeCellBehavior,
  refreshCellBehaviors,
  getCellBehaviorAt,
  hasCellBehaviors,
  activeBehaviorSheet,
  listCellBehaviors,
  CELL_BEHAVIORS_CHANGED_EVENT,
  type CellBehaviorBinding,
} from "../../../src/api/cellBehaviors";
import { getScaffoldTemplate } from "../../../src/api/scriptableObjectScaffolds";
import { saveObjectScript } from "../../../src/api/objectScriptBackend";

// ============================================================================
// Range helpers
// ============================================================================

function colIndexToLetter(col: number): string {
  let letters = "";
  let c = col;
  while (c >= 0) {
    letters = String.fromCharCode(65 + (c % 26)) + letters;
    c = Math.floor(c / 26) - 1;
  }
  return letters;
}

interface TargetRange {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

function rangeLabel(r: TargetRange): string {
  const a1 = `${colIndexToLetter(r.startCol)}${r.startRow + 1}`;
  if (r.startRow === r.endRow && r.startCol === r.endCol) return a1;
  return `${a1}:${colIndexToLetter(r.endCol)}${r.endRow + 1}`;
}

function contextTarget(ctx: {
  selection: Selection | null;
  clickedCell: { row: number; col: number } | null;
  isWithinSelection: boolean;
  sheetIndex: number;
}): TargetRange | null {
  if (ctx.isWithinSelection && ctx.selection) {
    return {
      sheetIndex: ctx.sheetIndex,
      startRow: Math.min(ctx.selection.startRow, ctx.selection.endRow),
      startCol: Math.min(ctx.selection.startCol, ctx.selection.endCol),
      endRow: Math.max(ctx.selection.startRow, ctx.selection.endRow),
      endCol: Math.max(ctx.selection.startCol, ctx.selection.endCol),
    };
  }
  if (ctx.clickedCell) {
    return {
      sheetIndex: ctx.sheetIndex,
      startRow: ctx.clickedCell.row,
      startCol: ctx.clickedCell.col,
      endRow: ctx.clickedCell.row,
      endCol: ctx.clickedCell.col,
    };
  }
  return null;
}

// ============================================================================
// Attach / edit / remove flows
// ============================================================================

/**
 * Create a binding + its scaffolded "range" script, mount it (the scaffold's
 * onClick gives instant feedback), and open the code editor.
 */
async function attachBehavior(target: TargetRange): Promise<void> {
  const bindingId = crypto.randomUUID();
  const name = `Behavior ${rangeLabel(target)}`;
  const script = {
    id: crypto.randomUUID(),
    name,
    objectType: "range" as const,
    instanceId: bindingId,
    source: getScaffoldTemplate("range", name),
    accessLevel: "restricted" as const,
  };

  ObjectScriptManager.registerScript(script);
  try {
    await saveObjectScript(script);
  } catch (e) {
    console.warn("[CellBehaviors] Failed to persist behavior script:", e);
  }
  await attachCellBehavior({
    id: bindingId,
    scriptId: script.id,
    sheetIndex: target.sheetIndex,
    startRow: target.startRow,
    startCol: target.startCol,
    endRow: target.endRow,
    endCol: target.endCol,
  });
  // Mount so the scaffold works immediately (gated by Script Security).
  await ObjectScriptManager.mountScript(script.id);

  emitAppEvent("scriptable-objects:edit-script", {
    objectType: "range",
    instanceId: bindingId,
    scriptId: script.id,
    objectName: name,
  });
}

function editBehavior(binding: CellBehaviorBinding): void {
  emitAppEvent("scriptable-objects:edit-script", {
    objectType: "range",
    instanceId: binding.id,
    scriptId: binding.scriptId,
    objectName: `Behavior ${rangeLabel(binding)}`,
  });
}

async function removeBehavior(binding: CellBehaviorBinding): Promise<void> {
  // The binding goes (undoable); the script stays owned by the script UI —
  // unmount it so it stops receiving events immediately.
  ObjectScriptManager.unmountScript(binding.scriptId);
  await removeCellBehavior(binding.id);
}

// ============================================================================
// Design-mode cell badge
// ============================================================================

const BADGE_COLOR = "rgba(0, 120, 212, 0.85)";

function drawBehaviorBadge(context: {
  ctx: CanvasRenderingContext2D;
  row: number;
  col: number;
  cellLeft: number;
  cellTop: number;
  cellBottom: number;
}): void {
  if (!getDesignMode() || !hasCellBehaviors()) return;
  const b = getCellBehaviorAt(context.row, context.col);
  if (!b || !b.enabled) return;
  const { ctx, cellLeft, cellTop, cellBottom } = context;
  const size = Math.min(7, Math.max(5, (cellBottom - cellTop) / 3));
  ctx.fillStyle = b.orphaned ? "rgba(200, 60, 60, 0.85)" : BADGE_COLOR;
  ctx.beginPath();
  ctx.moveTo(cellLeft, cellTop);
  ctx.lineTo(cellLeft + size, cellTop);
  ctx.lineTo(cellLeft, cellTop + size);
  ctx.closePath();
  ctx.fill();
}

// ============================================================================
// Registration
// ============================================================================

/** Wire the cell-behavior UX. Returns a cleanup function. */
export function registerCellBehaviorUx(context: ExtensionContext): () => void {
  const cleanups: Array<() => void> = [];

  // Initial index load (workbook may already carry bindings).
  void refreshCellBehaviors();

  // Per-cell badge in Design Mode (top-LEFT corner; the cell-type fallback
  // badge owns the top-right).
  cleanups.push(context.grid.decorations.register("cell-behaviors-badge", drawBehaviorBadge, 30));

  // Repaint when bindings or design mode change.
  cleanups.push(
    onAppEvent(CELL_BEHAVIORS_CHANGED_EVENT, () => emitAppEvent(AppEvents.GRID_REFRESH))
  );
  cleanups.push(onDesignModeChange(() => emitAppEvent(AppEvents.GRID_REFRESH)));

  // Row-gutter widget (structural brick dogfood): in Design Mode, rows that
  // intersect a behavior target show a dot; clicking it opens the behavior's
  // code editor.
  const behaviorForRow = (row: number): CellBehaviorBinding | null => {
    const sheet = activeBehaviorSheet();
    for (const b of listCellBehaviors()) {
      if (b.sheetIndex === sheet && row >= b.startRow && row <= b.endRow) return b;
    }
    return null;
  };
  cleanups.push(
    registerRowGutterWidget({
      id: "cell-behaviors",
      priority: 10,
      getWidget: (row) => {
        if (!getDesignMode() || !hasCellBehaviors()) return null;
        const b = behaviorForRow(row);
        if (!b || !b.enabled) return null;
        return { glyph: "dot", color: b.orphaned ? "rgba(200, 60, 60, 0.9)" : undefined };
      },
      onClick: (row) => {
        if (!getDesignMode()) return false;
        const b = behaviorForRow(row);
        if (!b) return false;
        editBehavior(b);
        return true;
      },
    })
  );

  // Grid context menu.
  gridExtensions.registerContextMenuItems([
    {
      id: "cellBehaviors.attach",
      label: (ctx) => {
        const t = contextTarget(ctx);
        return t ? `Attach Behavior to ${rangeLabel(t)}…` : "Attach Behavior…";
      },
      group: "cellTypes",
      visible: (ctx) =>
        ctx.clickedCell != null &&
        getCellBehaviorAt(ctx.clickedCell.row, ctx.clickedCell.col) == null,
      onClick: (ctx) => {
        const t = contextTarget(ctx);
        if (t) void attachBehavior(t);
      },
    },
    {
      id: "cellBehaviors.edit",
      label: "Edit Behavior…",
      group: "cellTypes",
      visible: (ctx) =>
        ctx.clickedCell != null &&
        getCellBehaviorAt(ctx.clickedCell.row, ctx.clickedCell.col) != null,
      onClick: (ctx) => {
        if (!ctx.clickedCell) return;
        const b = getCellBehaviorAt(ctx.clickedCell.row, ctx.clickedCell.col);
        if (b) editBehavior(b);
      },
    },
    {
      id: "cellBehaviors.remove",
      label: "Remove Behavior",
      group: "cellTypes",
      visible: (ctx) =>
        ctx.clickedCell != null &&
        getCellBehaviorAt(ctx.clickedCell.row, ctx.clickedCell.col) != null,
      onClick: (ctx) => {
        if (!ctx.clickedCell) return;
        const b = getCellBehaviorAt(ctx.clickedCell.row, ctx.clickedCell.col);
        if (b) void removeBehavior(b);
      },
    },
  ]);
  cleanups.push(() => {
    gridExtensions.unregisterContextMenuItem("cellBehaviors.attach");
    gridExtensions.unregisterContextMenuItem("cellBehaviors.edit");
    gridExtensions.unregisterContextMenuItem("cellBehaviors.remove");
  });

  // Command mirror of the attach flow (usable from the palette / buttons).
  ExtensionRegistry.registerCommand({
    id: "cellBehaviors.attachToSelection",
    name: "Attach Cell Behavior to Selection",
    execute: async (cmdCtx) => {
      const sel = cmdCtx.selection;
      if (!sel) return;
      await attachBehavior({
        sheetIndex: activeBehaviorSheet(),
        startRow: Math.min(sel.startRow, sel.endRow),
        startCol: Math.min(sel.startCol, sel.endCol),
        endRow: Math.max(sel.startRow, sel.endRow),
        endCol: Math.max(sel.startCol, sel.endCol),
      });
    },
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
