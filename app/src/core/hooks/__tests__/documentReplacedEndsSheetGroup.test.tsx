//! FILENAME: app/src/core/hooks/__tests__/documentReplacedEndsSheetGroup.test.tsx
// PURPOSE: Replacing the document -- File > New, File > Open, a checkout --
//          ENDS the sheet group, on every replacement path, before AFTER_NEW /
//          AFTER_OPEN; so typing into the new workbook's Sheet1 never also
//          writes its Sheet2 off screen. Driven through the REAL file-api
//          replacement paths, the real sheet-grouping store and the REAL
//          useEditing commit against a fake backend whose
//          `update_cell_on_sheets` answers the sheets it wrote.
// CONTEXT: Review rev5C#2 (BUG-0350). The group is Core module state keyed by
//          sheet INDEX, and only a tab click, an ordinary switch outside it and
//          a renumbering changed it. newFile / openFileAtPath /
//          announceBackendStateReplaced fire no sheet switch, and the new
//          document opens on index 0 -- usually a member of the old group -- so
//          the stale group stayed live: Sheet1 + Sheet2 grouped, File > Open a
//          3-sheet workbook, type 5 into A1 -> the opened workbook's Sheet2!A1
//          got 5 too, and the strip painted the stale group as live.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const backend = vi.hoisted(() => ({
  active: 0,
  writes: [] as Array<{ sheet: number; value: string }>,
  /** Every sheet list the replication was asked for. */
  replications: [] as number[][],
}));

const tracedInvoke = vi.hoisted(() =>
  vi.fn(async (cmd: string) => {
    if (cmd === "open_file") return [];
    if (cmd === "keychain_get_password") return null;
    return undefined;
  }),
);
vi.mock("../../../utils/bridge", () => ({ tracedInvoke: (...a: unknown[]) => tracedInvoke(...(a as [string])) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  getSheets: vi.fn(async () => ({
    sheets: ["Sheet1", "Sheet2", "Sheet3"].map((name, index) => ({ index, name, sheetId: `S${index + 1}`, visibility: "visible" })),
    activeIndex: backend.active,
  })),
  setActiveSheet: vi.fn(async () => undefined),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    backend.writes.push({ sheet: backend.active, value });
    return { cells: [{ row, col, display: value, formula: null }] };
  }),
  // Rust's `update_cell_on_sheets`: the ACTIVE sheet is skipped (`update_cell`
  // wrote it), and the answer is the sheets it actually wrote.
  updateCellOnSheets: vi.fn(async (indices: number[], _row: number, _col: number, value: string) => {
    backend.replications.push([...indices]);
    const wrote: number[] = [];
    for (const index of indices) {
      if (index === backend.active) continue;
      backend.writes.push({ sheet: index, value });
      wrote.push(index);
    }
    return wrote;
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => undefined),
  confirmAsync: vi.fn(async () => true),
}));

import { useEditing, setGlobalIsEditing } from "../useEditing";
import { GridProvider } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { __resetExternalEditForTests } from "../../lib/formulaEditTarget";
import {
  clearSheetGrouping,
  getGroupForActiveSheet,
  isSheetGroupingActive,
  setSelectedSheetIndices,
} from "../../state/sheetGrouping";
import { announceBackendStateReplaced, newFile, openFileAtPath } from "../../lib/file-api";
import { AppEvents, onAppEvent } from "../../lib/events";
import type { GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let api: ReturnType<typeof useEditing> | null = null;

function Harness(): null {
  api = useEditing();
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const offs: (() => void)[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function stateOnSheet1(): GridState {
  return {
    ...getInitialState(),
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "S1" },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  };
}

async function mountOnSheet1(): Promise<void> {
  backend.active = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <GridProvider initialState={stateOnSheet1()}>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
}

/** Type `value` into A1 and press Enter, through the real useEditing. */
async function typeIntoA1(value: string): Promise<void> {
  await act(async () => {
    await api!.startEdit(0, 0, value);
  });
  await settle();
  await act(async () => {
    await api!.commitEdit();
  });
  await settle();
}

/** The group as the FIRST listener of `event` sees it. */
function groupAt(event: string): { seen: number[] | null } {
  const at = { seen: null as number[] | null };
  offs.push(
    onAppEvent(event, () => {
      if (at.seen === null) at.seen = getGroupForActiveSheet(0);
    }),
  );
  return at;
}

beforeEach(() => {
  backend.active = 0;
  backend.writes = [];
  backend.replications = [];
  tracedInvoke.mockClear();
  __resetExternalEditForTests();
  setGlobalIsEditing(false);
  clearSheetGrouping();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  while (offs.length > 0) offs.pop()!();
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  host?.remove();
  root = null;
  host = null;
  api = null;
  setGlobalIsEditing(false);
  __resetExternalEditForTests();
  clearSheetGrouping();
  vi.restoreAllMocks();
});

describe("rev5C#2: a document replacement ends the sheet group", () => {
  it("File > New ends it before AFTER_NEW, whose listeners act on the new document", async () => {
    setSelectedSheetIndices([0, 1]);
    const atAfterNew = groupAt(AppEvents.AFTER_NEW);
    await newFile();
    expect(atAfterNew.seen, "AFTER_NEW listeners saw the old document's sheet group").toEqual([]);
    expect(isSheetGroupingActive()).toBe(false);
    expect(getGroupForActiveSheet(0)).toEqual([]);
  });

  it("File > Open ends it before AFTER_OPEN", async () => {
    setSelectedSheetIndices([0, 1]);
    const atAfterOpen = groupAt(AppEvents.AFTER_OPEN);
    await openFileAtPath("C:/Books/Other.cala");
    expect(atAfterOpen.seen, "AFTER_OPEN listeners saw the old document's sheet group").toEqual([]);
    expect(isSheetGroupingActive()).toBe(false);
  });

  it("any other replacement (calp_checkout calls announceBackendStateReplaced) ends it too", () => {
    setSelectedSheetIndices([0, 2]);
    announceBackendStateReplaced();
    expect(isSheetGroupingActive(), "a checkout kept the old document's sheet group").toBe(false);
  });

  it("control: a FAILED File > New keeps the group (the old document is still there)", async () => {
    setSelectedSheetIndices([0, 1]);
    tracedInvoke.mockRejectedValueOnce(new Error("backend busy"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(newFile()).rejects.toThrow(/backend busy/);
    expect(getGroupForActiveSheet(0)).toEqual([0, 1]);
  });

  it("typing into the opened workbook's Sheet1 writes Sheet1 ONLY -- never its Sheet2 off screen", async () => {
    setSelectedSheetIndices([0, 1]);
    await mountOnSheet1();
    await openFileAtPath("C:/Books/ThreeSheets.cala");
    await typeIntoA1("5");

    expect(
      backend.replications,
      "the old document's group replicated the entry onto the opened workbook's Sheet2",
    ).toEqual([]);
    expect(backend.writes).toEqual([{ sheet: 0, value: "5" }]);
  });

  it("control: with no replacement the same group still replicates the entry", async () => {
    setSelectedSheetIndices([0, 1]);
    await mountOnSheet1();
    await typeIntoA1("5");

    expect(backend.replications).toEqual([[1]]);
    expect(backend.writes).toEqual([
      { sheet: 0, value: "5" },
      { sheet: 1, value: "5" },
    ]);
  });
});
