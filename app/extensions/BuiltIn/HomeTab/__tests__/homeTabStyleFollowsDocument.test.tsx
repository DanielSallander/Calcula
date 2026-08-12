//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabStyleFollowsDocument.test.tsx
// PURPOSE: The ribbon's formatting state is a function of the DOCUMENT, not of
//          whatever it last managed to read.
// CONTEXT: BUG-0028. `useHomeTabState` loaded the active cell's style on
//          `gridState.selection` alone and, when `getCell` resolved to null,
//          RETURNED WITHOUT CLEARING. Two consequences, both real:
//
//            - selecting an empty cell after a bold one left Bold lit, because
//              `isActive` reads only `currentStyle`;
//            - File > New through the E2E `resetToNewWorkbook` helper (which
//              calls `new_file` without the product's page reload), undo, and
//              Clear Formats all leave the selection object untouched, so
//              nothing re-read and the ribbon went on describing a document
//              that no longer existed.
//
//          The second one is what made the `core-empty-grid` golden a picture
//          of the PREVIOUS run — font box reading `Calibri` and Center
//          Vertically lit over a workbook that had just been emptied — and it
//          is why that golden passed warm and failed cold.
//
//          Both arms below are driven to FAIL against the old behaviour: the
//          first fails if the null branch stops clearing, the second fails if
//          the document events stop re-reading.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Mocks: keep the test on the read path, not on the whole @api graph ------

let selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null = {
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
};

vi.mock("@api", () => ({
  useGridState: () => ({ selection }),
  cellEvents: { emit: vi.fn() },
}));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection }),
}));

vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: vi.fn() },
  CoreCommands: {},
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: { openDialog: vi.fn() },
}));

vi.mock("@api/dialogs", () => ({
  alertAsync: vi.fn(),
}));

/** The backend, as far as this hook is concerned. */
const backend = {
  /** null = the cell holds nothing and carries no style. */
  cell: null as { row: number; col: number; styleIndex: number } | null,
  style: { bold: false } as Record<string, unknown>,
};
const getCell = vi.fn(async () => backend.cell);
const getStyle = vi.fn(async () => backend.style);

vi.mock("@api/lib", () => ({
  getCell: (row: number, col: number) => getCell(row, col),
  getStyle: (index: number) => getStyle(index),
  applyFormatting: vi.fn(async () => ({ cells: [] })),
  setCellRichText: vi.fn(),
}));

vi.mock("../homeTabConfig", () => ({
  ITEMS_BY_ID: new Map(),
}));

vi.mock("../../../_shared/lib/fontList", () => ({
  FONT_SIZES: [11],
}));

import { useHomeTabState } from "../components/useHomeTabState";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHomeTabState> | null = null;

function Probe(): React.ReactElement | null {
  latest = useHomeTabState();
  return null;
}

async function flush(): Promise<void> {
  // The document-event listener COALESCES on a 120 ms timer (see
  // `useHomeTabState`), so a flush that only drained microtasks would race it
  // and this suite would pass for the wrong reason.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  backend.cell = { row: 0, col: 0, styleIndex: 1 };
  backend.style = { bold: true };
  getCell.mockClear();
  getStyle.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  latest = null;
});

describe("the Home tab's formatting state follows the document", () => {
  it("starts lit for a bold cell — the positive control", async () => {
    expect(latest!.isActive("bold")).toBe(true);
  });

  it("CLEARS when the active cell holds nothing, instead of keeping the last cell that did", async () => {
    // Move to a cell the backend knows nothing about — an empty, unstyled cell.
    backend.cell = null;
    selection = { startRow: 8, startCol: 25, endRow: 8, endCol: 25 };
    await act(async () => {
      root.render(<Probe />);
    });
    await flush();

    expect(
      latest!.isActive("bold"),
      "Bold stayed lit over an empty cell: the null branch stopped clearing " +
        "`currentStyle`, which is BUG-0028's first half",
    ).toBe(false);
    expect(latest!.currentStyle).toBeNull();
    expect(latest!.currentCellData).toBeNull();
  });

  it("RE-READS when the document changes under a selection that did not move", async () => {
    // This is the File > New / undo / Clear Formats case. The selection object
    // is deliberately left ALONE — that is the whole point: the old effect
    // depended on it and therefore never ran.
    const readsBefore = getCell.mock.calls.length;
    backend.cell = null;

    await act(async () => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await flush();

    expect(
      getCell.mock.calls.length,
      "`grid:refresh` did not make the ribbon re-read the active cell, so it " +
        "goes on describing a document that has been replaced (BUG-0028)",
    ).toBeGreaterThan(readsBefore);
    expect(latest!.isActive("bold")).toBe(false);
  });

  it("re-reads on a sheet change too — A1 here is not the A1 it last read", async () => {
    const readsBefore = getCell.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("app:sheet-changed"));
    });
    await flush();
    expect(getCell.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("COALESCES a burst into ONE read, so typing does not put two IPC calls per keystroke on the wire", async () => {
    // `grid:refresh` is dispatched per edit. Without coalescing, a paste or a
    // fast typist would queue a `get_cell` + `get_style` pair behind every
    // keystroke they are still sending — which is a product cost, not just a
    // test one.
    const readsBefore = getCell.mock.calls.length;
    await act(async () => {
      for (let i = 0; i < 25; i++) window.dispatchEvent(new Event("grid:refresh"));
    });
    await flush();
    expect(
      getCell.mock.calls.length - readsBefore,
      "25 refresh events produced more than one re-read: the coalescing timer is gone",
    ).toBe(1);
  });

  it("stops listening when unmounted, so a stale ribbon cannot re-read", async () => {
    await act(async () => {
      root.unmount();
    });
    const readsBefore = getCell.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await flush();
    expect(getCell.mock.calls.length).toBe(readsBefore);
    // Re-mount so afterEach's unmount is harmless.
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
  });
});
