//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteVariantCommands.test.ts
// PURPOSE: The six paste variants Excel's Home > Paste menu adds to the four
//          quick pastes -- Formulas & Number Formatting, No Borders, Keep
//          Source Column Widths, Transpose, Values & Number Formatting, Values
//          & Source Formatting -- each registered as a command, each doing what
//          Excel's row does, each ONE undo step.
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; contract
//          section 4, survey clipboard.md sections 3 and 9). The code behind
//          most rows existed in the executor with no command to reach it;
//          "Values & Source Formatting" had no attribute at all; "No Borders"
//          re-applied a HAND-COPIED list of style fields that left out indent,
//          shrink-to-fit, fills, theme colours and protection; and "Keep
//          Source Column Widths" pasted widths only, never the cells.
//
//          Excel, measured live through COM (2026-10-04, xlPasteAllExceptBorders
//          on a cell with its own thick top border): the SOURCE's formatting
//          replaces the destination's (bold arrives, the destination's italic
//          goes, indent 2 arrives), the source's bottom border does NOT
//          arrive, and the destination's OWN top border STAYS.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- The backend's ONE undo-transaction slot (undo_commands.rs tickets) -----
const slot = vi.hoisted(() => {
  const s = {
    open: null as null | { label: string; ticket: number },
    issued: null as number | null,
    nextTicket: 100,
    committed: [] as string[],
    dropped: [] as string[],
    begin(description: string): number | null {
      if (s.open) return null;
      const ticket = s.nextTicket++;
      s.open = { label: description, ticket };
      s.issued = ticket;
      return ticket;
    },
    close(into: string[], ticket?: number | null): void {
      if (ticket === undefined || ticket === null) {
        if (s.open) into.push(s.open.label);
        s.open = null;
        s.issued = null;
        return;
      }
      if (s.open && s.issued === ticket) {
        into.push(s.open.label);
        s.open = null;
        s.issued = null;
      }
    },
    reset(): void {
      s.open = null;
      s.issued = null;
      s.nextTicket = 100;
      s.committed = [];
      s.dropped = [];
    },
  };
  return s;
});

// --- A tiny sheet: cell styles, the style table, column widths --------------
const h = vi.hoisted(() => ({
  clipboard: null as unknown,
  writes: [] as string[],
  updates: [] as Array<[number, number, string]>,
  styled: [] as Array<[number, number, number]>,
  formatted: [] as Array<{ rows: number[]; cols: number[]; fmt: Record<string, unknown> }>,
  widths: new Map<number, number>(),
  widthWrites: [] as Array<[number, number]>,
  destStyle: new Map<string, number>(),
  styles: new Map<number, Record<string, unknown>>(),
  alerts: [] as string[],
  current: true,
  canvas: false,
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: { registerDialog: vi.fn(), unregisterDialog: vi.fn(), openDialog: vi.fn() },
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" },
    config: { totalRows: 100, totalCols: 50 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    surface: "grid",
  }),
}));
vi.mock("@api/lib", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/lib")>();
  return {
    ...real,
    getInternalClipboard: () => h.clipboard,
    getCell: vi.fn(async (r: number, c: number) => {
      const s = h.destStyle.get(`${r},${c}`);
      return s === undefined ? null : { row: r, col: c, display: "old", formula: null, styleIndex: s };
    }),
    getStyle: vi.fn(async (i: number) => h.styles.get(i) ?? h.styles.get(0)),
    updateCell: vi.fn(async (r: number, c: number, v: string) => {
      h.writes.push("updateCell");
      h.updates.push([r, c, v]);
      return { cells: [] };
    }),
    setCellStyle: vi.fn(async (r: number, c: number, i: number) => {
      h.writes.push("setCellStyle");
      h.styled.push([r, c, i]);
      return null;
    }),
    applyFormatting: vi.fn(async (rows: number[], cols: number[], fmt: Record<string, unknown>) => {
      h.writes.push("applyFormatting");
      h.formatted.push({ rows, cols, fmt });
      return { cells: [], styles: [] };
    }),
    getColumnWidth: vi.fn(async (c: number) => h.widths.get(c) ?? null),
    setColumnWidth: vi.fn(async (c: number, w: number) => {
      h.writes.push("setColumnWidth");
      h.widthWrites.push([c, w]);
    }),
    shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
    addComment: vi.fn(async () => {}),
    setDataValidation: vi.fn(async () => {}),
    beginUndoTransaction: vi.fn(async (d: string) => slot.begin(d)),
    commitUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.committed, t)),
    cancelUndoTransaction: vi.fn(async (t?: number | null) => slot.close(slot.dropped, t)),
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
import { CoreCommands } from "@api/commands";

