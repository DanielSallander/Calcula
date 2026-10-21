//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabCellTarget.test.tsx
// PURPOSE: The Home tab's formatting doors act on a FLOATING GRID'S cells when
//          its owner admits the act: every write goes to the owner's own
//          selection with `{ target }`, never to Core's selection hidden under
//          the grid; the ribbon's pressed state reads the owner's active cell
//          through the target. An owner that admits nothing (the floating
//          grid before P3 S8 registers `actsOn`) refuses every door, once.
// CONTEXT: P3 S9 (owner finding G3: Home commands refused on floating-grid
//          cells). The owner here is a DOUBLE of the floating grid's claim
//          (@api/selectionOwner) answering `cellTarget()`; the real one is
//          wired in S8. Core's selection (A1:B2) and the grid's (C4:C5, active
//          C5) differ on purpose, so a write to the wrong one cannot pass.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const coreSelection = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

vi.mock("@api", () => ({
  useGridState: () => ({ selection: coreSelection }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection: coreSelection }),
}));
const execute = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (...a: unknown[]) => execute(...a) },
  CoreCommands: { FORMAT_PAINTER: "core.format.painter", FORMAT_CELLS: "core.format.cells" },
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));

const h = vi.hoisted(() => ({
  applyFormatting: vi.fn(async (..._a: unknown[]) => ({ cells: [], styles: [] })),
  setCellRichText: vi.fn(async (..._a: unknown[]) => undefined),
  adjustNumberFormatDecimals: vi.fn(async (..._a: unknown[]) => ({
    cells: [{ row: 4, col: 2, display: "1.0", formula: null, styleIndex: 2 }],
    styles: [{ index: 2, style: { numberFormat: "Number (1 decimal)" } }],
  })),
  getCell: vi.fn(async (..._a: unknown[]) => ({ row: 0, col: 0, styleIndex: 0, display: "core" })),
  getStyle: vi.fn(async (index: number) => ({ bold: index === 5, fontSize: 11 })),
  readTargetCell: vi.fn(async (..._a: unknown[]) => ({
    row: 4,
    col: 2,
    styleIndex: 5,
    display: "fr",
    formula: null,
    valueKind: "text",
  })),
}));
vi.mock("@api/lib", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  getStyle: (i: number) => h.getStyle(i),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  setCellRichText: (...a: unknown[]) => h.setCellRichText(...a),
  adjustNumberFormatDecimals: (...a: unknown[]) => h.adjustNumberFormatDecimals(...a),
}));
// The seam is REAL (resolveCellTarget, cellTargetFor, targetRefOf, the change
// notification); only its backend read is doubled.
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  readTargetCell: (...a: unknown[]) => h.readTargetCell(...a),
}));
vi.mock("../homeTabConfig", () => ({ ITEMS_BY_ID: new Map() }));
vi.mock("../../../_shared/lib/fontList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../_shared/lib/fontList")>()),
  FONT_SIZES: [8, 11, 14],
}));

import { useHomeTabState } from "../components/useHomeTabState";
import { registerSelectionOwner } from "@api/selectionOwner";
import { CELL_TARGET_CAPABILITIES, notifyCellTargetChanged, type CellTargetCapability } from "@api/cellTarget";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const REF = { kind: "floatingRange" as const, id: "fr-7" };
/** The floating grid's own selection: C4:C5, active C5 (local == backing). */
const FR_SELECTION = { startRow: 3, startCol: 2, endRow: 4, endCol: 2, activeRow: 4, activeCol: 2, type: "cells" as const };
/** Every capability the real floating grid will admit in S8. */
const ADMITTED = CELL_TARGET_CAPABILITIES.filter((c) => c !== "table" && c !== "filter" && c !== "shiftCells");

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHomeTabState> | null = null;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

function Probe(): React.ReactElement | null {
  latest = useHomeTabState();
  return null;
}

/** A double of the floating grid's claim: owns the selection and answers its
 *  cells; `actsOn` absent = the grid before S8 (admits nothing). */
