//! FILENAME: app/src/core/components/Spreadsheet/__tests__/formatStyleCachePrime.test.tsx
// PURPOSE: A cell that has just been formatted must PAINT with its own style,
//          not with the document default.
//
// CONTEXT: The frontend renders a cell by looking its `styleIndex` up in a
//          style cache (`getStyleFromCache`), and that lookup FALLS BACK to
//          index 0 — the document default — when the index is missing. Applying
//          a format MINTS a new registry index, so a route that refreshes the
//          cell data without refreshing the style table paints the cell with
//          the default style while `get_style` reports the format correctly.
//
//          `apply_formatting` already returns the entries the cache needs
//          (`FormattingResult.styles` — "New or updated styles that the
//          frontend should cache"). They were read for a console.log of their
//          LENGTH and otherwise discarded, so the cache learned nothing.
//
//          The tests below drive the REAL product routes — a Ctrl+B keypress on
//          the grid container, and the @api wrapper an extension/script calls —
//          against the real `tauri-api` module (only Tauri's `invoke` is
//          doubled). What they assert is the renderer's own question: "what
//          style would be painted for this cell?"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// A fake backend with a REAL style registry: dedup on equality, monotonically
// growing indices, and a per-cell style index — the three properties the
// frontend cache's correctness depends on.
// ---------------------------------------------------------------------------

import { DEFAULT_STYLE, type StyleData } from "../../../types";

let registry: StyleData[] = [];
let cellStyleIndex = new Map<string, number>();
let cellDisplay = new Map<string, string>();
/** Every command name the frontend invoked, in order. */
let invoked: string[] = [];

function resetBackend(): void {
  registry = [{ ...DEFAULT_STYLE }];
  cellStyleIndex = new Map();
  cellDisplay = new Map([["0,0", "Bold me"]]);
  invoked = [];
}

function getOrCreate(style: StyleData): number {
  const key = JSON.stringify(style);
  const found = registry.findIndex((s) => JSON.stringify(s) === key);
  if (found >= 0) return found;
  registry.push(style);
  return registry.length - 1;
}

function cellFor(row: number, col: number): Record<string, unknown> {
  const key = `${row},${col}`;
  return {
    row,
    col,
    display: cellDisplay.get(key) ?? "",
    displayColor: null,
    formula: null,
    styleIndex: cellStyleIndex.get(key) ?? 0,
    rowSpan: 1,
    colSpan: 1,
    sheetIndex: null,
    richText: null,
    accountingLayout: null,
  };
}

/** `apply_formatting`, modelled on `commands/styles.rs`: mint per cell, and
 *  report back every index that was used or created. */
function applyFormattingBackend(params: Record<string, unknown>): unknown {
  const rows = params.rows as number[];
  const cols = params.cols as number[];
  const used = new Set<number>();
  const cells: unknown[] = [];
  for (const row of rows) {
    for (const col of cols) {
      const key = `${row},${col}`;
      const base = registry[cellStyleIndex.get(key) ?? 0];
      const next: StyleData = { ...base };
      for (const [k, v] of Object.entries(params)) {
        if (k === "rows" || k === "cols" || v === undefined || v === null) continue;
        (next as unknown as Record<string, unknown>)[k] = v;
      }
      const index = getOrCreate(next);
      cellStyleIndex.set(key, index);
      used.add(index);
      cells.push(cellFor(row, col));
    }
  }
  return {
    cells,
    styles: [...used].map((index) => ({ index, style: registry[index] })),
  };
}

/**
 * The fill a NAMED style carries, so a cell painted from the document default
 * is visibly a different answer rather than a subtly different one.
 */
const NAMED_STYLE_FILL = "#00A650";

