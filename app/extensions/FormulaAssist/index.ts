//! FILENAME: app/extensions/FormulaAssist/index.ts
// PURPOSE: Wire the formula assistant into the product — a command, a
//          keybinding, a Formulas-menu item, a grid context-menu item, and the
//          `@api` seam other features reach it through.
// CONTEXT: Four doors and one seam, all unregistered in `deactivate` (an
//          extension that leaks a menu item survives its own removal as a
//          control that throws).
//
//          THE SEAM IS THE POINT OF THE LAST ONE. `registerFormulaAssistProvider`
//          is how the AI chat answers "write me a formula" without a tool loop,
//          how the grid's own context menu reaches this without importing it,
//          and how a future intent router gets its `formula` specialist. None
//          of those may import this folder — the Facade Rule forbids it, and it
//          would make FormulaAssist un-removable.
//
//          THE PROVIDER'S `insertProposal` AND `explainFormula` GO STRAIGHT TO
//          THE LIB, not through the popover. A caller reaching the seam has
//          already made its own decision; making it open a UI to act on that
//          decision would be a second, invisible consent step.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import {
  IconEvaluateFormula,
  columnToLetter,
  registerFormulaAssistProvider,
  registerMenuItem,
  unregisterMenuItem,
  gridExtensions,
  getAiCompletionProvider,
  getCell,
  onAppEvent,
  AppEvents,
} from "@api";
import type {
  FormulaAssistProvider,
  FormulaAssistRequest,
  FormulaProposal,
} from "@api/formulaAssistService";
import { OverlayExtensions } from "@api/ui";
import { getGridStateSnapshot } from "@api/grid";
import {
  FORMULA_ASSIST_COMBO,
  FORMULA_ASSIST_CONTEXT_MENU_ID,
  FORMULA_ASSIST_KEYBINDING_ID,
  FORMULA_ASSIST_MENU_ITEM_ID,
  FORMULA_ASSIST_OPEN_COMMAND,
  FORMULA_ASSIST_OVERLAY_ID,
  formulaAssistManifest,
} from "./manifest";
import { FormulaAssistPopover } from "./components/FormulaAssistPopover";
import { anchorForCell } from "./lib/anchor";
import { formulaAssistBackend } from "./lib/backend";
import { assistFormula } from "./lib/ladder";
import { explainCell } from "./lib/explain";
import { insertProposal } from "./lib/insert";
import { closeAssist, openAssist } from "./lib/store";

const cleanups: Array<() => void> = [];

// ---------------------------------------------------------------------------
// The active cell's formula, cached
// ---------------------------------------------------------------------------
//
// The grid context menu's `visible` predicate is SYNCHRONOUS, and the only way
// to know whether a cell holds a formula is an async backend read. So the last
// known state of the selected cell is cached and refreshed whenever the
// selection or a value changes — both of which fire before a right-click can
// open the menu, because right-clicking a cell selects it first.
//
// A MISS HIDES THE ITEM rather than showing it. A menu entry offering to fix a
// formula on a cell that holds a number is worse than a missing entry, and the
// refresh it kicks off makes the next open correct.

interface CachedCell {
  key: string;
  formula: string | null;
  isError: boolean;
}

let cachedCell: CachedCell | null = null;

function cellKey(sheetIndex: number, row: number, col: number): string {
  return `${sheetIndex}:${row}:${col}`;
}

function refreshCachedCell(): void {
  const state = getGridStateSnapshot();
  if (!state?.selection) {
    cachedCell = null;
    return;
  }
  const { startRow, startCol } = state.selection;
  const sheetIndex = state.sheetContext.activeSheetIndex ?? 0;
  const key = cellKey(sheetIndex, startRow, startCol);
  void getCell(startRow, startCol)
    .then((cell) => {
      cachedCell = {
        key,
        formula: cell?.formula ?? null,
        isError: typeof cell?.display === "string" && cell.display.startsWith("#"),
      };
    })
    .catch(() => {
      cachedCell = null;
    });
}

/** What the cached read says about the cell the menu was opened on. */
function cachedFor(sheetIndex: number, row: number, col: number): CachedCell | null {
  const key = cellKey(sheetIndex, row, col);
  if (cachedCell?.key === key) return cachedCell;
  refreshCachedCell();
  return null;
}

// ---------------------------------------------------------------------------
// Opening the popover
// ---------------------------------------------------------------------------

function openForActiveCell(intent?: string): void {
  const state = getGridStateSnapshot();
  if (!state?.selection) return;
  const row = state.selection.startRow;
  const col = state.selection.startCol;
  const sheetIndex = state.sheetContext.activeSheetIndex ?? 0;
  const cached = cachedFor(sheetIndex, row, col);

  openAssist({
    target: {
      sheetIndex,
      row,
      col,
      a1: `${columnToLetter(col)}${row + 1}`,
      existingFormula: cached?.formula ?? null,
    },
    anchor: anchorForCell(row, col),
    intent,
  });
}

