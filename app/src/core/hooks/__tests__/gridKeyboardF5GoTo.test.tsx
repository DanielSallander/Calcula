//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardF5GoTo.test.tsx
// PURPOSE: F5 belongs to the keybinding registry (navigate.goTo, Excel's Go To
//          dialog), so the grid's own keyboard handler must leave it alone.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) useGridKeyboard sent F5
//          to the Name Box itself ('navigate.focusNameBox'), hard-coded beside
//          the registry. With the registry's F5 -> navigate.goTo added, one press
//          could reach BOTH: the dispatcher stops a matched key in the window's
//          capture phase, but whenever it stands down (its binding refused, a
//          remap moving Go To elsewhere) the grid's copy fired anyway -- and a
//          user who remapped Go To would find F5 still doing something. Drives
//          the REAL hook (harness of gridKeyboardLayoutKeys).

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
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const commands: string[] = [];
let containerEl: HTMLDivElement;

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    onDelete: async () => {},
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

async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    containerEl.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
}

beforeEach(async () => {
  commands.length = 0;
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
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("F5 is the registry's (Go To), not the grid's", () => {
  it("bare F5: the grid sends no command and does not take the key", async () => {
    const e = await press({ key: "F5", code: "F5" });
    expect(commands, "the grid still sends F5 somewhere of its own").toEqual([]);
    expect(e.defaultPrevented, "the grid swallowed F5 that the registry owns").toBe(false);
  });

  it("control: F9 is still the grid's (Calculate Now), so the harness does see function keys", async () => {
    const e = await press({ key: "F9", code: "F9" });
    expect(commands).toEqual(["calculate.now"]);
    expect(e.defaultPrevented).toBe(true);
  });
});