function floatingGrid(actsOn?: readonly CellTargetCapability[]): void {
  release?.();
  release = registerSelectionOwner({
    id: "floatingRange",
    label: "a floating grid's cells",
    ownsSelection: () => true,
    cellTarget: () => ({
      ref: REF,
      selection: { ...FR_SELECTION },
      bounds: { rows: 20, cols: 6 },
      label: "Float1",
      wholeObject: false,
    }),
    ...(actsOn ? { actsOn } : {}),
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
  execute.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
});

afterEach(async () => {
  release?.();
  release = null;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  latest = null;
});

/** The rows/cols of the floating grid's selection, as applyFormatting takes them. */
const FR_ROWS = [3, 4];
const FR_COLS = [2];

describe("a floating grid that admits the act: the doors write ITS cells through the target", () => {
  /** [label, door, the formatting applyFormatting must receive] */
  const FORMAT_DOORS: [string, () => Promise<unknown>, Record<string, unknown>][] = [
    ["Bold", () => latest!.handleItemClick({ id: "bold", label: "Bold" } as never), { bold: false }],
    ["Wrap text", () => latest!.handleItemClick({ id: "wrapText", label: "Wrap Text" } as never), { wrapText: true }],
    ["Font colour", () => latest!.applyFormat({ textColor: "#ff0000" }, "Font Color"), { textColor: "#ff0000" }],
    ["Font family", () => latest!.handleFontFamilyChange("Arial"), { fontFamily: "Arial" }],
    ["Number format dropdown", () => latest!.handleNumberFormatChange("0.00"), { numberFormat: "0.00" }],
    ["Percent", () => latest!.handleItemClick({ id: "percentFormat", label: "Percent Style" } as never), { numberFormat: "0%" }],
    ["Cell style gallery", () => latest!.handleCellStyleApply({ italic: true } as never), { italic: true }],
  ];

  for (const [label, run, formatting] of FORMAT_DOORS) {
    it(`${label}: applyFormatting gets the grid's rows/cols and { target }, never Core's`, async () => {
      floatingGrid(ADMITTED);
      await mount();
      h.applyFormatting.mockClear();
      await act(async () => {
        await run();
      });
      expect(toasts, `${label} was refused`).toEqual([]);
      const calls = h.applyFormatting.mock.calls;
      expect(calls.length, `${label} wrote ${calls.length} times`).toBe(1);
      const [rows, cols, sent, opts] = calls[0] as [number[], number[], Record<string, unknown>, unknown];
      expect(rows).toEqual(FR_ROWS);
      expect(cols).toEqual(FR_COLS);
      expect(sent).toMatchObject(formatting);
      expect(opts, `${label} wrote without the target (the active sheet's cells)`).toEqual({ target: REF });
    });
  }

  it("Increase Decimal: the backend's step on the grid's cells, its ACTIVE cell first, with the target", async () => {
    floatingGrid(ADMITTED);
    await mount();
    await act(async () => {
      await latest!.handleItemClick({ id: "increaseDecimal", label: "Increase Decimal" } as never);
    });
    expect(toasts).toEqual([]);
    expect(h.adjustNumberFormatDecimals.mock.calls).toEqual([[[4, 3], [2], 1, { target: REF }]]);
  });

  it("Superscript reads the grid's active cell through the target and writes its rich text there", async () => {
    floatingGrid(ADMITTED);
    await mount();
    h.getCell.mockClear();
    h.readTargetCell.mockClear();
    await act(async () => {
      await latest!.handleItemClick({ id: "superscript", label: "Superscript" } as never);
    });
    expect(toasts).toEqual([]);
    expect(h.readTargetCell).toHaveBeenCalledWith(REF, 4, 2);
    expect(h.getCell, "superscript read the active sheet's cell").not.toHaveBeenCalled();
    expect(h.setCellRichText.mock.calls).toEqual([
      [4, 2, [{ text: "fr", superscript: true, subscript: false }], { target: REF }],
    ]);
  });

  it("the ribbon reads the grid's ACTIVE cell through the target: Bold lights for a bold floating-grid cell", async () => {
    floatingGrid(ADMITTED);
    await mount();
    expect(h.readTargetCell).toHaveBeenCalledWith(REF, 4, 2);
    expect(h.getStyle).toHaveBeenCalledWith(5);
    expect(latest!.isActive("bold")).toBe(true);
    expect(latest!.currentCellData?.display).toBe("fr");
  });

  it("the ribbon re-reads when the owner's selection moves (onCellTargetChanged)", async () => {
    floatingGrid(ADMITTED);
    await mount();
    h.readTargetCell.mockClear();
    h.readTargetCell.mockResolvedValueOnce({ row: 4, col: 2, styleIndex: 0, display: "plain", formula: null, valueKind: "text" });
    await act(async () => {
      notifyCellTargetChanged();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 160));
    });
    await flush();
    expect(h.readTargetCell).toHaveBeenCalledWith(REF, 4, 2);
    expect(latest!.isActive("bold")).toBe(false);
  });

  it("a number-format write asks \"numberFormat\": an owner admitting only \"format\" refuses Percent", async () => {
    floatingGrid(["format", "read"]);
    await mount();
    await act(async () => {
      await latest!.handleItemClick({ id: "percentFormat", label: "Percent Style" } as never);
    });
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
    // ... while a formatting button goes through.
    await act(async () => {
      await latest!.handleItemClick({ id: "italic", label: "Italic" } as never);
    });
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
  });

  it("without an owner the same doors write Core's selection with no target", async () => {
    await mount();
    await act(async () => {
      await latest!.handleItemClick({ id: "bold", label: "Bold" } as never);
    });
    expect(h.applyFormatting.mock.calls).toEqual([[[0, 1], [0, 1], { bold: true }, { target: undefined }]]);
    expect(h.readTargetCell).not.toHaveBeenCalled();
  });
});

