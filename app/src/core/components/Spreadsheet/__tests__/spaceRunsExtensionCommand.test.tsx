//! FILENAME: app/src/core/components/Spreadsheet/__tests__/spaceRunsExtensionCommand.test.tsx
// PURPOSE: Space on a legacy style-flag checkbox reaches the Checkbox
//          extension's `checkbox.toggle` -- and, generally, a keyboard command
//          Core does not handle itself runs from whichever registry holds it.
// CONTEXT: Y9 (wave E; wave D lifecycle fix-up NEW defect 1). useGridKeyboard's
//          bare-Space fallback calls onCommand("checkbox.toggle"); Core's
//          handleCommand (useSpreadsheetSelection) had no such case and logged
//          "Unknown command", while the Checkbox extension registers that
//          command with the EXTENSION registry (ExtensionRegistry
//          .registerCommand). Nothing bridged the two: a bare Space never
//          toggled a legacy checkbox. Driven through the REAL hook, the real
//          keyboard handler and the real @api registries.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../lib/tauri-api", () => ({
  getCell: vi.fn(async () => null),
  getMergeInfo: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  setColumnWidth: vi.fn(async () => {}),
  setRowHeight: vi.fn(async () => {}),
  clearRange: vi.fn(async () => {}),
  clearRangeOnSheets: vi.fn(async () => []),
  undo: vi.fn(async () => null),
  redo: vi.fn(async () => null),
  applyFormatting: vi.fn(async () => []),
  getStyle: vi.fn(async () => null),
  getAllStyles: vi.fn(async () => []),
  getCellsInCols: vi.fn(async () => []),
  getCellsInRows: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => null),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  fillRange: vi.fn(async () => []),
  calculateNow: vi.fn(async () => []),
  calculateSheet: vi.fn(async () => []),
  recalcControlDependents: vi.fn(async () => []),
  getAllColumnWidths: vi.fn(async () => []),
  getAllRowHeights: vi.fn(async () => []),
  getDefaultDimensions: vi.fn(async () => ({ defaultColumnWidth: 64, defaultRowHeight: 20 })),
  getViewportCells: vi.fn(async () => []),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => {}),
  applyColsHidden: vi.fn(async () => {}),
  refreshUserHidden: vi.fn(async () => {}),
}));

import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setActiveSheet, setSelection } from "../../../state/gridActions";
import { __resetExternalEditForTests } from "../../../lib/formulaEditTarget";
import {
  registerExtensionRegistryService,
  type CommandContext,
  type CommandDefinition,
  type ExtensionRegistryService,
} from "../../../../api/extensions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// --- The EXTENSION registry, holding the Checkbox extension's command -------
const extensionCommands = new Map<string, CommandDefinition>();
registerExtensionRegistryService({
  registerCommand: (c: CommandDefinition) => void extensionCommands.set(c.id, c),
  unregisterCommand: (c: CommandDefinition) => {
    if (extensionCommands.get(c.id) === c) extensionCommands.delete(c.id);
  },
  getCommand: (id: string) => extensionCommands.get(id),
  getAllCommands: () => [...extensionCommands.values()],
} as unknown as ExtensionRegistryService);

