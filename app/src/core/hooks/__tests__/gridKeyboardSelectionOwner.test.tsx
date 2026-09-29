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
import { registerSelectionOwner, setSelectionRefusalAnnouncer } from "../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const commands: string[] = [];
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
    onDelete: async () => {
      deleteCalls += 1;
    },
    onCommand: async (command: string) => {
      commands.push(command);
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