/** The pre-filled request for a cell that is already broken. */
function fixIntentFor(cached: CachedCell | null, a1: string): string {
  if (cached?.isError) {
    return `The formula in ${a1} returns an error. Fix it.`;
  }
  return `Explain and fix the formula in ${a1}.`;
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

function buildProvider(): FormulaAssistProvider {
  return {
    isConfigured(): boolean {
      const p = getAiCompletionProvider();
      return p !== null && p.isConfigured();
    },
    modelLabel(): string {
      return getAiCompletionProvider()?.modelLabel() ?? "";
    },
    assistFormula(req: FormulaAssistRequest): Promise<FormulaProposal> {
      return assistFormula(req);
    },
    async insertProposal(proposal: FormulaProposal): Promise<void> {
      const outcome = await insertProposal(proposal);
      // The seam returns void, so a refusal has to become a throw or it would
      // be silently swallowed by a caller that (correctly) only awaits.
      if (outcome.refusal) throw new Error(outcome.refusal);
    },
    async explainFormula(
      _sheetIndex: number,
      row: number,
      col: number,
    ): Promise<string> {
      const result = await explainCell(row, col);
      return result.note ? `${result.text}\n\n${result.note}` : result.text;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function activate(context: ExtensionContext): void {
  // Bind the backend channel FIRST: everything below can reach it, and an
  // unbound channel rejects with a message about this exact line.
  formulaAssistBackend.set(context.invokeBackend);

  // 1. The overlay. Registered once and shown permanently; the component
  //    returns null while the store says it is closed.
  OverlayExtensions.registerOverlay({
    id: FORMULA_ASSIST_OVERLAY_ID,
    component: FormulaAssistPopover,
    layer: "popover",
  });
  OverlayExtensions.showOverlay(FORMULA_ASSIST_OVERLAY_ID);
  cleanups.push(() => {
    OverlayExtensions.hideOverlay(FORMULA_ASSIST_OVERLAY_ID);
    OverlayExtensions.unregisterOverlay(FORMULA_ASSIST_OVERLAY_ID);
  });

  // 2. The command. `scriptSafe` is deliberately NOT set: opening a UI that
  //    asks a remote model is not something a sandboxed script may trigger.
  context.commands.register(FORMULA_ASSIST_OPEN_COMMAND, (args?: unknown) => {
    const intent =
      args &&
      typeof args === "object" &&
      typeof (args as { intent?: unknown }).intent === "string"
        ? (args as { intent: string }).intent
        : undefined;
    openForActiveCell(intent);
  });
  cleanups.push(() => context.commands.unregister(FORMULA_ASSIST_OPEN_COMMAND));

  // 3. The keybinding. See `manifest.ts` for why it is Ctrl+Shift+I and not
  //    either of the two combinations that look more natural.
  cleanups.push(
    context.keybindings.register({
      id: FORMULA_ASSIST_KEYBINDING_ID,
      combo: FORMULA_ASSIST_COMBO,
      commandId: FORMULA_ASSIST_OPEN_COMMAND,
      label: "Ask for a formula",
      category: "Formulas",
      context: "not-editing",
      extensionId: formulaAssistManifest.id,
    }),
  );

  // 4. The Formulas menu.
  registerMenuItem("formulas", {
    id: FORMULA_ASSIST_MENU_ITEM_ID,
    label: "Ask for a Formula…",
    shortcut: FORMULA_ASSIST_COMBO,
    icon: IconEvaluateFormula,
    action: () => openForActiveCell(),
  });
  cleanups.push(() => unregisterMenuItem("formulas", FORMULA_ASSIST_MENU_ITEM_ID));

  // 5. The grid context menu, for a cell that already has a formula or an
  //    error in it. Pre-fills the intent so the common case is one click.
  gridExtensions.registerContextMenuItem({
    id: FORMULA_ASSIST_CONTEXT_MENU_ID,
    label: "Fix this formula…",
    group: "formulas",
    order: 10,
    visible: (ctx) => {
      const cell = ctx.clickedCell;
      if (!cell) return false;
      const cached = cachedFor(ctx.sheetIndex, cell.row, cell.col);
      return cached !== null && (cached.formula !== null || cached.isError);
    },
    onClick: (ctx) => {
      const cell = ctx.clickedCell;
      if (!cell) return;
      const a1 = `${columnToLetter(cell.col)}${cell.row + 1}`;
      const cached = cachedFor(ctx.sheetIndex, cell.row, cell.col);
      openAssist({
        target: {
          sheetIndex: ctx.sheetIndex,
          row: cell.row,
          col: cell.col,
          a1,
          existingFormula: cached?.formula ?? null,
        },
        anchor: anchorForCell(cell.row, cell.col),
        intent: fixIntentFor(cached, a1),
      });
    },
  });
  cleanups.push(() =>
    gridExtensions.unregisterContextMenuItem(FORMULA_ASSIST_CONTEXT_MENU_ID),
  );

  // 6. The seam, so chat and a future router never import this folder.
  cleanups.push(registerFormulaAssistProvider(buildProvider()));

  // 7. Keep the cached cell honest.
  cleanups.push(onAppEvent(AppEvents.SELECTION_CHANGED, refreshCachedCell));
  cleanups.push(onAppEvent(AppEvents.CELL_VALUES_CHANGED, refreshCachedCell));
  refreshCachedCell();
}

function deactivate(): void {
  closeAssist();
  for (const fn of cleanups) {
    try {
      fn();
    } catch (err) {
      console.error("[FormulaAssist] cleanup error:", err);
    }
  }
  cleanups.length = 0;
  cachedCell = null;
}

const extension: ExtensionModule = {
  manifest: formulaAssistManifest,
  activate,
  deactivate,
};

export default extension;