let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let focusEl: HTMLDivElement | null = null;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);
  dispatchOut = dispatch;
  useSpreadsheetSelection({
    canvasRef,
    containerRef,
    focusContainerRef,
    scrollRef,
    state,
    dispatch,
    isFocused: true,
    onCommitBeforeSelect: async () => {},
  });
  return (
    <div ref={containerRef}>
      <div
        ref={(el) => {
          focusContainerRef.current = el;
          focusEl = el;
        }}
        data-focus-container="spreadsheet"
        tabIndex={0}
      />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(key: string): Promise<void> {
  await act(async () => {
    focusEl!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(async () => {
  __resetExternalEditForTests();
  extensionCommands.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Harness />
      </GridProvider>,
    );
  });
  await act(async () => {
    dispatchOut(setActiveSheet(0, "Sheet1"));
    dispatchOut(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe("Space on a cell no cell type claims (Y9)", () => {
  it("runs the extension registry's checkbox.toggle -- with the grid's selection in its context", async () => {
    const seen: CommandContext[] = [];
    extensionCommands.set("checkbox.toggle", {
      id: "checkbox.toggle",
      name: "Toggle Checkbox",
      execute: (ctx) => void seen.push(ctx),
    });
    await press(" ");
    expect(seen.length, "Space never reached the Checkbox extension's toggle").toBe(1);
    expect(seen[0].selection).toMatchObject({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
  });

  it("with no extension holding the command, it runs nothing and says so once (control)", async () => {
    const warn = vi.mocked(console.warn);
    await press(" ");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("checkbox.toggle"))).toBe(true);
  });

  it("a command that REJECTS never leaves an unhandled rejection (wave F, Z7)", async () => {
    // Space -> onCommand("checkbox.toggle") ran inside an un-awaited async
    // IIFE, and the keyboard's onCommand wrapper let a rejection through: a
    // toggle the backend refused (a legacy checkbox inside a pivot/report
    // output region) became an UNHANDLED rejection. The refusal's owner says
    // why (the Checkbox extension's toast); the key handler must only not drop
    // the promise on the floor.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ran = vi.fn(async () => {
        throw "Cannot change cell (3, 2): it is part of a PivotTable.";
      });
      extensionCommands.set("checkbox.toggle", { id: "checkbox.toggle", name: "Toggle Checkbox", execute: ran });
      await press(" ");
      await settle();
      expect(ran, "Space never reached the command: the test proves nothing").toHaveBeenCalledTimes(1);
      expect(unhandled, "the refused toggle's rejection was left unhandled").toEqual([]);
      expect(
        error.mock.calls.some((c) => c.some((a) => String(a).includes("it is part of a PivotTable"))),
        "the rejection was swallowed without a trace",
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ANY key's command that rejects (F11 here) never leaves an unhandled rejection (wave F, Z7)", async () => {
    // Every other key calls onCommand without awaiting it; the keyboard's
    // onCommand wrapper is what keeps a rejection from going unhandled there.
    const { CommandRegistry } = await import("../../../../api/commands");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("chart dialog unavailable");
    });
    CommandRegistry.register("insert.chart", failing);
    try {
      await press("F11");
      await settle();
      expect(failing, "F11 never reached the command: the test proves nothing").toHaveBeenCalledTimes(1);
      expect(unhandled, "the key's rejected command was left unhandled").toEqual([]);
      expect(error.mock.calls.some((c) => c.some((a) => String(a).includes("chart dialog unavailable")))).toBe(true);
    } finally {
      CommandRegistry.unregister("insert.chart");
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("F11 runs the registered insert.chart command -- the Insert > Chart door (wave F, Z9)", async () => {
    // F11 sent "insert.chart", and handleCommand forwarded it to
    // CommandRegistry.execute('charts.insertChart'), an id nothing registers:
    // the key did nothing. The Charts extension registers insert.chart
    // (opening the same create dialog as Insert > Chart...); Core only routes.
    const { CommandRegistry } = await import("../../../../api/commands");
    const opened = vi.fn();
    CommandRegistry.register("insert.chart", opened);
    try {
      await press("F11");
      expect(opened, "F11 never reached the registered insert.chart command").toHaveBeenCalledTimes(1);
    } finally {
      CommandRegistry.unregister("insert.chart");
    }
  });

  it("an extension command that is DISABLED for this context is not run", async () => {
    const ran = vi.fn();
    extensionCommands.set("checkbox.toggle", {
      id: "checkbox.toggle",
      name: "Toggle Checkbox",
      isEnabled: () => false,
      execute: ran,
    });
    await press(" ");
    expect(ran, "a command its isEnabled refused ran anyway").not.toHaveBeenCalled();
  });
});
