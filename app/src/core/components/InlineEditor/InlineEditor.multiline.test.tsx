//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.multiline.test.tsx
// PURPOSE: Multi-line entries (Alt+Enter) survive editing and are RENDERED on
//          more than one line, without disturbing the commit semantics that
//          every single-line edit in the product depends on.
//
// CONTEXT: The editor used to be an <input type="text">. HTML's value
//          sanitization algorithm strips CR/LF from that element, so this was
//          never merely a "shown on one line" cosmetic gap:
//
//            1. Alt+Enter called onValueChange("a\n"). React state kept the
//               newline; the DOM input silently dropped it.
//            2. The very next keystroke went through handleChange, which reads
//               `event.target.value` — the STRIPPED string — and wrote it back
//               to state.
//
//          So the newline was destroyed by the next character typed after it.
//          `alt-enter-eats-the-newline` below is that exact sequence and fails
//          against the <input> implementation.
//
//          The commit semantics are the risky half of the textarea swap, not
//          the resizing: in a <textarea> an Enter that is not preventDefault-ed
//          inserts a newline instead of committing. Every Enter/Tab path is
//          therefore pinned here, including the early-return guard.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const getViewportCells = vi.fn(async () => [] as Array<{ row: number; col: number; display: string }>);
vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: (...args: [number, number, number, number]) => getViewportCells(...args),
}));
vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));

import { InlineEditor } from "./InlineEditor";
import { GridProvider } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type EditingCell,
  type GridConfig,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const COL_W = 64.29;
const ROW_H = 20;

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: COL_W,
  defaultCellHeight: ROW_H,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1000,
  totalCols: 100,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 30,
  colCount: 20,
};

let root: Root;
let host: HTMLDivElement;

/** The live editor element, whatever tag it is built from. */
function editorEl(): HTMLTextAreaElement | HTMLInputElement {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement | HTMLInputElement;
}

function renderedHeight(): number {
  return parseFloat(window.getComputedStyle(editorEl()).height);
}

/** Calls recorded by the harness, so each test can assert what the editor did. */
interface Recorder {
  commits: number;
  cancels: number;
  enters: Array<boolean>;
  tabs: Array<boolean>;
  value: () => string;
}

let rec: Recorder;
let currentValue = "";

/**
 * Renders the REAL editor inside a controlled wrapper that owns the value,
 * exactly as the Spreadsheet does — so a value written by onValueChange comes
 * back to the editor as a prop and we can observe what the DOM did with it.
 */
function Harness(props: { initial: string; cell?: Partial<EditingCell> }): React.ReactElement {
  const [value, setValue] = useState(props.initial);
  currentValue = value;

  const editing: EditingCell = {
    row: 3,
    col: 2,
    value,
    ...props.cell,
  } as EditingCell;

  return (
    <GridProvider initialState={getInitialState()}>
      <InlineEditor
        editing={editing}
        config={CONFIG}
        viewport={VIEWPORT}
        dimensions={createEmptyDimensionOverrides()}
        onValueChange={(v) => {
          setValue(v);
          currentValue = v;
        }}
        onCommit={async () => {
          rec.commits += 1;
          return true;
        }}
        onCancel={() => {
          rec.cancels += 1;
        }}
        onEnter={(shift) => rec.enters.push(shift)}
        onTab={(shift) => rec.tabs.push(shift)}
      />
    </GridProvider>
  );
}

/** Bumped per mount so React remounts the harness rather than reusing the
 *  previous instance's `useState` seed — otherwise a second mount() in one test
 *  would silently keep the first entry. */
let mountSeq = 0;

