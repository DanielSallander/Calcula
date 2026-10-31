//! FILENAME: app/src/shell/SheetTabs/SheetTabs.tsx
// PURPOSE: Sheet tabs component for switching between worksheets
// CONTEXT: Enhanced to support sheet switching during formula editing without page reload.
//          Key fix: Uses global flag to prevent blur commit during formula mode navigation.
// REFACTOR: Imports from api layer instead of core internals to comply with architecture rules.
// FIX (2026-09-27): a floating grid's cell edit (an EXTERNAL session) is formula
//      mode too. What a click means is decided by `resolveTabClick` (pure,
//      tested); the switch itself is Core's one `switchSheetForPointMode`, which
//      PARKS the session so it survives the trip and is brought back by a click
//      on its host tab (a canvas included) or ended through the formula bar.

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import {
  // Tauri API functions
  getSheets,
  setActiveSheetApi,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  copySheet,
  hideSheet,
  unhideSheet,
  setTabColor,
  // Extension registry
  sheetExtensions,
  registerCoreSheetContextMenu,
  // State hooks and actions
  useGridContext,
  setActiveSheet,
  setSheetContext,
  setSheetSurfaces,
  // Events
  emitAppEvent,
  AppEvents,
  // Types and utilities
  isFormulaExpectingReference,
  // Sheet grouping
  setSelectedSheetIndices,
  clearSheetGrouping,
  toggleSheetInGroup,
  isSheetGroupingActive,
  getSelectedSheetIndices,
  // Sheet-switch prefetch (BUG-0052)
  primeSheetSwitch,
  // Extension-contributed tab marks (subscribed sheets, and whatever comes next)
  getSheetTabDecorations,
  onSheetTabDecorationsChanged,
  MAX_SHEET_TAB_DECORATION_GLYPHS,
} from "../../api";
import {
  isGlobalFormulaMode,
  getGlobalCursorPosition,
  getExternalFormulaTarget,
  getGlobalIsEditing,
  findEditSheet,
} from "../../api/editing";
// The typed-open latch: an edit that is OPENING (its first keystroke landed,
// its editing state not dispatched yet). A dependency-free Core primitive the
// facade does not carry; the Shell may read Core (insertFunctionHost.tsx reads
// cellEditFlag the same way).
import { isEditorOpening } from "../../core/lib/editOpenBuffer";
// The sheet group's change announcement: the strip PAINTS the group Core owns
// (core/state/sheetGrouping.ts) instead of keeping its own copy, so a group
// Core ends -- an ordinary switch to a sheet outside it -- stops showing at
// once (review revG#4). Read the same way as the typed-open latch above; the
// subscription and its snapshot come from the one module as a pair (a
// snapshot that is a new array on every read never settles).
import {
  subscribeToSheetGrouping,
  getSelectedSheetIndices as getCoreSheetGroup,
} from "../../core/state/sheetGrouping";
// The SUBPATH (NameBox.tsx precedent): a dependency-free store plus Core's one
// point-mode switch, kept out of any test's `@api/editing` double.
import {
  subscribeExternalEdit,
  getCrossSheetPointModeKey,
  isCrossSheetPointMode,
  getExternalEditSession,
  isExternalSessionParked,
  isExternalSessionHostSheet,
  switchSheetForPointMode,
  focusExternalSessionView,
} from "../../api/externalEdit";
// The sheet PRIMITIVES a temporary sheet is kept and discarded with, by the
// facade's own names and by STABLE id (the Shell must not spell a feature's
// command; model-drillthrough.md 2.5).
import { keepEphemeralSheet, discardEphemeralSheet, type DiscardedSheet } from "../../api/lib";
import { showToast } from "@api/notifications";
import { resolveTabClick, plainClickKeepsGroup, shiftClickGroup, type GroupTab } from "./resolveTabClick";
import {
  EPHEMERAL_TAB_TOOLTIP,
  createEphemeralLeaveObserver,
  keepNotice,
  leaveObserverPaused,
  refusedDiscardOutcome,
  resolveTabDoubleClick,
  temporarySheetStateIn,
  type EphemeralLeaveObserver,
  type SyncEditFlags,
  type TemporarySheetState,
} from "./ephemeralSheets";
import { sheetRangePrefix } from "./sheetRangePrefix";
import { registerSheetTabsController, STRUCTURE_LOCKED } from "./sheetCommands";
import { promptForSheetName } from "./renameSheetPrompt";
import { sheetDeleteNeedsConfirmation } from "./sheetDeletePolicy";
import { insertSheetBefore, moveOrCopySheet } from "./sheetTabFlows";
import {
  findSameSheet,
  insertionReorderDetail,
  removalReorderDetail,
  type PlacedSheet,
} from "./sheetPlacement";
import type {
  SheetInfo,
  SheetsResult,
  SheetContext,
  ResolvedSheetContextMenuItem,
  SheetKindName,
  SheetSurface,
} from "../../api";
import * as S from './SheetTabs.styles';
import { alertAsync } from "@api/dialogs";

export interface SheetTabsProps {
  onSheetChange?: (sheetIndex: number, sheetName: string) => void;
}

// Register core context menu items once
let coreMenuRegistered = false;

/**
 * Temporary sheets whose discard is in flight, by stable id, each with the
 * discard's own answer (model-drillthrough.md 2.7, rule 2; C7). MODULE-level on
 * purpose: a second request for the same sheet -- the delete's own
 * `sheets:refresh` re-read, a remount, the drill runner's
 * core.sheet.discardEphemeral racing the observer -- must find it here and
 * AWAIT that answer, never send a second discard nor answer before the first
 * one landed.
 */
const discardInFlight = new Map<string, Promise<boolean>>();

/**
 * Discards whose backend call has been SENT -- past the hold in
 * `discardSheetById` -- and not yet answered. Every door of the strip that
 * acts on a sheet its gesture named (Duplicate, Move Left / Right, a drag,
 * Delete, Hide, Rename, Tab Color, Unhide, Insert Sheet, Move or Copy) awaits
 * these before it reads the list again (`resolveDoorTargets`): a discard
 * landing after the gesture renumbers every sheet after it, and the door then
 * acted on whichever sheet slid into the index it held (review TSHELL-3's
 * converse; TSHELL3-CONVERSE-OTHER-DOORS). Only SENT ones: a discard still
 * waiting on the hold waits for the door, so awaiting it there would deadlock.
 */
const discardsSent = new Set<Promise<unknown>>();

/** Wait for every discard already sent; true when there was one (the list moved). */
async function settleSentDiscards(): Promise<boolean> {
  if (discardsSent.size === 0) return false;
  await Promise.allSettled([...discardsSent]);
  return true;
}

/** A rejection as the sentence the backend refused with. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The backend's refusal of a delete that named its sheet by stable id when the
 * sheet at that index no longer carries it (Rust
 * `SHEETS_CHANGED_UNDER_THE_DELETE`, sheets.rs): nothing was deleted. The
 * strip says it in a toast -- the sheets moved under the delete, as a
 * temporary sheet's discard moves them -- never as a modal "Failed to delete".
 */
const SHEETS_CHANGED_UNDER_THE_DELETE =
  "The sheets changed while that sheet was being deleted, so nothing was deleted.";

/**
 * Core's synchronous edit flags, read NOW (ephemeralSheets.ts `SyncEditFlags`):
 * the edit flag and the typed-open latch. An edit that is still OPENING has no
 * React `editing` state yet, so the strip's render cannot see it -- only these.
 */
const syncEditFlags = (): SyncEditFlags => ({
  coreEditOpen: getGlobalIsEditing(),
  editorOpening: isEditorOpening(),
});

/** Who asked for a temporary sheet's discard: the leave observer, or a caller through core.sheet.discardEphemeral. */
type DiscardCaller = "leave" | "command";

/**
 * The discard door's refusal while a plain cell edit is open or opening (a
 * formula being written gets the structural lock's own sentence): a discard
 * landing under the edit renumbers the sheet being edited, and a drill-from-
 * drill's discard would delete the very sheet being typed on.
 */
const DISCARD_UNDER_EDIT =
  "Finish editing the cell first: the temporary sheet cannot be closed while a cell is being edited.";

/**
 * Where the temporary sheet with this id stands in a FRESH read of the list:
 * asked when a keep was refused, so the strip says "still temporary" or
 * "gone" from the backend's word rather than guessing ("unknown" when even the
 * read fails).
 */
async function temporarySheetStateNow(sheetId: string): Promise<TemporarySheetState | "unknown"> {
  try {
    return temporarySheetStateIn(await getSheets(), sheetId);
  } catch (err) {
    console.error("[SheetTabs] getSheets after a refused keep failed:", err);
    return "unknown";
  }
}

/**
 * The sheet a TRUE workbook index names — by the `index` FIELD, never by list
 * position.
 *
 * `getSheets()` omits object-backed sheets (a floating range's cell store) from
 * the list while keeping every row's true state-vector index
 * (`build_sheet_list`, sheets.rs). `sheets[i].index === i` therefore holds only
 * while every object sheet sits at the tail — an invariant `add_sheet_inner`
 * maintains and which a `.calp` pull, a drill-through sheet and a report-pages
 * sheet all break by appending PAST it.
 *
 * Every index this component handles is a true one: `activeIndex` is
 * `state.active_sheet`, and the tabs pass `sheet.index`. So a subscript here is
 * wrong the moment a workbook has both a floating range and pulled sheets, and
 * wrong SILENTLY — it returns a real sheet, just not that one. It named the
 * wrong tab in the detach confirm while the command detached the right one,
 * broadcast `SHEET_CHANGED` with one sheet's index and another's name, and
 * built `Sheet1:Detail!` for a shift-click on KPIs.
 */
const sheetAt = (sheets: SheetInfo[], index: number): SheetInfo | undefined =>
  sheets.find((s) => s.index === index);

/**
 * The Core surface a listed sheet paints as. Every sheet switch below passes
 * it in the SAME dispatch that moves the sheet context, so the canvas surface
 * can never tear against the sheet it belongs to (BUG-0052's one flush).
 */
const surfaceOf = (sheet: SheetInfo | undefined): SheetSurface =>
  sheet?.kind === "canvas" ? "canvas" : "grid";

/** Every listed sheet's surface, keyed by TRUE index (never list position). */
const surfacesOf = (sheets: SheetInfo[]): Record<number, SheetSurface> => {
  const out: Record<number, SheetSurface> = {};
  for (const s of sheets) out[s.index] = surfaceOf(s);
  return out;
};

/**
 * Tell Core's per-sheet view cache (selection + scroll, keyed by TRUE index;
 * core/components/Spreadsheet/sheetSwitchListeners.ts) and its sheet group
 * that sheets were renumbered. A move is
 * a rotate; an insertion or a removal is told the same way through
 * sheetPlacement.ts's `insertionReorderDetail` / `removalReorderDetail`.
 */
const announceReorder = (detail: { fromIndex: number; toIndex: number }): void => {
  window.dispatchEvent(new CustomEvent("sheet:reorder", { detail }));
};

// ============================================================================
// The strip's doors: identity captured at the gesture, resolved at ONE place
// ============================================================================
//
// A temporary sheet's discard runs in the background once the user leaves it
// (model-drillthrough.md 2.7) and renumbers every sheet after it. A door that
// captured an INDEX at its gesture -- a right-click, a drag, a confirmation, a
// dialog, a prompt -- and acted on it later acted on whichever sheet slid into
// that index: Duplicate copied the neighbour, Move Left moved it, and Delete
// DELETED it, with no undo (review TSHELL3-CONVERSE-OTHER-DOORS,
// TSHELL3-CONVERSE-DIALOG-WINDOW, DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM). So
// every such door captures the sheet's STABLE id at its gesture and finds it
// again in `resolveDoorTargets`, inside `runSheetDoor`.

/**
 * A sheet as a door's GESTURE named it, by its stable id, with the name and
 * temporary flag it had then -- what a refusal says if it is gone by the time
 * the door acts. The index it had then is only `findSameSheet`'s fallback for a
 * list without ids, which matches by name.
 */
interface DoorTarget extends PlacedSheet {
  ephemeral?: boolean;
  /** How a refusal names it: the sheet acted on (default), the sheet to place it before, or the tab it was dropped on. */
  role?: "anchor" | "drop";
}

/** What a door's caller hands the strip: the TRUE index it saw, and the stable id when it carried one. */
interface SheetRequest {
  index: number;
  sheetId?: string;
}

/**
 * The names of the temporary sheets this strip discarded, by stable id (the
 * last few): a door that names one of them AFTER its discard landed -- a
 * dialog left open, a request carrying the id -- still says WHICH sheet is
 * gone, and why, rather than "That sheet".
 */
const discardedNames = new Map<string, string>();
const DISCARDED_NAMES_KEPT = 32;

