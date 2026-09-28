//! FILENAME: app/extensions/FloatingRange/lib/frFormulaBar.ts
// PURPOSE: A floating range's selected cell, as the formula bar and the Name
//          Box see it: the publisher of the SELECTED CELL (address, content,
//          and the door that opens an edit from the bar), the rule that ends an
//          edit whose cell the selection left, and the Name Box resolver that
//          accepts "Float1!B2" back.
// CONTEXT: Owner finding #10 (2026-09-27): a selected floating-range cell's
//          formula never reached the formula bar or the Name Box, and on a
//          WORKSHEET the bar went on showing -- and writing -- Core's last
//          active grid cell, hidden behind the range. The seam is Core's one
//          external-edit module (@api/externalEdit, fr-edit-design.md §1):
//          this file publishes into its CELL slot; the edit SESSION itself is
//          the cell editor's (editor/frEditor.ts), which registers in its
//          pick slot, so the bar's session and a grid pick's session are the
//          same object by construction.
//
//          The ACTIVE cell is the selection's ANCHOR (F2 and type-to-edit open
//          there). Content = `formula ?? display`, the in-cell editor's own
//          seed rule, so what the bar shows is what an edit starts from; it is
//          read by id (one cell), and while that read is in flight the bar
//          shows NOTHING -- never the previous cell's text.

import { getFloatingRangeCells } from "@api/floatingRanges";
import {
  getGridRegions,
  onRegionChange,
  requestOverlayRedraw,
} from "@api/gridOverlays";
import { getExternalFormulaTarget } from "@api/editing";
import {
  getParkedViewSheetIndex,
  isExternalSessionParked,
  publishExternalCellTarget,
  type ExternalAddressResolver,
  type ExternalCellTarget,
  type ExternalEditSession,
} from "@api/externalEdit";
import { selectObject } from "@api/objectSelection";
import { letterToColumn, restoreFocusToGrid } from "@api";
import {
  FLOATING_RANGE_REGION_TYPE,
  getAllFloatingRanges,
  getFloatingRangeById,
  getFrActiveSheetIndex,
} from "./floatingRangeStore";
import {
  clearLocalSelection,
  getLocalSelection,
  onLocalSelectionChanged,
  selectFloatingRange,
  setLocalSelection,
} from "./frSelection";
import { buildQualifiedRef } from "./frRefs";
import { getFrView, ensureFrCellVisible } from "./frView";
import {
  commitFrEditor,
  getFrEditorCell,
  getFrEditorSession,
  isFrEditorOpen,
  openFrEditor,
} from "../editor/frEditor";

/** The owner key this extension publishes the selected cell under. */
export const FR_FORMULA_BAR_OWNER = "floatingRange";

/** Content cache cap (arrowing back over a cell must not flash; nothing more). */
const CACHE_CAP = 256;

/** Content of each cell read so far, by `cacheKey`. */
const contentCache = new Map<string, string>();
/**
 * What the active cell showed when the cache was last dropped (a write, a
 * recalc): kept on screen for THAT cell until its re-read lands, so a refresh
 * does not blank the bar for a frame. Never shown for any other cell.
 */
let staleShown: { key: string; value: string } | null = null;
/** Bumped by every read and every refresh: only the LATEST read may land. */
let generation = 0;
/** The key a read is in flight for (one read per key). */
let pendingKey: string | null = null;
/** A key whose read FAILED: not retried until the anchor moves or a refresh. */
let failedKey: string | null = null;
/** The key published last (a changed anchor forgets `failedKey`). */
let lastKey: string | null = null;
/** Whether the publisher is installed (reads landing after uninstall are dropped). */
let installed = false;

function cacheKey(frId: string, row: number, col: number): string {
  return `${frId}|${row}|${col}`;
}

function cacheSet(key: string, value: string): void {
  contentCache.delete(key);
  contentCache.set(key, value);
  while (contentCache.size > CACHE_CAP) {
    const oldest = contentCache.keys().next().value;
    if (oldest === undefined) break;
    contentCache.delete(oldest);
  }
}

/** The text the bar shows for `key` right now; null = its read is in flight. */
function shownContent(key: string): string | null {
  const cached = contentCache.get(key);
  if (cached !== undefined) return cached;
  if (staleShown && staleShown.key === key) return staleShown.value;
  return null;
}

// ============================================================================
// Publish
// ============================================================================

/**
 * Publish the selected cell (or withdraw). The data-equality check lives in
 * Core's slot, so an identical republish is silent; the target object is
 * always replaced and its `beginEdit` reads live state.
 */
