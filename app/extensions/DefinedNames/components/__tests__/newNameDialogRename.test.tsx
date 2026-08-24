//! FILENAME: app/extensions/DefinedNames/components/__tests__/newNameDialogRename.test.tsx
// PURPOSE: A defined name can be renamed, the rename is addressed to the backend
//          in the one order that works, and NOTHING asks the user to accept a
//          consequence the product no longer has.
// CONTEXT: The Name input carried `disabled={mode === "edit"}`, so an existing
//          name could never be renamed from the app at all — Excel allows it.
//          Enabling the field is only half the fix: `update_named_range` looks
//          its target up by the UPPERCASED name and refuses an unknown key, so
//          submitting a new name without moving the key first fails with
//          "does not exist" — the edit would silently do nothing.
//
//          THE WARNING THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE
//          PROPERTY. The first version of the rename shipped behind an awaited
//          confirmation saying two things: that formulas using the old name
//          would break (Calcula stores the NAME inside the formula and resolves
//          it at calculation time, D2), and that Ctrl+Z would not bring the old
//          name back. Both were true of that command. Neither is true now:
//          `rename_named_range` repoints every formula that reads the name —
//          across sheets, and inside other names' definitions — and records the
//          registry move and the rewritten formulas as ONE undo step. A dialog
//          that states consequences the product does not have is worse than no
//          dialog, because it teaches the user to click through warnings. So
//          `confirmAsync` is still mocked here for exactly one reason: to assert
//          it is never called.
//
//          Mocked: @api (the facade calls) and @api/dialogs (doubled with the
//          TAURI shape: confirmAsync resolves a PROMISE, never a bare boolean).
//          Everything else — useDialogWindow, nameUtils, the real markup — runs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks (hoisted — keep every reference to a test local inside a closure)
// ---------------------------------------------------------------------------

const createNamedRangeMock = vi.fn();
const updateNamedRangeMock = vi.fn();
const renameNamedRangeMock = vi.fn();
const emitAppEventMock = vi.fn();
const confirmAsyncMock = vi.fn();

/** Every backend call in the order it was made — a rename that runs AFTER the
 *  update would fail against the old key, so order is the property. */
const callLog: string[] = [];

const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 0 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

vi.mock("@api", () => ({
  createNamedRange: (...args: unknown[]) => {
    callLog.push("create");
    return createNamedRangeMock(...args);
  },
  updateNamedRange: (...args: unknown[]) => {
    callLog.push("update");
    return updateNamedRangeMock(...args);
  },
  renameNamedRange: (...args: unknown[]) => {
    callLog.push("rename");
    return renameNamedRangeMock(...args);
  },
  getSheets: () => Promise.resolve({ sheets: [{ name: "Sheet1" }], activeIndex: 0 }),
  useGridState: () => gridState,
  // The key names ARE the @api export names; the naming rule cannot know that.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AppEvents: { NAMED_RANGES_CHANGED: "app:named-ranges-changed" },
  emitAppEvent: (...args: unknown[]) => emitAppEventMock(...args),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  letterToColumn: (letters: string) => letters.charCodeAt(0) - 65,
  isFormulaAutocompleteVisible: () => false,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AutocompleteEvents: {
    INPUT: "autocomplete:input",
    ACCEPTED: "autocomplete:accepted",
    DISMISS: "autocomplete:dismiss",
    KEY: "autocomplete:key",
  },
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...args: unknown[]) => confirmAsyncMock(...args),
}));

import { NewNameDialog } from "../NewNameDialog";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const EDIT_DATA = {
  mode: "edit",
  editName: "Total",
  editRefersTo: "=Sheet1!$A$1:$A$5",
  editSheetIndex: null,
  editComment: "",
  editFolder: "",
};

async function renderEdit(): Promise<void> {
  await act(async () => {
    root.render(<NewNameDialog isOpen onClose={onClose} data={EDIT_DATA} />);
  });
}

function textInputs(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>("input[type='text']"));
}

