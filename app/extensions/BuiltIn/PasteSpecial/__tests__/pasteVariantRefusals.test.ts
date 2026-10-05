//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteVariantRefusals.test.ts
// PURPOSE: Every paste variant -- the four quick pastes, the six Home-menu
//          rows and the Paste Special dialog -- refuses, with ONE sentence the
//          user reads (alertAsync, never the console) and NOTHING written,
//          exactly where plain Paste would not paste the internal clipboard:
//            - after a CUT (Excel greys every row but Paste then; measured live
//              2026-10-04: GetEnabledMso("PasteValues" / "PasteFormulas" /
//              "PasteLink" / "PasteTranspose" / "PasteNoBorders" /
//              "PasteValuesAndSourceFormatting" / "PasteSpecialDialog") are all
//              False after Range.Cut, True after Range.Copy);
//            - when another program put NEWER text on the clipboard (the
//              internal clipboard is stale -- the same rule plain Paste uses);
//            - when the paste area overlaps a protected region (a pivot table:
//              the range guards plain Paste checks);
//            - with nothing copied, and on a canvas sheet (no cells).
// CONTEXT: Survey clipboard.md section 9, defects 3 and 4: the variants read
//          `getInternalClipboard()` blindly, skipped the pivot/protected-region
//          check, and returned SILENTLY when there was nothing to paste.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  clipboard: null as unknown,
  writes: [] as string[],
  alerts: [] as string[],
  opened: [] as string[],
  current: true,
  canvas: false,
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: {
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    openDialog: (id: string) => h.opened.push(id),
  },
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" },
    config: { totalRows: 100, totalCols: 50 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    surface: h.canvas ? "canvas" : "grid",
  }),
}));
vi.mock("@api/lib", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/lib")>();
  const write = (name: string) => async () => {
    h.writes.push(name);
    return name === "updateCell" || name === "applyFormatting" ? { cells: [], styles: [] } : null;
  };
  return {
    ...real,
    getInternalClipboard: () => h.clipboard,
    getCell: vi.fn(async () => null),
    getStyle: vi.fn(async () => ({ borderTop: { style: "none", color: "#000000", width: 0 } })),
    updateCell: write("updateCell"),
    setCellStyle: write("setCellStyle"),
    applyFormatting: write("applyFormatting"),
    setColumnWidth: write("setColumnWidth"),
    getColumnWidth: vi.fn(async () => 64),
    shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
    addComment: write("addComment"),
    setDataValidation: write("setDataValidation"),
    beginUndoTransaction: write("beginUndoTransaction"),
    commitUndoTransaction: vi.fn(async () => {}),
    cancelUndoTransaction: vi.fn(async () => {}),
  };
});
vi.mock("@api/dialogs", () => ({
  alertAsync: vi.fn(async (m: string) => {
    h.alerts.push(m);
  }),
}));
vi.mock("@api/cellClipboard", () => ({
  internalClipboardIsCurrent: vi.fn(async () => h.current),
}));
vi.mock("@api/objectClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canvasOwnsObjectClipboard: () => h.canvas,
}));

import extension from "../index";
import { executePasteSpecial, executePasteLink } from "../pasteSpecialExecute";
import { CoreCommands } from "@api/commands";
import { registerRangeGuard } from "@api/editGuards";

