//! FILENAME: app/extensions/Sparklines/__tests__/sparklineGroupSelectionOwner.test.tsx
// PURPOSE: Sparkline design > Group groups the sparklines inside Core's
//          SELECTION, so it refuses with ONE toast and groups nothing while a
//          selection owner holds the selection; it groups when nothing does.
//          Ungroup and Clear act on the group the tab SHOWS (not on a range
//          read from the selection) and stay allowed -- the rule Table
//          Design's Resize Table set (resize refuses, the rest act on the
//          table the tab names).
// CONTEXT: D4 review (wave B; BUG-0185 class). The tab is shown and hidden by
//          Core's selection alone (handlers/selectionHandler.ts), so it stays
//          up while a floating grid's cell owns the selection, and Group then
//          merged the sparklines of a range the user could not see. The
//          sections read the selection through useGridState (mocked) and write
//          through the REAL in-memory store. TEST owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * React's own act() flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { grid } = vi.hoisted(() => ({
  grid: {
    selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
  },
}));

vi.mock("@api/state", () => ({ useGridState: () => grid }));
vi.mock("@api/ui", () => ({ showDialog: vi.fn() }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: vi.fn(async () => []) }));
// The extension entry point wires the whole extension; the sections need only
// the dialog id from it.
vi.mock("../index", () => ({ SPARKLINE_DIALOG_ID: "sparkline:createDialog" }));

import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { createSparklineGroup, getAllGroups, resetSparklineStore, ungroupSparkline } from "../store";
import { SparklineGroupSection } from "../components/SparklineDesignSections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let container: HTMLDivElement;
let root: Root;

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

function click(testId: string): void {
  const el = container.querySelector(`[data-testid='${testId}']`);
  if (!el) throw new Error(`no element for ${testId}`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function render(): void {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout()}>
        <SparklineGroupSection {...({ placement: "ribbon" } as PanelSectionProps)} />
      </SurfaceLayoutProvider>,
    );
  });
}

beforeEach(() => {
  resetSparklineStore();
  // Three single column sparklines at F1, F2, F3 (over A:E of their rows),
  // with F1:F3 -- Core's selection -- selected.
  const three = createSparklineGroup(
    { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
    { startRow: 0, startCol: 0, endRow: 2, endCol: 4 },
    "column",
  );
  if (!three.group) throw new Error("precondition: the sparkline group was not created");
  ungroupSparkline(three.group.id);
  expect(getAllGroups(), "precondition: three single sparklines").toHaveLength(3);
  grid.selection = { startRow: 0, startCol: 5, endRow: 2, endCol: 5 };
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  release();
  act(() => root.unmount());
  container.remove();
});

describe("Sparkline design > Group while a selection owner holds the selection", () => {
  it("groups nothing in Core's hidden selection; one toast", () => {
    owns = true;
    click("sparkline-group");
    expect(getAllGroups(), "Group merged the sparklines of Core's HIDDEN selection").toHaveLength(3);
    expect(refusals().length).toBe(1);
  });

  it("Clear acts on the group the tab shows (as Ungroup does): not refused", () => {
    owns = true;
    click("sparkline-clear");
    expect(getAllGroups(), "Clear removed the shown group").toHaveLength(2);
    expect(refusals()).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("Group merges the three sparklines of the selection, no refusal", () => {
    click("sparkline-group");
    expect(getAllGroups()).toHaveLength(1);
    expect(refusals()).toEqual([]);
  });
});
