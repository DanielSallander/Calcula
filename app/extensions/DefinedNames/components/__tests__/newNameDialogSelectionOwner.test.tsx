//! FILENAME: app/extensions/DefinedNames/components/__tests__/newNameDialogSelectionOwner.test.tsx
// PURPOSE: Name Manager > New... opens while a selection owner (a floating
//          grid's selected cell) holds the selection -- the Name Manager does
//          not refuse -- but the new name's "Refers to" is NOT prefilled from
//          Core's hidden selection: it starts empty.
// CONTEXT: W24 (wave C), with the owner default: "Name Manager ... do NOT
//          refuse while a selection owner claims the selection: they open with
//          NO prefill from Core's hidden selection." The New Name dialog read
//          Core's selection itself (useGridState), so the prefill named a cell
//          hidden under the floating grid -- a name pointing at a range the
//          user never chose. (Formulas > Define Name... still refuses, D4: its
//          whole purpose is to name the selection.) TEST owner
//          (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * The @api double's keys ARE the @api export names. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Core's selection: B4 -- hidden under the owner's object in the claimed case.
const gridState = {
  selection: { startRow: 3, startCol: 1, endRow: 3, endCol: 1 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

vi.mock("@api", () => ({
  createNamedRange: vi.fn(),
  updateNamedRange: vi.fn(),
  renameNamedRange: vi.fn(),
  getSheets: () => Promise.resolve({ sheets: [{ name: "Sheet1" }], activeIndex: 0 }),
  useGridState: () => gridState,
  AppEvents: { NAMED_RANGES_CHANGED: "app:named-ranges-changed" },
  emitAppEvent: vi.fn(),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  letterToColumn: (letters: string) => letters.charCodeAt(0) - 65,
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: {
    INPUT: "autocomplete:input",
    ACCEPTED: "autocomplete:accepted",
    DISMISS: "autocomplete:dismiss",
    KEY: "autocomplete:key",
  },
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(async () => false) }));

import { NewNameDialog } from "../NewNameDialog";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

async function openNew(): Promise<void> {
  await act(async () => {
    root.render(<NewNameDialog isOpen onClose={() => {}} data={{ mode: "new" }} />);
  });
}

/** The dialog renders Name, Folder, then Refers to. */
function refersTo(): string {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='text']"));
  const input = inputs[2];
  if (!input) throw new Error(`no Refers to field among ${inputs.length} text inputs`);
  return input.value;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});

afterEach(async () => {
  release();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("New Name while a selection owner holds the selection", () => {
  it("opens with an EMPTY Refers to (no prefill from Core's hidden selection), no refusal", async () => {
    owns = true;
    await openNew();
    expect(refersTo(), "the new name was prefilled with Core's HIDDEN selection").toBe("");
    expect(toasts).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("Refers to is prefilled from the selection (B4)", async () => {
    await openNew();
    expect(refersTo()).toBe("=Sheet1!$B$4");
  });
});