const NONE = { style: "none", color: "#000000", width: 0 };
function style(over: Record<string, unknown>): Record<string, unknown> {
  return {
    bold: false,
    italic: false,
    underline: "none",
    strikethrough: false,
    fontSize: 11,
    fontFamily: "Calibri",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    textAlign: "general",
    verticalAlign: "bottom",
    numberFormat: "General",
    wrapText: false,
    textRotation: "none",
    borderTop: NONE,
    borderRight: NONE,
    borderBottom: NONE,
    borderLeft: NONE,
    borderDiagonalDown: NONE,
    borderDiagonalUp: NONE,
    checkbox: false,
    button: false,
    indent: 0,
    shrinkToFit: false,
    locked: true,
    formulaHidden: false,
    ...over,
  };
}

type Cell = { display: string; formula?: string | null; styleIndex: number } | null;
function clipboardOf(
  rows: Cell[][],
  over: Partial<{ startRow: number; startCol: number; sourceRows: number[]; isCut: boolean }> = {},
): unknown {
  const startRow = over.startRow ?? 0;
  const startCol = over.startCol ?? 0;
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  return {
    cells: rows.map((r, ri) =>
      r.map((c, ci) => (c ? { row: startRow + ri, col: startCol + ci, formula: null, ...c } : null)),
    ),
    sourceSelection: {
      startRow,
      startCol,
      endRow: startRow + height - 1,
      endCol: startCol + width - 1,
      type: "cells",
    },
    sourceRows: over.sourceRows ?? rows.map((_, i) => startRow + i),
    isCut: over.isCut ?? false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: "x",
  };
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const unregistered: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  slot.reset();
  h.writes = [];
  h.updates = [];
  h.styled = [];
  h.formatted = [];
  h.widths = new Map();
  h.widthWrites = [];
  h.destStyle = new Map();
  h.styles = new Map([[0, style({})]]);
  h.alerts = [];
  h.current = true;
  h.canvas = false;
  handlers.clear();
  unregistered.length = 0;
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn),
      unregister: (id: string) => unregistered.push(id),
    },
  } as never);
});

afterEach(() => {
  extension.deactivate();
  vi.restoreAllMocks();
});

async function run(id: string): Promise<void> {
  const handler = handlers.get(id);
  expect(handler, `${id} is not registered`).toBeDefined();
  await handler!();
}

const NEW_VARIANTS = [
  CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_NO_BORDERS,
  CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
  CoreCommands.PASTE_TRANSPOSE,
  CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
];

describe("the six new paste variants are registered (and go on deactivate)", () => {
  it("each is a command", () => {
    for (const id of NEW_VARIANTS) expect(handlers.has(id), `${id} not registered`).toBe(true);
  });

  it("deactivate unregisters every paste command the extension registered", () => {
    extension.deactivate();
    expect(new Set(unregistered)).toEqual(new Set(handlers.keys()));
    // re-activate so afterEach's deactivate has something to do
    extension.activate({
      commands: { register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn), unregister: vi.fn() },
    } as never);
  });

  it.each(NEW_VARIANTS)("%s writes, and records exactly ONE undo step", async (id) => {
    h.clipboard = clipboardOf([[{ display: "3", formula: "=1+2", styleIndex: 6 }]]);
    h.styles.set(6, style({ numberFormat: "0.00", bold: true }));
    h.widths.set(0, 80);
    await run(id);
    expect(h.writes.length, `${id} wrote nothing`).toBeGreaterThan(0);
    expect(slot.committed, `${id} did not record one undo step`).toHaveLength(1);
    expect(slot.open).toBeNull();
    expect(h.alerts).toEqual([]);
  });
});

