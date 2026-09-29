//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabSelectionOwner.test.tsx
// PURPOSE: The Home tab's formatting doors refuse -- with ONE toast, writing
//          nothing -- while a selection owner holds the selection, and still
//          format Core's selection when nothing does.
// CONTEXT: BUG-0185. With a floating grid's cell selected on a worksheet,
//          Core's selection stays on a cell HIDDEN under the floating grid, and
//          every Home tab door read that selection and wrote to it: Bold, the
//          font and size pickers, the colours, alignment, number formats, the
//          cell-style gallery (all through `applyFormat`) and superscript /
//          subscript (their own `setCellRichText` path). The owner here is a
//          TEST owner (@api/selectionOwner); the floating grid's claim is wired
//          in wave B.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

vi.mock("@api", () => ({
  useGridState: () => ({ selection }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection }),
}));
const execute = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (...a: unknown[]) => execute(...a) },
  CoreCommands: { FORMAT_PAINTER: "core.format.painter", FORMAT_CELLS: "core.format.cells" },
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));

const applyFormatting = vi.fn(async (..._a: unknown[]) => ({ cells: [] }));
const setCellRichText = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@api/lib", () => ({
  getCell: vi.fn(async () => ({ row: 0, col: 0, styleIndex: 0, display: "x2" })),
  getStyle: vi.fn(async () => ({ bold: false, fontSize: 11 })),
  applyFormatting: (...a: unknown[]) => applyFormatting(...a),
  setCellRichText: (...a: unknown[]) => setCellRichText(...a),
}));
vi.mock("../homeTabConfig", () => ({ ITEMS_BY_ID: new Map() }));
vi.mock("../../../_shared/lib/fontList", () => ({ FONT_SIZES: [8, 11, 14] }));

import { useHomeTabState } from "../components/useHomeTabState";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHomeTabState> | null = null;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

function Probe(): React.ReactElement | null {
  latest = useHomeTabState();
  return null;
}

function claim(): void {
  release = registerSelectionOwner({
    id: "test-owner",
    label: "the test object's cells",
    ownsSelection: () => true,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

beforeEach(async () => {
  applyFormatting.mockClear();
  setCellRichText.mockClear();
  execute.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await flush();
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

/** Every Home tab door that writes formatting to Core's selection. */
const DOORS: [string, () => Promise<unknown>][] = [
  ["Bold button", () => latest!.handleItemClick({ id: "bold" } as never)],
  ["Italic button", () => latest!.handleItemClick({ id: "italic" } as never)],
  ["Increase font size", () => latest!.handleItemClick({ id: "increaseFontSize" } as never)],
  ["Align center", () => latest!.handleItemClick({ id: "alignCenter" } as never)],
  ["Wrap text", () => latest!.handleItemClick({ id: "wrapText" } as never)],
  ["Percent format", () => latest!.handleItemClick({ id: "percentFormat" } as never)],
  ["Increase decimal", () => latest!.handleItemClick({ id: "increaseDecimal" } as never)],
  ["Superscript", () => latest!.handleItemClick({ id: "superscript" } as never)],
  ["Subscript", () => latest!.handleItemClick({ id: "subscript" } as never)],
  ["Font colour", () => latest!.handleColorSelect("textColor", "#ff0000")],
  ["Fill colour", () => latest!.handleColorSelect("backgroundColor", "#00ff00")],
  ["Font family picker", () => latest!.handleFontFamilyChange("Arial")],
  ["Font size picker", () => latest!.handleFontSizeChange(14)],
  ["Number format dropdown", () => latest!.handleNumberFormatChange("0.00")],
  ["Cell style gallery", () => latest!.handleCellStyleApply({ bold: true } as never)],
];

describe("Home tab formatting doors while a selection owner holds the selection", () => {
  for (const [label, run] of DOORS) {
    it(`${label}: writes nothing and says so once`, async () => {
      claim();
      await act(async () => {
        await run();
      });
      expect(applyFormatting, `${label} formatted Core's hidden selection`).not.toHaveBeenCalled();
      expect(setCellRichText, `${label} wrote rich text into Core's hidden cell`).not.toHaveBeenCalled();
      expect(toasts.length, `${label} refused ${toasts.length} times`).toBe(1);
      expect(toasts[0].message).toContain("the test object's cells");
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, run] of DOORS) {
    it(`${label}: writes to Core's selection, no refusal`, async () => {
      await act(async () => {
        await run();
      });
      expect(applyFormatting.mock.calls.length + setCellRichText.mock.calls.length).toBe(1);
      expect(toasts).toEqual([]);
    });
  }

  it("an owner that says NO leaves the doors working", async () => {
    release = registerSelectionOwner({ id: "idle", label: "x", ownsSelection: () => false });
    await act(async () => {
      await latest!.handleItemClick({ id: "bold" } as never);
    });
    expect(applyFormatting).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});
