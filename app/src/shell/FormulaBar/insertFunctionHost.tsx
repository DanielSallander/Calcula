//! FILENAME: app/src/shell/FormulaBar/insertFunctionHost.tsx
// PURPOSE: ONE host for the Insert Function dialog, mounted whether or not the
//          formula bar is shown, and the `core.formula.insertFunction` command
//          (Shift+F3, the Home tab's AutoSum > More Functions...) that opens it
//          the same way the bar's fx button does.
// CONTEXT: Home tab 2026-10-04. The dialog was LOCAL STATE of the FormulaBar
//          component, so only fx could open it -- and hiding the formula bar
//          (View menu) unmounts that component, taking any command registered
//          by it along. Excel's More Functions... and Shift+F3 work with the bar
//          hidden, so the host moved OUT of the bar rather than the command
//          un-hiding the bar (which would rewrite a View setting the user chose
//          as a side effect of asking for a function).
//
//          DECISION: the host is a shell component (@api/ui
//          registerShellComponent -- the frame mounts every one, always) and the
//          command is registered when this module is INSTALLED, which the
//          FormulaBar barrel does on import (Layout imports the barrel whatever
//          the bar's visibility). The fx button and the command both call
//          `openInsertFunction()`, so there is one opening rule:
//            - an edit already open (Core's, or a floating grid's in the bar):
//              the dialog works on it;
//            - a selected floating-grid cell: its OWN edit begins with "=";
//            - a live floating-grid session in its in-cell view: handed to the
//              BAR before the dialog exists (the dialog focuses its search box
//              on mount, which blurred the in-cell view, whose deferred blur
//              committed the half-typed formula -- review 2026-09-27);
//            - an OBJECT holding the selection: refused, out loud, no dialog
//              (BUG-0270 review: "=" and the function chosen would have been
//              written into the cell hidden behind the object);
//            - a canvas sheet: refused (it has no cells);
//            - otherwise: the dialog opens and Core's edit of the active cell
//              begins with "=" -- started by the HOST, which holds a
//              useEditing() instance (Core's open path, guards and flag
//              included); the command has no hook of its own.

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { InsertFunctionDialog } from "./InsertFunctionDialog";
import { useEditing } from "../../api/editing";
// The SUBPATH, as FormulaBar.tsx does: the bar's tests double `api/editing`
// with a fixed list, and the external-edit store must stay real in them.
import {
  subscribeExternalEdit,
  getExternalEditVersion,
  isExternalEditLive,
  getExternalEditSession,
  resolveFormulaBarSource,
  endExternalFormulaSession,
} from "../../api/externalEdit";
import { useGridContext } from "../../api";
import { refuseIfSelectionOwned } from "../../api/selectionOwner";
import { CommandRegistry, CoreCommands } from "../../api/commands";
import { registerShellComponent } from "../../api/ui";
import { showToast } from "../../api/notifications";
import { isCoreCellEditOpen } from "../../core/lib/cellEditFlag";
import { getGridStateSnapshot } from "../../core/state/GridContext";

// ============================================================================
// The open request (a tiny store the host subscribes to)
// ============================================================================

interface InsertFunctionRequest {
  open: boolean;
  /** Bumped on every open, so the host acts once per open. */
  seq: number;
  /** The host must begin Core's "=" edit (nothing else was open to work on). */
  beginCoreEdit: boolean;
}

let request: InsertFunctionRequest = { open: false, seq: 0, beginCoreEdit: false };
const listeners = new Set<() => void>();

