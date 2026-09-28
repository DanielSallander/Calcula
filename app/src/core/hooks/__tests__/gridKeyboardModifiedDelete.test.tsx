//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardModifiedDelete.test.tsx
// PURPOSE: The grid keyboard clears the selection on the BARE Delete and
//          Backspace only. With a modifier it is not a clear.
// CONTEXT: Review 2026-09-28. The onDelete branch accepted any modifier, and
//          nothing else binds a modified Delete: the registry's clear-contents
//          binding is exactly "Delete", and a floating range binds exactly
//          "Delete"/"Backspace". So while a floating range's cell owned the
//          selection -- Core's active cell HIDDEN under it -- Ctrl+Backspace
//          (Excel's "show the active cell", pressed out of habit), Shift+
//          Backspace (Excel's "collapse the selection to the active cell"),
//          Ctrl+Delete and Shift+Delete each cleared that hidden cell with a
//          real clearRange and an undo entry. Excel clears on none of them.
//
//          Drives the REAL hook with the harness of gridKeyboardExternalEdit.
//          The container's React fallback asks the same question
//          (externalEditContainerKeys.test.tsx, "modified Delete").

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return {
    fnLog: { enter: noop, exit: noop },
    stateLog: { action: noop },
    eventLog: { keyboard: noop },
  };
});

import { useGridKeyboard } from "../useGridKeyboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let deleteCalls = 0;
let containerEl: HTMLDivElement;

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
  });

  React.useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);

  return (
    <div ref={ref} data-testid="grid" tabIndex={0}>
      <canvas data-testid="canvas" />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function press(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    containerEl.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event.defaultPrevented;
}

describe("Delete and Backspace with a modifier are not a clear", () => {
  beforeEach(async () => {
    deleteCalls = 0;
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

  it("positive control: the bare Delete and Backspace clear the selection", async () => {
    expect(await press("Delete")).toBe(true);
    expect(await press("Backspace")).toBe(true);
    expect(deleteCalls).toBe(2);
  });

  const MODIFIED: [string, KeyboardEventInit][] = [
    ["Delete", { ctrlKey: true }],
    ["Delete", { shiftKey: true }],
    ["Delete", { altKey: true }],
    ["Delete", { metaKey: true }],
    ["Backspace", { ctrlKey: true }],
    ["Backspace", { shiftKey: true }],
    ["Backspace", { altKey: true }],
    ["Backspace", { ctrlKey: true, shiftKey: true }],
  ];
  for (const [key, init] of MODIFIED) {
    const mods = Object.keys(init).map((m) => m.replace("Key", "")).join("+");
    it(`${mods}+${key} does not clear the selection`, async () => {
      await press(key, init);
      expect(deleteCalls, `${mods}+${key} cleared the selection`).toBe(0);
    });
  }
});
