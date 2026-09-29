//! FILENAME: app/src/core/components/Spreadsheet/__tests__/editorAltGrTyping.test.tsx
// PURPOSE: On a layout with AltGr (sv-SE, de-DE, pl-PL, ...), a character typed
//          with AltGr STARTS a cell entry in ready mode and is kept while the
//          editor opens -- "@", "$", "{", "}", "\", "|", "~" and "EUR" are
//          ordinary characters there (E13).
// CONTEXT: Windows reports AltGr as Ctrl+Alt, so Chromium delivers AltGr+2 on
//          sv-SE as key "@" with ctrlKey AND altKey set. The grid container's
//          ready-mode test (useSpreadsheetEditing) and the open window's
//          (editOpenBuffer) both required "no Ctrl and no Alt", so the key
//          started nothing and was dropped: a cell entry could not begin with
//          "@" or "$" on the owner's own keyboard. Driven through the REAL
//          keybinding dispatcher first (api/keybindings.ts: the window-capture
//          listener the app installs, which runs BEFORE the grid container and
//          stops every keystroke it takes) and then the real container keydown
//          -> useEditing -> InlineEditor wiring, as in editorTypingRace.test.tsx.
//          Review B (2026-09-28): the first version dispatched on the grid
//          element with NO dispatcher installed and so claimed "[" starts an
//          entry -- in the app the dispatcher's layout tier read AltGr+8 as
//          Ctrl+[ (Previous Bookmark) and the key never reached the grid.
//          W17 (wave C, the owner's decision): TYPING WINS in ready mode. An
//          AltGr character typed with the grid's keyboard starts an entry;
//          a colliding shortcut (Ctrl+[ / Ctrl+], New Comment's Ctrl+Alt+M on
//          a layout where AltGr+M types the micro sign) stays reachable from
//          its menu, by a remap, and from the keyboard off the grid.
//          The harness container carries the app's focus-container attribute
//          (data-focus-container="spreadsheet"), so the dispatcher sees the
//          grid's keyboard exactly as it does in the app.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

let mergeGate: Array<() => void> = [];
let holdMergeInfo = false;