function rememberDiscarded(sheetId: string, name: string): void {
  discardedNames.delete(sheetId);
  discardedNames.set(sheetId, name);
  while (discardedNames.size > DISCARDED_NAMES_KEPT) {
    const oldest = discardedNames.keys().next();
    if (oldest.done) break;
    discardedNames.delete(oldest.value);
  }
}

/** A listed sheet as a door target. */
const doorTargetOf = (sheet: SheetInfo): DoorTarget => ({
  index: sheet.index,
  name: sheet.name,
  sheetId: sheet.sheetId,
  ephemeral: sheet.ephemeral === true,
});

/**
 * The door target a request names, read from `list` -- the strip's list AT
 * THE GESTURE: by the stable id the request carries (named from the list, or
 * from a discard this strip made), else the sheet at its TRUE index. An index
 * the list does not carry gives a target no list matches.
 */
function doorTargetFor(list: SheetInfo[], request: SheetRequest): DoorTarget {
  if (request.sheetId) {
    const listed = list.find((s) => s.sheetId === request.sheetId);
    if (listed) return doorTargetOf(listed);
    const discarded = discardedNames.get(request.sheetId);
    return { index: request.index, sheetId: request.sheetId, name: discarded ?? "", ephemeral: discarded !== undefined };
  }
  const at = sheetAt(list, request.index);
  return at ? doorTargetOf(at) : { index: request.index, name: "" };
}

/** True when a target names no sheet at all (neither an id nor a name to match). */
const namesNoSheet = (target: DoorTarget): boolean => !target.sheetId && !target.name;

/**
 * THE one refusal of a door whose sheet is gone by the time it acts: which
 * sheet, and -- for a temporary sheet, the usual case -- why. `done` is what
 * was not done ("copied", "deleted", ...).
 */
function goneNotice(target: DoorTarget, done: string): string {
  const role =
    target.role === "anchor" ? "the sheet to place it before" : target.role === "drop" ? "the sheet it was dropped on" : null;
  const who = target.name
    ? `"${target.name}"${role ? `, ${role},` : ""}`
    : role
      ? role.charAt(0).toUpperCase() + role.slice(1)
      : "That sheet";
  const why = target.ephemeral ? ": it was a temporary sheet and closed when you left it" : "";
  return `${who} is no longer in the workbook${why}. Nothing was ${done}.`;
}

/**
 * THE one place a door of the strip finds the sheet(s) its gesture named
 * again: every discard already SENT answers first, then a FRESH read, and each
 * target is found in it by its stable id (`findSameSheet`). The door's step
 * then acts on the TRUE indices of that read -- never on an index the gesture
 * captured. A target that is gone refuses the whole door with ONE toast (the
 * strip's temporary-sheet events are toasts, never a modal) and answers null;
 * a failed read rejects, for the door's own "Failed to ..." alert.
 *
 * Always settles and always re-reads, whatever the settle found: a discard
 * that already LANDED leaves nothing in `discardsSent`, and the strip's own
 * list can still be the one the gesture was made on. Called only inside
 * `runSheetDoor`, whose hold keeps a NEW discard from being sent between this
 * read and the step.
 */
async function resolveDoorTargets(
  targets: readonly DoorTarget[],
  done: string,
): Promise<{ found: SheetInfo[]; fresh: SheetsResult } | null> {
  await settleSentDiscards();
  const fresh = await getSheets();
  const found: SheetInfo[] = [];
  for (const target of targets) {
    const sheet = namesNoSheet(target) ? undefined : findSameSheet(fresh.sheets, target);
    if (!sheet) {
      showToast(goneNotice(target, done), { variant: "warning" });
      return null;
    }
    found.push(sheet);
  }
  return { found, fresh };
}