async function mount(initial: string, cell?: Partial<EditingCell>): Promise<void> {
  mountSeq += 1;
  await act(async () => {
    root.render(<Harness key={mountSeq} initial={initial} cell={cell} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // A user arriving at this entry has their caret after the last character (in
  // the product the autofocus effect puts it there). Tests that care about a
  // different caret set it themselves.
  const el = editorEl();
  if (el) el.setSelectionRange(el.value.length, el.value.length);
}

/** Presses a key on the editor the way the browser would. */
async function press(
  key: string,
  mods: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
): Promise<void> {
  await act(async () => {
    editorEl().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Types `text` at the end of the entry the way a browser does: the element's
 * own value is mutated through the NATIVE setter (bypassing React's
 * descriptor), then an input event is dispatched. This is what makes the test
 * honest — it reproduces the browser's value sanitization instead of asserting
 * on React state that the DOM never agreed with.
 */
async function typeAtEnd(text: string): Promise<void> {
  const el = editorEl();
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  await act(async () => {
    desc?.set?.call(el, el.value + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("InlineEditor: multi-line entries", () => {
  beforeEach(() => {
    getViewportCells.mockClear();
    window.innerWidth = 1200;
    window.innerHeight = 800;
    rec = { commits: 0, cancels: 0, enters: [], tabs: [], value: () => currentValue };
    currentValue = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  // An editor left mounted keeps its focus/blur handlers live, and the blur
  // path commits. Without this, a previous test's editor commits into the NEXT
  // test's recorder and the whole suite reads as if Escape committed.
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  // -------------------------------------------------------------------------
  // The data loss
  // -------------------------------------------------------------------------

  it("keeps the newline in the DOM after Alt+Enter", async () => {
    await mount("a");
    await press("Enter", { altKey: true });
    // The <input> implementation silently sanitizes this back to "a".
    expect(editorEl().value).toBe("a\n");
  });

  it("alt-enter-eats-the-newline: the newline survives the NEXT keystroke", async () => {
    await mount("a");
    await press("Enter", { altKey: true });
    await typeAtEnd("b");

    // Against <input>: handleChange read the sanitized "ab" and wrote it to
    // state, destroying the line break the user just asked for.
    expect(rec.value()).toBe("a\nb");
    expect(editorEl().value).toBe("a\nb");
  });

  it("loads existing multi-line cell content and round-trips it unchanged", async () => {
    await mount("line one\nline two\nline three");
    expect(editorEl().value).toBe("line one\nline two\nline three");

    await press("Enter");
    expect(rec.commits).toBe(1);
    // Committing did not rewrite the entry.
    expect(rec.value()).toBe("line one\nline two\nline three");
  });

  // -------------------------------------------------------------------------
  // Commit semantics — the risky half of the swap
  // -------------------------------------------------------------------------

  it("Enter COMMITS and does not insert a newline", async () => {
    await mount("hello");
    await press("Enter");

    expect(rec.commits).toBe(1);
    expect(rec.enters).toEqual([false]);
    expect(rec.value()).toBe("hello");
    expect(rec.value()).not.toContain("\n");
  });

  it("Shift+Enter commits (moving up) rather than inserting a newline", async () => {
    await mount("hello");
    await press("Enter", { shiftKey: true });

    expect(rec.commits).toBe(1);
    expect(rec.enters).toEqual([true]);
    expect(rec.value()).not.toContain("\n");
  });

  it("Alt+Enter inserts a newline and does NOT commit", async () => {
    await mount("hello");
    await press("Enter", { altKey: true });

    expect(rec.commits).toBe(0);
    expect(rec.enters).toEqual([]);
    expect(rec.value()).toBe("hello\n");
  });

  it("Escape cancels without committing and without touching the entry", async () => {
    await mount("hello");
    await press("Escape");

    expect(rec.cancels).toBe(1);
    expect(rec.commits).toBe(0);
    expect(rec.value()).toBe("hello");
  });

  it("Tab commits and moves, inserting no tab character", async () => {
    await mount("hello");
    await press("Tab");

    expect(rec.commits).toBe(1);
    expect(rec.tabs).toEqual([false]);
    expect(rec.value()).toBe("hello");
    expect(rec.value()).not.toContain("\t");
  });

  it("inserts the newline AT THE CARET, not at the end", async () => {
    await mount("abcd");
    const el = editorEl();
    el.setSelectionRange(2, 2);
    await press("Enter", { altKey: true });

    expect(rec.value()).toBe("ab\ncd");
  });

  it("a disabled editor swallows Enter without inserting a newline", async () => {
    await act(async () => {
      root.render(
        <GridProvider initialState={getInitialState()}>
          <InlineEditor
            editing={{ row: 3, col: 2, value: "x" } as EditingCell}
            config={CONFIG}
            viewport={VIEWPORT}
            dimensions={createEmptyDimensionOverrides()}
            onValueChange={() => {}}
            onCommit={async () => true}
            onCancel={() => {}}
            disabled
          />
        </GridProvider>,
      );
    });
    const el = editorEl();
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(el.value).toBe("x");
  });

  // -------------------------------------------------------------------------
  // Vertical growth
  // -------------------------------------------------------------------------

  it("grows DOWNWARD for a multi-line entry", async () => {
    await mount("one");
    const single = renderedHeight();
    expect(single).toBeCloseTo(ROW_H, 1);

    await mount("one\ntwo\nthree");
    expect(renderedHeight()).toBeGreaterThan(single * 2.5);
  });

  it("collapses back to one row when the newlines are removed", async () => {
    await mount("one\ntwo\nthree");
    expect(renderedHeight()).toBeGreaterThan(ROW_H);

    await mount("one");
    expect(renderedHeight()).toBeCloseTo(ROW_H, 1);
  });

  it("clamps vertical growth at the viewport bottom", async () => {
    window.innerHeight = 200;
    await mount(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"));

    const el = editorEl();
    const top = parseFloat(window.getComputedStyle(el).top);
    expect(top + renderedHeight()).toBeLessThanOrEqual(200 + 0.01);
    // ...and it did use the room it had.
    expect(renderedHeight()).toBeGreaterThan(ROW_H);
  });

  it("still expands horizontally, using the WIDEST line", async () => {
    await mount("a\nQuarterly revenue for the EMEA region, restated\nb");
    const width = parseFloat(window.getComputedStyle(editorEl()).width);
    expect(width).toBeGreaterThan(COL_W * 2);
  });
});
