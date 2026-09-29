//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialSelectionOwner.test.ts
// PURPOSE: Paste Special refuses -- one toast, nothing written -- while a
//          selection owner holds the selection: the dialog does not open, the
//          quick commands (Paste Values / Formulas / Formatting / Link) write
//          nothing, and neither does a dialog that is already open.
// CONTEXT: BUG-0185. Every Paste Special door pastes into Core's selection, a
//          cell HIDDEN under a floating grid while that grid's cell is
//          selected. The two execute functions are where every door lands, so
//          they are where it refuses. TEST owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  openDialog: vi.fn(),
  writes: vi.fn(),
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: {
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    openDialog: (...a: unknown[]) => h.openDialog(...a),
  },
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" },
    config: { totalRows: 100, totalCols: 50 },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/lib")>();
  const write = (name: string) => async (...a: unknown[]) => {
    h.writes(name, ...a);
    return name === "updateCell" || name === "applyFormatting" ? { cells: [] } : undefined;
  };
  return {
    ...real,
    getInternalClipboard: () => CLIPBOARD,
    getCell: vi.fn(async () => ({ display: "1", formula: null, styleIndex: 0 })),
    getStyle: vi.fn(async () => ({})),
    updateCell: write("updateCell"),
    setCellStyle: write("setCellStyle"),
    applyFormatting: write("applyFormatting"),
    setColumnWidth: write("setColumnWidth"),
    getColumnWidth: vi.fn(async () => 64),
    beginUndoTransaction: write("beginUndoTransaction"),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    shiftFormulasBatch: vi.fn(async (inputs: unknown[]) => inputs.map(() => "")),
    addComment: write("addComment"),
    setDataValidation: write("setDataValidation"),
  };
});
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));

const CLIPBOARD = {
  cells: [[{ row: 0, col: 0, display: "1", formula: null, styleIndex: 2 }]],
  sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  mode: "copy",
} as never;

import extension from "../index";
import { executePasteSpecial, executePasteLink } from "../pasteSpecialExecute";
import { CoreCommands } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
const TARGET = { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" } as never;
const OPTIONS = { pasteAttribute: "all", operation: "none", skipBlanks: false, transpose: false } as never;

beforeEach(() => {
  h.openDialog.mockReset();
  h.writes.mockReset();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  handlers.clear();
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn),
      unregister: vi.fn(),
    },
  } as never);
});

afterEach(() => {
  extension.deactivate();
  release();
});

const QUICK = [
  CoreCommands.PASTE_VALUES,
  CoreCommands.PASTE_FORMULAS,
  CoreCommands.PASTE_FORMATTING,
  CoreCommands.PASTE_LINK,
];

describe("Paste Special while a selection owner holds the selection", () => {
  it("Paste Special... (Ctrl+Alt+V, Ctrl+Shift+V, the Edit menu) does not open the dialog; one toast", async () => {
    owns = true;
    await handlers.get(CoreCommands.PASTE_SPECIAL)!();
    expect(h.openDialog, "Paste Special opened over Core's hidden selection").not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  for (const id of QUICK) {
    it(`${id}: writes nothing into Core's hidden selection; one toast`, async () => {
      owns = true;
      await handlers.get(id)!();
      expect(h.writes, `${id} wrote into Core's hidden selection`).not.toHaveBeenCalled();
      expect(toasts.length).toBe(1);
    });
  }

  it("a dialog already open: OK (executePasteSpecial) and Paste Link write nothing", async () => {
    owns = true;
    await executePasteSpecial(CLIPBOARD, TARGET, OPTIONS, 100, 50);
    await executePasteLink(CLIPBOARD, TARGET, 100, 50);
    expect(h.writes).not.toHaveBeenCalled();
    expect(toasts.length).toBe(2);
  });
});

describe("positive controls: nothing owns the selection", () => {
  it("Paste Special... opens the dialog", async () => {
    await handlers.get(CoreCommands.PASTE_SPECIAL)!();
    expect(h.openDialog).toHaveBeenCalledWith("paste-special");
  });

  for (const id of QUICK) {
    it(`${id}: writes into Core's selection`, async () => {
      await handlers.get(id)!();
      expect(h.writes).toHaveBeenCalled();
      expect(toasts).toEqual([]);
    });
  }
});