/**
 * `apply_named_style_range`, modelled on `named_styles_cmd.rs`: it rewrites the
 * target cells' style index wholesale and returns the SAME `FormattingResult`
 * shape `apply_formatting` returns -- `cells` plus the `styles` entries the
 * frontend is meant to cache.
 *
 * It is a SECOND door to the same defect: `announceStyleEntries` was added to
 * the `applyFormatting` / `applyBorderPreset` wrappers in
 * `src/core/lib/tauri-api.ts`, whose comment says "there is no other door to
 * the command" -- true of `apply_formatting`, and not true of the style cache.
 * `applyNamedStyle` / `applyNamedStyleRange` live in `src/api/backend.ts`, are
 * exported through `@api`, and threw `result.styles` away.
 */
function applyNamedStyleBackend(args: Record<string, unknown>): unknown {
  const startRow = args.startRow as number;
  const startCol = args.startCol as number;
  const endRow = args.endRow as number;
  const endCol = args.endCol as number;
  const used = new Set<number>();
  const cells: unknown[] = [];
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const index = getOrCreate({ ...DEFAULT_STYLE, backgroundColor: NAMED_STYLE_FILL });
      cellStyleIndex.set(`${row},${col}`, index);
      used.add(index);
      cells.push(cellFor(row, col));
    }
  }
  return {
    cells,
    styles: [...used].map((index) => ({ index, style: registry[index] })),
  };
}

const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  invoked.push(cmd);
  switch (cmd) {
    case "get_all_styles":
      return Promise.resolve(registry.map((s) => ({ ...s })));
    case "get_style":
      return Promise.resolve({ ...registry[(args?.index as number) ?? 0] });
    case "get_style_count":
      return Promise.resolve(registry.length);
    case "get_cell":
      return Promise.resolve(cellFor(args?.row as number, args?.col as number));
    case "apply_formatting":
      return Promise.resolve(
        applyFormattingBackend(args?.params as Record<string, unknown>),
      );
    case "apply_named_style_range":
      return Promise.resolve(applyNamedStyleBackend(args ?? {}));
    case "get_merge_info":
      return Promise.resolve(null);
    case "get_merged_regions":
      return Promise.resolve([]);
    case "get_viewport_cells":
      return Promise.resolve([cellFor(0, 0)]);
    case "get_spill_ranges":
      return Promise.resolve([]);
    case "get_active_sheet":
      return Promise.resolve(0);
    default:
      return Promise.resolve(null);
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../../../lib/hiddenRowsCols", () => ({
  applyRowsHidden: vi.fn(async () => {}),
  applyColsHidden: vi.fn(async () => {}),
  refreshUserHidden: vi.fn(async () => {}),
}));

import { useSpreadsheetStyles } from "../useSpreadsheetStyles";
import { useSpreadsheetSelection } from "../useSpreadsheetSelection";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { getStyleFromCache } from "../../../lib/gridRenderer/styles/styleUtils";
import { applyFormatting } from "../../../lib/tauri-api";
import { applyNamedStyleRange } from "../../../../api/backend";
import type { StyleDataMap } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Harness: the two hooks Spreadsheet.tsx mounts, wired the way it wires them.
// ---------------------------------------------------------------------------

/** The cache the renderer would be handed on the next paint. */
let observedStyleCache: StyleDataMap = new Map();
let gridEl: HTMLDivElement | null = null;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef(null);

  const styleLogic = useSpreadsheetStyles(canvasRef);
  observedStyleCache = styleLogic.styleCache;

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
    <div
      ref={(el) => {
        focusContainerRef.current = el;
        gridEl = el;
      }}
      data-testid="grid"
      tabIndex={0}
    />
  );
}

let root: Root;
let host: HTMLDivElement;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Capture(): null {
  dispatchOut = useGridContext().dispatch;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Capture />
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
  // Select A1, as a click would.
  await act(async () => {
    dispatchOut(setSelection(0, 0, 0, 0, "cells"));
  });
  await settle();
}

/** Ctrl+B on the grid container — the real keyboard route (`useGridKeyboard`
 *  -> `handleCommand('format.toggleBold')`). Dispatched on the element for the
 *  same reason `e2e/helpers/grid.ts` does: WebView2 swallows Ctrl+B before the
 *  page sees it, so this IS the product's own entry point. */
