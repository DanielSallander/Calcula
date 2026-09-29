//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardLayoutKeys.test.tsx
// PURPOSE: The grid's date and number-format keys work on a keyboard layout
//          whose shifted digits are not US symbols (sv-SE), because they are
//          matched on the PHYSICAL digit key, the way Excel binds them.
// CONTEXT: D5 (wa-keys fixup). useGridKeyboard matched the TYPED character.
//          On sv-SE, Ctrl+; is typed Ctrl+Shift+comma (";" is Shift+comma),
//          and Shift+2 / Shift+4 / Shift+6 type '"', a currency sign and "&"
//          instead of "@", "$" and "^" -- so Insert Date, Time format, Currency
//          and Scientific were dead keys on the owner's own layout. The fix
//          reads `event.code` (Digit1..Digit6) for the digit shortcuts and
//          accepts ";" with Shift; synthetic events with no `code` (and every
//          US keystroke) still match by character. Drives the REAL hook
//          (harness of gridKeyboardSelectionOwner).

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

const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

/** [label, the keystroke as sv-SE reports it, the command Excel runs for that physical key] */
const SV_SE: [string, KeyboardEventInit, string][] = [
  ["Ctrl+; typed Ctrl+Shift+comma", { key: ";", code: "Comma", ...CTRL_SHIFT }, "edit.insertDate"],
  ["Ctrl+Shift+1 (types !)", { key: "!", code: "Digit1", ...CTRL_SHIFT }, "format.numberNumber"],
  ["Ctrl+Shift+2 (types \")", { key: '"', code: "Digit2", ...CTRL_SHIFT }, "format.numberTime"],
  ["Ctrl+Shift+3 (types #)", { key: "#", code: "Digit3", ...CTRL_SHIFT }, "format.numberDate"],
  ["Ctrl+Shift+4 (types the currency sign)", { key: "¤", code: "Digit4", ...CTRL_SHIFT }, "format.numberCurrency"],
  ["Ctrl+Shift+5 (types %)", { key: "%", code: "Digit5", ...CTRL_SHIFT }, "format.numberPercentage"],
  ["Ctrl+Shift+6 (types &)", { key: "&", code: "Digit6", ...CTRL_SHIFT }, "format.numberScientific"],
  ["Ctrl+Shift+. (types :)", { key: ":", code: "Period", ...CTRL_SHIFT }, "edit.insertTime"],
];

describe("sv-SE: the date and number-format keys follow the physical key", () => {
  for (const [label, init, command] of SV_SE) {
    it(`${label} -> ${command}`, async () => {
      const e = await press(init);
      expect(commands, `${label} was a dead key`).toEqual([command]);
      expect(e.defaultPrevented).toBe(true);
    });
  }
});

describe("a layout whose digits need Shift (fr-FR AZERTY): the physical digit still decides", () => {
  it("Ctrl+Shift+Digit4 (types 4) -> Currency", async () => {
    await press({ key: "4", code: "Digit4", ...CTRL_SHIFT });
    expect(commands).toEqual(["format.numberCurrency"]);
  });

  it("Ctrl+Digit2 unshifted (types an accented e) -> Bold, as Ctrl+2 is", async () => {
    await press({ key: "é", code: "Digit2", ctrlKey: true });
    expect(commands).toEqual(["format.toggleBold"]);
  });
});

describe("US layout and synthetic events are unchanged", () => {
  const US: [string, KeyboardEventInit, string][] = [
    ["Ctrl+; (US)", { key: ";", code: "Semicolon", ctrlKey: true }, "edit.insertDate"],
    ["Ctrl+Shift+; types : on US -> Insert TIME, not date", { key: ":", code: "Semicolon", ...CTRL_SHIFT }, "edit.insertTime"],
    ["Ctrl+Shift+$ with its code", { key: "$", code: "Digit4", ...CTRL_SHIFT }, "format.numberCurrency"],
    ["Ctrl+Shift+$ with no code (synthetic)", { key: "$", ...CTRL_SHIFT }, "format.numberCurrency"],
    ["Ctrl+Shift+@ with no code (synthetic)", { key: "@", ...CTRL_SHIFT }, "format.numberTime"],
    ["Ctrl+Shift+^ with no code (synthetic)", { key: "^", ...CTRL_SHIFT }, "format.numberScientific"],
    ["Ctrl+Shift+~ (General)", { key: "~", code: "Backquote", ...CTRL_SHIFT }, "format.numberGeneral"],
    ["Ctrl+2 (bold, US)", { key: "2", code: "Digit2", ctrlKey: true }, "format.toggleBold"],
    ["Ctrl+Numpad5 keeps its character match (strikethrough)", { key: "5", code: "Numpad5", ctrlKey: true }, "format.toggleStrikethrough"],
  ];
  for (const [label, init, command] of US) {
    it(`${label} -> ${command}`, async () => {
      await press(init);
      expect(commands).toEqual([command]);
    });
  }
});

describe("keys that must stay unbound", () => {
  it("a physical digit outside 1..6 with Ctrl+Shift runs nothing (sv-SE Ctrl+Shift+7 types /)", async () => {
    await press({ key: "/", code: "Digit7", ...CTRL_SHIFT });
    expect(commands).toEqual([]);
  });

  it("AltGr+4 (Ctrl+Alt on Windows, types $ on sv-SE) is not Ctrl+Shift+4: no Currency", async () => {
    await press({ key: "$", code: "Digit4", ctrlKey: true, altKey: true });
    expect(commands).toEqual([]);
  });

  it("the physical key beats the character: Ctrl+Shift+Digit7 that types $ is not Currency", async () => {
    await press({ key: "$", code: "Digit7", ...CTRL_SHIFT });
    expect(commands).toEqual([]);
  });

  it("Ctrl+Alt+; (AltGr) is not Insert Date", async () => {
    await press({ key: ";", code: "Comma", ctrlKey: true, altKey: true });
    expect(commands).toEqual([]);
  });
});
