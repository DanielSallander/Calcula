//! FILENAME: app/extensions/Table/components/__tests__/tableResizeSelectionOwner.test.tsx
// PURPOSE: Table Design > Resize Table resizes the table to Core's SELECTION,
//          so it refuses with ONE toast and resizes nothing while a selection
//          owner holds the selection; it resizes when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's selection is HIDDEN under the floating grid, and
//          Resize Table used THAT range. ("Format as Table", named in the
//          audit, is not a door in this tree; Resize is the one Table Design
//          action that reads the selection -- the others act on the table the
//          tab names.) TEST owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the @api namespace objects
 * (RibbonIcon, AppEvents); React's own act() flag is spelled
 * IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  currentTable: null as unknown,
  resizeTableAsync: vi.fn(),
}));

vi.mock("@api", async () => {
  const icons = await vi.importActual<typeof import("@api/ribbonIcons")>("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    AppEvents: {
      TABLE_CREATED: "app:table-created",
      TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    },
    onAppEvent: (name: string, cb: (detail: unknown) => void) => {
      if (!h.listeners.has(name)) h.listeners.set(name, new Set());
      h.listeners.get(name)!.add(cb);
      return () => h.listeners.get(name)?.delete(cb);
    },
    emitAppEvent: (name: string) => {
      if (name === "app:table-request-state" && h.currentTable) {
        h.listeners.get("app:table-state")?.forEach((cb) => cb({ table: h.currentTable }));
      }
    },
    showDialog: vi.fn(),
    // The new range the user selected: rows 0..9 of the table's columns.
    useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 9, endCol: 3 } }),
    openTaskPane: vi.fn(),
    closeTaskPane: vi.fn(),
    useIsTaskPaneOpen: () => false,
    useTaskPaneOpenPaneIds: () => [],
  };
});
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn() }));
vi.mock("@api/backend", () => ({ updateTableStyle: vi.fn() }));
vi.mock("@api/jsonView", () => ({
  getObjectJson: vi.fn(() => Promise.resolve("{}")),
  setObjectJson: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/tableStore", () => ({
  updateTableStyleAsync: vi.fn(),
  toggleTotalsRowAsync: vi.fn(),
  convertToRangeAsync: vi.fn(),
  deleteTableAsync: vi.fn(),
  renameTableAsync: vi.fn(),
  resizeTableAsync: (...a: unknown[]) => h.resizeTableAsync(...a),
  refreshCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("../CreateTableDialog", () => ({ CreateTableDialog: () => null }));
vi.mock("../RemoveDuplicatesDialog", () => ({ RemoveDuplicatesDialog: () => null }));

import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import { PropertiesSection } from "../TableDesignTab";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let container: HTMLDivElement;
let root: Root;

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
async function clickResize(): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="table-design-resize"]');
  if (!button) throw new Error("no Resize Table button");
  expect(button.disabled, "precondition: Resize is enabled for the selected range").toBe(false);
  await act(async () => {
    button.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  h.listeners.clear();
  h.currentTable = {
    id: "t1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 4,
    endCol: 3,
    columns: [],
    styleOptions: {},
    styleName: "TableStyleMedium2",
  };
  h.resizeTableAsync.mockReset();
  h.resizeTableAsync.mockResolvedValue({ id: "t1" });
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout(900)}>
        <PropertiesSection {...({} as PanelSectionProps)} />
      </SurfaceLayoutProvider>,
    );
  });
});
afterEach(() => {
  release();
  act(() => root.unmount());
  container.remove();
});

describe("Resize Table while a selection owner holds the selection", () => {
  it("resizes nothing to Core's hidden selection; one toast", async () => {
    owns = true;
    await clickResize();
    expect(h.resizeTableAsync, "the table was resized to Core's hidden selection").not.toHaveBeenCalled();
    expect(refusals().length).toBe(1);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("resizes the table to the selected range, no refusal", async () => {
    await clickResize();
    expect(h.resizeTableAsync).toHaveBeenCalledWith("t1", 0, 0, 9, 3);
    expect(refusals()).toEqual([]);
  });
});
