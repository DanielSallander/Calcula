//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaBarExpand.test.tsx
// PURPOSE: The formula bar must be able to show more than one line.
//
// CONTEXT: The bar was a fixed 28px box around a fixed 22px <input>, with no
//          expanded variant anywhere — no chevron, no resize edge, no state to
//          hold a height. A long or nested formula was readable only through a
//          one-line slit, scrolled sideways past the caret. Excel has had
//          Ctrl+Shift+U, a chevron and a draggable bottom edge since forever.
//
//          Three separate things have to agree for the feature to exist at all,
//          and each is asserted here rather than assumed:
//            1. the bar's own geometry (the container grows, the grid below is
//               pushed down rather than covered — Layout stacks them in one flex
//               column, so the bar's height IS the reflow),
//            2. the editor swaps from <input> to <textarea>, because a one-line
//               input cannot show a second line however tall its container is,
//            3. Ctrl+Shift+U reaches it — the shortcut is dispatched by the
//               keybinding registry as a COMMAND ID, a string that nothing
//               type-checks against the handler the bar registers.
//
// The drag is driven with real mouse events on the grip, not by calling the
// handler: the resize listens on `document` for the move, which is the part a
// direct call would skip.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FORMULA_BAR_COLLAPSED_HEIGHT,
  FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT,
  FORMULA_BAR_EXPANDED_CHROME_HEIGHT,
  FORMULA_BAR_MIN_EXPANDED_HEIGHT,
  FORMULA_BAR_MAX_EXPANDED_HEIGHT,
  FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
  clampFormulaBarHeight,
} from "../../../core/types";

// ---------------------------------------------------------------------------
// Doubles. Same shape as formulaInputSelectionRace.test.tsx: the barrel is the
// only route the bar and its input take to the backend. The Name Box and the
// Insert Function dialog are stubbed — they are separate components with their
// own suites, and neither has anything to do with the bar's height.
// ---------------------------------------------------------------------------

const dispatch = vi.fn();
const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  referenceStyle: "A1",
  formulaBarExpanded: false,
  formulaBarHeight: FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
};

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  getCell: () => Promise.resolve(null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    updateValue: vi.fn(),
    commitEdit: vi.fn(),
    cancelEdit: vi.fn(),
    startEdit: vi.fn(),
    startEditing: vi.fn(),
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

vi.mock("../NameBox", () => ({ NameBox: () => null }));
vi.mock("../InsertFunctionDialog", () => ({ InsertFunctionDialog: () => null }));

import { FormulaBar } from "../FormulaBar";
import {
  FORMULA_BAR_TOGGLE_EXPANDED_COMMAND,
  getAllKeybindings,
  handleGlobalKeyDown,
  initKeybindings,
} from "../../../api/keybindings";

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(): void {
  act(() => {
    root.render(React.createElement(FormulaBar));
  });
}

function bar(): HTMLElement {
  const el = container.querySelector("[data-formula-bar-expanded]");
  if (!el) throw new Error("the formula bar did not render");
  return el as HTMLElement;
}

function isExpanded(): boolean {
  return bar().getAttribute("data-formula-bar-expanded") === "true";
}

/** Height as the browser resolves it — styled-components rules and all. */
function pxHeight(el: Element): number {
  return parseFloat(window.getComputedStyle(el as HTMLElement).height);
}

function editor(): HTMLElement {
  const el = container.querySelector("[data-formula-bar]");
  if (!el) throw new Error("the formula bar editor did not render");
  return el as HTMLElement;
}

function chevron(): HTMLElement {
  const el = container.querySelector("[data-formula-bar-expand]");
  if (!el) throw new Error("the expand chevron did not render");
  return el as HTMLElement;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Press the bar's bottom edge at `fromY` and drag it to `toY`. */
function dragEdge(fromY: number, toY: number): void {
  const grip = container.querySelector("[data-formula-bar-resize]");
  if (!grip) throw new Error("the resize grip did not render");
  act(() => {
    grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: fromY }));
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: toY }));
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

