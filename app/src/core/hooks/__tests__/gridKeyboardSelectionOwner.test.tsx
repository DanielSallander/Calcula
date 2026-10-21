//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardSelectionOwner.test.tsx
// PURPOSE: Core's own grid keyboard does not WRITE to Core's selection while a
//          selection owner holds the selection: the format keys (Ctrl+B/I/U,
//          Ctrl+2..5, the Ctrl+Shift number formats), Ctrl+; / Ctrl+Shift+:,
//          Ctrl+Alt+V, F11, Space and the bare Delete/Backspace refuse with one
//          announcement. Navigation still moves.
// CONTEXT: BUG-0185. With a floating grid's cell selected, Core's selection is
//          a cell HIDDEN under the floating grid and the grid container keeps
//          the keyboard. The floating grid used to refuse these combos one by
//          one with bindings on their default keys; since E7 it claims the
//          selection instead, and the claim is answered HERE, at the one Core
//          door, whatever the key. Drives the REAL hook (harness of
//          gridKeyboardModifiedDelete).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));
vi.mock("../../../api/cellTypes", () => ({ handleCellTypeKeyDown: vi.fn(async () => false) }));
vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return { fnLog: { enter: noop, exit: noop }, stateLog: { action: noop }, eventLog: { keyboard: noop } };
});

import { useGridKeyboard } from "../useGridKeyboard";
import { GridProvider, useGridContext, getGridStateSnapshot } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";
import {
  registerSelectionOwner,
  setSelectionRefusalAnnouncer,
  CELL_TARGET_CAPABILITIES,
  type CellTarget,
  type CellTargetCapability,
} from "../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const commands: string[] = [];
/** The target each command / Delete was handed (P3), in order. */
const targets: (CellTarget | undefined)[] = [];
const deleteTargets: (CellTarget | undefined)[] = [];
let deleteCalls = 0;
let containerEl: HTMLDivElement;
const announced: string[] = [];

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    onDelete: async (target?: CellTarget) => {
      deleteCalls += 1;
      deleteTargets.push(target);
    },
    onCommand: async (command: string, target?: CellTarget) => {
      commands.push(command);
      targets.push(target);
    },
  });
  React.useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);
  return (
    <div ref={ref} data-testid="grid" tabIndex={0}>
      <canvas />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let release: () => void = () => {};
let owns = false;

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    containerEl.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  commands.length = 0;
  targets.length = 0;
  deleteTargets.length = 0;
  deleteCalls = 0;
  announced.length = 0;
  setSelectionRefusalAnnouncer((m) => announced.push(m));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
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
  containerEl = host.querySelector("[data-testid='grid']") as HTMLDivElement;
  containerEl.focus();
});

afterEach(async () => {
  release();
  setSelectionRefusalAnnouncer(null);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

/** [label, key, init, the command the key runs] -- every grid-keyboard WRITE. */
const WRITES: [string, string, KeyboardEventInit, string][] = [
  ["Ctrl+B", "b", { ctrlKey: true }, "format.toggleBold"],
  ["Ctrl+I", "i", { ctrlKey: true }, "format.toggleItalic"],
  ["Ctrl+U", "u", { ctrlKey: true }, "format.toggleUnderline"],
  ["Ctrl+2", "2", { ctrlKey: true }, "format.toggleBold"],
  ["Ctrl+5", "5", { ctrlKey: true }, "format.toggleStrikethrough"],
  ["Ctrl+Shift+$", "$", { ctrlKey: true, shiftKey: true }, "format.numberCurrency"],
  ["Ctrl+Shift+%", "%", { ctrlKey: true, shiftKey: true }, "format.numberPercentage"],
  ["Ctrl+Shift+~", "~", { ctrlKey: true, shiftKey: true }, "format.numberGeneral"],
  ["Ctrl+;", ";", { ctrlKey: true }, "edit.insertDate"],
  ["Ctrl+Shift+:", ":", { ctrlKey: true, shiftKey: true }, "edit.insertTime"],
  ["Ctrl+Alt+V", "v", { ctrlKey: true, altKey: true }, "clipboard.pasteSpecial"],
  ["F11", "F11", {}, "insert.chart"],
  ["Space", " ", {}, "checkbox.toggle"],
];

describe("the grid keyboard while a selection owner holds the selection", () => {
  for (const [label, key, init, command] of WRITES) {
    it(`${label}: ${command} is not run; one announcement`, async () => {
      owns = true;
      await press(key, init);
      expect(commands, `${label} wrote to Core's hidden selection`).toEqual([]);
      expect(announced.length).toBe(1);
    });
  }

  it("bare Delete and Backspace do not clear Core's hidden selection", async () => {
    owns = true;
    await press("Delete");
    await press("Backspace");
    expect(deleteCalls).toBe(0);
    expect(announced.length).toBe(2);
  });

  it("navigation is not a write: ArrowDown still moves Core's selection, nothing announced", async () => {
    owns = true;
    await press("ArrowDown");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(getGridStateSnapshot()?.selection?.endRow).toBe(3);
    expect(announced).toEqual([]);
  });
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, key, init, command] of WRITES) {
    it(`${label}: runs ${command}`, async () => {
      await press(key, init);
      expect(commands).toEqual([command]);
      expect(announced).toEqual([]);
    });
  }

  it("bare Delete clears", async () => {
    await press("Delete");
    expect(deleteCalls).toBe(1);
  });
});

