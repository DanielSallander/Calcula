//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.sheetIdentity.test.tsx
// PURPOSE: The in-cell editor stays on screen while the grid shows the edit's
//          OWN sheet -- decided by the sheet's identity (its name) -- whatever
//          index that sheet holds now; it steps aside only for ANOTHER sheet
//          (cross-sheet point mode).
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. The tab strip's discard
//          of a temporary sheet landed while an edit was open on Summary and
//          moved Summary from index 3 to 2. The editor compared indices
//          (`editing.sourceSheetIndex !== activeSheetIndex`), decided it was
//          "on a different sheet", and unmounted under the user's typing. The
//          edit's index here is deliberately left STALE (3) -- the reducer's
//          rebase is not under test -- so the editor's own rule is.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: vi.fn(async () => []),
}));
vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));

import { InlineEditor } from "./InlineEditor";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setActiveSheet, setSheetContext } from "../../state/gridActions";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type EditingCell,
  type GridConfig,
  type GridState,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1000,
  totalCols: 100,
};

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 20 };

/** An edit opened on Summary when Summary was sheet 3; never rebased here. */
const EDIT_ON_SUMMARY: EditingCell = { row: 3, col: 2, value: "42", sourceSheetIndex: 3, sourceSheetName: "Summary" };

let root: Root;
let host: HTMLDivElement;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"] | null = null;

function DispatchProbe(): null {
  dispatchOut = useGridContext().dispatch;
  return null;
}

function stateOn(index: number, name: string): GridState {
  return { ...getInitialState(), sheetContext: { activeSheetIndex: index, activeSheetName: name } };
}

async function mount(initial: GridState, editing: EditingCell = EDIT_ON_SUMMARY): Promise<void> {
  await act(async () => {
    root.render(
      <GridProvider initialState={initial}>
        <DispatchProbe />
        <InlineEditor
          editing={editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={() => {}}
          onCommit={async () => true}
          onCancel={() => {}}
        />
      </GridProvider>,
    );
  });
}

function editorShown(): boolean {
  return host.querySelector("[data-inline-editor]") !== null;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  dispatchOut = null;
});

describe("InlineEditor: on the edit's own sheet by IDENTITY, not by index", () => {
  it("the edit's sheet RENUMBERED under the open edit (3 -> 2): the editor stays", async () => {
    await mount(stateOn(3, "Summary"));
    expect(editorShown(), "precondition: the editor is up on its sheet").toBe(true);

    // The strip's discard lands: Core's context follows Summary to index 2.
    await act(async () => {
      dispatchOut!(setSheetContext(2, "Summary"));
    });
    expect(editorShown(), "the editor unmounted from its own sheet").toBe(true);
  });

  it("mounted on the renumbered sheet straight away: the editor is shown", async () => {
    await mount(stateOn(2, "Summary"));
    expect(editorShown()).toBe(true);
  });

  it("ANOTHER sheet slid into the edit's old index: the editor steps aside (it is not the edit's sheet)", async () => {
    await mount(stateOn(3, "Extra"));
    expect(editorShown(), "the editor was drawn over a sheet that is not its own").toBe(false);
  });

  it("control: cross-sheet point mode -- away and back -- still hides and re-shows it", async () => {
    await mount(stateOn(3, "Summary"));
    await act(async () => {
      dispatchOut!(setActiveSheet(1, "Costs"));
    });
    expect(editorShown()).toBe(false);
    await act(async () => {
      dispatchOut!(setActiveSheet(3, "Summary"));
    });
    expect(editorShown()).toBe(true);
  });
});

// Review F1-rename-refuses-entry (round 5): by NAME, a rename of the edited
// sheet -- an MCP or script rename re-reads the sheets and moves Core's context
// to the same sheet under its new name -- unmounted the editor while the user
// was typing. By the STABLE id the editor stays.
describe("InlineEditor: a RENAME of the edit's own sheet keeps the editor (by the stable id)", () => {
  const EDIT_WITH_ID: EditingCell = { ...EDIT_ON_SUMMARY, sourceSheetId: "S-summary" };

  function stateWithId(index: number, name: string, id: string): GridState {
    return { ...getInitialState(), sheetContext: { activeSheetIndex: index, activeSheetName: name, activeSheetId: id } };
  }

  it("the context arrives at the same id under a NEW name: the editor stays mounted", async () => {
    await mount(stateWithId(3, "Summary", "S-summary"), EDIT_WITH_ID);
    expect(editorShown(), "precondition: the editor is up on its sheet").toBe(true);
    await act(async () => {
      dispatchOut!(setSheetContext(3, "Totals", undefined, "S-summary"));
    });
    expect(editorShown(), "the rename unmounted the editor from its own sheet").toBe(true);
  });

  it("another sheet (another id) under the edit's OWN name is not its sheet: the editor steps aside", async () => {
    await mount(stateWithId(3, "Summary", "S-other"), EDIT_WITH_ID);
    expect(editorShown(), "a namesake with another id was taken for the edit's sheet").toBe(false);
  });
});