function setRequest(next: InsertFunctionRequest): void {
  request = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRequest(): InsertFunctionRequest {
  return request;
}

/** Whether the dialog is open (for tests and the command's callers). */
export function isInsertFunctionOpen(): boolean {
  return request.open;
}

export function closeInsertFunction(): void {
  if (request.open) setRequest({ ...request, open: false, beginCoreEdit: false });
}

/**
 * Open Insert Function the way fx does (see the header for the rules).
 * Returns false when it refused. Synchronous up to the open, on purpose: the
 * floating-grid hand-over must happen before the dialog mounts.
 */
export function openInsertFunction(): boolean {
  const coreEditing = isCoreCellEditOpen() || getGridStateSnapshot()?.editing != null;
  let beginCoreEdit = false;
  if (!coreEditing) {
    // fx on a selected floating-grid cell starts THAT cell's edit, never a
    // Core edit of the grid cell under it; a live session is handed to the
    // BAR before the dialog exists.
    const src = resolveFormulaBarSource();
    if (src.kind === "session") src.session.adoptBarView();
    else if (src.kind === "cell") src.cell.beginEdit("=");
    else {
      if (refuseIfSelectionOwned("Insert Function")) return false;
      if (getGridStateSnapshot()?.surface === "canvas") {
        showToast("Insert Function is not available on a canvas sheet: it holds objects, not cells.", { variant: "info" });
        return false;
      }
      beginCoreEdit = true;
    }
  }
  setRequest({ open: true, seq: request.seq + 1, beginCoreEdit });
  return true;
}

// ============================================================================
// The host
// ============================================================================

export function InsertFunctionHost(): React.ReactElement | null {
  const req = useSyncExternalStore(subscribe, getRequest);
  const { state } = useGridContext();
  const { editing, commitEdit, updateValue, startEditing } = useEditing();

  // A live EXTERNAL session (a floating grid's cell edit) is the edit the
  // dialog works on when Core has none. Subscribed by VERSION and read during
  // render, like the bar (see FormulaBar.tsx for why not the boolean).
  useSyncExternalStore(subscribeExternalEdit, getExternalEditVersion);
  const extLive = isExternalEditLive();

  // Begin Core's "=" edit ONCE per open that asked for it. Not awaited: the
  // dialog is open while the edit opens, exactly as when fx did both.
  const startedForSeq = useRef(0);
  useEffect(() => {
    if (!req.open || !req.beginCoreEdit || startedForSeq.current === req.seq) return;
    startedForSeq.current = req.seq;
    void startEditing("=");
  }, [req, startEditing]);

  const handleFunctionSelect = useCallback(
    (functionName: string, template: string) => {
      const session = editing ? null : getExternalEditSession();
      if (session) {
        const current = session.getText();
        const next = current === "=" || current === "" ? template : current + functionName + "(";
        session.setText(next, next.length);
      } else if (editing) {
        const currentValue = editing.value;
        if (currentValue === "=" || currentValue === "") {
          updateValue(template);
        } else {
          updateValue(currentValue + functionName + "(");
        }
      }
      closeInsertFunction();
    },
    [editing, updateValue],
  );

  /**
   * A function-argument builder produced a COMPLETE formula, so unlike a
   * template there is nothing left for the user to fill in and the cell is
   * committed for them -- Excel's Function Arguments OK button.
   *
   * WHY THIS COMMITS ON A LATER RENDER INSTEAD OF RIGHT HERE.
   * `commitEdit` commits `editing.value` out of its own closure -- it is a
   * useCallback with `editing` in its deps -- and `editing` is React state, so
   * `updateValue(formula); commitEdit();` in one handler writes the formula
   * into the editor and then commits a value from an EARLIER render: "=", the
   * seed the open started the session with, or nothing at all when the
   * handler's own closure is older still. Measured, not assumed: sabotaging
   * this into the same-tick form commits "<not editing>". So the formula is
   * parked, and the effect below commits once the dispatch has landed.
   *
   * It must also go through `commitEdit` rather than straight to `updateCell`,
   * which is what the old standalone builder dialog did: only the commit path
   * runs the commit guards, the R1C1 rewrite and the grouped-sheet replication,
   * and a cell written around them is a cell that skipped its own validation.
   */
  const pendingCommitRef = useRef<string | null>(null);

  const handleFunctionBuilt = useCallback(
    (formula: string) => {
      closeInsertFunction();
      // An external session's text is SYNCHRONOUS (it is not React state), so
      // the parked-commit dance is not needed: set, then commit through the
      // owner's own path.
      const session = editing ? null : getExternalEditSession();
      if (session) {
        session.setText(formula, formula.length);
        void endExternalFormulaSession("commit", null);
        return;
      }
      pendingCommitRef.current = formula;
      updateValue(formula);
    },
    [editing, updateValue],
  );

  useEffect(() => {
    if (pendingCommitRef.current === null) return;
    // The edit session went away underneath us (Esc, a click elsewhere):
    // abandon the commit rather than resurrecting it into whatever is
    // selected now.
    if (!editing) {
      pendingCommitRef.current = null;
      return;
    }
    if (editing.value !== pendingCommitRef.current) return;
    pendingCommitRef.current = null;
    void commitEdit();
  }, [editing, commitEdit]);

  if (!req.open) return null;

  // Where a built formula will land. `editing` is authoritative once the
  // open's startEditing has resolved; the selection anchor covers the window
  // before that, so the builder is never handed (0,0) by accident.
  //
  // An external session's anchor is in its OWNER's coordinates (FR-local): a
  // builder that reads the host sheet at those coordinates reads the wrong
  // cells (a stated v1 gap), but it is still the cell the formula lands in.
  const externalAnchor = editing ? null : extLive ? getExternalEditSession()?.anchor ?? null : null;
  const anchor = editing
    ? { row: editing.row, col: editing.col }
    : externalAnchor
      ? { row: externalAnchor.row, col: externalAnchor.col }
      : { row: state.selection?.startRow ?? 0, col: state.selection?.startCol ?? 0 };

  return (
    <InsertFunctionDialog
      onSelect={handleFunctionSelect}
      onBuilt={handleFunctionBuilt}
      anchor={anchor}
      onClose={closeInsertFunction}
    />
  );
}

// ============================================================================
// Installation
// ============================================================================

const HOST_ID = "core.insertFunctionHost";
let installed = false;

/**
 * Mount the host in the shell frame and register the command. Idempotent.
 * Called by the FormulaBar barrel (index.ts) when the shell imports it.
 */
export function installInsertFunction(): void {
  if (installed) return;
  installed = true;
  registerShellComponent({ id: HOST_ID, component: InsertFunctionHost });
  CommandRegistry.register(CoreCommands.INSERT_FUNCTION, () => {
    openInsertFunction();
  });
}

/** Test hook: forget the open request (the store outlives a test's render). */
export function resetInsertFunctionForTests(): void {
  request = { open: false, seq: 0, beginCoreEdit: false };
}