function clipboard(over: Record<string, unknown> = {}): unknown {
  return {
    cells: [[{ row: 0, col: 0, display: "1", formula: null, styleIndex: 2 }]],
    sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    sourceRows: [0],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: "1",
    ...over,
  };
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.clipboard = clipboard();
  h.writes = [];
  h.alerts = [];
  h.opened = [];
  h.current = true;
  h.canvas = false;
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
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

const VARIANTS = [
  CoreCommands.PASTE_VALUES,
  CoreCommands.PASTE_FORMULAS,
  CoreCommands.PASTE_FORMATTING,
  CoreCommands.PASTE_LINK,
  CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_NO_BORDERS,
  CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
  CoreCommands.PASTE_TRANSPOSE,
  CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
];

async function run(id: string): Promise<void> {
  const fn = handlers.get(id);
  expect(fn, `${id} is not registered`).toBeDefined();
  await fn!();
}

function expectRefused(id: string, words: RegExp): void {
  expect(h.writes, `${id} wrote anyway`).toEqual([]);
  expect(h.alerts.length, `${id}: the refusal never reached the user`).toBe(1);
  expect(h.alerts[0]).toMatch(words);
  expect(h.alerts[0]).toMatch(/Nothing was changed/);
}

describe.each(VARIANTS)("%s", (id) => {
  it("after a CUT: refused (Excel allows only plain Paste then)", async () => {
    h.clipboard = clipboard({ isCut: true });
    await run(id);
    expectRefused(id, /Cut/);
  });

  it("another program copied newer text: the OLD cells are not pasted", async () => {
    h.current = false;
    await run(id);
    expectRefused(id, /another program/);
  });

  it("the paste area overlaps a protected region: the guard's sentence, nothing written", async () => {
    cleanups.push(
      registerRangeGuard((r0, c0, r1, c1) =>
        r0 <= 4 && r1 >= 4 && c0 <= 4 && c1 >= 4
          ? { blocked: true, message: "You can't change part of a PivotTable. Nothing was changed." }
          : null,
      ),
    );
    await run(id);
    expectRefused(id, /PivotTable/);
  });

  it("nothing copied: said, not silent", async () => {
    h.clipboard = null;
    await run(id);
    expectRefused(id, /Copy/);
  });

  it("on a canvas sheet: said, not silent", async () => {
    h.canvas = true;
    await run(id);
    expectRefused(id, /canvas/);
  });

  it("positive control: a current copy, no guard, a worksheet -- it writes and says nothing", async () => {
    await run(id);
    expect(h.writes.length, `${id} wrote nothing`).toBeGreaterThan(0);
    expect(h.alerts).toEqual([]);
  });
});

describe("the range guard is asked about the WHOLE paste area", () => {
  it("a 1x3 Transpose is checked as 3 rows by 1 column", async () => {
    h.clipboard = clipboard({
      cells: [
        [
          { row: 0, col: 0, display: "a", formula: null, styleIndex: 0 },
          { row: 0, col: 1, display: "b", formula: null, styleIndex: 0 },
          { row: 0, col: 2, display: "c", formula: null, styleIndex: 0 },
        ],
      ],
      sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 2, type: "cells" },
    });
    const asked: number[][] = [];
    cleanups.push(
      registerRangeGuard((r0, c0, r1, c1) => {
        asked.push([r0, c0, r1, c1]);
        return null;
      }),
    );
    await run(CoreCommands.PASTE_TRANSPOSE);
    expect(asked).toContainEqual([4, 4, 6, 4]);
  });
});

describe("Paste Special... itself", () => {
  it("after a CUT the dialog does not open (Excel disables it); one sentence", async () => {
    h.clipboard = clipboard({ isCut: true });
    await run(CoreCommands.PASTE_SPECIAL);
    expect(h.opened).toEqual([]);
    expect(h.alerts.length).toBe(1);
    expect(h.alerts[0]).toMatch(/Cut/);
  });

  it("on a canvas sheet the dialog does not open; one sentence", async () => {
    h.canvas = true;
    await run(CoreCommands.PASTE_SPECIAL);
    expect(h.opened).toEqual([]);
    expect(h.alerts[0]).toMatch(/canvas/);
  });

  it("positive control: it opens", async () => {
    await run(CoreCommands.PASTE_SPECIAL);
    expect(h.opened).toEqual(["paste-special"]);
    expect(h.alerts).toEqual([]);
  });

  it("the dialog's OK (executePasteSpecial) and its Paste Link refuse a cut clipboard too", async () => {
    const cut = clipboard({ isCut: true }) as never;
    const target = { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" } as never;
    const pasted = await executePasteSpecial(
      cut,
      target,
      { pasteAttribute: "values", operation: "none", skipBlanks: false, transpose: false },
      100,
      50,
    );
    const linked = await executePasteLink(cut, target, 100, 50);
    expect(pasted).toBe(false);
    expect(linked).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.alerts.length).toBe(2);
  });
});