function publish(): void {
  if (!installed) return;
  const sel = getLocalSelection();
  const entry = sel ? getFloatingRangeById(sel.frId) : null;
  if (!sel || !entry) {
    lastKey = null;
    publishExternalCellTarget(FR_FORMULA_BAR_OWNER, null);
    return;
  }
  const key = cacheKey(sel.frId, sel.anchorRow, sel.anchorCol);
  if (key !== lastKey) {
    lastKey = key;
    failedKey = null;
  }
  const target: ExternalCellTarget = {
    address: buildQualifiedRef(entry.name, sel.anchorRow, sel.anchorCol, sel.endRow, sel.endCol),
    content: shownContent(key),
    readOnly: false,
    beginEdit,
  };
  publishExternalCellTarget(FR_FORMULA_BAR_OWNER, target);
  if (!contentCache.has(key) && key !== pendingKey && key !== failedKey) {
    readCell(sel.frId, sel.anchorRow, sel.anchorCol, key);
  }
}

/** Read one cell's content (last read wins: the FormulaInput.tsx race lesson). */
function readCell(frId: string, row: number, col: number, key: string): void {
  const gen = ++generation;
  pendingKey = key;
  getFloatingRangeCells(frId, row, col, row, col).then(
    (cells) => {
      if (!installed || gen !== generation) return;
      pendingKey = null;
      const cell = cells.find((c) => c.row === row && c.col === col);
      cacheSet(key, cell ? (cell.formula ?? cell.display ?? "") : "");
      if (staleShown?.key === key) staleShown = null;
      publish();
    },
    (err) => {
      if (!installed || gen !== generation) return;
      pendingKey = null;
      failedKey = key;
      // The bar keeps showing nothing for the cell (content null), and an
      // edit begun from it loads the content itself -- or, if that read fails
      // too, writes nothing on an untouched Enter.
      console.error("[FloatingRange] Could not read the selected cell for the formula bar:", err);
    },
  );
}

/**
 * Drop the content cache and re-read the active cell: a write, a recalc, an
 * undo, a rename or a formula rewrite may have changed what it shows. A read
 * already in flight is discarded (it may predate the change).
 */
export function refreshFrFormulaBarContent(): void {
  const sel = getLocalSelection();
  if (sel) {
    const key = cacheKey(sel.frId, sel.anchorRow, sel.anchorCol);
    const shown = shownContent(key);
    staleShown = shown !== null ? { key, value: shown } : null;
  } else {
    staleShown = null;
  }
  contentCache.clear();
  generation++;
  pendingKey = null;
  failedKey = null;
  publish();
}

// ============================================================================
// Opening an edit from the bar
// ============================================================================

/**
 * The bar was focused (or fx pressed) over the selected cell: open -- or adopt
 * -- the edit on the ACTIVE cell with the BAR owning the caret. The textarea is
 * shown over the cell but not focused. Unseeded, the edit shows the cached
 * content provisionally (never marked touched: the cell's own read replaces
 * it, and an untouched Enter before it lands writes nothing).
 */
function beginEdit(seed?: string): ExternalEditSession | null {
  const sel = getLocalSelection();
  const entry = sel ? getFloatingRangeById(sel.frId) : null;
  if (!sel || !entry) return null;
  if (isFrEditorOpen()) {
    const open = getFrEditorSession();
    if (open) {
      open.adoptBarView();
      if (seed !== undefined) open.setText(seed, seed.length);
      return open;
    }
  }
  ensureFrCellVisible(entry, sel.anchorRow, sel.anchorCol);
  const key = cacheKey(sel.frId, sel.anchorRow, sel.anchorCol);
  openFrEditor(entry.id, sel.anchorRow, sel.anchorCol, seed ?? null, {
    focus: false,
    view: "bar",
    // What the bar showed a moment ago, so focusing it changes nothing on
    // screen; the edit's own read of the cell replaces it.
    provisional: seed === undefined ? shownContent(key) : null,
  });
  return getFrEditorSession();
}

// ============================================================================
// Session lifetime
// ============================================================================

/**
 * An edit can never outlive its cell's selection. The in-cell view was always
 * saved by its blur-commit; the BAR view has no blur that means "done", so
 * every door that moves or drops the local selection -- a canvas background
 * press, another object family's press, a grid click, a reset, the Name Box --
 * commits here (Excel's click-away). Except while a reference is being picked
 * (the click is FEEDING the edit) or while the edit is parked on another sheet.
 */
function endEditThatLostItsCell(): void {
  const cell = getFrEditorCell();
  if (!cell) return;
  if (isExternalSessionParked()) return;
  if (getExternalFormulaTarget()?.isExpectingReference() === true) return;
  const sel = getLocalSelection();
  if (
    !sel ||
    sel.frId !== cell.frId ||
    sel.anchorRow !== cell.row ||
    sel.anchorCol !== cell.col
  ) {
    void commitFrEditor(null);
  }
}

/**
 * Install the publisher: it follows the local selection (and, before
 * publishing, ends an edit whose cell was left) and every region change (a
 * rename republishes the range's `name`). Returns the cleanup, which withdraws
 * the published cell.
 */
