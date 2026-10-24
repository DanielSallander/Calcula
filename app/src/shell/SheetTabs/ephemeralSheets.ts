//! FILENAME: app/src/shell/SheetTabs/ephemeralSheets.ts
// PURPOSE: What the tab strip does about a TEMPORARY (drill-through) sheet,
//          decided in pure functions: what a tab's double-click means, which
//          sheet -- if any -- a fresh read of the sheet list says the user has
//          just LEFT, when the leave observer must record nothing, and what
//          the strip SAYS after a keep or a refused discard.
// CONTEXT: A drill-through lands its result on a new sheet the backend flags
//          `ephemeral` in a session-only set keyed by the stable sheet id
//          (docs/design/model-drillthrough.md 2.6). The strip discards that
//          sheet when the user leaves it and keeps it on a double-click of its
//          tab (2.7). The observer that decides "left" runs ONLY inside the
//          strip's `loadSheets()` (the backend-derived read), compares the
//          PREVIOUSLY active sheet's id with the fresh read, and consults the
//          fresh read's own flag -- so a sheet kept in the meantime, a sheet
//          already gone, and a document replaced under the strip (File > New /
//          Open mints fresh ids) all resolve to "nothing to discard".
//
//          The observer itself is `createEphemeralLeaveObserver`: framework-
//          free, so its whole behaviour -- the pause while a cell edit is open,
//          the strip's own two-step flows, the memory overwritten before the
//          discard, the in-flight guard -- is driven in a unit test against a
//          model of the backend, without mounting the strip. Everything it
//          discards it names by STABLE id; the backend resolves the id to the
//          sheet's index at the moment of deletion (`discard_ephemeral_sheet`),
//          so a renumbering in between can never delete another sheet.
//
//          Extracted like resolveTabClick.ts, so every rule is unit-tested
//          (__tests__/ephemeralSheets.test.ts).

import type { SheetInfo, SheetsResult } from "../../core/lib/tauri-api";

/** The tab's tooltip for a temporary sheet (model-drillthrough.md 2.7, "Look"). */
export const EPHEMERAL_TAB_TOOLTIP =
  "Temporary sheet: it closes when you leave it. Double-click the tab to keep it.";

export type TabDoubleClickAction = "keep" | "rename";

/**
 * A double-click on an ephemeral tab KEEPS the sheet (`keepEphemeralSheet`);
 * on any other tab it opens the rename prompt, as it always has. Rename stays
 * reachable for a temporary sheet through its tab menu.
 */
export function resolveTabDoubleClick(
  sheet: Pick<SheetInfo, "ephemeral"> | undefined,
): TabDoubleClickAction {
  return sheet?.ephemeral === true ? "keep" : "rename";
}

/** The active sheet as the strip last saw it: its stable id and its flag. */
export interface PrevActiveSheet {
  sheetId: string;
  ephemeral: boolean;
}

/**
 * The identity the observer remembers from a backend read: the active sheet's
 * id and flag, or null when the active sheet carries no id (an older backend,
 * or a list with no such row). The strip's ERROR fallback list has no ids and
 * must never be passed here -- the caller does not adopt it (rule 4).
 */
export function prevActiveOf(result: SheetsResult): PrevActiveSheet | null {
  const active = result.sheets.find((s) => s.index === result.activeIndex);
  if (!active || typeof active.sheetId !== "string" || active.sheetId === "") return null;
  return { sheetId: active.sheetId, ephemeral: active.ephemeral === true };
}

/**
 * The id of the sheet to DISCARD after a fresh read of the list, or null.
 *
 * Rules:
 *  1. nothing was remembered (first read, or the previous read had no id):
 *     null -- reaching a sheet is never leaving one;
 *  2. the remembered sheet was not ephemeral: null;
 *  3. it is still the active sheet (same id -- a delete of ANOTHER sheet lands
 *     on the same id; a reload of the same list): null;
 *  4. it is no longer listed (already discarded; File > New / Open replaced
 *     every id): null -- there is nothing to delete;
 *  5. the fresh read no longer flags it ephemeral (kept from its tab menu or
 *     by a refused discard in the meantime): null -- the backend's flag is
 *     the authority, never the strip's memory;
 *  6. otherwise its id: the user left a temporary sheet that still exists.
 */
export function resolveEphemeralLeave(
  prev: PrevActiveSheet | null,
  next: SheetsResult,
): string | null {
  if (prev === null || !prev.ephemeral) return null;
  const active = next.sheets.find((s) => s.index === next.activeIndex);
  if (active?.sheetId === prev.sheetId) return null;
  const left = next.sheets.find((s) => s.sheetId === prev.sheetId);
  if (!left || left.ephemeral !== true) return null;
  return prev.sheetId;
}

