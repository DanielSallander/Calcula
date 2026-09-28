//! FILENAME: app/src/core/lib/__tests__/helpers/fakeExternalEdit.ts
// PURPOSE: A fake two-view external edit session (and its pick target and
//          selected-cell target) for the Core/shell tests of the external-edit
//          seam, so those tests stand alone without the Floating Range
//          extension.
// CONTEXT: It behaves the way the real owner (the floating grid's cell editor)
//          is contracted to in core/lib/formulaEditTarget.ts:
//            - commit() and cancel() tear the session down SYNCHRONOUSLY (the
//              slot is empty before commit's promise settles);
//            - setText() is a no-op, with NO notify, when neither the text nor
//              the caret changed;
//            - insertReference() splices "Sheet!A1" at the caret and notifies;
//            - the cell target's beginEdit() registers the session in the pick
//              slot and returns it.
//          Every call the shell or Core makes is recorded in `calls`.

import {
  notifyExternalEditChanged,
  publishExternalCellTarget,
  registerExternalFormulaTarget,
  type ExternalCellTarget,
  type ExternalEditMove,
  type ExternalEditSession,
  type ExternalEditView,
  type ExternalFormulaReference,
  type ExternalFormulaTarget,
} from "../../formulaEditTarget";
import { columnToLetter, isFormulaExpectingReference } from "../../../types";

export type FakeSessionCall =
  | "setText"
  | "setCursor"
  | "adoptBarView"
  | "focusCellView"
  | "commit"
  | "cancel";

export type FakeSession = ExternalEditSession & {
  text: string;
  cursor: number;
  view: ExternalEditView;
  parkedFlips: boolean[];
};

export interface FakeExternalEdit {
  session: FakeSession;
  /** expecting = text.startsWith("=") && isFormulaExpectingReference(text, cursor). */
  target: ExternalFormulaTarget;
  calls: Array<{ fn: FakeSessionCall; args: unknown[] }>;
  /** registerExternalFormulaTarget(target); returns the identity-checked cleanup. */
  register(): () => void;
  /** A selected-cell target whose beginEdit registers the session and returns it. */
  cell(over?: Partial<{ address: string; content: string | null; readOnly: boolean }>): ExternalCellTarget;
  /** publishExternalCellTarget("fake", cell(over)); returns the withdraw. */
  publishCell(over?: Partial<{ address: string; content: string | null; readOnly: boolean }>): () => void;
  /** Whether the session is currently registered in the pick slot. */
  isRegistered(): boolean;
}

export const FAKE_CELL_OWNER = "fake";

export function createFakeExternalEdit(opts: {
  hostSheetIndex: number;
  address?: string;
  text?: string;
  cursor?: number;
  commitResult?: boolean;
  anchor?: { row: number; col: number };
}): FakeExternalEdit {
  const calls: FakeExternalEdit["calls"] = [];
  let unregister: (() => void) | null = null;

  const record = (fn: FakeSessionCall, ...args: unknown[]): void => {
    calls.push({ fn, args });
  };

  const teardown = (): void => {
    const off = unregister;
    unregister = null;
    off?.();
  };

  const session: FakeSession = {
    text: opts.text ?? "",
    cursor: opts.cursor ?? (opts.text ?? "").length,
    view: "bar",
    parkedFlips: [],
    address: opts.address ?? "Float1!A1",
    hostSheetIndex: opts.hostSheetIndex,
    anchor: opts.anchor ?? { row: 0, col: 0 },
    getText() {
      return session.text;
    },
    getCursor() {
      return session.cursor;
    },
    getView() {
      return session.view;
    },
    setText(text: string, cursor: number) {
      record("setText", text, cursor);
      if (session.text === text && session.cursor === cursor) return;
      session.text = text;
      session.cursor = cursor;
      notifyExternalEditChanged();
    },
    setCursor(cursor: number) {
      record("setCursor", cursor);
      session.cursor = cursor;
    },
    adoptBarView() {
      record("adoptBarView");
      if (session.view === "bar") return;
      session.view = "bar";
      notifyExternalEditChanged();
    },
    focusCellView() {
      record("focusCellView");
    },
    commit(move: ExternalEditMove) {
      record("commit", move);
      teardown();
      return Promise.resolve(opts.commitResult ?? true);
    },
    cancel() {
      record("cancel");
      teardown();
    },
    onParkedChanged(parked: boolean) {
      session.parkedFlips.push(parked);
    },
  };

  const target: ExternalFormulaTarget = {
    isExpectingReference: () =>
      session.text.startsWith("=") && isFormulaExpectingReference(session.text, session.cursor),
    insertReference: (ref: ExternalFormulaReference) => {
      const a1 =
        `${columnToLetter(ref.startCol)}${ref.startRow + 1}` +
        (ref.startRow !== ref.endRow || ref.startCol !== ref.endCol
          ? `:${columnToLetter(ref.endCol)}${ref.endRow + 1}`
          : "");
      const text = ref.sheetName ? `${ref.sheetName}!${a1}` : a1;
      const c = session.cursor;
      session.text = session.text.slice(0, c) + text + session.text.slice(c);
      session.cursor = c + text.length;
      notifyExternalEditChanged();
    },
    session,
  };

  const register = (): (() => void) => {
    unregister = registerExternalFormulaTarget(target);
    return () => teardown();
  };

  const cell: FakeExternalEdit["cell"] = (over) => ({
    address: over?.address ?? session.address,
    content: over && "content" in over ? (over.content as string | null) : session.text,
    readOnly: over?.readOnly ?? false,
    beginEdit: (seed?: string) => {
      if (seed !== undefined) {
        session.text = seed;
        session.cursor = seed.length;
      }
      if (!unregister) register();
      return session;
    },
  });

  return {
    session,
    target,
    calls,
    register,
    cell,
    publishCell: (over) => {
      publishExternalCellTarget(FAKE_CELL_OWNER, cell(over));
      return () => publishExternalCellTarget(FAKE_CELL_OWNER, null);
    },
    isRegistered: () => unregister !== null,
  };
}
