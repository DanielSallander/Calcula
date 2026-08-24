//! FILENAME: app/src/shell/__tests__/statusBarModeReadout.test.tsx
// PURPOSE: The status bar's left zone must print the mode the GRID reports.
// CONTEXT: `getModeStatus` (core/components/Spreadsheet/useSpreadsheetLayout)
//          has always computed [Fill] / [Resizing] / [Selecting Ref] /
//          [Selecting] / [Editing] / [Extend] / [End] / [Ready], and
//          `statusText` the selection's reference and R x C size. Both were
//          returned all the way up through useSpreadsheet and consumed by
//          NOBODY -- the bar printed the string "Ready" no matter what the grid
//          was doing, so the F8 extend indicator never reached a user.
//
//          The idle assertions here are not decoration: e2e/tests/
//          vba-idioms-wave4.spec.ts reads the first <span> of this bar and
//          expects exactly "Ready" before a macro sets a message, and
//          zoom-view.spec.ts looks for the visible text "Ready". An idle grid
//          must therefore print that word whether or not it has focus.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StatusBar } from "../StatusBar";
import {
  GRID_MODE_CHANGED,
  type GridModeDetail,
} from "../../core/components/Spreadsheet/useSpreadsheetLayout";
import { AppEvents, emitAppEvent } from "../../api/events";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

/** Announce a grid mode exactly the way useSpreadsheetLayout announces it. */
function announce(detail: GridModeDetail): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(GRID_MODE_CHANGED, { detail }));
  });
}

/** The text of the bar's mode slot -- the first <span>, as e2e reads it. */
function modeSlotText(): string {
  const bar = container.querySelector("[data-testid='status-bar']");
  expect(bar, "the status bar is not in the DOM").not.toBeNull();
  return bar!.querySelector("span")?.textContent ?? "";
}

function selectionSlotText(): string | null {
  const span = container.querySelector("[data-testid='status-bar-selection']");
  return span ? span.textContent : null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<StatusBar />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("status bar mode readout", () => {
  it("prints Ready before the grid has announced anything", () => {
    expect(modeSlotText()).toBe("Ready");
    expect(selectionSlotText()).toBeNull();
  });

  it("prints the mode the grid announced", () => {
    announce({ mode: "[Extend]", selectionText: null });
    expect(modeSlotText()).toBe("[Extend]");

    announce({ mode: "[Editing]", selectionText: null });
    expect(modeSlotText()).toBe("[Editing]");

    announce({ mode: "[End]", selectionText: null });
    expect(modeSlotText()).toBe("[End]");
  });

  it("prints Ready for BOTH idle modes, focused or not", () => {
    announce({ mode: "[Ready]", selectionText: null });
    expect(modeSlotText()).toBe("Ready");

    announce({ mode: "[Click to focus]", selectionText: null });
    expect(modeSlotText()).toBe("Ready");
  });

  it("shows the selection summary beside the mode, and drops it with the selection", () => {
    announce({ mode: "[Ready]", selectionText: "A1:B3 [3R x 2C] | Row: 3, Col: 2" });
    expect(selectionSlotText()).toBe("A1:B3 [3R x 2C] | Row: 3, Col: 2");
    expect(modeSlotText()).toBe("Ready");

    announce({ mode: "[Ready]", selectionText: null });
    expect(selectionSlotText()).toBeNull();
  });

  it("lets a script's message replace the mode, and restores the mode on clear", () => {
    announce({ mode: "[Extend]", selectionText: "A1 | Row: 1, Col: 1" });

    act(() => {
      emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: "Running macro" });
    });
    expect(modeSlotText()).toBe("Running macro");
    // The selection summary is not the message's slot: Excel keeps showing it.
    expect(selectionSlotText()).toBe("A1 | Row: 1, Col: 1");

    act(() => {
      emitAppEvent(AppEvents.STATUS_BAR_TEXT_CHANGED, { text: null });
    });
    expect(modeSlotText()).toBe("[Extend]");
  });

  it("keeps the mode slot as the bar's FIRST span (the e2e contract)", () => {
    announce({ mode: "[Ready]", selectionText: "A1 | Row: 1, Col: 1" });
    const bar = container.querySelector("[data-testid='status-bar']")!;
    expect(bar.querySelector("span")).toBe(
      bar.querySelector("[data-testid='status-bar-mode']"),
    );
  });
});