// ============================================================================
// When the observer records nothing (rule 3)
// ============================================================================

/**
 * Core's SYNCHRONOUS edit flags, read at the moment of asking -- never from a
 * render. An edit that is still OPENING has neither a React `editing` state
 * nor an external session yet: a typed open engages the latch on its first
 * keystroke, awaits the edit guards (one backend round trip), raises the edit
 * flag, awaits the merge lookup (another), and only then dispatches its
 * editing state.
 */
export interface SyncEditFlags {
  /** Core's edit flag is up (`getGlobalIsEditing`): from the moment an open cleared its guards. */
  coreEditOpen: boolean;
  /** A typed open is in flight (`isEditorOpening`): the latch its first keystroke engaged. */
  editorOpening: boolean;
}

/**
 * Whether the leave observer must record NOTHING for a read that arrives now:
 * while ANY cell edit is open -- the grid's own editor (the React `editing`
 * state is not null) or an external session (a floating grid's cell edit) is
 * live -- whatever the formula being written looks like; and while one is
 * still OPENING (Core's synchronous flags, `flags`). A read judged in the
 * opening window -- the user left a temporary sheet and began typing into a
 * cell at once -- discarded that sheet while the edit was opening, and the
 * discard landed under the edit, renumbering the sheet it was being typed on
 * (review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT; Core's own fix rebases the
 * edit, this only narrows the window).
 *
 * NOT "the formula expects a reference" (the structural lock's question). A
 * point-mode trip moves the BACKEND's active sheet without a SHEET_CHANGED, and
 * the moment the user clicks a cell over there the formula (`=Sales!B2`) stops
 * expecting a reference while the backend is still on the other sheet: a read
 * judged then deleted the temporary sheet the formula was being written on,
 * with the editor still open (review finding point-mode-discards-edited-sheet).
 * A trip that ends through commit or cancel switches back to the source sheet
 * BEFORE the edit is closed, so a read judged only once the edit is closed sees
 * the user where they really are.
 *
 * `coreEdit` is the strip's `editing` (read through a ref the render keeps
 * current), `externalSession` the live external session -- each null when
 * there is none -- and `flags` Core's synchronous edit flags as they stand
 * now. Required, so no caller can leave the opening window out.
 */
export function leaveObserverPaused(
  coreEdit: unknown,
  externalSession: unknown,
  flags: SyncEditFlags,
): boolean {
  const coreEditOpen = coreEdit !== null && coreEdit !== undefined;
  const externalLive = externalSession !== null && externalSession !== undefined;
  return coreEditOpen || externalLive || flags.coreEditOpen || flags.editorOpening;
}

// ============================================================================
// The leave observer
// ============================================================================

/** What a read carries from the moment it was SENT (`readSent`). */
export interface LeaveReadTicket {
  /** The strip-flow epoch when the read was sent. */
  readonly flowEpoch: number;
  /** A strip flow was in flight when the read was sent. */
  readonly flowInFlight: boolean;
}

/** The strip's side of the observer: when to pause, and how to discard. */
export interface EphemeralLeaveObserverDeps {
  /** True while the observer must record nothing (`leaveObserverPaused`, asked at event time). */
  paused(): boolean;
  /** True while a discard of this sheet is already in flight. */
  discardInFlight(sheetId: string): boolean;
  /** Discard the temporary sheet with this STABLE id. Not awaited by the observer. */
  discard(sheetId: string): void;
}

