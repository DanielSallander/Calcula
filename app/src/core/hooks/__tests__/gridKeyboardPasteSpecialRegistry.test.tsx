//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardPasteSpecialRegistry.test.tsx
// PURPOSE: Paste Special's shortcut has ONE source, the keybinding registry.
// CONTEXT: useGridKeyboard used to hard-code Ctrl+Alt+V as well. The
//          registry's capture-phase dispatcher took the key first while
//          Paste Special was on its default, so the hard-coded case looked
//          dead -- until the user rebound Paste Special in Settings: the
//          registry then no longer took Ctrl+Alt+V, the grid keyboard did, and
//          the old key still opened the dialog. Drives the REAL hook with the
//          REAL registry listener installed (initKeybindings), the grid
//          container marked as the spreadsheet focus container so the
//          grid-scoped command may run.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
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
import { initKeybindings, resetUserKeybinding, setUserKeybinding } from "../../../api/keybindings";
import { CommandRegistry } from "../../../api/commands";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PASTE_SPECIAL = "core.clipboard.pasteSpecial";
const gridCommands: string[] = [];
const pasteSpecial = vi.fn();

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    onCommand: async (command: string) => {
      gridCommands.push(command);
    },
  });
  React.useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);
  return (
    <div ref={ref} data-testid="grid" data-focus-container="spreadsheet" tabIndex={0}>
      <canvas />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let containerEl: HTMLDivElement;

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    containerEl.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(() => {
  initKeybindings();
});

beforeEach(async () => {
  gridCommands.length = 0;
  pasteSpecial.mockReset();
  CommandRegistry.register(PASTE_SPECIAL, pasteSpecial);
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
  resetUserKeybinding("core.pasteSpecial");
  CommandRegistry.unregister(PASTE_SPECIAL);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("Paste Special's key comes from the registry alone", () => {
  it("default: Ctrl+Alt+V on the grid runs Paste Special once, through the registry", async () => {
    await press("v", { ctrlKey: true, altKey: true });
    expect(pasteSpecial).toHaveBeenCalledTimes(1);
    expect(gridCommands, "the grid keyboard ran its own copy of the shortcut").toEqual([]);
  });

  it("rebound in Settings: Ctrl+Alt+V no longer opens Paste Special; the new key does", async () => {
    setUserKeybinding("core.pasteSpecial", "Ctrl+Shift+F9");
    await press("v", { ctrlKey: true, altKey: true });
    expect(pasteSpecial, "the registry still ran Paste Special on the old key").not.toHaveBeenCalled();
    expect(gridCommands, "Ctrl+Alt+V still opened Paste Special after the rebind").not.toContain(
      "clipboard.pasteSpecial",
    );

    await press("F9", { ctrlKey: true, shiftKey: true });
    expect(pasteSpecial, "the new key did not run Paste Special").toHaveBeenCalledTimes(1);
  });
});