export function SheetTabs({ onSheetChange }: SheetTabsProps): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { editing, sheetContext } = state;

  const [sheets, setSheets] = useState<SheetInfo[]>([{ index: 0, name: "Sheet1", visibility: "visible" as const }]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sheet grouping: which sheets are selected (Ctrl+Click), as CORE holds them.
  // The strip kept its own copy in React state, so a group Core ended or
  // renumbered went on showing here (review revG#4). It renders the one owner
  // now; its snapshot keeps its identity until the group changes.
  const groupedIndices = useSyncExternalStore(subscribeToSheetGrouping, getCoreSheetGroup);
  const groupedSheets = React.useMemo(() => new Set(groupedIndices), [groupedIndices]);

  // Bumped when an extension registers a tab mark or says its answer changed.
  // The strip renders once; extensions activate AFTER it mounts, and a .calp
  // pull can land while it is up — neither has any other way to reach these
  // pixels. (Same shape as ActivityBar's script-presence tick.)
  const [decorationTick, setDecorationTick] = useState(0);
  useEffect(
    () => onSheetTabDecorationsChanged(() => setDecorationTick((t) => t + 1)),
    [],
  );

  // Keep Core's per-sheet SURFACE map in step with the list. The switch
  // dispatches below carry the surface themselves; this map is what lets a
  // dispatcher that does NOT hold the list (the Name Box, the script host,
  // bookmarks) still land on the right surface.
  useEffect(() => {
    if (!isLoading) dispatch(setSheetSurfaces(surfacesOf(sheets)));
  }, [sheets, isLoading, dispatch]);

  // Sync local activeIndex with Redux state when it changes from outside
  // This handles the case when commitEdit switches back to the source sheet
  useEffect(() => {
    if (sheetContext.activeSheetIndex !== activeIndex && !isLoading) {
      console.log("[SheetTabs] Syncing activeIndex with Redux:", sheetContext.activeSheetIndex);
      setActiveIndex(sheetContext.activeSheetIndex);
    }
  }, [sheetContext.activeSheetIndex, activeIndex, isLoading]);

  // Context menu state: the right-clicked sheet as the list showed it, kept BY
  // IDENTITY -- the render and the item click find it again by its stable id
  // (`findSameSheet`), never by the index it had at the right-click.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sheet: SheetInfo;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Unhide dialog state
  const [unhideDialog, setUnhideDialog] = useState<{
    hiddenSheets: SheetInfo[];
    selectedIndex: number | null;
  } | null>(null);

  // Delete confirmation dialog state: the sheet the prompt NAMES, by its
  // stable id. Its Delete deletes THAT sheet (`confirmDeleteSheet`), whatever
  // a discard landing while the prompt was open did to the indices.
  const [deleteConfirm, setDeleteConfirm] = useState<DoorTarget | null>(null);

  // The "+" caret's kind menu (Worksheet / Canvas), anchored above the caret.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Drag-to-reorder state. The indices drive the drag's own pixels; the drop
  // moves the sheets the STABLE ids name (a discard can land mid-drag).
  const [dragState, setDragState] = useState<{
    dragging: boolean;
    sourceIndex: number;
    /** The dragged sheet's stable id, taken at the press. */
    sourceSheetId?: string;
    currentIndex: number;
    /** The stable id of the tab under the pointer: the one the drop takes the place of. */
    currentSheetId?: string;
    startX: number;
  } | null>(null);
  const tabsAreaRef = useRef<HTMLDivElement>(null);

  // A FINISHED drag is not a click (the FIRST early return of
  // `handleSheetClick`, below -- the strip's to decide, never resolveTabClick's:
  // it must run before the group-clearing step; review
  // DRAG-DISARM-MAKES-THE-DROP-A-CLICK, RESOLVETABCLICK-DRAGGING-DEAD; tested
  // in sheetTabsTemporarySheets.test.tsx). The drag disarms AT its mouseup,
  // before the drop's door is awaited (TSHELL4-DRAG-STATE-ARMED-DURING-DOOR),
  // and React commits that before the browser dispatches the click that
  // follows the release -- so `dragState` can no longer tell that click from a
  // genuine one, and a drop released over the dragged tab switched to it (or,
  // with Ctrl, grouped it) by its PRE-move index while the move was in
  // flight. This ref remembers the release instead: set by the mouseup for
  // ANY finished drag, honoured -- and cleared -- FIRST by the click; cleared
  // by a timer (Chromium dispatches the click in the mouseup's own task, so
  // the timer always runs after it, and also covers a release with no tab
  // click) and by the next press.
  const dropJustEndedRef = useRef(false);
  const dropEndedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forgetDropEnded = useCallback(() => {
    dropJustEndedRef.current = false;
    if (dropEndedTimerRef.current !== null) {
      clearTimeout(dropEndedTimerRef.current);
      dropEndedTimerRef.current = null;
    }
  }, []);

  // Tab scroll state: how many tabs are hidden on each side
  const [hiddenLeft, setHiddenLeft] = useState(0);
  const [hiddenRight, setHiddenRight] = useState(0);

  // Check if we're in formula reference mode
  // FIX: Use BOTH React state AND synchronous global check. React state may be stale
  // if the user types an operator (e.g., comma) and immediately clicks a sheet tab
  // before React re-renders. The global check uses module-level state updated synchronously.
  //
  // A live EXTERNAL session (a floating grid's cell edit) counts when it expects
  // a reference or is parked on another sheet. `pointKey` is a primitive
  // snapshot ("host:parked:expecting"), so the strip re-renders when one of
  // those changes and not on every keystroke of the formula.
  const pointKey = useSyncExternalStore(subscribeExternalEdit, getCrossSheetPointModeKey);
  const externalLive = pointKey !== null;
  const isInFormulaMode =
    (editing !== null && isFormulaExpectingReference(editing.value)) ||
    isGlobalFormulaMode() ||
    isCrossSheetPointMode();
  // Adding, deleting, renaming or reordering sheets is refused while ANY
  // external session is live, expecting or not: the session holds its host's
  // TRUE index, and a structural change would move that sheet underneath it.
  const structuralLocked = isInFormulaMode || externalLive;

  // The structural lock as it stands NOW, for a check made AFTER an await (a
  // door's settle and fresh read, review TSHELL4-DOOR-WAIT-SKIPS-STRUCTURAL-LOCK)
  // or from a callback created once: the render's verdict through a ref the
  // render keeps current, OR the same synchronous globals the render reads,
  // which a keystroke since the last render has already moved. A callback that
  // closed over `structuralLocked` would ask the lock as it was when the door
  // STARTED -- before a formula edit opened during its wait.
  const structuralLockedRef = useRef(structuralLocked);
  structuralLockedRef.current = structuralLocked;
  const structureLockedNow = useCallback(
    (): boolean =>
      structuralLockedRef.current ||
      isGlobalFormulaMode() ||
      isCrossSheetPointMode() ||
      getExternalEditSession() !== null,
    [],
  );

  // The leave observer's OWN pause (model-drillthrough.md 2.7, rule 3): ANY
  // cell edit open -- the grid's editor or an external session -- whatever the
  // formula looks like. NOT `structuralLocked`: that lock asks "does the
  // formula expect a reference right now?", which turns false the moment a
  // point-mode click inserts `Sales!B2` while the backend is still on Sales,
  // and a read judged then deleted the temporary sheet being edited
  // (ephemeralSheets.ts `leaveObserverPaused`). `editingRef` is what the
  // observer asks at EVENT time; the render keeps it current. Core's
  // SYNCHRONOUS edit flags join it, so an edit that is still OPENING -- its
  // first keystroke landed, no editing state yet -- pauses the observer too.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // `pointKey` is null exactly when no external session is live.
  const observerPaused = leaveObserverPaused(editing, pointKey, syncEditFlags());
  // The same pause asked NOW (event time): the observer's, and the discard's
  // own check before it sends (`discardSheetById`).
  const editPausedNow = useCallback(
    (): boolean => leaveObserverPaused(editingRef.current, getExternalEditSession(), syncEditFlags()),
    [],
  );

  // The temporary sheet's discard, by stable id, read through a ref so the
  // observer (created once) always reaches the current body.
  const discardByIdRef = useRef<(sheetId: string, caller?: DiscardCaller) => Promise<boolean>>(
    () => Promise.resolve(false),
  );

  // THE leave observer (ephemeralSheets.ts `createEphemeralLeaveObserver`):
  // its memory -- the ACTIVE sheet as the last JUDGED read reported it, by
  // stable id, with its flag -- is overwritten synchronously before any
  // discard; it records nothing while a cell edit is open or while the
  // strip's own two-step flow is in flight; it discards by stable id.
  const leaveObserverRef = useRef<EphemeralLeaveObserver | null>(null);
  if (leaveObserverRef.current === null) {
    leaveObserverRef.current = createEphemeralLeaveObserver({
      paused: () => leaveObserverPaused(editingRef.current, getExternalEditSession(), syncEditFlags()),
      discardInFlight: (sheetId) => discardInFlight.has(sheetId),
      discard: (sheetId) => {
        void discardByIdRef.current(sheetId, "leave");
      },
    });
  }
  const leaveObserver = leaveObserverRef.current;

  // Rule 3's other half: nothing is queued while the observer is paused. When
  // the pause ENDS -- the edit closed, which a Core trip does only after it
  // switched back to the source sheet -- the list is re-read ONCE, and only if
  // a read was skipped meanwhile, so the verdict comes from a fresh
  // `get_sheets()`. Only the true -> false edge reads; the mount read is the
  // effect below.
  const wasPausedRef = useRef(observerPaused);
  useEffect(() => {
    const wasPaused = wasPausedRef.current;
    wasPausedRef.current = observerPaused;
    if (wasPaused && !observerPaused && leaveObserver.pauseEnded()) loadSheets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observerPaused]);

  // Register core menu items on first render
  useEffect(() => {
    if (!coreMenuRegistered) {
      registerCoreSheetContextMenu();
      coreMenuRegistered = true;
    }
  }, []);

  // Load sheets on mount
  useEffect(() => {
    loadSheets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload sheets whenever a SHEET_CHANGED event fires from outside
  // (e.g., when a sheet is added from CreatePivotDialog), or when the sheet
  // COLLECTION itself changed.
  //
  // §3cd: "sheets:refresh" is the `sheets` domain's event. An MCP tool that
  // adds, renames, moves or deletes a sheet runs entirely in the backend, with
  // no frontend call to return from -- it used to emit a bespoke Tauri event of
  // this same name that NOTHING in the app had ever listened to, so an
  // AI-created sheet simply never appeared in the tab bar. It now announces the
  // domain and the Shell translator dispatches this.
  useEffect(() => {
    const handleExternalSheetChange = () => { loadSheets(); };
    window.addEventListener("app:sheet-changed", handleExternalSheetChange);
    window.addEventListener("sheets:refresh", handleExternalSheetChange);
    return () => {
      window.removeEventListener("app:sheet-changed", handleExternalSheetChange);
      window.removeEventListener("sheets:refresh", handleExternalSheetChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper: apply a SheetsResult and trigger sheet switch events.
  // backendHandledSwitch=true means the backend already swapped grids/state for the new active
  // index, so we must NOT call setActiveSheetApi again (which would do a redundant swap).
  // forceSwitch=true runs the switch steps even when the active INDEX did not
  // change: Insert Sheet (before the active sheet) and Move or Copy's copy can
  // leave a DIFFERENT sheet at the same index, and comparing numbers would
  // then keep painting the old sheet's cells under the new sheet's tab.
  const applySheetsResult = useCallback(async (
    result: SheetsResult,
    { switchSheet = true, backendHandledSwitch = false, forceSwitch = false } = {}
  ) => {
    setSheets(result.sheets);
    if (switchSheet && (forceSwitch || result.activeIndex !== activeIndex)) {
      if (backendHandledSwitch) {
        // Backend already swapped - just sync frontend state.
        // BUG-0052: prime the canvas with the new sheet's viewport BEFORE any
        // visible state moves, so strip and grid repaint in one flush. The
        // dispatch sequence below stays free of awaits.
        await primeSheetSwitch(result.activeIndex);
        setActiveIndex(result.activeIndex);
        const newActive = sheetAt(result.sheets, result.activeIndex);
        if (newActive) {
          dispatch(setActiveSheet(result.activeIndex, newActive.name, surfaceOf(newActive), newActive.sheetId));
        }
        onSheetChange?.(result.activeIndex, newActive?.name || "");
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: result.activeIndex, newSheetName: newActive?.name || "" },
        }));
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActive?.name || "",
        });
      } else {
        // Need to actually switch sheets in backend
        const switchResult = await setActiveSheetApi(result.activeIndex);
        // BUG-0052: backend is on the new sheet now — prime before the
        // visible commit below, which then runs without awaits.
        await primeSheetSwitch(switchResult.activeIndex);
        setSheets(switchResult.sheets);
        setActiveIndex(switchResult.activeIndex);
        const newActive = sheetAt(switchResult.sheets, switchResult.activeIndex);
        if (newActive) {
          dispatch(setActiveSheet(switchResult.activeIndex, newActive.name, surfaceOf(newActive), newActive.sheetId));
        }
        onSheetChange?.(switchResult.activeIndex, newActive?.name || "");
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: switchResult.activeIndex, newSheetName: newActive?.name || "" },
        }));
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: switchResult.activeIndex,
          sheetName: newActive?.name || "",
        });
      }
    } else {
      setActiveIndex(result.activeIndex);
    }
  }, [activeIndex, dispatch, onSheetChange]);

  // The strip's operations, reached two ways: the `sheet:request*` window
  // events the tab context menu (and Protection's guarded copies of its items)
  // dispatch, and the controller the core.sheet.* commands call
  // (sheetCommands.ts). ONE body per operation, so the two doors cannot
  // drift. Every handler is read through a ref, so this effect registers once.
  //
  // Each door takes its sheet BY IDENTITY at the event -- the stable id the
  // tab menu sends, else the sheet at the index in the list the caller just
  // chose from -- and acts through `runSheetDoor`, which finds it again after
  // every discard already sent has answered (review
  // TSHELL3-CONVERSE-OTHER-DOORS).
  useEffect(() => {
    // The strip's list as of the last render: the list a menu item, or a
    // command that has just read the snapshot, chose its sheet from.
    const listNow = (): SheetInfo[] => controllerStateRef.current.sheets;
    const targetOf = (request: SheetRequest): DoorTarget => doorTargetFor(listNow(), request);
    /** A window event's sheet: the TRUE index it names and, from the tab menu, the stable id. */
    const requestFrom = (index: unknown, sheetId: unknown): SheetRequest => ({
      index: typeof index === "number" ? index : -1,
      sheetId: typeof sheetId === "string" && sheetId !== "" ? sheetId : undefined,
    });

    /** One `move_sheet`, told to Core's view cache once it LANDED, then applied. */
    const rotateSheet = async (fromIndex: number, toIndex: number) => {
      const result = await moveSheet(fromIndex, toIndex);
      announceReorder({ fromIndex, toIndex });
      await applySheetsResultRef.current(result, { backendHandledSwitch: true });
    };

    /**
     * Move Left / Move Right: one place along the tabs the user SEES. The
     * neighbour is taken from where the sheet stands in the door's FRESH read,
     * never from an index the menu captured (a discard landing since moved the
     * sheet onto itself, or past another one).
     */
    const moveSheetBeside = async (request: SheetRequest, direction: "left" | "right") => {
      try {
        await runSheetDoorRef.current([targetOf(request)], "moved", async ([sheet], fresh) => {
          const visible = fresh.sheets.filter((s) => s.visibility === "visible");
          const at = visible.findIndex((s) => s.index === sheet.index);
          const to = direction === "left" ? at - 1 : at + 1;
          // Already at that end of the visible tabs: nothing to move.
          if (at < 0 || to < 0 || to >= visible.length) return;
          await rotateSheet(sheet.index, visible[to].index);
        });
      } catch (err) {
        console.error("[SheetTabs] moveSheet error:", err);
        void alertAsync("Failed to move sheet: " + String(err));
      }
    };

    /**
     * `sheet:requestMove { fromIndex, toIndex }` (the journeys' door): the
     * sheet at `fromIndex` to where the sheet at `toIndex` stands, both taken
     * by identity at the event and found again in the door's fresh read.
     */
    const moveSheetTo = async (from: SheetRequest, to: SheetRequest) => {
      try {
        const place: DoorTarget = { ...targetOf(to), role: "drop" };
        await runSheetDoorRef.current([targetOf(from), place], "moved", async ([sheet, destination]) => {
          if (sheet.index !== destination.index) await rotateSheet(sheet.index, destination.index);
        });
      } catch (err) {
        console.error("[SheetTabs] moveSheet error:", err);
        void alertAsync("Failed to move sheet: " + String(err));
      }
    };

    const copySheetAt = async (request: SheetRequest) => {
      try {
        await runSheetDoorRef.current([targetOf(request)], "copied", async ([source]) => {
          window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
            detail: { oldSheetIndex: -1, newSheetIndex: -1 },
          }));
          const result = await copySheet(source.index);
          // The copy lands right after its source, renumbering every sheet past
          // it: untold, each of them restored its NEIGHBOUR's selection and
          // scroll on its next visit.
          announceReorder(insertionReorderDetail(result.activeIndex));
          await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: true });
        });
      } catch (err) {
        console.error("[SheetTabs] copySheet error:", err);
        void alertAsync("Failed to copy sheet: " + String(err));
      }
    };

    const hideSheetAt = async (request: SheetRequest) => {
      try {
        await runSheetDoorRef.current([targetOf(request)], "hidden", async ([sheet]) => {
          const result = await hideSheet(sheet.index);
          await applySheetsResultRef.current(result, { backendHandledSwitch: true });
        });
      } catch (err) {
        console.error("[SheetTabs] hideSheet error:", err);
        void alertAsync("Failed to hide sheet: " + String(err));
      }
    };

    const openUnhideDialog = async () => {
      try {
        const current = await getSheets();
        const hiddenSheets = current.sheets.filter(s => s.visibility === "hidden");
        if (hiddenSheets.length === 0) {
          void alertAsync("No hidden sheets to unhide.");
          return;
        }
        // Open the unhide dialog
        setUnhideDialog({ hiddenSheets, selectedIndex: hiddenSheets[0].index });
      } catch (err) {
        console.error("[SheetTabs] unhideSheet error:", err);
        void alertAsync("Failed to unhide sheet: " + String(err));
      }
    };

    const setTabColorAt = async (request: SheetRequest, color: string) => {
      try {
        await runSheetDoorRef.current([targetOf(request)], "recolored", async ([sheet]) => {
          const result = await setTabColor(sheet.index, color);
          setSheets(result.sheets);
        });
      } catch (err) {
        console.error("[SheetTabs] setTabColor error:", err);
        void alertAsync("Failed to set tab color: " + String(err));
      }
    };

    const handleRename = async (e: Event) => {
      const { index, newName, sheetId } = (e as CustomEvent).detail;
      await handleRenameSheetRef.current(requestFrom(index, sheetId), newName);
    };

    const handleDelete = async (e: Event) => {
      const { index, sheetId } = (e as CustomEvent).detail;
      await handleDeleteSheetRef.current(requestFrom(index, sheetId));
    };

    const handleAdd = async (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: SheetKindName } | null>).detail?.kind;
      await handleAddSheetRef.current(kind === "canvas" ? "canvas" : undefined);
    };

    const handleMove = async (e: Event) => {
      const { fromIndex, toIndex, sheetId, direction } = (e as CustomEvent).detail;
      if (direction === "left" || direction === "right") {
        await moveSheetBeside(requestFrom(fromIndex, sheetId), direction);
      } else {
        await moveSheetTo(requestFrom(fromIndex, sheetId), requestFrom(toIndex, undefined));
      }
    };

    const handleCopy = async (e: Event) => {
      const { index, sheetId } = (e as CustomEvent).detail;
      await copySheetAt(requestFrom(index, sheetId));
    };

    const handleHide = async (e: Event) => {
      const { index, sheetId } = (e as CustomEvent).detail;
      await hideSheetAt(requestFrom(index, sheetId));
    };

    const handleUnhide = async () => {
      await openUnhideDialog();
    };

    const handleTabColor = async (e: Event) => {
      const { index, color, sheetId } = (e as CustomEvent).detail;
      await setTabColorAt(requestFrom(index, sheetId), color);
    };

    // The core.sheet.* commands' door (sheetCommands.ts). Seated for as long
    // as the strip is mounted; every method is a handler of the strip's own,
    // so a command runs the same switch steps a click does. An index from a
    // command names the sheet at that index in the list it just read (the
    // controller's contract); Rename passes the id it read before its prompt,
    // and Move or Copy passes ids only.
    const releaseController = registerSheetTabsController({
      // The lock as it stands NOW (`structureLockedNow`), so the commands'
      // refusals and the door's own re-check ask the same question.
      snapshot: () => ({ ...controllerStateRef.current, locked: structureLockedNow() }),
      insertSheetBefore: (beforeIndex, kind) => handleInsertSheetBeforeRef.current(beforeIndex, kind),
      // The strip's own "+" (append), for the command's `{ atEnd: true }`.
      appendSheet: (kind) => handleAddSheetRef.current(kind),
      // Excel's rule for the command door: a blank sheet goes without asking.
      deleteSheet: (index) => handleDeleteSheetRef.current({ index }, { confirm: "whenNotBlank" }),
      // A TEMPORARY sheet's two doors (model-drillthrough.md 2.7): the drill
      // runner's discard-before-the-next (core.sheet.discardEphemeral) and the
      // tab menu's Keep Sheet. Neither asks: the sheet is a drill's result.
      // Both by the STABLE id, passed straight through -- never an index.
      discardSheet: (sheetId) => discardByIdRef.current(sheetId),
      keepSheet: (sheetId) => keepSheetRef.current(sheetId),
      renameSheet: (index, newName, sheetId) => handleRenameSheetRef.current({ index, sheetId }, newName),
      hideSheet: (index) => hideSheetAt({ index }),
      openUnhideDialog,
      setTabColor: (index, color) => setTabColorAt({ index }, color),
      moveOrCopySheet: (sourceSheetId, beforeSheetId, copy) =>
        handleMoveOrCopySheetRef.current(sourceSheetId, beforeSheetId, copy),
    });

    window.addEventListener("sheet:requestRename", handleRename);
    window.addEventListener("sheet:requestDelete", handleDelete);
    window.addEventListener("sheet:requestAdd", handleAdd);
    window.addEventListener("sheet:requestMove", handleMove);
    window.addEventListener("sheet:requestCopy", handleCopy);
    window.addEventListener("sheet:requestHide", handleHide);
    window.addEventListener("sheet:requestUnhide", handleUnhide);
    window.addEventListener("sheet:requestTabColor", handleTabColor);

    return () => {
      window.removeEventListener("sheet:requestRename", handleRename);
      window.removeEventListener("sheet:requestDelete", handleDelete);
      window.removeEventListener("sheet:requestAdd", handleAdd);
      window.removeEventListener("sheet:requestMove", handleMove);
      window.removeEventListener("sheet:requestCopy", handleCopy);
      window.removeEventListener("sheet:requestHide", handleHide);
      window.removeEventListener("sheet:requestUnhide", handleUnhide);
      window.removeEventListener("sheet:requestTabColor", handleTabColor);
      releaseController();
    };
    // `structureLockedNow` is created once (no deps), so this still registers once.
  }, [structureLockedNow]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [contextMenu]);

  // Close the "+" kind menu on an outside click or Escape.
  useEffect(() => {
    if (!addMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      // The caret is its own toggle: closing here on its press would let its
      // click reopen the menu, so a second click on the caret could never close it.
      if ((e.target as Element | null)?.closest?.("[data-add-sheet-menu-trigger]")) return;
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [addMenu]);

  /**
   * Discard a TEMPORARY (drill-through) sheet the user has LEFT -- or, through
   * the controller (core.sheet.discardEphemeral), the one a drill runner must
   * clear before it adds the next (model-drillthrough.md 2.7) -- by its STABLE
   * id. Resolves true once the sheet is gone, false on a refusal it has
   * already told the user about (C7).
   *
   * By id END TO END: the backend resolves the id to the sheet's CURRENT index
   * in the same command that deletes it (`discard_ephemeral_sheet`), and the
   * index everything here announces is the one it REPORTS. An index taken from
   * an earlier read named whichever sheet slid into it: Insert Sheet (an add
   * then a move) and Move or Copy's copy (a copy then a move) renumber the
   * sheets between the read and the delete, and the strip deleted the user's
   * own sheet while the temporary one survived (review finding
   * discard-stale-index-after-insert-or-copy-move).
   *
   * Its OWN body, NOT `executeDeleteSheet`: that one is a SWITCH body
   * (beforeSwitch, prime, `dispatch(setActiveSheet)`, normalSwitch,
   * SHEET_CHANGED), and replayed onto a sheet the user already reached it
   * restores that sheet's OLD selection and scroll ~100 ms after a hyperlink or
   * the Watch Window landed. The user sits on the sheet they chose; this only
   * removes the one they left: the wrapper's discard (its SHEET_DELETED and
   * MUTATION_REFRESH over seven domains -- exactly what `deleteSheet`
   * announces -- make every cache, and this strip through the translator's
   * `sheets:refresh`, re-read), the view-cache renumbering at the REPORTED
   * index, the list, and Core's sheet context from the backend's answer. No
   * switch fan-out and no SHEET_CHANGED of its own; nothing recorded for a
   * macro.
   *
   * A second request for the same id while one is in flight gets the SAME
   * promise: it awaits the first discard's answer instead of sending another.
   *
   * NEVER INSIDE ONE OF THE STRIP'S OWN DOORS (review TSHELL-3; `runSheetDoor`):
   * between a door's fresh read and its step -- and between the two steps of
   * Insert Sheet or Move or Copy with a copy -- a discard landing renumbers the
   * sheets under the indices the step uses. The leave observer holds its own
   * verdicts for a door; a discard through core.sheet.discardEphemeral (the
   * drill runner's) waits here, INSIDE the promise, so the in-flight entry is
   * still recorded synchronously and the observer's re-read after the door
   * joins this discard instead of sending a second one. Once sent it is in
   * `discardsSent`, which a door that starts later awaits first.
   *
   * A REFUSED discard (Protect Workbook Structure turned on while on the
   * sheet; a repairability pre-flight) KEEPS the sheet instead, by the same id,
   * and says so ONCE in a toast -- never a modal, never the same refusal at
   * every later leave -- and "kept" ONLY when the keep landed
   * (ephemeralSheets.ts `refusedDiscardOutcome`).
   *
   * NEVER SENT UNDER A CELL EDIT (review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT,
   * TSHELL4-DOOR-WAIT-SKIPS-STRUCTURAL-LOCK): when a Core edit or an external
   * session is open -- or still OPENING -- at the moment the discard would go
   * (after the hold, which an edit can open during), it is not sent: a discard
   * landing under the edit renumbers the sheet being edited, and the edit then
   * commits into whichever sheet slid into its index. The leave is handed back
   * to the observer as OWED (`leaveDeferred`), whose pause re-reads once when
   * the edit closes and discards the sheet then -- if the user has left it. A
   * caller through core.sheet.discardEphemeral (`caller` "command", the drill
   * runner) is told once in a toast -- the structural lock's sentence while a
   * formula is being written -- and answered false, so it adds nothing.
   */
  const discardSheetById = useCallback(
    (sheetId: string, caller: DiscardCaller = "command"): Promise<boolean> => {
      const pending = discardInFlight.get(sheetId);
      if (pending) return pending;
      const run = (async (): Promise<boolean> => {
        while (leaveObserver.flowsInFlight() > 0) await leaveObserver.whenFlowsIdle();
        if (editPausedNow()) {
          leaveObserver.leaveDeferred(sheetId);
          if (caller === "command") {
            showToast(structureLockedNow() ? STRUCTURE_LOCKED : DISCARD_UNDER_EDIT, { variant: "info" });
          }
          return false;
        }
        let discarded: DiscardedSheet;
        // SENT from here, in the same turn the hold let go: no flow can start in between.
        const sent = discardEphemeralSheet(sheetId);
        discardsSent.add(sent);
        const forget = () => {
          discardsSent.delete(sent);
        };
        sent.then(forget, forget);
        try {
          discarded = await sent;
        } catch (err) {
          // Only the BACKEND's refusal lands here (nothing was deleted).
          const reason = errorText(err);
          console.warn("[SheetTabs] discard of a temporary sheet refused; keeping it:", reason);
          let state: TemporarySheetState | "unknown";
          let keepRefusal: string | undefined;
          try {
            const kept = await keepEphemeralSheet(sheetId);
            setSheets(kept.sheets);
            state = temporarySheetStateIn(kept, sheetId);
          } catch (keepErr) {
            keepRefusal = errorText(keepErr);
            console.error("[SheetTabs] keepEphemeralSheet after a refused discard failed:", keepRefusal);
            state = await temporarySheetStateNow(sheetId);
          }
          if (state === "kept") leaveObserver.kept(sheetId);
          const outcome = refusedDiscardOutcome(reason, state, keepRefusal);
          if (outcome.notice) showToast(outcome.notice.message, { variant: outcome.notice.variant });
          return outcome.gone;
        }
        const { deletedIndex, result } = discarded;
        // A door that still names this sheet can say which sheet is gone.
        rememberDiscarded(sheetId, discarded.deletedName);
        // Every sheet past the discarded one moved down an index -- the same
        // telling executeDeleteSheet makes to Core's per-sheet view cache, at
        // the index the backend actually removed.
        announceReorder(removalReorderDetail(deletedIndex));
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);
        const active = sheetAt(result.sheets, result.activeIndex);
        if (active) {
          dispatch(setSheetContext(result.activeIndex, active.name, surfaceOf(active), active.sheetId));
        }
        return true;
      })();
      discardInFlight.set(sheetId, run);
      const release = () => {
        if (discardInFlight.get(sheetId) === run) discardInFlight.delete(sheetId);
      };
      run.then(release, release);
      return run;
    },
    // `leaveObserver` is created once per mount (a ref), never replaced; the
    // two predicates are created once (no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch, editPausedNow, structureLockedNow],
  );
  discardByIdRef.current = discardSheetById;

  /**
   * Keep a TEMPORARY sheet (the tab's double-click; the tab menu's Keep
   * Sheet), by the STABLE id the caller saw: the backend drops its flag and the
   * strip adopts the list -- the italic goes with the flag. "Sheet kept" ONLY
   * when the answered list holds THAT sheet unflagged; otherwise it says the
   * sheet is still temporary, or gone (a refused keep asks a fresh read which).
   * The observer's memory follows, so a later leave of this sheet finds
   * nothing to discard even before the next read (the fresh read's own flag
   * decides anyway; ephemeralSheets.ts rule 5).
   */
  const keepSheet = useCallback(async (sheetId: string | undefined) => {
    if (sheetId === undefined || sheetId === "") {
      const notice = keepNotice("unknown", "the workbook did not report which sheet this is");
      showToast(notice.message, { variant: notice.variant });
      return;
    }
    let state: TemporarySheetState | "unknown";
    let refusal: string | undefined;
    try {
      const result = await keepEphemeralSheet(sheetId);
      setSheets(result.sheets);
      state = temporarySheetStateIn(result, sheetId);
    } catch (err) {
      refusal = errorText(err);
      console.error("[SheetTabs] keepEphemeralSheet error:", refusal);
      state = await temporarySheetStateNow(sheetId);
    }
    if (state === "kept") leaveObserver.kept(sheetId);
    const notice = keepNotice(state, refusal);
    showToast(notice.message, { variant: notice.variant });
    // `leaveObserver` is created once per mount (a ref), never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The backend-derived read, and THE one site of the temporary-sheet leave
   * observer (model-drillthrough.md 2.7, rule 1) -- never the strip's own adopt
   * sites: a tab click adopts its result and THEN emits SHEET_CHANGED, so a
   * second site would judge the same pair twice. The observer
   * (ephemeralSheets.ts) records nothing while a cell edit is open or while the
   * strip's own two-step flow is in flight -- which is why the ticket is taken
   * as the read is SENT, not when it answers -- overwrites its memory before
   * any discard, and discards by stable id. Doors that switch with a raw
   * `setActiveSheet` and no event (the Insights pane, the command line's
   * `ensureSheetActive`) produce a LATE leave on the next sheets event;
   * accepted and named in the design (rule 6).
   */
  const loadSheets = useCallback(async () => {
    const ticket = leaveObserver.readSent();
    try {
      const result = await getSheets();
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);
      // Sync sheet context with state -- with the sheet's STABLE id, which is
      // how an open edit follows a rename of its own sheet (review
      // F1-rename-refuses-entry): a rename re-reads here, and the context
      // arrives at the same id under the new name.
      const activeSheet = sheetAt(result.sheets, result.activeIndex);
      if (activeSheet) {
        dispatch(setSheetContext(result.activeIndex, activeSheet.name, surfaceOf(activeSheet), activeSheet.sheetId));
      }
      setError(null);
      // The ONE site of the temporary-sheet leave observer (rule 1).
      leaveObserver.observe(result, ticket);
    } catch (err) {
      console.error("[SheetTabs] getSheets error:", err);
      setError(String(err));
      // The fallback list has no ids and is NEVER handed to the observer
      // (rule 4): its memory keeps what the last judged read said.
      setSheets([{ index: 0, name: "Sheet1", visibility: "visible" as const }]);
      setActiveIndex(0);
    } finally {
      setIsLoading(false);
    }
    // `leaveObserver` is created once per mount (a ref), never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  /**
   * Run one of the strip's doors on the sheet(s) its gesture named -- every
   * `targets` entry captured BEFORE anything was awaited -- through the ONE
   * shared resolver (`resolveDoorTargets`), and then `step` with those sheets
   * as the door's fresh read lists them.
   *
   * Held from the leave observer like a two-step flow (`flowStarted` /
   * `flowSettled`), from before the settle to after the step: no discard can
   * be SENT between the fresh read and the step (it waits for the door), and
   * a leave read that answers meanwhile -- the user left a temporary sheet a
   * moment before the gesture -- is not judged until the door is done, when
   * the list is re-read ONCE. Without the hold that read's discard was sent
   * after the door's read and before its step, and the step acted on the
   * renumbered list.
   *
   * The STRUCTURAL LOCK is asked again between the resolve and the step, as it
   * stands NOW (`structureLockedNow`): a door whose entry check passed can
   * spend a sent discard's whole round trip and a fresh read waiting, and a
   * formula edit opened meanwhile holds its source sheet by INDEX -- the
   * door's add, copy, move or delete renumbered it under the edit, and Enter
   * wrote the formula into another sheet (review
   * TSHELL4-DOOR-WAIT-SKIPS-STRUCTURAL-LOCK). One place for every door,
   * including those with no entry check of their own (Duplicate, Move Left /
   * Right, a drag, Hide, Tab Color, Unhide). It refuses with the lock's own
   * sentence in one toast, and the step does not run; the settle's re-read
   * still does.
   *
   * Rejects with whatever the read or the step threw, for the door's own
   * alert; a gone target was already refused with a toast.
   */
  const runSheetDoor = useCallback(
    async (
      targets: readonly DoorTarget[],
      done: string,
      step: (found: SheetInfo[], fresh: SheetsResult) => Promise<void>,
    ): Promise<void> => {
      leaveObserver.flowStarted();
      try {
        const resolved = await resolveDoorTargets(targets, done);
        if (!resolved) return;
        if (structureLockedNow()) {
          showToast(STRUCTURE_LOCKED, { variant: "info" });
          return;
        }
        await step(resolved.found, resolved.fresh);
      } finally {
        if (leaveObserver.flowSettled()) void loadSheets();
      }
    },
    // `leaveObserver` is created once per mount (a ref), never replaced;
    // `structureLockedNow` is created once (no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadSheets, structureLockedNow],
  );

  /**
   * Handle mousedown on sheet tabs.
   * CRITICAL: When in formula mode, set the global flag to prevent blur commit.
   * This flag is checked by InlineEditor's blur handler.
   * FIX: Check isGlobalFormulaMode() at event time for synchronous detection,
   * in addition to the React-derived isInFormulaMode from the render closure.
   */
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, sheetIndex: number) => {
      // FIX: Check BOTH the closure value AND the synchronous global state.
      // The closure value may be stale if React hasn't re-rendered since the last keystroke.
      // An external session is asked at event time too: without the
      // preventDefault the tab button takes focus, and the floating grid's
      // editor blur-commits whatever was typed ("=" included) 150 ms later.
      const isCurrentlyFormulaMode = isInFormulaMode || isGlobalFormulaMode() || isCrossSheetPointMode();
      if (isCurrentlyFormulaMode && sheetIndex !== activeIndex) {
        console.log("[SheetTabs] Formula mode mousedown - setting prevent blur flag");
        // Set the global flag BEFORE blur fires
        emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, true);
        // Prevent default to try to keep focus (may not work in all browsers)
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [isInFormulaMode, activeIndex]
  );

  const handleSheetClick = useCallback(
    async (index: number, event?: React.MouseEvent) => {
      // A finished drag is not a click -- asked FIRST, before anything below
      // can act, the group-clearing block included: this is the click the
      // browser dispatches after a drag's release (`dropJustEndedRef`), which
      // the drag's own state, disarmed at the mouseup, can no longer tell.
      // These two early returns are the ONLY place a drag's click is refused:
      // `resolveTabClick` takes no drag input, because its "ignore" is honoured
      // only after the group-clearing block (review RESOLVETABCLICK-DRAGGING-DEAD).
      if (dropJustEndedRef.current) {
        forgetDropEnded();
        return;
      }
      // A drag still ARMED (the button held, no release seen yet) is not a
      // click either: a keyboard-driven click on a tab mid-drag.
      if (dragState?.dragging) return;

      // FIX: Check BOTH the closure value AND the synchronous global state at event time.
      // The closure value may be stale if React hasn't re-rendered since the last keystroke.
      const coreFormulaMode =
        (editing !== null && isFormulaExpectingReference(editing.value)) || isGlobalFormulaMode();
      // The external session is read at EVENT time as well, never from the
      // render: a keystroke can have made it expect a reference since.
      const session = getExternalEditSession();
      const target = sheetAt(sheets, index);
      const sessionInput = session
        ? {
            // The CLICKED tab is the session's host by IDENTITY, asked now
            // (review F3-strip-uses-owner-host-index) -- never the owner's
            // opening `hostSheetIndex`, which a renumbering under a parked
            // edit leaves naming another sheet.
            targetIsSessionHost: target !== undefined && isExternalSessionHostSheet(target),
            parked: isExternalSessionParked(),
            expecting: getExternalFormulaTarget()?.isExpectingReference() === true,
          }
        : null;
      const isCurrentlyFormulaMode =
        coreFormulaMode || (sessionInput !== null && (sessionInput.expecting || sessionInput.parked));

      // A CANVAS never joins a sheet group, from either end (a group replicates
      // cell edits, clears and formats, and the backend refuses every one of
      // those on a canvas -- for the WHOLE group); a CANVAS is never a formula's
      // reference target nor a 3D endpoint, except that a parked session's own
      // host tab brings the edit back. All of it lives in `resolveTabClick`.
      const action = resolveTabClick({
        index,
        activeIndex,
        targetIsCanvas: target?.kind === "canvas",
        activeIsCanvas: sheetAt(sheets, activeIndex)?.kind === "canvas",
        ctrlKey: event?.ctrlKey === true,
        shiftKey: event?.shiftKey === true,
        coreFormulaMode,
        session: sessionInput,
      });

      // Ctrl+Click: Toggle sheet grouping (multi-select) when NOT in formula mode
      // (Core's group, which the strip paints through its subscription.)
      if (action === "group") {
        const newSelection = toggleSheetInGroup(index, activeIndex);
        setSelectedSheetIndices(newSelection);
        console.log("[SheetTabs] Ctrl+Click: groupedSheets =", newSelection);
        return;
      }

      // The tabs as the group rules read them (resolveTabClick.ts, SHEET GROUP
      // CLICKS): which are visible, which are canvases.
      const groupTabs: GroupTab[] = sheets.map((s) => ({
        index: s.index,
        visible: s.visibility === "visible",
        isCanvas: s.kind === "canvas",
      }));

      // Shift+click outside formula mode: the sheets from the active one to the
      // clicked one become the group, replacing any group; the active sheet
      // stays where it is (Excel [LIVE]).
      if (action === "groupRange") {
        const range = shiftClickGroup(activeIndex, index, groupTabs);
        if (range.length > 1) setSelectedSheetIndices(range);
        else clearSheetGrouping();
        return;
      }

      // A plain click that SWITCHES: it ends the group unless it lands on a
      // member of a group that leaves some visible tab out -- Excel keeps the
      // group then and only moves the active sheet (BUG-0616 item 6). A click on
      // the active tab, and a Ctrl/Shift click refused at a canvas, change
      // nothing ("ignore"). Asked of Core's group at EVENT time, never the
      // render's copy.
      if (
        action === "normal" &&
        isSheetGroupingActive() &&
        !plainClickKeepsGroup(getSelectedSheetIndices(), index, groupTabs)
      ) {
        clearSheetGrouping();
        console.log("[SheetTabs] Normal click: cleared sheet grouping");
      }

      if (action === "ignore") return;

      console.log("[SheetTabs] Sheet click, index:", index, "action:", action, "shift:", event?.shiftKey);

      try {
        // Shift+Click in formula mode: insert 3D reference prefix
        if (action === "prefix3d") {
          const startSheet = sheetAt(sheets, activeIndex)?.name;
          const endSheet = sheetAt(sheets, index)?.name;
          if (startSheet && endSheet) {
            // Build the 3D reference prefix, by the parser's rule (W13).
            const prefix = sheetRangePrefix(startSheet, endSheet);

            // Insert the 3D prefix into the formula bar
            const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
            if (formulaBar) {
              const cursorPos = formulaBar.selectionStart ?? formulaBar.value.length;
              const before = formulaBar.value.substring(0, cursorPos);
              const after = formulaBar.value.substring(cursorPos);
              formulaBar.value = before + prefix + after;
              // Trigger input event so React picks up the change
              formulaBar.dispatchEvent(new Event('input', { bubbles: true }));
              // Position cursor after the prefix
              const newPos = cursorPos + prefix.length;
              formulaBar.setSelectionRange(newPos, newPos);
              formulaBar.focus();
            }

            console.log("[SheetTabs] Inserted 3D reference prefix:", prefix);
          }
          return;
        }

        // When in formula mode, we need special handling
        if (action === "pointMode") {
          console.log("[SheetTabs] Formula mode - switching without reload");

          // Core's ONE point-mode switch: the backend's active sheet moves (so
          // clicks there pick references), the grid shows the new sheet, and the
          // edit stays open. For an external session it also PARKS the session
          // (before the dispatch, so the paint it causes already hides the
          // edit's own objects) -- or un-parks it, on the way back to its host --
          // and refreshes dimensions. GridCanvas refetches on the
          // `sheet:formulaModeSwitch` it emits; InlineEditor refocuses on it.
          const result: SheetsResult = await switchSheetForPointMode(index, dispatch);
          setSheets(result.sheets);
          setActiveIndex(result.activeIndex);

          const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
          onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

          // THE ONE PLACE that decides focus after a point-mode switch. For the
          // grid's own editor: the formula bar (InlineEditor does not render on
          // the target sheet), at the tracked caret -- Excel's behaviour. For an
          // external session: the bar while parked, its own in-place editor back
          // on the host. The two must never both run: each steals focus from
          // the other.
          // FIX: Clear preventBlurCommit AFTER focus is stable on the formula bar.
          // On the target sheet, InlineEditor returns null and can't clear the flag itself.
          setTimeout(() => {
            if (getExternalEditSession()) {
              focusExternalSessionView();
            } else {
              const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
              if (formulaBar) {
                formulaBar.focus();
                // FIX: Use tracked cursor position instead of always placing at end
                const cursorPos = getGlobalCursorPosition();
                const len = formulaBar.value.length;
                const pos = Math.min(cursorPos, len);
                formulaBar.setSelectionRange(pos, pos);
              }
            }
            // Clear the flag after focus is stable
            emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, false);
          }, 50);

          // DO NOT reload - stay in edit mode for formula reference selection
          return;
        }

        // Normal mode: switch sheets with full reload
        // Dispatch event BEFORE switching to save current sheet's state
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: {
            oldSheetIndex: activeIndex,
            newSheetIndex: index,
          }
        }));

        const result: SheetsResult = await setActiveSheetApi(index);
        // BUG-0052: the backend is on the new sheet — fetch its viewport
        // BEFORE the visible swap so the tab strip and the canvas commit in
        // ONE paint. Everything from here to SHEET_CHANGED runs without an
        // await, which is what keeps the switch atomic on screen.
        await primeSheetSwitch(result.activeIndex);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        const newActiveSheet = sheetAt(result.sheets, result.activeIndex);

        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet), newActiveSheet.sheetId));
        }

        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

        // Dispatch event to refresh grid data without full page reload
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: {
            newSheetIndex: result.activeIndex,
            newSheetName: newActiveSheet?.name || "",
          }
        }));

        // Notify extensions (AutoFilter, Grouping, etc.) that the active sheet changed
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActiveSheet?.name || "",
        });
      } catch (err) {
        console.error("[SheetTabs] setActiveSheet error:", err);
        // Clear the prevent flag on error
        emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, false);
        void alertAsync("Failed to switch sheet: " + String(err));
      }
    },
    [activeIndex, sheets, onSheetChange, editing, dispatch, dragState, forgetDropEnded]
  );

  const handleAddSheet = useCallback(async (kind?: SheetKindName) => {
    // Don't allow adding sheets while in formula mode
    if (structuralLocked) {
      return;
    }
    setAddMenu(null);

    try {
      // Dispatch event BEFORE adding sheet to save current sheet's state
      window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
        detail: {
          oldSheetIndex: activeIndex,
          newSheetIndex: -1, // New sheet index not known yet
        }
      }));

      const result = await addSheet(undefined, kind);
      // BUG-0052: same prime-before-commit as a tab click — a new sheet's
      // empty viewport still has to replace the old sheet's cells in the
      // same paint as the tab that claims it.
      await primeSheetSwitch(result.activeIndex);
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);

      const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
      if (newActiveSheet) {
        dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet), newActiveSheet.sheetId));
      }
      onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

      // Dispatch event to refresh grid data without full page reload
      window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
        detail: {
          newSheetIndex: result.activeIndex,
          newSheetName: newActiveSheet?.name || "",
        }
      }));

      // Notify extensions that the active sheet changed
      emitAppEvent(AppEvents.SHEET_CHANGED, {
        sheetIndex: result.activeIndex,
        sheetName: newActiveSheet?.name || "",
      });
    } catch (err) {
      console.error("[SheetTabs] addSheet error:", err);
      void alertAsync("Failed to add sheet: " + String(err));
    }
  }, [onSheetChange, structuralLocked]);

  /**
   * Excel's Insert Sheet (Shift+F11, Home > Insert > Insert Sheet): a new
   * worksheet immediately BEFORE `beforeIndex`, made active. The "+" button
   * keeps its append (handleAddSheet above); the backend can only append, so
   * this is an add followed by one move (sheetTabFlows.ts), applied through
   * the same commit-before-switch steps. FORCED: the new sheet takes the
   * anchor's index, so the active INDEX can come back unchanged while the
   * active SHEET is a different one.
   *
   * The anchor is taken BY IDENTITY from the list the caller chose it from
   * and found again by `runSheetDoor`, whose hold covers both backend steps:
   * the temporary-sheet leave observer judges nothing until both landed and
   * the result was applied -- a list read between the add and the move is not
   * the list the user ends up with, and a discard landing between them would
   * renumber the sheets under the move's indices -- and the list is re-read
   * ONCE when the door settles. An anchor that is gone by then (it was the
   * temporary sheet, closing) refuses the insert with a toast.
   */
  const handleInsertSheetBefore = useCallback(async (beforeIndex: number, kind?: SheetKindName) => {
    if (structuralLocked) return;
    const anchor: DoorTarget = { ...doorTargetFor(sheets, { index: beforeIndex }), role: "anchor" };
    try {
      await runSheetDoor([anchor], "inserted", async ([before]) => {
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: { oldSheetIndex: activeIndex, newSheetIndex: -1 },
        }));
        // The flow follows the anchor by identity again in the add's answer (`moveTargetFor`).
        const { result, error } = await insertSheetBefore(
          { addSheet: () => addSheet(undefined, kind), copySheet, moveSheet },
          announceReorder,
          before,
        );
        await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: true });
        if (error !== undefined) {
          // The sheet exists (and is shown); only its position failed.
          console.error("[SheetTabs] insert-before move error:", error);
          void alertAsync(`The new sheet was added at the end: it could not be moved before "${before.name}". ` + String(error));
        }
      });
    } catch (err) {
      console.error("[SheetTabs] insertSheetBefore error:", err);
      void alertAsync("Failed to insert sheet: " + String(err));
    }
  }, [sheets, activeIndex, structuralLocked, runSheetDoor]);

  /**
   * Excel's Move or Copy: the sheet with stable id `sourceSheetId` -- or a
   * copy of it -- immediately before the sheet with id `beforeSheetId`, or at
   * the end (null). A copy is made active (Excel), so its switch is forced
   * (see handleInsertSheetBefore); a move keeps the active sheet, and the
   * backend's index follows it.
   *
   * BY ID END TO END (review TSHELL3-CONVERSE-DIALOG-WINDOW): the dialog and
   * the command line hand over the ids they read, and the door ALWAYS settles
   * every discard already sent and finds both sheets again in a FRESH read
   * (`runSheetDoor`) -- the dialog can have stayed open while a discard
   * renumbered every sheet after the temporary one -- and the flow runs on
   * that read's indices. A source or a target that is gone REFUSES with a
   * toast; a gone target is never read as "(move to end)" (review
   * MOC-RERESOLVE-GONE-TARGET-READS-AS-END). The door's hold covers both of a
   * copy's steps, with the one re-read when it settles.
   */
  const handleMoveOrCopySheet = useCallback(
    async (sourceSheetId: string, beforeSheetId: string | null, copy: boolean) => {
      if (structuralLocked) return;
      const source = doorTargetFor(sheets, { index: -1, sheetId: sourceSheetId });
      const targets: DoorTarget[] =
        beforeSheetId === null
          ? [source]
          : [source, { ...doorTargetFor(sheets, { index: -1, sheetId: beforeSheetId }), role: "anchor" }];
      try {
        await runSheetDoor(targets, copy ? "copied" : "moved", async ([from, before], fresh) => {
          if (copy) {
            window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
              detail: { oldSheetIndex: activeIndex, newSheetIndex: -1 },
            }));
          }
          const { result, error } = await moveOrCopySheet(
            { addSheet: () => addSheet(), copySheet, moveSheet },
            announceReorder,
            fresh.sheets,
            from.index,
            beforeSheetId === null ? null : before.index,
            copy,
          );
          if (result) {
            await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: copy });
          }
          if (error !== undefined) {
            console.error("[SheetTabs] move-or-copy move error:", error);
            void alertAsync("The copy was made, but it could not be moved: " + String(error));
          }
        });
      } catch (err) {
        console.error("[SheetTabs] moveOrCopySheet error:", err);
        void alertAsync((copy ? "Failed to copy sheet: " : "Failed to move sheet: ") + String(err));
      }
    },
    [sheets, activeIndex, structuralLocked, runSheetDoor]
  );

  /**
   * The delete itself and its switch steps, for the sheet at `index` in the
   * door's fresh read. With `expectedSheetId` the backend deletes only THAT
   * sheet and refuses -- deleting nothing -- when the index names another by
   * the time the delete holds its locks (another door renumbered them); that
   * refusal is a toast, and every announcement below is made only for a delete
   * that landed, at the index it landed at.
   */
  const executeDeleteSheet = useCallback(
    async (index: number, expectedSheetId?: string) => {
      try {
        // Dispatch event BEFORE deleting sheet to save current sheet's state
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: {
            oldSheetIndex: activeIndex,
            newSheetIndex: -1,
          }
        }));

        const result = await deleteSheet(index, expectedSheetId === undefined ? undefined : { expectedSheetId });
        // Every sheet past the deleted one moved down an index. Untold, Core's
        // per-sheet view cache restored the DELETED sheet's selection and
        // scroll onto the neighbour that inherited its index, and each later
        // sheet its neighbour's.
        announceReorder(removalReorderDetail(index));
        // BUG-0052: prime-before-commit; deleting the active sheet lands the
        // user on a NEIGHBOUR whose cells must arrive with its tab.
        await primeSheetSwitch(result.activeIndex);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet), newActiveSheet.sheetId));
        }
        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: {
            newSheetIndex: result.activeIndex,
            newSheetName: newActiveSheet?.name || "",
          }
        }));

        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActiveSheet?.name || "",
        });
      } catch (err) {
        const reason = errorText(err);
        if (expectedSheetId !== undefined && reason.trim() === SHEETS_CHANGED_UNDER_THE_DELETE) {
          // Nothing was deleted: the backend's own sentence, once, in a toast.
          // The door's settle re-reads the list.
          console.warn("[SheetTabs] delete refused, the sheets changed under it:", reason);
          showToast(reason, { variant: "warning" });
          return;
        }
        console.error("[SheetTabs] deleteSheet error:", err);
        void alertAsync("Failed to delete sheet: " + String(err));
      }
    },
    [onSheetChange, activeIndex, dispatch]
  );

  /**
   * Delete, from either door: the tab menu's `sheet:requestDelete` and
   * core.sheet.delete (Home > Delete > Delete Sheet).
   *
   * `confirm: "whenNotBlank"` is Excel's rule -- ask first only when the sheet
   * holds something, delete a blank one at once; every doubt asks
   * (sheetDeletePolicy.ts: a delete ends the undo history, so a wrong "blank"
   * is unrecoverable). The COMMAND uses it. The tab menu still always asks
   * (`"always"`, the default): three journeys drive its confirmation on sheets
   * that may be blank (fixall-lifecycle X19, orphaned-sheet-state,
   * report-store), so moving that door is an owner's call, not this change's.
   *
   * The sheet is taken BY IDENTITY before anything is awaited -- the stable id
   * the tab menu sent, else the sheet at `index` in the list the command just
   * read. The confirmation remembers it by id (`confirmDeleteSheet` finds it
   * again); the Excel-rule door finds it again in a fresh read before it asks
   * the policy about THAT sheet and deletes it by id (review
   * DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM: the index read before the await
   * named the next sheet once a discard landed, and a delete ends the undo
   * history).
   */
  const handleDeleteSheet = useCallback(
    async (request: SheetRequest, options: { confirm?: "always" | "whenNotBlank" } = {}) => {
      if (sheets.length <= 1) return;
      if (structuralLocked) return;

      const target = doorTargetFor(sheets, request);
      if (namesNoSheet(target)) {
        showToast(goneNotice(target, "deleted"), { variant: "warning" });
        return;
      }
      if (options.confirm !== "whenNotBlank") {
        // Show confirmation dialog instead of using confirm()
        setDeleteConfirm(target);
        return;
      }
      try {
        await runSheetDoor([target], "deleted", async ([sheet], fresh) => {
          const ask = await sheetDeleteNeedsConfirmation(
            { index: sheet.index, kind: sheet.kind === "canvas" ? "canvas" : "worksheet" },
            sheet.index === fresh.activeIndex,
          );
          if (ask) setDeleteConfirm(doorTargetOf(sheet));
          else await executeDeleteSheet(sheet.index, sheet.sheetId);
        });
      } catch (err) {
        console.error("[SheetTabs] deleteSheet error:", err);
        void alertAsync("Failed to delete sheet: " + String(err));
      }
    },
    [sheets, structuralLocked, runSheetDoor, executeDeleteSheet]
  );

  /**
   * The confirmation's Delete: the sheet the prompt NAMED, found again by its
   * stable id once every discard already sent has answered -- never the index
   * it had when the prompt opened, which a discard landing while the prompt
   * was open hands to the next sheet (review
   * DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM). The delete carries the id too, so
   * the backend refuses rather than delete another sheet should anything
   * renumber the sheets after this read.
   */
  const confirmDeleteSheet = useCallback(
    async (target: DoorTarget) => {
      try {
        await runSheetDoor([target], "deleted", async ([sheet]) => {
          await executeDeleteSheet(sheet.index, sheet.sheetId);
        });
      } catch (err) {
        console.error("[SheetTabs] deleteSheet error:", err);
        void alertAsync("Failed to delete sheet: " + String(err));
      }
    },
    [runSheetDoor, executeDeleteSheet]
  );

  const handleRenameSheet = useCallback(
    async (request: SheetRequest, newName: string) => {
      // Don't allow renaming sheets while in formula mode
      if (structuralLocked) {
        return;
      }

      try {
        // The sheet BY IDENTITY: a prompt was open between the gesture and
        // this call, and a discard landing meanwhile renumbered the sheets.
        await runSheetDoor([doorTargetFor(sheets, request)], "renamed", async ([sheet]) => {
          const result = await renameSheet(sheet.index, newName);
          setSheets(result.sheets);
        });
      } catch (err) {
        console.error("[SheetTabs] renameSheet error:", err);
        void alertAsync("Failed to rename sheet: " + String(err));
      }
    },
    [structuralLocked, sheets, runSheetDoor]
  );

  // Refs to always access the latest handler versions from stable event listeners.
  // Must be declared AFTER the useCallback definitions to avoid temporal dead zone.
  const handleDeleteSheetRef = useRef(handleDeleteSheet);
  handleDeleteSheetRef.current = handleDeleteSheet;
  const handleRenameSheetRef = useRef(handleRenameSheet);
  handleRenameSheetRef.current = handleRenameSheet;
  const handleAddSheetRef = useRef(handleAddSheet);
  handleAddSheetRef.current = handleAddSheet;
  const handleInsertSheetBeforeRef = useRef(handleInsertSheetBefore);
  handleInsertSheetBeforeRef.current = handleInsertSheetBefore;
  const handleMoveOrCopySheetRef = useRef(handleMoveOrCopySheet);
  handleMoveOrCopySheetRef.current = handleMoveOrCopySheet;
  const applySheetsResultRef = useRef(applySheetsResult);
  applySheetsResultRef.current = applySheetsResult;
  const keepSheetRef = useRef(keepSheet);
  keepSheetRef.current = keepSheet;
  const runSheetDoorRef = useRef(runSheetDoor);
  runSheetDoorRef.current = runSheetDoor;
  // What the core.sheet.* commands' refusals read SYNCHRONOUSLY (the command-
  // refusal registry cannot await): the list, the active sheet and the
  // structural lock as of this render.
  const controllerStateRef = useRef({ sheets, activeIndex, locked: structuralLocked });
  controllerStateRef.current = { sheets, activeIndex, locked: structuralLocked };

  const sheetByIndex = useCallback(
    (index: number): SheetInfo | undefined => sheetAt(sheets, index),
    [sheets]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      // Don't show context menu while in formula mode
      if (structuralLocked) {
        return;
      }
      // The tab's sheet, kept BY IDENTITY from here on: a discard can land
      // while the menu is open and hand this index to the next sheet.
      const sheet = sheetByIndex(index);
      if (!sheet) return;
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        sheet,
      });
    },
    [structuralLocked, sheetByIndex]
  );

  const handleDoubleClick = useCallback(
    async (index: number) => {
      // Don't allow rename while in formula mode
      if (structuralLocked) {
        return;
      }
      const sheet = sheetByIndex(index);
      // A TEMPORARY sheet's double-click KEEPS it (model-drillthrough.md 2.7);
      // its rename stays in the tab menu. Decided by the pure helper. Kept by
      // the STABLE id of the tab that was double-clicked (this render's list,
      // the one the tab was drawn from), never by its index.
      if (resolveTabDoubleClick(sheet) === "keep") {
        await keepSheet(sheet?.sheetId);
        return;
      }
      const currentName = sheet?.name || "";
      // THE rename prompt (renameSheetPrompt.ts), shared with the tab menu's
      // Rename and core.sheet.rename; it explains why it is promptAsync and
      // never window.prompt.
      const newName = await promptForSheetName(currentName);
      if (newName !== null) {
        // The double-clicked sheet BY IDENTITY: a discard can have landed
        // while the prompt was open.
        await handleRenameSheet({ index, sheetId: sheet?.sheetId }, newName);
      }
    },
    [sheetByIndex, handleRenameSheet, structuralLocked, keepSheet]
  );

  const contextFor = useCallback(
    (sheet: SheetInfo | undefined): SheetContext | null => {
      if (!sheet) return null;
      return {
        sheet,
        index: sheet.index,
        // The STABLE key. An extension that answers "did this sheet come from
        // an application?" from a cache must key it on identity: the index
        // shifts under an insert, a delete or a move, and nothing tells the
        // extension it did.
        sheetId: sheet.sheetId,
        isActive: sheet.index === activeIndex,
        totalSheets: sheets.length,
      };
    },
    [sheets.length, activeIndex]
  );

  const getContextMenuItems = useCallback(
    (sheet: SheetInfo): ResolvedSheetContextMenuItem[] => {
      const context = contextFor(sheet);
      if (!context) return [];
      return sheetExtensions.getContextMenuItemsForContext(context);
    },
    [contextFor]
  );

  const handleContextMenuItemClick = useCallback(
    async (item: ResolvedSheetContextMenuItem) => {
      if (!contextMenu) return;

      // The sheet the menu was opened for, found again BY ITS STABLE ID in the
      // list as it is NOW -- never by the index it had at the right-click: a
      // temporary sheet's discard landing while the menu was open shifts every
      // sheet after it, and each item then acted on the neighbour (review
      // TSHELL3-CONVERSE-OTHER-DOORS). Each item's door finds it once more after
      // any discard still in flight (`runSheetDoor`).
      const sheet = findSameSheet(sheets, contextMenu.sheet);
      setContextMenu(null);
      if (!sheet) {
        showToast(goneNotice(doorTargetOf(contextMenu.sheet), "done"), { variant: "warning" });
        return;
      }
      const context = contextFor(sheet);
      if (!context) return;

      if (!item.disabled) {
        await item.onClick(context);
      }
    },
    [contextMenu, contextFor, sheets]
  );

  // Unhide dialog confirm. `index` is the row a DOUBLE-CLICK chose: the
  // double-click handler used to set the selection and call this in the same
  // tick, and this read `unhideDialog.selectedIndex` from its render closure --
  // the PREVIOUS selection -- so double-clicking the second hidden sheet
  // unhid the first. OK passes nothing and reads the selection. The row is
  // the sheet the dialog LISTED, by identity: the indices it was opened with
  // shift under a discard that lands while it is open.
  const handleUnhideConfirm = useCallback(async (index?: number) => {
    const target = typeof index === "number" ? index : unhideDialog?.selectedIndex ?? null;
    if (!unhideDialog || target === null) return;
    try {
      await runSheetDoor([doorTargetFor(unhideDialog.hiddenSheets, { index: target })], "unhidden", async ([sheet]) => {
        const result = await unhideSheet(sheet.index);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);
      });
    } catch (err) {
      console.error("[SheetTabs] unhideSheet error:", err);
      void alertAsync("Failed to unhide sheet: " + String(err));
    }
    setUnhideDialog(null);
  }, [unhideDialog, runSheetDoor]);

  // ---------------------------------------------------------------------------
  // Drag-to-reorder handlers
  // ---------------------------------------------------------------------------

  /** Get visible tab elements within the TabsArea */
  const getVisibleTabs = useCallback((): HTMLElement[] => {
    if (!tabsAreaRef.current) return [];
    return Array.from(tabsAreaRef.current.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
  }, []);

  /** Resolve a clientX position to a visible-tab drop index */
  const resolveDropIndex = useCallback((clientX: number): number => {
    const tabs = getVisibleTabs();
    if (tabs.length === 0) return 0;
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) return i;
    }
    return tabs.length - 1;
  }, [getVisibleTabs]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent, sheetIndex: number) => {
      // Every new press starts clean: a release whose click never reached a
      // tab must not swallow THIS gesture's click (`dropJustEndedRef`).
      forgetDropEnded();
      if (structuralLocked || e.button !== 0) return;
      // Only start drag on left-click, not on context-menu
      const sheetId = sheetByIndex(sheetIndex)?.sheetId;
      setDragState({
        dragging: false,
        sourceIndex: sheetIndex,
        sourceSheetId: sheetId,
        currentIndex: sheetIndex,
        currentSheetId: sheetId,
        startX: e.clientX,
      });
    },
    [structuralLocked, sheetByIndex, forgetDropEnded]
  );

  // Global mousemove / mouseup for drag
  useEffect(() => {
    if (!dragState) return;
    // Set by the release: from then on THIS drag's listeners act on nothing,
    // even before the render that removes them.
    let released = false;

    const handleMouseMove = (e: MouseEvent) => {
      if (released) return;
      setDragState(prev => {
        if (!prev) return null;
        const dragging = prev.dragging || Math.abs(e.clientX - prev.startX) > 5;
        const dropIdx = resolveDropIndex(e.clientX);
        // Map visible index back to real sheet index
        const visibleSheets = sheets.filter(s => s.visibility === "visible");
        const targetSheet = visibleSheets[dropIdx];
        const targetRealIndex = targetSheet ? targetSheet.index : prev.currentIndex;
        const targetSheetId = targetSheet ? targetSheet.sheetId : prev.currentSheetId;
        return { ...prev, dragging, currentIndex: targetRealIndex, currentSheetId: targetSheetId };
      });
    };

    const handleMouseUp = async () => {
      if (released) return;
      // DISARMED FIRST, synchronously, before anything is awaited (review
      // TSHELL4-DRAG-STATE-ARMED-DURING-DOOR): the door below can wait out a
      // sent discard, a fresh read and the move itself, and a drag still armed
      // all that time let the indicator follow the released pointer and let
      // the NEXT mouseup anywhere -- a click on a cell -- start a second move
      // from a read taken before the first landed. This closure keeps what the
      // drag named; the render this causes removes the listeners.
      released = true;
      // A FINISHED drag -- moved or released back on its own tab -- is not a
      // click (review DRAG-DISARM-MAKES-THE-DROP-A-CLICK): the click the
      // browser dispatches after this release must be ignored, and with the
      // drag disarmed below only this ref can still tell (`dropJustEndedRef`).
      if (dragState.dragging) {
        forgetDropEnded();
        dropJustEndedRef.current = true;
        dropEndedTimerRef.current = setTimeout(() => {
          dropEndedTimerRef.current = null;
          dropJustEndedRef.current = false;
        }, 0);
      }
      setDragState(null);
      if (!dragState.dragging || dragState.sourceIndex === dragState.currentIndex) return;
      // Both ends BY IDENTITY, as the drag named them: a discard landing
      // during the drag renumbers the sheets, and a move by the captured
      // indices moved another sheet (review TSHELL3-CONVERSE-OTHER-DOORS).
      const source = doorTargetFor(sheets, { index: dragState.sourceIndex, sheetId: dragState.sourceSheetId });
      const drop: DoorTarget = {
        ...doorTargetFor(sheets, { index: dragState.currentIndex, sheetId: dragState.currentSheetId }),
        role: "drop",
      };
      try {
        await runSheetDoor([source, drop], "moved", async ([sheet, place]) => {
          if (sheet.index === place.index) return;
          const result = await moveSheet(sheet.index, place.index);
          // Told to Core's view cache once the move LANDED.
          announceReorder({ fromIndex: sheet.index, toIndex: place.index });
          // The CURRENT applySheetsResult, as every other door applies (review
          // TSHELL4-DRAG-STALE-APPLYSHEETSRESULT): the one this listener closed
          // over compares against the active index from BEFORE the door's
          // settle, and a discard landing in that settle renumbers the active
          // sheet -- the stale comparison then replayed a full switch onto the
          // sheet the user was already on, restoring its old selection and scroll.
          await applySheetsResultRef.current(result, { backendHandledSwitch: true });
        });
      } catch (err) {
        console.error("[SheetTabs] drag moveSheet error:", err);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sheets, resolveDropIndex, runSheetDoor, forgetDropEnded]);

  // ---------------------------------------------------------------------------
  // Tab scroll navigation
  // ---------------------------------------------------------------------------

  /** Count how many tabs are hidden on left and right of the visible scroll area */
  const updateHiddenCounts = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    if (tabs.length === 0) {
      setHiddenLeft(0);
      setHiddenRight(0);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const tab of tabs) {
      const tabRect = tab.getBoundingClientRect();
      // Tab is hidden on the left if its right edge is at or before the container's left
      if (tabRect.right <= containerRect.left + 1) {
        left++;
      }
      // Tab is hidden on the right if its left edge is at or past the container's right
      else if (tabRect.left >= containerRect.right - 1) {
        right++;
      }
    }
    setHiddenLeft(left);
    setHiddenRight(right);
  }, []);

  // Update hidden counts on scroll, resize, and sheet list changes
  useEffect(() => {
    const container = tabsAreaRef.current;
    if (!container) return;

    const handleScroll = () => updateHiddenCounts();
    container.addEventListener('scroll', handleScroll);

    const resizeObserver = new ResizeObserver(() => updateHiddenCounts());
    resizeObserver.observe(container);

    // Initial calculation
    updateHiddenCounts();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
    // `decorationTick`: marks WIDEN tabs, so the overflow counters must be
    // recomputed when one appears. Without it the "(3)" chips go stale the
    // moment an extension activates and stay stale until the next resize.
  }, [updateHiddenCounts, sheets, decorationTick]);

  // Auto-scroll active tab into view when it changes
  useEffect(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const activeTab = container.querySelector(`button[data-sheet-tab="${activeIndex}"]`) as HTMLElement | null;
    if (activeTab) {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeIndex]);

  /** Scroll to show the first tab */
  const scrollToFirst = useCallback(() => {
    const container = tabsAreaRef.current;
    if (container) container.scrollLeft = 0;
  }, []);

  /** Scroll to show the last tab */
  const scrollToLast = useCallback(() => {
    const container = tabsAreaRef.current;
    if (container) container.scrollLeft = container.scrollWidth;
  }, []);

  /** Scroll left by one tab — aligns the hidden tab's left edge with the container's left */
  const scrollPrev = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    // Find the last tab whose left edge is before the container's visible left
    for (let i = tabs.length - 1; i >= 0; i--) {
      const tabLeft = tabs[i].offsetLeft;
      if (tabLeft < container.scrollLeft) {
        container.scrollLeft = tabLeft;
        return;
      }
    }
    container.scrollLeft = 0;
  }, []);

  /** Scroll right by one tab — aligns the hidden tab's right edge with the container's right */
  const scrollNext = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    const visibleRight = container.scrollLeft + container.clientWidth;
    // Find the first tab whose right edge extends past the visible area
    for (const tab of tabs) {
      const tabRight = tab.offsetLeft + tab.offsetWidth;
      if (tabRight > visibleRight + 1) {
        container.scrollLeft = tabRight - container.clientWidth;
        return;
      }
    }
    container.scrollLeft = container.scrollWidth;
  }, []);

  // The sheet the formula being written BELONGS to, found in the strip's OWN
  // list by IDENTITY (review F3-strip-uses-owner-host-index): the grid
  // editor's source sheet (`findEditSheet`: its stable id, else its name), or a
  // live external session's host (`isExternalSessionHostSheet`, a floating
  // grid's sheet). Never an index taken when the edit opened: a renumbering
  // while the grid shows another sheet (point mode, a parked session) leaves
  // that index naming whichever sheet slid into it, and the marker sat on the
  // wrong tab. Undefined when the list has no such sheet (it is gone). Read at
  // render: a renumbering re-reads the list, and `pointKey` re-renders the
  // strip when the session's host changes.
  const sourceSheet: SheetInfo | undefined =
    editing !== null
      ? findEditSheet(editing, sheets) ?? undefined
      : externalLive
        ? sheets.find((s) => isExternalSessionHostSheet(s))
        : undefined;
  const sourceIndex: number | undefined = sourceSheet?.index;

  // Determine if we're viewing a different sheet than the formula source
  const isViewingDifferentSheet = isInFormulaMode &&
    sourceIndex !== undefined &&
    sourceIndex !== activeIndex;

  // Visible tabs in render order; shared by the tab map and drag indicator.
  const visibleSheets = sheets.filter(s => s.visibility === "visible");

  // BUG-0052: the index the strip PAINTS as active. The grid sheet context,
  // not the local mirror: every switch — tab click, add/delete, and the
  // backend-initiated follow undo/redo uses — dispatches the context in the
  // same synchronous batch as the canvas's prefetched cell commit, so painting
  // from it puts the bold tab and the new sheet's cells in ONE flush. The
  // local `activeIndex` only catches up via the sync effect above, which runs
  // AFTER the browser has painted — rendering from it gave undo's switch a
  // two-frame window with the new sheet's cells under the old sheet's bold
  // tab. `followBackendSheetActivation` has always said "the tab strip has no
  // state of its own to update: it syncs its highlight from this"; this makes
  // that sentence true of the pixels, not only of the state. The local
  // `activeIndex` remains for behaviour (click guards, drag, scroll-into-view).
  const paintedActiveIndex = isLoading ? activeIndex : sheetContext.activeSheetIndex;

  // True when a tab renders "selected" (raised on the grid background) —
  // used to hide the Excel-style separators next to selected tabs.
  const isTabSelected = (s?: SheetInfo): boolean =>
    !!s && (
      s.index === paintedActiveIndex ||
      groupedSheets.has(s.index) ||
      (isInFormulaMode && sourceIndex === s.index)
    );

  return (
    <S.Container>
      {/* Navigation arrows */}
      <S.NavArea>
        <S.NavButton title="First sheet" disabled={hiddenLeft === 0} onClick={scrollToFirst}>
          |&lt;
        </S.NavButton>
        <S.NavButton title="Previous sheet" disabled={hiddenLeft === 0} onClick={scrollPrev}>
          &lt;
        </S.NavButton>
        <S.NavButton title="Next sheet" disabled={hiddenRight === 0} onClick={scrollNext}>
          &gt;
        </S.NavButton>
        <S.NavButton title="Last sheet" disabled={hiddenRight === 0} onClick={scrollToLast}>
          &gt;|
        </S.NavButton>
      </S.NavArea>

      {/* Hidden tabs indicator (left) */}
      {hiddenLeft > 0 && <S.HiddenCount>({hiddenLeft})</S.HiddenCount>}

      {/* Sheet tabs */}
      <S.TabsArea ref={tabsAreaRef}>
        {isLoading ? (
          <S.LoadingText>Loading...</S.LoadingText>
        ) : (
          visibleSheets.map((sheet, visIdx) => {
            const isSourceSheet = isInFormulaMode &&
              sourceIndex === sheet.index;
            const isTargetSheet = isInFormulaMode &&
              sheet.index === paintedActiveIndex &&
              !isSourceSheet;

            // Excel-style separators: only between two unselected neighbors.
            const withSeparator =
              visIdx > 0 &&
              !isTabSelected(sheet) &&
              !isTabSelected(visibleSheets[visIdx - 1]);

            // Extension-contributed marks — "this sheet came from an
            // application", and whatever else asks later. Keyed on `sheetId`,
            // never on the index or the name, both of which move.
            const decorations = getSheetTabDecorations({
              index: sheet.index,
              name: sheet.name,
              sheetId: sheet.sheetId,
            });

            return (
              <S.Tab
                key={sheet.index}
                type="button"
                tabIndex={-1}
                data-sheet-tab={sheet.index}
                $isActive={sheet.index === paintedActiveIndex}
                $isGrouped={groupedSheets.has(sheet.index)}
                $isFormulaSource={isSourceSheet}
                $isFormulaTarget={isTargetSheet}
                $tabColor={sheet.tabColor || ""}
                $withSeparator={withSeparator}
                $isEphemeral={sheet.ephemeral === true}
                onMouseDown={(e) => {
                  handleTabMouseDown(e, sheet.index);
                  handleDragStart(e, sheet.index);
                }}
                onClick={(e) => handleSheetClick(sheet.index, e)}
                onContextMenu={(e) => handleContextMenu(e, sheet.index)}
                onDoubleClick={() => void handleDoubleClick(sheet.index)}
                style={dragState?.dragging && dragState.sourceIndex === sheet.index
                  ? { opacity: 0.5 }
                  : undefined
                }
                title={
                  [
                    isInFormulaMode
                      ? isSourceSheet
                        ? `Formula source: ${sheet.name}`
                        : `Click to select cells from ${sheet.name}`
                      : `${sheet.name} (right-click for options)`,
                    // A temporary sheet says what it is and how to keep it.
                    ...(sheet.ephemeral === true ? [EPHEMERAL_TAB_TOOLTIP] : []),
                    // EVERY mark's reason, including any past the glyph cap —
                    // the cap limits pixels, never disclosure.
                    ...decorations.map((d) => d.tooltip).filter(Boolean),
                  ].join("\n\n")
                }
              >
                {/*
                  Marks LEAD, the `[*]` formula-source marker TRAILS. Two glyph
                  runs at the same edge read as one string ("Sales ↓ [*]"); this
                  way "what this sheet permanently IS" and "what it is doing
                  right now" sit on opposite sides of the name. Leading also
                  lines the glyphs up in a column down the strip, which is what
                  makes it scannable.
                */}
                {decorations.slice(0, MAX_SHEET_TAB_DECORATION_GLYPHS).map((d) => (
                  <S.TabDecoration
                    key={d.id}
                    data-sheet-tab-decoration={d.id}
                    $color={d.color}
                    $background={d.background}
                    role="img"
                    aria-label={d.tooltip}
                  >
                    {d.glyph}
                  </S.TabDecoration>
                ))}
                {sheet.name}
                {isSourceSheet && <S.SourceIndicator> [*]</S.SourceIndicator>}
              </S.Tab>
            );
          })
        )}
        {error && (
          <S.ErrorText title={error}>
            [API Error]
          </S.ErrorText>
        )}
      </S.TabsArea>

      {/* Hidden tabs indicator (right) */}
      {hiddenRight > 0 && <S.HiddenCount>({hiddenRight})</S.HiddenCount>}

      {/* Add sheet: a SPLIT control. The "+" keeps its one-click worksheet add
          (and its title, which journeys select by); the caret opens the kind
          menu. Outside TabsArea to avoid overflow clipping. */}
      {!isLoading && (
        <S.AddButton
          type="button"
          tabIndex={-1}
          $disabled={structuralLocked}
          onClick={() => void handleAddSheet()}
          title={structuralLocked ? "Finish formula editing first" : "Add new sheet"}
          disabled={structuralLocked}
        >
          +
        </S.AddButton>
      )}
      {!isLoading && (
        <S.AddCaretButton
          type="button"
          tabIndex={-1}
          $disabled={structuralLocked}
          disabled={structuralLocked}
          aria-haspopup="menu"
          aria-expanded={addMenu !== null}
          data-add-sheet-menu-trigger
          title={structuralLocked ? "Finish formula editing first" : "Add a worksheet or a canvas"}
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setAddMenu((open) => (open ? null : { x: rect.left, y: rect.top - 2 }));
          }}
        >
          &#9662;
        </S.AddCaretButton>
      )}
      {addMenu && (
        <S.ContextMenu ref={addMenuRef} role="menu" $x={addMenu.x} $y={addMenu.y}>
          <S.ContextMenuItem
            type="button"
            role="menuitem"
            data-add-sheet-kind="worksheet"
            onClick={() => void handleAddSheet("worksheet")}
          >
            Worksheet
          </S.ContextMenuItem>
          <S.ContextMenuItem
            type="button"
            role="menuitem"
            data-add-sheet-kind="canvas"
            onClick={() => void handleAddSheet("canvas")}
          >
            Canvas
          </S.ContextMenuItem>
        </S.ContextMenu>
      )}

      {/* Formula mode indicator */}
      {isViewingDifferentSheet && (
        <S.FormulaModeIndicator>
          Selecting from: {sheetAt(sheets, activeIndex)?.name} 
          {" --> "}
          {sourceSheet?.name ?? editing?.sourceSheetName}
        </S.FormulaModeIndicator>
      )}

      {/* Sheet grouping indicator */}
      {groupedSheets.size > 1 && !isViewingDifferentSheet && (
        <S.FormulaModeIndicator>
          [Group]
        </S.FormulaModeIndicator>
      )}

      {/* Drag indicator */}
      {dragState?.dragging && (() => {
        const tabs = getVisibleTabs();
        const dropVisibleIdx = visibleSheets.findIndex(s => s.index === dragState.currentIndex);
        const sourceVisibleIdx = visibleSheets.findIndex(s => s.index === dragState.sourceIndex);
        if (dropVisibleIdx < 0 || sourceVisibleIdx < 0 || dropVisibleIdx === sourceVisibleIdx) return null;
        const tabEl = tabs[dropVisibleIdx];
        if (!tabEl) return null;
        const tabRect = tabEl.getBoundingClientRect();
        // Place indicator at the edge between tabs:
        // Dropping right of source -> right edge of drop target
        // Dropping left of source -> left edge of drop target
        const left = dropVisibleIdx > sourceVisibleIdx
          ? tabRect.right
          : tabRect.left;
        return <S.DragIndicator style={{ left: left - 1, top: tabRect.top, height: tabRect.height }} />;
      })()}

      {/* Context Menu */}
      {contextMenu && (
        <S.ContextMenu
          ref={contextMenuRef}
          $x={contextMenu.x}
          $y={contextMenu.y}
        >
          {getContextMenuItems(findSameSheet(sheets, contextMenu.sheet) ?? contextMenu.sheet).map((item, _idx) => (
            <React.Fragment key={item.id}>
              <S.ContextMenuItem
                type="button"
                $disabled={!!item.disabled}
                onClick={() => handleContextMenuItemClick(item)}
                disabled={!!item.disabled}
              >
                {item.icon && <S.ContextMenuIcon>{item.icon}</S.ContextMenuIcon>}
                {item.label}
              </S.ContextMenuItem>
              {item.separatorAfter && <S.ContextMenuSeparator />}
            </React.Fragment>
          ))}
        </S.ContextMenu>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <S.DialogOverlay onClick={() => setDeleteConfirm(null)}>
          <S.DialogBox onClick={(e) => e.stopPropagation()}>
            <S.DialogTitle>Delete Sheet</S.DialogTitle>
            <div style={{ fontSize: 12, marginBottom: 16, color: 'var(--text-primary)' }}>
              Are you sure you want to delete &quot;{deleteConfirm.name}&quot;?
            </div>
            <S.DialogButtons>
              <S.DialogButton onClick={() => setDeleteConfirm(null)}>
                Cancel
              </S.DialogButton>
              <S.DialogButtonPrimary onClick={() => {
                const target = deleteConfirm;
                setDeleteConfirm(null);
                void confirmDeleteSheet(target);
              }}>
                Delete
              </S.DialogButtonPrimary>
            </S.DialogButtons>
          </S.DialogBox>
        </S.DialogOverlay>
      )}

      {/* Unhide Dialog */}
      {unhideDialog && (
        <S.DialogOverlay onClick={() => setUnhideDialog(null)}>
          <S.DialogBox onClick={(e) => e.stopPropagation()}>
            <S.DialogTitle>Unhide Sheet</S.DialogTitle>
            <S.DialogList>
              {unhideDialog.hiddenSheets.map((sheet) => (
                <S.DialogListItem
                  key={sheet.index}
                  $selected={unhideDialog.selectedIndex === sheet.index}
                  onClick={() => setUnhideDialog(prev =>
                    prev ? { ...prev, selectedIndex: sheet.index } : null
                  )}
                  onDoubleClick={() => {
                    void handleUnhideConfirm(sheet.index);
                  }}
                >
                  {sheet.name}
                </S.DialogListItem>
              ))}
            </S.DialogList>
            <S.DialogButtons>
              <S.DialogButton onClick={() => setUnhideDialog(null)}>
                Cancel
              </S.DialogButton>
              <S.DialogButtonPrimary
                onClick={() => void handleUnhideConfirm()}
                disabled={unhideDialog.selectedIndex === null}
              >
                OK
              </S.DialogButtonPrimary>
            </S.DialogButtons>
          </S.DialogBox>
        </S.DialogOverlay>
      )}
    </S.Container>
  );
}