beforeAll(() => {
  // The real registry, so the Ctrl+Shift+U row under test is the shipped one.
  initKeybindings();
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dispatch.mockClear();
  gridState.formulaBarExpanded = false;
  gridState.formulaBarHeight = FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FormulaBar — the bar can show more than one line", () => {
  it("is one line, and a plain input, until something expands it", async () => {
    render();
    await flush();

    expect(isExpanded()).toBe(false);
    expect(pxHeight(bar())).toBe(FORMULA_BAR_COLLAPSED_HEIGHT);
    expect(
      editor().tagName.toLowerCase(),
      "the collapsed bar must stay an <input>: it is what the E2E helpers and " +
        "the in-cell editor's hand-off both look for",
    ).toBe("input");
    expect(pxHeight(editor())).toBe(FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT);
  });

  it("the chevron expands the bar to the height grid state carries", async () => {
    render();
    await flush();

    click(chevron());

    expect(isExpanded()).toBe(true);
    expect(pxHeight(editor())).toBe(FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT);
    expect(
      pxHeight(bar()),
      "the bar's own box must grow with the editor — Layout stacks the bar and " +
        "the grid in one flex column, so this height IS what pushes the grid down",
    ).toBe(FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT + FORMULA_BAR_EXPANDED_CHROME_HEIGHT);
  });

  it("the expanded editor is a textarea, so a second line can exist at all", async () => {
    render();
    await flush();

    click(chevron());

    expect(editor().tagName.toLowerCase()).toBe("textarea");
    expect(container.querySelector("input[data-formula-bar]")).toBeNull();
  });

  it("the chevron collapses it again", async () => {
    render();
    await flush();

    click(chevron());
    click(chevron());

    expect(isExpanded()).toBe(false);
    expect(pxHeight(bar())).toBe(FORMULA_BAR_COLLAPSED_HEIGHT);
    expect(editor().tagName.toLowerCase()).toBe("input");
  });

  it("opens expanded when grid state says the user left it expanded", async () => {
    gridState.formulaBarExpanded = true;
    gridState.formulaBarHeight = 120;

    render();
    await flush();

    expect(isExpanded()).toBe(true);
    expect(pxHeight(editor())).toBe(120);
  });

  it("a height outside the band never reaches the DOM", async () => {
    // A stored (or dragged) height is not trusted: NaN renders as `height: NaNpx`
    // and silently collapses the bar to nothing.
    gridState.formulaBarExpanded = true;
    gridState.formulaBarHeight = Number.NaN;

    render();
    await flush();

    expect(pxHeight(editor())).toBe(FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT);
  });
});

describe("FormulaBar — Ctrl+Shift+U", () => {
  it("toggles the bar through the keybinding registry", async () => {
    render();
    await flush();
    expect(isExpanded()).toBe(false);

    await act(async () => {
      handleGlobalKeyDown(
        new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(
      isExpanded(),
      "Ctrl+Shift+U did not reach the bar — the binding and the handler are " +
        "joined only by a command-id string",
    ).toBe(true);

    await act(async () => {
      handleGlobalKeyDown(
        new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(isExpanded()).toBe(false);
  });

  it("is the combination the registry actually holds", () => {
    const binding = getAllKeybindings().find((b) => b.commandId === FORMULA_BAR_TOGGLE_EXPANDED_COMMAND);
    expect(binding, "no shipped binding runs the formula bar's toggle command").toBeDefined();
    expect(binding?.combo).toBe("Ctrl+Shift+U");
  });
});

describe("FormulaBar — the bottom edge resizes the bar", () => {
  it("dragging down from the collapsed bar expands it to the dragged height", async () => {
    render();
    await flush();

    dragEdge(100, 200);

    expect(isExpanded()).toBe(true);
    expect(pxHeight(editor())).toBe(FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT + 100);
  });

  it("dragging back up past the two-line minimum collapses it", async () => {
    gridState.formulaBarExpanded = true;
    gridState.formulaBarHeight = 120;
    render();
    await flush();

    dragEdge(200, 100);

    expect(isExpanded()).toBe(false);
    expect(pxHeight(bar())).toBe(FORMULA_BAR_COLLAPSED_HEIGHT);
  });

  it("cannot be dragged past the band, in either direction", async () => {
    gridState.formulaBarExpanded = true;
    gridState.formulaBarHeight = 120;
    render();
    await flush();

    dragEdge(0, 100000);
    expect(
      pxHeight(editor()),
      "an unbounded drag hands the whole window to the formula bar and leaves " +
        "no grid to read the answer in",
    ).toBe(FORMULA_BAR_MAX_EXPANDED_HEIGHT);

    // Dragging up by more than the bar is tall: the floor is a collapse, not a
    // negative height.
    dragEdge(0, -1000);
    expect(isExpanded()).toBe(false);
  });

  it("stops following the pointer once the button is up", async () => {
    render();
    await flush();

    dragEdge(100, 200);
    const settled = pxHeight(editor());

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 400 }));
    });

    expect(
      pxHeight(editor()),
      "the document-level move listener outlived the drag, so the bar resizes " +
        "whenever the pointer crosses the window",
    ).toBe(settled);
  });
});

describe("clampFormulaBarHeight", () => {
  it("holds the band", () => {
    expect(clampFormulaBarHeight(FORMULA_BAR_MIN_EXPANDED_HEIGHT - 1)).toBe(FORMULA_BAR_MIN_EXPANDED_HEIGHT);
    expect(clampFormulaBarHeight(FORMULA_BAR_MAX_EXPANDED_HEIGHT + 1)).toBe(FORMULA_BAR_MAX_EXPANDED_HEIGHT);
    expect(clampFormulaBarHeight(90)).toBe(90);
  });

  it("answers with the default for a number that is not one", () => {
    expect(clampFormulaBarHeight(Number.NaN)).toBe(FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT);
    expect(clampFormulaBarHeight(Number.POSITIVE_INFINITY)).toBe(FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT);
  });

  it("rounds, because a fractional px height blurs the text on it", () => {
    expect(clampFormulaBarHeight(90.6)).toBe(91);
  });
});