describe("Formulas & Number Formatting / Values & Number Formatting", () => {
  beforeEach(() => {
    h.clipboard = clipboardOf([[{ display: "3", formula: "=1+2", styleIndex: 6 }]]);
    h.styles.set(6, style({ numberFormat: "0.00", bold: true }));
  });

  it("Formulas & Number Formatting: the FORMULA and only the number format", async () => {
    await run(CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS);
    expect(h.updates).toEqual([[4, 4, "=1+2"]]);
    expect(h.styled).toEqual([]);
    expect(h.formatted).toEqual([{ rows: [4], cols: [4], fmt: { numberFormat: "0.00" } }]);
  });

  it("Values & Number Formatting: the VALUE (formula flattened) and only the number format", async () => {
    await run(CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS);
    expect(h.updates).toEqual([[4, 4, "3"]]);
    expect(h.styled).toEqual([]);
    expect(h.formatted).toEqual([{ rows: [4], cols: [4], fmt: { numberFormat: "0.00" } }]);
  });
});

describe("Values & Source Formatting (a new attribute: flattened values + the WHOLE source style)", () => {
  it("writes the value, not the formula, and points the cell at the source's style", async () => {
    h.clipboard = clipboardOf([[{ display: "3", formula: "=1+2", styleIndex: 6 }]]);
    await run(CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING);
    expect(h.updates).toEqual([[4, 4, "3"]]);
    expect(h.styled).toEqual([[4, 4, 6]]);
  });

  it("an EMPTY source cell clears the value and gives the default style (Excel pastes it unformatted)", async () => {
    h.clipboard = clipboardOf([[{ display: "3", styleIndex: 6 }, null]]);
    await run(CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING);
    expect(h.updates).toEqual([
      [4, 4, "3"],
      [4, 5, ""],
    ]);
    expect(h.styled).toEqual([
      [4, 4, 6],
      [4, 5, 0],
    ]);
  });
});

describe("No Borders: every style field of the source except borders; the destination keeps its own borders", () => {
  const THIN_BLACK = { style: "thin", color: "#000000", width: 1 };
  const THICK_RED = { style: "thick", color: "#ff0000", width: 3 };

  beforeEach(() => {
    // The source carries every field the old hand-copied list DROPPED.
    h.styles.set(
      5,
      style({
        bold: true,
        indent: 2,
        shrinkToFit: true,
        textColorTheme: "accent1",
        textColorTint: 400,
        fill: { type: "pattern", patternType: "lightGrid", fgColor: "#ff0000", bgColor: "#ffffff" },
        locked: false,
        formulaHidden: true,
        borderBottom: THIN_BLACK,
      }),
    );
    // The destination: italic, with its own thick red TOP border.
    h.styles.set(9, style({ italic: true, borderTop: THICK_RED }));
    h.destStyle.set("4,4", 9);
    h.clipboard = clipboardOf([[{ display: "5", styleIndex: 5 }]]);
  });

  it("the cell takes the SOURCE's style whole (no hand-copied field list), then only borders are written", async () => {
    await run(CoreCommands.PASTE_NO_BORDERS);
    expect(h.updates).toEqual([[4, 4, "5"]]);
    expect(h.styled, "the source style was not applied whole").toEqual([[4, 4, 5]]);
    for (const f of h.formatted) {
      const keys = Object.keys(f.fmt);
      expect(keys.length).toBeGreaterThan(0);
      expect(
        keys.every((k) => k.startsWith("border")),
        `No Borders re-applied a non-border field by hand: ${keys.join(", ")}`,
      ).toBe(true);
    }
  });

  it("the destination's own top border stays, the source's bottom border does not arrive (Excel, live)", async () => {
    await run(CoreCommands.PASTE_NO_BORDERS);
    const borders = Object.assign({}, ...h.formatted.map((f) => f.fmt)) as Record<string, { style: string; color: string }>;
    expect(borders.borderTop).toEqual({ style: "thick", color: "#ff0000" });
    expect(borders.borderBottom?.style).toBe("none");
    // Sides that are the same on both (none / none) are not rewritten.
    expect(borders.borderLeft).toBeUndefined();
    expect(borders.borderDiagonalUp).toBeUndefined();
  });

  it("a source with no borders over a destination with none writes no border at all", async () => {
    h.styles.set(5, style({ bold: true }));
    h.destStyle.delete("4,4");
    await run(CoreCommands.PASTE_NO_BORDERS);
    expect(h.styled).toEqual([[4, 4, 5]]);
    expect(h.formatted).toEqual([]);
  });
});