// ============================================================================
// P3 S9: an owner that ANSWERS its cells (a floating grid's claim)
// ============================================================================

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const FR_SELECTION = { startRow: 4, startCol: 1, endRow: 4, endCol: 1, activeRow: 4, activeCol: 1, type: "cells" as const };
const ADMITTED = CELL_TARGET_CAPABILITIES.filter((c) => c !== "table" && c !== "filter" && c !== "shiftCells");

/** Replace the test owner by a double of the floating grid's claim. */
function floatingGrid(actsOn?: readonly CellTargetCapability[]): void {
  release();
  release = registerSelectionOwner({
    id: "floatingRange",
    label: "a floating grid's cells",
    ownsSelection: () => true,
    cellTarget: () => ({ ref: REF, selection: { ...FR_SELECTION }, bounds: { rows: 10, cols: 4 }, label: "Float1", wholeObject: false }),
    ...(actsOn ? { actsOn } : {}),
  });
}

/** The keys whose command may act on an owner's cells, and the rest. */
const TARGETED = WRITES.filter(([, , , c]) => c.startsWith("format.") || c === "clipboard.pasteSpecial");
const REFUSED = WRITES.filter(([, , , c]) => !TARGETED.some(([, , , t]) => t === c));

describe("a floating grid that admits the act: the keyboard hands its cells on", () => {
  it("the two lists split the keys as intended (the filter is not blind)", () => {
    expect(TARGETED.length).toBeGreaterThan(5);
    expect(REFUSED.map(([, , , c]) => c).sort()).toEqual(["checkbox.toggle", "edit.insertDate", "edit.insertTime", "insert.chart"]);
  });

  for (const [label, key, init, command] of TARGETED) {
    it(`${label}: runs ${command} with the grid's target, nothing announced`, async () => {
      floatingGrid(ADMITTED);
      await press(key, init);
      expect(commands).toEqual([command]);
      expect(targets[0]).toMatchObject({ kind: "object", ref: REF, selection: FR_SELECTION });
      expect(announced).toEqual([]);
    });
  }

  for (const [label, key, init, command] of REFUSED) {
    it(`${label}: ${command} has no target route and still refuses, once`, async () => {
      floatingGrid(ADMITTED);
      await press(key, init);
      expect(commands).toEqual([]);
      expect(announced.length).toBe(1);
    });
  }

  it('Delete hands the grid\'s target to the clear ("clear")', async () => {
    floatingGrid(ADMITTED);
    await press("Delete");
    expect(deleteCalls).toBe(1);
    expect(deleteTargets[0]).toMatchObject({ kind: "object", ref: REF });
    expect(announced).toEqual([]);
  });

  it('an owner admitting "format" only refuses the number-format keys', async () => {
    floatingGrid(["format"]);
    await press("b", { ctrlKey: true });
    await press("%", { ctrlKey: true, shiftKey: true });
    expect(commands).toEqual(["format.toggleBold"]);
    expect(announced.length).toBe(1);
  });

  it("with no owner the commands receive the GRID target", async () => {
    release();
    release = () => {};
    await press("b", { ctrlKey: true });
    expect(commands).toEqual(["format.toggleBold"]);
    expect(targets[0]).toMatchObject({ kind: "grid" });
  });
});

describe("inert until S8: a floating-grid owner that admits NOTHING refuses every key", () => {
  for (const [label, key, init, command] of WRITES) {
    it(`${label}: ${command} is not run; one announcement`, async () => {
      floatingGrid(undefined);
      await press(key, init);
      expect(commands).toEqual([]);
      expect(announced.length).toBe(1);
    });
  }

  it("Delete refuses", async () => {
    floatingGrid(undefined);
    await press("Delete");
    expect(deleteCalls).toBe(0);
    expect(announced.length).toBe(1);
  });
});