async function pressCtrlB(): Promise<void> {
  await act(async () => {
    gridEl?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        code: "KeyB",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

/** What the renderer would paint for A1: exactly the lookup `cells.ts` does. */
function paintedStyleForA1(): StyleData {
  const index = cellStyleIndex.get("0,0") ?? 0;
  return getStyleFromCache(observedStyleCache, index);
}

describe("a formatted cell paints its own style, not the document default", () => {
  beforeEach(() => {
    resetBackend();
    invokeMock.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("Ctrl+B: the backend minted a bold style AND the renderer would paint it bold", async () => {
    await mount();
    await pressCtrlB();

    // The backend half — this always worked, and is why the defect is invisible
    // to every oracle that reads state instead of pixels.
    const index = cellStyleIndex.get("0,0") ?? 0;
    expect(index).toBeGreaterThan(0);
    expect(registry[index].bold).toBe(true);

    // The half that was broken: what would actually be PAINTED.
    expect(paintedStyleForA1().bold).toBe(true);
  });

  it("the priming costs no extra IPC — no style re-fetch follows the format", async () => {
    await mount();
    const before = invoked.filter((c) => c === "get_all_styles").length;
    await pressCtrlB();
    const after = invoked.filter((c) => c === "get_all_styles").length;
    expect(after).toBe(before);
  });

  it("the @api wrapper primes it for every caller — script, macro and extension alike", async () => {
    await mount();
    // No component involved: the wrapper is the only door to the command, so a
    // caller that never heard of `styles:refresh` still leaves a correct cache.
    await act(async () => {
      await applyFormatting([0], [0], { italic: true });
    });
    await settle();
    expect(paintedStyleForA1().italic).toBe(true);
  });

  it("a NAMED style primes the cache too — it is the same FormattingResult", async () => {
    await mount();
    // No `grid:refresh`, on purpose: that event is what triggers the HEAL, and
    // the heal would mask whether this DOOR announces anything. An extension
    // calling `@api`'s applyNamedStyleRange gets exactly this — a returned
    // result and no events — and the next repaint (a scroll, a resize) then
    // paints from whatever the cache holds.
    await act(async () => {
      await applyNamedStyleRange("Accent1", 0, 0, 0, 0);
    });
    await settle();

    expect(
      paintedStyleForA1().backgroundColor,
      "the renderer would paint the DOCUMENT DEFAULT for a cell the backend " +
        "reports as carrying the named style's fill — `apply_named_style_range` " +
        "returns the entries to cache and the @api wrapper discarded them " +
        "(the same defect as BUG-0076, through a second door)",
    ).toBe(NAMED_STYLE_FILL);
  });

  it("an unknown index still reaches the backend — the cache SELF-HEALS", async () => {
    await mount();
    // Mint a style entirely behind the frontend's back, exactly as an MCP tool
    // (`mcp/tools.rs` format_range) or a .calp refresh does: the registry grows
    // in Rust and the only announcement is `grid:refresh`.
    const hidden = getOrCreate({ ...DEFAULT_STYLE, bold: true, italic: true });
    cellStyleIndex.set("0,0", hidden);
    await act(async () => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await settle();
    expect(paintedStyleForA1().italic).toBe(true);
  });

  it("a sheet switch heals too — a style minted while another sheet was active", async () => {
    await mount();
    const hidden = getOrCreate({ ...DEFAULT_STYLE, strikethrough: true });
    cellStyleIndex.set("0,0", hidden);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: 1, newSheetName: "Sheet2" },
        }),
      );
    });
    await settle();
    expect(paintedStyleForA1().strikethrough).toBe(true);
  });

  it("the check is a SCALAR probe — a quiet refresh re-reads no styles", async () => {
    await mount();
    const before = invoked.filter((c) => c === "get_all_styles").length;
    await act(async () => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await settle();
    // Nothing minted, so the count agrees and the full registry is not re-read.
    expect(invoked.filter((c) => c === "get_all_styles").length).toBe(before);
    expect(invoked.filter((c) => c === "get_style_count").length).toBeGreaterThan(0);
  });
});