export interface EphemeralLeaveObserver {
  /** Call as a backend read of the sheet list is SENT; hand the ticket to `observe`. */
  readSent(): LeaveReadTicket;
  /** A backend-derived read arrived (the ONE observer site, rule 1). */
  observe(result: SheetsResult, ticket: LeaveReadTicket): void;
  /** The edit pause just ended: true when a read was skipped during it, so ONE re-read is owed. */
  pauseEnded(): boolean;
  /**
   * One of the strip's own DOORS is starting (SheetTabs.tsx `runSheetDoor`):
   * from the fresh read that finds the sheet a gesture named to the step that
   * acts on it -- both steps, for Insert Sheet (add + move) and Move or Copy
   * with a copy (copy + move). Called a "flow" here.
   */
  flowStarted(): void;
  /** That flow settled: true when no flow is left in flight, so ONE re-read is owed. */
  flowSettled(): boolean;
  /** How many of the strip's own flows are in flight right now. */
  flowsInFlight(): number;
  /**
   * Resolves once NO strip flow is in flight -- at once when none is. A discard
   * that is not the observer's own (the drill runner's, through
   * core.sheet.discardEphemeral) waits on it, so it never lands between a
   * flow's two steps. Re-check `flowsInFlight()` after it resolves: another
   * flow may have started in the same turn.
   */
  whenFlowsIdle(): Promise<void>;
  /** A keep of this sheet landed: the memory follows, before any later read. */
  kept(sheetId: string): void;
  /**
   * A discard of this temporary sheet was asked for and NOT sent: a cell edit
   * was open or opening when it would have gone (SheetTabs.tsx
   * `discardSheetById`), and a discard landing under an edit renumbers the
   * sheet being edited. The leave is OWED: the next read the observer judges
   * discards the sheet when it is still listed, still temporary and not the
   * active sheet -- the user's own sheet is never discarded -- and a re-read is
   * owed for the moment the pause ends (`pauseEnded`), so the verdict comes
   * from a fresh list once the edit is closed.
   */
  leaveDeferred(sheetId: string): void;
  /** The temporary sheets whose leave is owed (for tests and diagnostics). */
  owedLeaves(): string[];
  /** The memory (for tests and diagnostics). */
  remembered(): PrevActiveSheet | null;
}

/**
 * THE leave observer for temporary sheets (model-drillthrough.md 2.7, rules
 * 1-6), framework-free.
 *
 *  - It records NOTHING for a read that arrives while `paused()` (a cell edit
 *    is open, `leaveObserverPaused`): no verdict, no memory. Nothing is queued
 *    either -- `pauseEnded()` says whether a read was skipped, and the strip
 *    then re-reads ONCE, so the verdict comes from a fresh list.
 *  - It records nothing for a read SENT or ANSWERED while one of the strip's
 *    own flows is in flight -- a door between its fresh read and its step,
 *    which spans both steps of Insert Sheet (add then move) and of Move or
 *    Copy with a copy (copy then move) -- nor for one that straddles such a
 *    flow: a list read inside it is not the list the user ends up with, and a
 *    discard issued inside it renumbers the sheets under the step's indices.
 *    `flowSettled()` asks for the one re-read instead.
 *  - The memory is overwritten SYNCHRONOUSLY, before the discard is issued
 *    (rule 2), and a sheet whose discard is already in flight is not
 *    discarded again.
 *  - The discard names the sheet by its STABLE id; the backend resolves the id
 *    to the sheet's index at the moment of deletion.
 *  - A discard that was asked for and not sent because a cell edit was open or
 *    opening (`leaveDeferred`) is OWED: the next judged read discards that
 *    sheet too when it is still listed, still temporary and not active, and
 *    the end of the pause re-reads once so that read comes.
 */
