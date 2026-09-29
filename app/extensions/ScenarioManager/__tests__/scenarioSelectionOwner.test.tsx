//! FILENAME: app/extensions/ScenarioManager/__tests__/scenarioSelectionOwner.test.tsx
// PURPOSE: Data > What-If Analysis > Scenario Manager... opens while a
//          selection owner (a floating grid's selected cell) holds the
//          selection -- it does not refuse -- but WITHOUT the prefill from
//          Core's hidden selection: Add... then starts with an empty Changing
//          cells field instead of the hidden cell's address.
// CONTEXT: W24 (wave C), with the owner default: "Scenario Manager ... do NOT
//          refuse while a selection owner claims the selection: they open with
//          NO prefill from Core's hidden selection." The manager is
//          workbook-level; only its Add prefill came from Core's selection.
//          TEST owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * React's own act() flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  scenarioList: vi.fn(async () => ({ scenarios: [] })),
}));
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, resizeHandles: null, onHeaderMouseDown: () => {}, reset: () => {} }),
}));

import { registerScenarioMenuItems, setCurrentSelection } from "../handlers/dataMenuBuilder";
import { ScenarioManagerDialog } from "../components/ScenarioManagerDialog";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let root: Root | null = null;
let host: HTMLDivElement;

/** The Data menu door, with the dialog's opener recorded. */
function menuDoor(): { run: () => unknown; shown: [string, unknown][] } {
  const items = new Map<string, { id: string; action?: () => unknown; children?: { id: string; action?: () => unknown }[] }>();
  const shown: [string, unknown][] = [];
  const context = {
    ui: {
      menus: {
        registerItem: (_menu: string, item: { id: string; children?: { id: string; action?: () => unknown }[] }) =>
          void items.set(item.id, item),
        unregisterItem: (_menu: string, id: string) => void items.delete(id),
      },
      dialogs: { show: (id: string, data?: unknown) => void shown.push([id, data]) },
    },
  } as never;
  registerScenarioMenuItems(context);
  const door = items.get("data:whatIf")?.children?.find((c) => c.id === "data:whatIf:scenarioManager");
  if (!door?.action) throw new Error("no Scenario Manager menu item");
  return { run: door.action, shown };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function openDialogAndAdd(data: Record<string, unknown>): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root!.render(<ScenarioManagerDialog isOpen={true} onClose={() => {}} data={data} {...({} as object)} />);
    await settle();
  });
  const add = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add..."));
  if (!add) throw new Error(`no Add... button in: ${host.textContent?.slice(0, 300)}`);
  await act(async () => {
    add.click();
    await settle();
  });
}

function changingCells(): string {
  const label = [...host.querySelectorAll("label")].find((l) => l.textContent === "Changing cells:");
  const input = label?.parentElement?.querySelector("input");
  if (!input) throw new Error("no Changing cells field");
  return input.value;
}

beforeEach(() => {
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  // Core's selection: B4 -- hidden under the owner's object in the claimed cases.
  setCurrentSelection({ activeRow: 3, activeCol: 1, endRow: 3, endCol: 1 });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  release();
  setCurrentSelection(null);
  if (root) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
    root = null;
  }
  host.remove();
});

describe("Scenario Manager... while a selection owner holds the selection", () => {
  it("opens (no refusal), handing the dialog NO selection to prefill from", async () => {
    const door = menuDoor();
    owns = true;
    await door.run();
    expect(door.shown.map(([id]) => id)).toEqual(["scenario-manager"]);
    const data = (door.shown[0][1] ?? {}) as Record<string, unknown>;
    expect(data.activeRow, "the door handed the dialog Core's HIDDEN selection").toBeUndefined();
    expect(toasts).toEqual([]);
  });

  it("the dialog opened that way starts Add... with an EMPTY Changing cells field", async () => {
    await openDialogAndAdd({});
    expect(changingCells(), "Add... prefilled a cell nobody chose").toBe("");
    expect(host.querySelector('[data-testid="scenario-cell-values"]')).toBeNull();
  });
});

describe("positive control: nothing owns the selection", () => {
  it("the door hands the dialog the selection (B4)", async () => {
    const door = menuDoor();
    await door.run();
    expect(door.shown).toEqual([["scenario-manager", { activeRow: 3, activeCol: 1, endRow: 3, endCol: 1 }]]);
  });

  it("Add... prefills the Changing cells from it", async () => {
    await openDialogAndAdd({ activeRow: 3, activeCol: 1, endRow: 3, endCol: 1 });
    expect(changingCells()).toBe("$B$4");
  });
});