/** The dialog renders Name, Folder, then Refers to. */
function nameInput(): HTMLInputElement {
  return textInputs()[0];
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickOk(): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "OK",
  );
  if (!button) throw new Error("no OK button");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // handleOk awaits up to two backend calls. A macrotask hop drains the whole
  // microtask queue; counting `await Promise.resolve()` turns would under-drain
  // the moment a step is added.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function errorText(): string {
  return container.textContent ?? "";
}

const OK_RESULT = { success: true, namedRange: null, error: null };

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  callLog.length = 0;
  createNamedRangeMock.mockReset().mockResolvedValue(OK_RESULT);
  updateNamedRangeMock.mockReset().mockResolvedValue(OK_RESULT);
  renameNamedRangeMock.mockReset().mockResolvedValue(OK_RESULT);
  emitAppEventMock.mockReset();
  // The Tauri shape: a PROMISE, never a bare boolean. A synchronous double is
  // what let `if (!window.confirm(m))` pass review six times. Nothing should
  // reach this mock any more — the assertions below say so.
  confirmAsyncMock.mockReset().mockReturnValue(Promise.resolve(true));
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------

describe("Edit Name dialog - the Name field", () => {
  it("is editable in edit mode (it used to be disabled, so no name could be renamed)", async () => {
    await renderEdit();
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe("Total");
  });
});

describe("Edit Name dialog - renaming", () => {
  it("moves the key BEFORE applying the other edits, and addresses them to the new name", async () => {
    await renderEdit();
    await typeInto(nameInput(), "GrandTotal");
    await clickOk();

    expect(renameNamedRangeMock).toHaveBeenCalledWith("Total", "GrandTotal");
    // update_named_range refuses a key it does not hold, so an update sent to
    // "Total" after the rename - or sent first - would fail with "does not
    // exist" and the edit would appear to do nothing.
    expect(callLog).toEqual(["rename", "update"]);
    expect(updateNamedRangeMock.mock.calls[0][0]).toBe("GrandTotal");
    expect(onClose).toHaveBeenCalled();
  });

  it("asks the user nothing: the backend repoints the formulas and the rename is one undo step", async () => {
    // The consequences the old confirmation described no longer exist. Keeping
    // a dialog that describes them would train the user to click through
    // warnings - so its absence is asserted, not merely allowed.
    await renderEdit();
    await typeInto(nameInput(), "GrandTotal");
    await clickOk();

    expect(confirmAsyncMock).not.toHaveBeenCalled();
    expect(renameNamedRangeMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("stops and reports when the backend refuses the rename, leaving the other edits unapplied", async () => {
    renameNamedRangeMock.mockResolvedValue({
      success: false,
      namedRange: null,
      error: "A table named 'GrandTotal' already exists.",
    });
    await renderEdit();
    await typeInto(nameInput(), "GrandTotal");
    await clickOk();

    expect(callLog).toEqual(["rename"]);
    expect(updateNamedRangeMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(errorText()).toContain("already exists");
  });

  it("does not rename when only the SCOPE or target changed", async () => {
    await renderEdit();
    await typeInto(textInputs()[2], "=Sheet1!$B$1:$B$9");
    await clickOk();

    expect(callLog).toEqual(["update"]);
    expect(updateNamedRangeMock).toHaveBeenCalledWith(
      "Total",
      null,
      "=Sheet1!$B$1:$B$9",
      undefined,
      undefined,
    );
  });

  it("treats a case-only change as an update, not a rename - the key does not move", async () => {
    await renderEdit();
    await typeInto(nameInput(), "TOTAL");
    await clickOk();

    expect(renameNamedRangeMock).not.toHaveBeenCalled();
    // update_named_range stores the spelling it is given, so the new casing
    // still reaches the workbook.
    expect(updateNamedRangeMock.mock.calls[0][0]).toBe("TOTAL");
  });

  it("refuses a new name that is not a legal name, before touching the backend", async () => {
    await renderEdit();
    await typeInto(nameInput(), "1Total");
    await clickOk();

    expect(callLog).toEqual([]);
    expect(errorText()).toContain("Invalid name");
  });
});