export function createEphemeralLeaveObserver(deps: EphemeralLeaveObserverDeps): EphemeralLeaveObserver {
  let prev: PrevActiveSheet | null = null;
  let skippedWhilePaused = false;
  let flowsInFlight = 0;
  let flowEpoch = 0;
  let idleWaiters: Array<() => void> = [];
  /** Temporary sheets whose discard was asked for and not sent (`leaveDeferred`). */
  const owed = new Set<string>();

  return {
    readSent: () => ({ flowEpoch, flowInFlight: flowsInFlight > 0 }),

    observe(result, ticket) {
      if (deps.paused()) {
        skippedWhilePaused = true;
        return;
      }
      if (ticket.flowInFlight || flowsInFlight > 0 || ticket.flowEpoch !== flowEpoch) return;
      const leaving = resolveEphemeralLeave(prev, result);
      prev = prevActiveOf(result);
      // An owed leave stands only for a sheet this read still lists as temporary
      // and NOT active: the same rule as a leave, from the sheet's own id.
      const stillOwed = [...owed].filter(
        (id) => id !== leaving && resolveEphemeralLeave({ sheetId: id, ephemeral: true }, result) === id,
      );
      // Both overwritten BEFORE any discard is issued (rule 2): a discard that is
      // deferred again re-registers its own debt.
      owed.clear();
      for (const id of leaving === null ? stillOwed : [leaving, ...stillOwed]) {
        if (!deps.discardInFlight(id)) deps.discard(id);
      }
    },

    pauseEnded() {
      const owed = skippedWhilePaused;
      skippedWhilePaused = false;
      return owed;
    },

    flowStarted() {
      flowsInFlight += 1;
      flowEpoch += 1;
    },

    flowSettled() {
      flowsInFlight = Math.max(0, flowsInFlight - 1);
      flowEpoch += 1;
      if (flowsInFlight === 0 && idleWaiters.length > 0) {
        const waiting = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiting) resolve();
      }
      return flowsInFlight === 0;
    },

    flowsInFlight: () => flowsInFlight,

    whenFlowsIdle() {
      if (flowsInFlight === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    kept(sheetId) {
      if (prev?.sheetId === sheetId) prev = { sheetId, ephemeral: false };
      owed.delete(sheetId);
    },

    leaveDeferred(sheetId) {
      owed.add(sheetId);
      skippedWhilePaused = true;
    },

    owedLeaves: () => [...owed],

    remembered: () => prev,
  };
}

// ============================================================================
// What the strip says after a keep, or after a refused discard
// ============================================================================

/** Where a temporary sheet stands in a sheet list the backend answered. */
export type TemporarySheetState = "temporary" | "kept" | "gone";

/** The sheet with this id in `result`: still flagged, unflagged (kept), or not listed (gone). */
export function temporarySheetStateIn(result: SheetsResult, sheetId: string): TemporarySheetState {
  const row = result.sheets.find((s) => s.sheetId === sheetId);
  if (!row) return "gone";
  return row.ephemeral === true ? "temporary" : "kept";
}

/** One toast. */
export interface StripNotice {
  message: string;
  variant: "success" | "info" | "warning" | "error";
}

/** A backend reason as a clause inside a sentence: trimmed, without its closing full stop. */
function clause(reason: string): string {
  return reason.trim().replace(/[.\s]+$/, "");
}

/**
 * What the strip says after a Keep (the tab's double-click, Keep Sheet), from
 * where the sheet stands in the list the keep answered -- or, when the keep was
 * refused, in a fresh read ("unknown" when even that failed). "Sheet kept" ONLY
 * when that list holds the sheet unflagged: a keep that answered without
 * changing THIS sheet must never claim it did.
 */
export function keepNotice(state: TemporarySheetState | "unknown", refusal?: string): StripNotice {
  switch (state) {
    case "kept":
      return { message: "Sheet kept", variant: "success" };
    case "temporary":
      return {
        message:
          `The sheet could not be kept${refusal ? ` (${clause(refusal)})` : ""}: ` +
          "it is still temporary and will close when you leave it.",
        variant: "error",
      };
    case "gone":
      return { message: "The sheet could not be kept: it is no longer in the workbook.", variant: "error" };
    default:
      return {
        message: `The sheet could not be kept: ${refusal ? clause(refusal) : "the workbook did not answer"}.`,
        variant: "error",
      };
  }
}

/** The outcome of a REFUSED discard, once the strip tried to keep the sheet instead. */
export interface RefusedDiscardOutcome {
  /** The sheet is gone after all (not listed): the caller's goal holds. */
  gone: boolean;
  /** The one toast, or null when there is nothing to tell. */
  notice: StripNotice | null;
}

/**
 * A REFUSED discard (Protect Workbook Structure turned on while on the sheet,
 * a repairability pre-flight) is answered by KEEPING the sheet, said once in a
 * toast -- never a modal, never the same refusal at every later leave. Decided
 * by where the sheet stands afterwards:
 *  - kept (listed unflagged): "Temporary sheet kept: <reason>" -- ONLY then;
 *  - still temporary (the keep failed too): a warning that says so, and that it
 *    will close when the user leaves it;
 *  - gone (not listed): nothing to tell, and the caller's goal holds;
 *  - unknown (the keep and the re-read both failed): a warning with both reasons.
 */
export function refusedDiscardOutcome(
  reason: string,
  state: TemporarySheetState | "unknown",
  keepRefusal?: string,
): RefusedDiscardOutcome {
  switch (state) {
    case "kept":
      return { gone: false, notice: { message: `Temporary sheet kept: ${reason}`, variant: "info" } };
    case "gone":
      return { gone: true, notice: null };
    case "temporary":
      return {
        gone: false,
        notice: {
          message:
            `The temporary sheet could not be closed (${clause(reason)}) or kept: ` +
            "it is still temporary and will close when you leave it.",
          variant: "warning",
        },
      };
    default:
      return {
        gone: false,
        notice: {
          message:
            `The temporary sheet could not be closed (${clause(reason)})` +
            `${keepRefusal ? ` or kept (${clause(keepRefusal)})` : ""}.`,
          variant: "warning",
        },
      };
  }
}
