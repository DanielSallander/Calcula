//! FILENAME: app/src/core/components/Spreadsheet/__tests__/gridModeReadout.test.tsx
// PURPOSE: The mode the grid computes must LEAVE the grid.
// CONTEXT: useSpreadsheetLayout has always computed a mode indicator
//          ([Fill] / [Resizing] / [Selecting Ref] / [Selecting] / [Editing] /
//          [Extend] / [End] / [Ready]) and a selection summary, returned both
//          through useSpreadsheet, and had no consumer anywhere in the repo.
//          The status bar printed a hardcoded "Ready" beside them.
//
//          The F8 test is the one with teeth. Extend mode is a module-level
//          flag inside useGridKeyboard with nothing subscribed to it, and the
//          keydown handler that flips it calls stopPropagation() -- so the
//          readout can only follow it if the listener that schedules the
//          repaint runs in the CAPTURE phase and re-reads the flag AFTER the
//          handler has flipped it. The harness below reproduces exactly that
//          shape: a bubble-phase handler on a child element that flips the flag
//          and stops propagation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GridProvider, useGridState, getInitialState } from "../../../state";
import { setExtendMode, setEndMode } from "../../../hooks/useGridKeyboard";
import type { GridState } from "../../../types";
import { useSpreadsheetLayout, GRID_MODE_CHANGED, type GridModeDetail } from "../useSpreadsheetLayout";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface HarnessProps {
  isFocused?: boolean;
  isResizing?: boolean;
  isFormulaDragging?: boolean;
  isDragging?: boolean;
  isFillDragging?: boolean;
}

/**
 * Drives the hook with the flags useSpreadsheet passes it, and renders the
 * element whose keydown handler stands in for useGridKeyboard's.
 */
function Harness(props: HarnessProps): React.ReactElement {
  const state = useGridState();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef(null);

  useSpreadsheetLayout({
    scrollRef,
    containerRef,
    canvasRef,
    state,
    isFocused: props.isFocused ?? true,
    getSelectionReference: () => "A1",
    mouseCursorStyle: "default",
    isResizing: props.isResizing ?? false,
    isFormulaDragging: props.isFormulaDragging ?? false,
    isDragging: props.isDragging ?? false,
    isFillDragging: props.isFillDragging ?? false,
  });

  return <div ref={containerRef} data-testid="grid" tabIndex={0} />;
}

let container: HTMLDivElement;
let root: Root;
let announced: GridModeDetail[];

/** Everything the grid has announced, most recent last. */
function lastAnnounced(): GridModeDetail | undefined {
  return announced[announced.length - 1];
}

function record(event: Event): void {
  announced.push((event as CustomEvent<GridModeDetail>).detail);
}

function mount(props: HarnessProps = {}, initialState?: GridState): void {
  act(() => {
    root.render(
      <GridProvider initialState={initialState}>
        <Harness {...props} />
      </GridProvider>,
    );
  });
}

/** Let the capture listener's scheduled repaint land. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

beforeEach(() => {
  announced = [];
  window.addEventListener(GRID_MODE_CHANGED, record);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.removeEventListener(GRID_MODE_CHANGED, record);
  // Both flags are module-level and outlive the component that read them.
  setExtendMode(false);
  setEndMode(false);
});

describe("grid mode readout", () => {
  it("announces the computed mode as soon as the grid mounts", () => {
    mount({ isFocused: true });
    expect(lastAnnounced()?.mode).toBe("[Ready]");
  });

  it("announces the unfocused mode rather than pretending to be ready", () => {
    mount({ isFocused: false });
    expect(lastAnnounced()?.mode).toBe("[Click to focus]");
  });

  it.each([
    ["isFillDragging", "[Fill]"],
    ["isResizing", "[Resizing]"],
    ["isFormulaDragging", "[Selecting Ref]"],
    ["isDragging", "[Selecting]"],
  ] as const)("announces %s as %s", (flag, expected) => {
    mount({ [flag]: true });
    expect(lastAnnounced()?.mode).toBe(expected);
  });

  it("announces the selection's reference and size", () => {
    mount();
    expect(lastAnnounced()?.selectionText).toBe("A1  | Row: 1, Col: 1");
  });

  it("announces no selection summary when nothing is selected", () => {
    mount({}, { ...getInitialState(), selection: null });
    expect(lastAnnounced()?.selectionText).toBeNull();
  });

  it("follows F8 extend mode even though the flag re-renders nothing", async () => {
    mount({ isFocused: true });
    expect(lastAnnounced()?.mode).toBe("[Ready]");

    // useGridKeyboard's own shape: bubble-phase, on the grid container, and it
    // stops propagation so nothing above the container ever sees the key.
    const grid = container.querySelector("[data-testid='grid']") as HTMLElement;
    const flip = (event: KeyboardEvent) => {
      event.stopPropagation();
      setExtendMode(true);
    };
    grid.addEventListener("keydown", flip);
    act(() => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
    });
    grid.removeEventListener("keydown", flip);

    await nextFrame();
    expect(lastAnnounced()?.mode).toBe("[Extend]");
  });

  it("follows End mode, and lets the next keystroke clear it", async () => {
    mount({ isFocused: true });

    const grid = container.querySelector("[data-testid='grid']") as HTMLElement;
    const arm = () => setEndMode(true);
    grid.addEventListener("keydown", arm);
    act(() => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    grid.removeEventListener("keydown", arm);
    await nextFrame();
    expect(lastAnnounced()?.mode).toBe("[End]");

    // The next key spends End mode. It is an ordinary arrow key -- no listener
    // filter can predict it, which is why an ARMED End mode is itself part of
    // the filter.
    const spend = () => setEndMode(false);
    grid.addEventListener("keydown", spend);
    act(() => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    grid.removeEventListener("keydown", spend);
    await nextFrame();
    expect(lastAnnounced()?.mode).toBe("[Ready]");
  });

  it("schedules the re-read for the next frame instead of reading a flag mid-dispatch", () => {
    mount({ isFocused: true });
    const raf = vi.spyOn(window, "requestAnimationFrame");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F8" }));
    });

    // Reading getExtendMode() inside the capture listener would photograph the
    // value from BEFORE useGridKeyboard's own handler flips it, and no test can
    // pin listener order -- useGridKeyboard re-registers its listener whenever
    // the selection changes. Deferring the read is what makes order irrelevant.
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  it("does not schedule a repaint for keys that cannot flip a mode", async () => {
    mount({ isFocused: true });
    const raf = vi.spyOn(window, "requestAnimationFrame");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});