describe("Transpose: rows become columns", () => {
  it("a 1x2 copy lands as 2x1, each cell with its source style", async () => {
    h.clipboard = clipboardOf([[{ display: "a", styleIndex: 1 }, { display: "b", styleIndex: 2 }]]);
    await run(CoreCommands.PASTE_TRANSPOSE);
    expect(h.updates).toEqual([
      [4, 4, "a"],
      [5, 4, "b"],
    ]);
    expect(h.styled).toEqual([
      [4, 4, 1],
      [5, 4, 2],
    ]);
  });
});

describe("Keep Source Column Widths: the full paste AND the source's column widths, ONE undo step", () => {
  it("pastes the cells, sets the widths, and records a single step", async () => {
    h.clipboard = clipboardOf([[{ display: "a", styleIndex: 1 }, { display: "b", styleIndex: 2 }]]);
    h.widths.set(0, 80);
    h.widths.set(1, 120);
    await run(CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS);
    expect(h.updates, "the cells were not pasted (widths only is Paste Special > Column widths)").toEqual([
      [4, 4, "a"],
      [4, 5, "b"],
    ]);
    expect(h.styled).toEqual([
      [4, 4, 1],
      [4, 5, 2],
    ]);
    expect(h.widthWrites).toEqual([
      [4, 80],
      [5, 120],
    ]);
    expect(slot.committed, "the paste and the widths are two undo steps").toEqual([
      "Paste (Keep Source Column Widths) 2 cells",
    ]);
    expect(slot.open).toBeNull();
  });

  it("a width the backend refuses cancels the WHOLE step (cells and widths go together)", async () => {
    h.clipboard = clipboardOf([[{ display: "a", styleIndex: 1 }]]);
    h.widths.set(0, 80);
    const lib = await import("@api/lib");
    vi.mocked(lib.setColumnWidth).mockImplementationOnce(async () => {
      throw new Error("The sheet is protected");
    });
    await run(CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS);
    expect(slot.committed).toEqual([]);
    expect(slot.dropped).toEqual(["Paste (Keep Source Column Widths) 1 cells"]);
    expect(h.alerts.some((a) => a.includes("The sheet is protected")), "the refusal never reached the user").toBe(true);
  });
});

describe("Paste All's empty source cells (Transpose, Keep Source Column Widths)", () => {
  it("an empty source cell gives the destination the default style, as plain Paste does", async () => {
    h.clipboard = clipboardOf([[{ display: "a", styleIndex: 1 }, null]]);
    await run(CoreCommands.PASTE_TRANSPOSE);
    expect(h.styled).toEqual([
      [4, 4, 1],
      [5, 4, 0],
    ]);
  });
});
