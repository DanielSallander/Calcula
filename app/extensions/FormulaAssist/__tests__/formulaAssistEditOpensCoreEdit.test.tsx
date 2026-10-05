//! FILENAME: app/extensions/FormulaAssist/__tests__/formulaAssistEditOpensCoreEdit.test.tsx
// PURPOSE: Formula Assist's "Edit" opens CORE's cell edit -- the real one, with
//          Core's "a cell edit is open" flag up -- holding the proposed
//          formula, on the cell the request is for.
// CONTEXT: Home tab 2026-10-04 (editing-ext suspicion, verified here). Edit
//          dispatched the raw `startEditing` grid ACTION, which writes the
//          editing state and nothing else: none of Core's open path ran -- no
//          edit guards (a protected cell, a PivotTable), no merge resolution,
//          no EDIT_STARTED, and above all no edit FLAG
//          (core/lib/cellEditFlag.ts). Every keyboard and pointer gate reads
//          that flag, so an editor opened that way was treated as absent: the
//          keybinding dispatcher ran workbook keys (Delete cleared the cells
//          under the open editor) and a click on a cell moved the selection
//          instead of picking a reference. AutoSum met the same trap and opens
//          its edit through `useEditing()` (extensions/AutoSum/lib/
//          editOpener.ts); Edit now opens through the same hook.
//
//          Driven through the REAL GridProvider, the REAL useEditing and the
//          REAL flag; only the Tauri wrappers Core's open path calls are
//          doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
}));

import { useGridContext, getGridStateSnapshot, setSelection, setActiveSheet } from "@api/grid";
import { registerEditGuard } from "@api/editGuards";
import { isCellEditInProgress, setGlobalIsEditing } from "@api/editing";
import type { FormulaProposal } from "@api/formulaAssistService";
import { FormulaAssistPopover } from "../components/FormulaAssistPopover";
import { getAssistState, openAssist, resetAssistStore, setAssistState } from "../lib/store";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The app's provider (Layout mounts it around every overlay). @api exports its
// hooks and actions, not the provider itself, so it is reached the way other
// extension tests reach a Core module they must run for real.
const { GridProvider } = await vi.importActual<typeof import("../../../src/core/state/GridContext")>(
  "../../../src/core/state/GridContext",
);
const { getInitialState } = await vi.importActual<typeof import("../../../src/core/state/gridReducer")>(
  "../../../src/core/state/gridReducer",
);

const TARGET = { sheetIndex: 0, row: 5, col: 2, a1: "C6", existingFormula: null as string | null };

function proposal(): FormulaProposal {
  return {
    status: "verified",
    formulaInvariant: "=SUM(B2:B6)",
    formulaLocalized: "=SUMMA(B2:B6)",
    explanation: "Adds up the Amount column.",
    assumptions: [],
    fillDown: false,
    verification: { verified: true, display: "500", fillDownDisplays: [], findings: [] },
    target: { sheetIndex: 0, row: 5, col: 2, a1: "C6" },
    rounds: 1,
    model: "test-model",
    summary: "Verified by Calcula's engine on C6.",
  };
}

let gridDispatch: React.Dispatch<unknown> | null = null;
function DispatchProbe(): null {
  gridDispatch = useGridContext().dispatch as React.Dispatch<unknown>;
  return null;
}

let host: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function select(row: number, col: number): Promise<void> {
  await act(async () => {
    gridDispatch!(setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" }));
  });
}

function editButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Edit");
  if (!button) throw new Error("no Edit button");
  return button as HTMLButtonElement;
}

async function clickEdit(): Promise<void> {
  await act(async () => {
    editButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  setGlobalIsEditing(false);
  resetAssistStore();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <DispatchProbe />
        <FormulaAssistPopover onClose={() => {}} />
      </GridProvider>,
    );
  });
  await select(TARGET.row, TARGET.col);
  await act(async () => {
    openAssist({ target: TARGET, anchor: null, intent: "sum the Amount column" });
    setAssistState({ proposal: proposal() });
  });
});

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
  await act(async () => {
    root.unmount();
  });
  host.remove();
  resetAssistStore();
  setGlobalIsEditing(false);
});

describe("Edit opens Core's own cell edit", () => {
  it("raises Core's edit flag (the raw grid action left it down)", async () => {
    await clickEdit();
    expect(isCellEditInProgress(), "the editor is open but Core's edit flag is down").toBe(true);
  });

  it("holds the LOCALIZED proposal on the target cell, uncommitted, and closes the popover", async () => {
    await clickEdit();
    const editing = getGridStateSnapshot()?.editing;
    expect(editing).toMatchObject({ row: 5, col: 2, value: "=SUMMA(B2:B6)" });
    expect(getAssistState().open).toBe(false);
  });

  it("puts the selection back on the target cell when it had moved, and edits THERE", async () => {
    await select(0, 0);
    await clickEdit();
    const state = getGridStateSnapshot();
    expect(state?.selection).toMatchObject({ startRow: 5, startCol: 2, endRow: 5, endCol: 2 });
    expect(state?.editing).toMatchObject({ row: 5, col: 2, value: "=SUMMA(B2:B6)" });
    expect(isCellEditInProgress()).toBe(true);
  });

  it("is REFUSED by an edit guard like every other way into a cell (the raw action skipped them)", async () => {
    cleanups.push(registerEditGuard(async () => ({ blocked: true, message: "You can't change this part of the PivotTable." })));
    await clickEdit();
    expect(getGridStateSnapshot()?.editing ?? null, "an edit opened past the guard").toBeNull();
    expect(isCellEditInProgress()).toBe(false);
    // The popover stays, and says why nothing opened.
    expect(getAssistState().open).toBe(true);
    expect(host.textContent).toContain("C6 could not be opened for editing");
  });

  it("is refused on ANOTHER sheet than the request's, saying so (it would edit the wrong sheet's C6)", async () => {
    await act(async () => {
      gridDispatch!(setActiveSheet(1, "Sheet2"));
    });
    await clickEdit();
    expect(getGridStateSnapshot()?.editing ?? null).toBeNull();
    expect(isCellEditInProgress()).toBe(false);
    expect(getAssistState().open).toBe(true);
    expect(host.textContent).toContain("on another sheet");
  });
});