const getMergeInfo = vi.fn(async () => {
  if (holdMergeInfo) {
    await new Promise<void>((resolve) => {
      mergeGate.push(resolve);
    });
  }
  return null;
});

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: (...args: unknown[]) => getMergeInfo(...(args as [])),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null }],
  })),
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));
vi.mock("../../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

import { useSpreadsheetEditing } from "../useSpreadsheetEditing";
import { InlineEditor } from "../../InlineEditor";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import { isTypedCharacterKey } from "../../../lib/editOpenBuffer";
import { initKeybindings, resetAllKeybindings } from "../../../../api/keybindings";
import { CommandRegistry } from "../../../../api/commands";
import { registerSelectionOwner, setSelectionRefusalAnnouncer } from "../../../lib/selectionOwner";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type GridConfig,
  type Viewport,
} from "../../../types";

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

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);

  const { editingState, handlers } = useSpreadsheetEditing({
    containerRef,
    focusContainerRef,
    formulaInputRef,
    state,
    selectedCellContent: "",
    moveActiveCell: () => {},
    scrollToSelection: () => {},
    selectCell: () => {},
  });

  useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);

  return (
    <div
      ref={focusContainerRef}
      data-testid="grid"
      data-focus-container="spreadsheet"
      tabIndex={0}
      onKeyDown={handlers.handleContainerKeyDown}
    >
      {editingState.editing && editingState.isEditing && (
        <InlineEditor
          editing={editingState.editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={handlers.handleInlineValueChange}
          onCommit={handlers.handleInlineCommit}
          onCancel={handlers.handleInlineCancel}
          onTab={handlers.handleInlineTab}
          onEnter={handlers.handleInlineEnter}
          onCtrlEnter={handlers.handleInlineCtrlEnter}
          onRestoreFocus={() => focusContainerRef.current?.focus()}
          onArrowKeyReference={handlers.handleArrowKeyReference}
        />
      )}
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

const gridEl = (): HTMLDivElement => host.querySelector("[data-testid='grid']") as HTMLDivElement;
const editorEl = (): HTMLTextAreaElement | null => host.querySelector("[data-inline-editor]") as HTMLTextAreaElement | null;

async function mount(): Promise<void> {
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
}

/**
 * A keydown at the FOCUSED grid container -- so the app's window-capture
 * dispatcher hears it first. `altGr` = what Windows reports: Ctrl AND Alt;
 * `code` = the physical key (sv-SE: AltGr+2 is "@" on Digit2).
 */
async function pressOnGrid(
  key: string,
  mods: { altGr?: boolean; ctrlKey?: boolean; altKey?: boolean; code?: string } = {},
): Promise<void> {
  const init = mods.altGr ? { ctrlKey: true, altKey: true } : { ctrlKey: !!mods.ctrlKey, altKey: !!mods.altKey };
  const event = new KeyboardEvent("keydown", { key, code: mods.code ?? "", bubbles: true, cancelable: true, ...init });
  await act(async () => {
    gridEl().focus();
    gridEl().dispatchEvent(event);
    await Promise.resolve();
  });
}

async function releaseBackend(): Promise<void> {
  await act(async () => {
    const gates = mergeGate;
    mergeGate = [];
    for (const open of gates) open();
    await Promise.resolve();
    await Promise.resolve();
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeAll(() => {
  // The app's keybinding dispatcher, as the shell installs it at startup.
  initKeybindings();
});

beforeEach(() => {
  resetAllKeybindings();
  mergeGate = [];
  holdMergeInfo = true;
  getMergeInfo.mockClear();
  window.innerWidth = 1200;
  window.innerHeight = 800;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalIsEditing(false);
  holdMergeInfo = false;
  mergeGate = [];
});

describe("an AltGr character in ready mode (E13)", () => {
  // sv-SE: the character AltGr types, and the physical key it is on.
  const SV_SE_ALTGR: Array<[string, string]> = [
    ["@", "Digit2"],
    ["$", "Digit4"],
    ["€", "KeyE"],
    ["{", "Digit7"],
    ["}", "Digit0"],
    ["\\", "Minus"],
    ["|", "IntlBackslash"],
    ["~", "BracketRight"],
  ];
  for (const [ch, code] of SV_SE_ALTGR) {
    it(`AltGr "${ch}" (Ctrl+Alt as Windows reports it) passes the dispatcher and starts an entry holding "${ch}"`, async () => {
      await mount();
      await pressOnGrid(ch, { altGr: true, code });
      await releaseBackend();
      expect(editorEl(), `AltGr "${ch}" opened no editor`).not.toBeNull();
      expect(editorEl()?.value).toBe(ch);
    });
  }

  // The owner's decision (W17, wave C), flipping the KNOWN CONFLICT this test
  // pinned in wave B: Chromium on Windows cannot tell AltGr+8 from
  // Ctrl+AltGr+8, and the dispatcher's layout tier read it as Ctrl+[
  // (Previous Bookmark), so on sv-SE "[" and "]" could never START an entry.
  // In ready mode the character now wins; the bookmark keys stay what they
  // are everywhere else (keybindings.altGrReadyMode.test.ts).
  it.each([
    ["[", "Digit8"],
    ["]", "Digit9"],
  ])('AltGr "%s" starts an entry holding it -- Previous / Next Bookmark do not take it', async (ch, code) => {
    const ran: string[] = [];
    CommandRegistry.register("bookmarks.prev", () => void ran.push("bookmarks.prev"));
    CommandRegistry.register("bookmarks.next", () => void ran.push("bookmarks.next"));
    try {
      await mount();
      await pressOnGrid(ch, { altGr: true, code });
      await releaseBackend();
      expect(ran, `AltGr "${ch}" ran a bookmark command`).toEqual([]);
      expect(editorEl(), `AltGr "${ch}" opened no editor`).not.toBeNull();
      expect(editorEl()?.value).toBe(ch);
    } finally {
      CommandRegistry.unregister("bookmarks.prev");
      CommandRegistry.unregister("bookmarks.next");
    }
  });

  it('sv-SE AltGr+M (the micro sign) starts an entry -- New Comment (Ctrl+Alt+M) does not take it', async () => {
    const ran: string[] = [];
    CommandRegistry.register("review.newComment", () => void ran.push("review.newComment"));
    try {
      await mount();
      await pressOnGrid("µ", { altGr: true, code: "KeyM" });
      await releaseBackend();
      expect(ran).toEqual([]);
      expect(editorEl()?.value).toBe("µ");
    } finally {
      CommandRegistry.unregister("review.newComment");
    }
  });

  it("control: US Ctrl+[ (no AltGr) is still Previous Bookmark, and starts no entry", async () => {
    const ran: string[] = [];
    CommandRegistry.register("bookmarks.prev", () => void ran.push("bookmarks.prev"));
    try {
      await mount();
      await pressOnGrid("[", { ctrlKey: true, code: "BracketLeft" });
      await releaseBackend();
      expect(ran).toEqual(["bookmarks.prev"]);
      expect(editorEl()).toBeNull();
    } finally {
      CommandRegistry.unregister("bookmarks.prev");
    }
  });

  it("an AltGr character typed while the editor is still OPENING is kept, in order", async () => {
    await mount();
    await pressOnGrid("a");
    await pressOnGrid("@", { altGr: true });
    await pressOnGrid("b");
    await releaseBackend();
    expect(editorEl()?.value).toBe("a@b");
  });

  it("control: a Ctrl+Alt LETTER is a shortcut (Paste Special's Ctrl+Alt+V), never typed", async () => {
    await mount();
    await pressOnGrid("v", { ctrlKey: true, altKey: true });
    await releaseBackend();
    expect(editorEl()).toBeNull();
    expect(getMergeInfo).not.toHaveBeenCalled();
  });

  it("control: Ctrl alone or Alt alone never types", async () => {
    await mount();
    await pressOnGrid("@", { ctrlKey: true });
    await pressOnGrid("@", { altKey: true });
    await releaseBackend();
    expect(editorEl()).toBeNull();
  });
});

describe("a SELECTION OWNER claims Core's selection (review C)", () => {
  // A floating grid selected as a whole OBJECT claims the selection and leaves
  // the keyboard on the grid's container, with Core's own active cell hidden
  // under it. Typing, F2 and the bare Backspace began an entry in THAT cell --
  // Enter then wrote it (the BUG-0185 class) -- and since W17 an AltGr
  // character did too instead of running its shortcut. Core's type-to-edit is
  // a door that writes to Core's selection: it asks the owner, and refuses
  // once. The owner's OWN cell takes its keys before they get here (a floating
  // grid's type-to-edit), so an owner that says its cell takes typing
  // (`receivesTyping`) is where an AltGr character goes -- never Core's.
  let release: () => void = () => {};
  let owns = true;
  let refusals: string[] = [];
  beforeEach(() => {
    owns = true;
    refusals = [];
    setSelectionRefusalAnnouncer((message) => void refusals.push(message));
    release = registerSelectionOwner({
      id: "test.objectOwner",
      label: "a test object",
      ownsSelection: () => owns,
      refusal: (action) => `${action}: refused`,
    });
  });
  afterEach(() => {
    release();
    setSelectionRefusalAnnouncer(null);
  });

  it.each([
    ["a plain letter", "a", {}, "Edit Cell"],
    ["an AltGr character", "@", { altGr: true, code: "Digit2" }, "Edit Cell"],
    ["F2", "F2", {}, "Edit Cell"],
    ["the bare Backspace (a clear)", "Backspace", {}, "Clear Contents"],
  ] as const)("%s opens no edit of Core's HIDDEN cell, and is refused once", async (_label, key, mods, action) => {
    await mount();
    await pressOnGrid(key, mods);
    await releaseBackend();
    expect(editorEl(), `${key}: Core opened an edit of its hidden active cell`).toBeNull();
    expect(getMergeInfo, `${key}: Core began an entry in its hidden active cell`).not.toHaveBeenCalled();
    expect(refusals).toEqual([`${action}: refused`]);
  });

  it('AltGr "]" with no cell of the owner to type into is Next Bookmark again -- not typing, and not Core\'s', async () => {
    const ran: string[] = [];
    CommandRegistry.register("bookmarks.next", () => void ran.push("bookmarks.next"));
    try {
      await mount();
      await pressOnGrid("]", { altGr: true, code: "Digit9" });
      await releaseBackend();
      expect(ran).toEqual(["bookmarks.next"]);
      expect(editorEl()).toBeNull();
      expect(refusals).toEqual([]);
    } finally {
      CommandRegistry.unregister("bookmarks.next");
    }
  });

  it("positive control: once the claim ends, a letter starts Core's entry again", async () => {
    owns = false;
    await mount();
    await pressOnGrid("a");
    await releaseBackend();
    expect(editorEl()?.value).toBe("a");
    expect(refusals).toEqual([]);
  });
});

describe("isTypedCharacterKey -- the one predicate", () => {
  const k = (key: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...m,
  });
  it("types a plain character, and an AltGr symbol or accented letter", () => {
    expect(isTypedCharacterKey(k("a"))).toBe(true);
    expect(isTypedCharacterKey(k("@", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTypedCharacterKey(k("ą", { ctrlKey: true, altKey: true }))).toBe(true); // pl-PL AltGr+A
  });
  it("never types a shortcut: Ctrl+letter, Alt+letter, Ctrl+Alt+letter/digit, Meta, a named key", () => {
    expect(isTypedCharacterKey(k("b", { ctrlKey: true }))).toBe(false);
    expect(isTypedCharacterKey(k("h", { altKey: true }))).toBe(false);
    expect(isTypedCharacterKey(k("m", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTypedCharacterKey(k("2", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTypedCharacterKey(k("@", { ctrlKey: true, altKey: true, metaKey: true }))).toBe(false);
    expect(isTypedCharacterKey(k("Enter"))).toBe(false);
  });
});