export function installFrFormulaBarPublisher(): () => void {
  installed = true;
  const offSelection = onLocalSelectionChanged(() => {
    endEditThatLostItsCell();
    publish();
  });
  const offRegions = onRegionChange(() => publish());
  publish();
  return () => {
    offSelection();
    offRegions();
    installed = false;
    publishExternalCellTarget(FR_FORMULA_BAR_OWNER, null);
    contentCache.clear();
    staleShown = null;
    generation++;
    pendingKey = null;
    failedKey = null;
    lastKey = null;
  };
}

// ============================================================================
// The Name Box resolver: "Float1!B2" goes to that cell
// ============================================================================

/** The Name Box's refusal while this extension's edit picks a reference. */
export const FR_NAME_BOX_BUSY_MESSAGE =
  "Finish the formula you are editing (Enter) or cancel it (Esc) before going to another address.";

/**
 * A resolution that goes nowhere and says why, while a floating-range edit is
 * PARKED or EXPECTING a reference; null otherwise. Its `hostSheetIndex` is the
 * sheet on screen (the viewed one while parked), so the box switches nothing.
 */
function refusalWhileFormulaPicks(): { hostSheetIndex: number; go: () => Promise<string | null> } | null {
  if (!isFrEditorOpen()) return null;
  const picking =
    isExternalSessionParked() || getExternalFormulaTarget()?.isExpectingReference() === true;
  if (!picking) return null;
  return {
    hostSheetIndex: getParkedViewSheetIndex() ?? getFrActiveSheetIndex(),
    go: async () => FR_NAME_BOX_BUSY_MESSAGE,
  };
}

/** `Name!A1`, `'My Float'!A1`, `Name!$A$1:$C$3` (the forms the Name Box shows). */
const FR_ADDRESS_RE =
  /^(?:'((?:[^']|'')+)'|([A-Za-z0-9_]+))!\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/;

/**
 * The Name Box resolver: claims an address whose name is one of the floating
 * ranges (case-insensitively -- their names share the sheet namespace, so
 * there is no ambiguity) and declines everything else, which the Name Box then
 * handles itself. `afterPendingReloads` is the extension's reload queue: a
 * sheet switch the box made first queues a re-sync that would otherwise wipe
 * the selection this sets.
 */
export function createFrAddressResolver(
  afterPendingReloads: () => Promise<void>,
): ExternalAddressResolver {
  return (text: string) => {
    // THIS extension's edit is picking a reference (or is parked on another
    // sheet doing so): the Name Box is no navigation door then -- Excel's rule
    // in edit mode. Every entry is claimed and refused, whatever it names, at
    // the sheet on screen, so the box switches nowhere first. Navigating
    // instead ended the edit through `sheet:beforeSwitch`, which cannot
    // return to the host, and the half-typed formula was stored as text.
    const refusal = refusalWhileFormulaPicks();
    if (refusal) return refusal;
    const trimmed = text.trim();
    const m = FR_ADDRESS_RE.exec(trimmed);
    if (!m) return null;
    const name = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    const lower = name.toLowerCase();
    const entry = getAllFloatingRanges().find((e) => e.name.toLowerCase() === lower);
    if (!entry) return null;

    const anchorCol = letterToColumn(m[3].toUpperCase());
    const anchorRow = Number.parseInt(m[4], 10) - 1;
    const endCol = m[5] !== undefined ? letterToColumn(m[5].toUpperCase()) : anchorCol;
    const endRow = m[6] !== undefined ? Number.parseInt(m[6], 10) - 1 : anchorRow;
    const frId = entry.id;

    return {
      hostSheetIndex: entry.sheetIndex,
      go: async (): Promise<string | null> => {
        await afterPendingReloads();
        const live = getFloatingRangeById(frId);
        if (!live) return `The floating range "${entry.name}" no longer exists.`;
        const view = getFrView(live);
        const outside =
          Math.min(anchorRow, endRow) < 0 ||
          Math.min(anchorCol, endCol) < 0 ||
          Math.max(anchorRow, endRow) >= view.rows ||
          Math.max(anchorCol, endCol) >= view.cols;
        if (outside) {
          const extent = buildQualifiedRef(null, 0, 0, view.rows - 1, view.cols - 1);
          return `"${trimmed}" is outside the floating range "${live.name}" (${extent}).`;
        }
        // Select the OBJECT the way Tab-cycling does (every other family is
        // deselected), THEN the cells inside it.
        const region = getGridRegions().find(
          (r) => r.type === FLOATING_RANGE_REGION_TYPE && r.data?.frId === frId,
        );
        if (!region || !selectObject(region)) {
          const local = getLocalSelection();
          if (local && local.frId !== frId) clearLocalSelection();
          selectFloatingRange(frId);
        }
        setLocalSelection({ frId, anchorRow, anchorCol, endRow, endCol });
        ensureFrCellVisible(live, anchorRow, anchorCol);
        requestOverlayRedraw();
        restoreFocusToGrid();
        return null;
      },
    };
  };
}