describe("inert until S8: a floating-grid owner that admits NOTHING refuses every migrated door", () => {
  const DOORS: [string, () => Promise<unknown>][] = [
    ["Bold", () => latest!.handleItemClick({ id: "bold", label: "Bold" } as never)],
    ["Increase font size", () => latest!.handleItemClick({ id: "increaseFontSize", label: "Increase Font Size" } as never)],
    ["Align center", () => latest!.handleItemClick({ id: "alignCenter", label: "Align Center" } as never)],
    ["Percent", () => latest!.handleItemClick({ id: "percentFormat", label: "Percent Style" } as never)],
    ["Comma Style", () => latest!.handleItemClick({ id: "commaFormat", label: "Comma Style" } as never)],
    ["Increase decimal", () => latest!.handleItemClick({ id: "increaseDecimal", label: "Increase Decimal" } as never)],
    ["Decrease decimal", () => latest!.handleItemClick({ id: "decreaseDecimal", label: "Decrease Decimal" } as never)],
    ["Superscript", () => latest!.handleItemClick({ id: "superscript", label: "Superscript" } as never)],
    ["Fill colour", () => latest!.applyFormat({ backgroundColor: "#00ff00" }, "Fill Color")],
    ["Font size picker", () => latest!.handleFontSizeChange(14)],
    ["Number format dropdown", () => latest!.handleNumberFormatChange("0.00")],
    ["Cell style gallery", () => latest!.handleCellStyleApply({ bold: true } as never)],
  ];
  for (const [label, run] of DOORS) {
    it(`${label}: writes nothing anywhere and says so once`, async () => {
      floatingGrid(undefined);
      await mount();
      await act(async () => {
        await run();
      });
      expect(h.applyFormatting, `${label} wrote`).not.toHaveBeenCalled();
      expect(h.setCellRichText, `${label} wrote rich text`).not.toHaveBeenCalled();
      expect(h.adjustNumberFormatDecimals, `${label} stepped decimals`).not.toHaveBeenCalled();
      expect(toasts.length, `${label} refused ${toasts.length} times`).toBe(1);
    });
  }

  it("the ribbon of a refusing owner never reads through a target", async () => {
    floatingGrid(undefined);
    await mount();
    expect(h.readTargetCell).not.toHaveBeenCalled();
  });
});
