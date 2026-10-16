//! FILENAME: app/extensions/Slicer/components/__tests__/SlicerSettingsTab.test.tsx
// PURPOSE: The slicer's Settings tab in the object pane (WP-C S11, D-PANE):
//            - the provider offers ONE build tab, "settings", headed by the
//              slicer's name, rendering the Slicer Settings BODY (the dialog's
//              own fields, one column);
//            - a change commits AT ONCE as ONE "Slicer Settings" step that
//              sends ONLY what changed (a toggle; a number on blur, not per
//              keystroke);
//            - a subscribed page disables every control and writes nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Slicer } from "../../lib/slicerTypes";

const h = vi.hoisted(() => ({
  current: undefined as Slicer | undefined,
  update: vi.fn(async (..._a: unknown[]) => null),
  steps: [] as string[],
}));

vi.mock("../../lib/slicerStore", () => ({
  getSlicerById: () => h.current,
  updateSlicerAsync: (...a: unknown[]) => h.update(...a),
}));
vi.mock("../../lib/slicerFilterBridge", () => ({ applySlicerFilter: vi.fn() }));
vi.mock("../../lib/slicer-api", () => ({ getSlicerComputedAttributes: async () => [] }));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));
vi.mock("@api/pivotOverwrite", () => ({
  runStepThenConfirmOverwrite: async (label: string, fn: (o: unknown) => Promise<void>) => {
    h.steps.push(label);
    await fn({ note: () => undefined });
  },
}));

import { SlicerSettingsTab } from "../SlicerSettingsTab";
import { createSlicerObjectPaneProvider, SLICER_PANE_TAB_SETTINGS } from "../../lib/slicerObjectPane";

function slicer(over: Partial<Slicer> = {}): Slicer {
  return {
    id: "s1",
    name: "Region",
    headerText: null,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "pivot",
    cacheSourceId: "p1",
    fieldName: "Region",
    selectedItems: null,
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-light-2",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 3,
    itemGap: 4,
    autogrid: true,
    itemPadding: 0,
    buttonRadius: 2,
    connectedSources: [],
    filterLevel: 1,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.current = slicer();
  h.update.mockClear();
  h.steps.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(readOnly = false): Promise<void> {
  await act(async () => {
    root.render(<SlicerSettingsTab slicerId="s1" readOnly={readOnly} readOnlyReason={readOnly ? "Subscribed." : null} />);
  });
  await flush();
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("the slicer's object-pane provider", () => {
  it("one build tab, Settings, headed by the slicer's name", () => {
    const p = createSlicerObjectPaneProvider({ getSlicer: () => h.current });
    const region = { id: "slicer-s1", type: "slicer", startRow: 0, startCol: 0, endRow: 0, endCol: 0, data: { slicerId: "s1" } };
    expect(p.types).toEqual(["slicer"]);
    expect(p.tabs(region).map((t) => [t.id, t.label])).toEqual([[SLICER_PANE_TAB_SETTINGS, "Settings"]]);
    expect(p.headerOf!(region)).toBe("Slicer - Region");
    expect(p.tabs({ ...region, data: {} })).toEqual([]);
  });
});

describe("the Settings tab", () => {
  it("renders the shared body in its pane layout", async () => {
    await mount();
    expect(byTestId("slicer-settings-body")?.getAttribute("data-variant")).toBe("pane");
    expect(byTestId("slicer-setting-singleSelect")).not.toBeNull();
  });

  it("a toggle commits at once, as ONE 'Slicer Settings' step sending only that setting", async () => {
    await mount();
    await act(async () => {
      byTestId("slicer-setting-singleSelect")!.click();
    });
    await flush();
    expect(h.steps).toEqual(["Slicer Settings"]);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith("s1", { selectionMode: "single" });
  });

  it("a number is committed when its box is left, not per keystroke", async () => {
    await mount();
    const input = byTestId("slicer-setting-itemGap") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "12");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.update).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith("s1", { itemGap: 12 });
  });

  it("on a subscribed page every control is disabled and nothing is written", async () => {
    await mount(true);
    const toggle = byTestId("slicer-setting-singleSelect") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    await act(async () => toggle.click());
    await flush();
    expect(h.update).not.toHaveBeenCalled();
  });
});
