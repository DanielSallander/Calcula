//! FILENAME: app/extensions/Tracing/__tests__/tracingMenuDoors.test.ts
// PURPOSE: (1) The Formulas menu Tracing BUILDS goes with it on deactivate,
//          and the items other extensions added to that menu survive and come
//          back once when it is built again. (2) Trace Precedents / Trace
//          Dependents refuse -- one toast, no trace -- while a selection owner
//          holds the selection; Remove Arrows does not.
// CONTEXT: W20 and W24 (wave C). (1) @api/ui had no unregisterMenu, so the
//          menu outlived the extension. (2) The trace starts at Core's ACTIVE
//          cell, which is hidden under a floating grid while that grid's cell
//          is selected: the arrows came from a cell the user could not see.
//          The owner default: View > Split and Trace Precedents / Dependents
//          act on the hidden active cell, so they refuse while claimed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  addPrecedentLevel: vi.fn(async () => {}),
  addDependentLevel: vi.fn(async () => {}),
  removeAllArrows: vi.fn(),
}));

vi.mock("../lib/tracingStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tracingStore")>()),
  addPrecedentLevel: h.addPrecedentLevel,
  addDependentLevel: h.addDependentLevel,
  removeAllArrows: h.removeAllArrows,
}));

import * as ui from "@api/ui";
import type { MenuItemDefinition } from "@api/ui";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import extension from "../index";

/** Every door of the context inert, except the menu registry, which is REAL. */
function context(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const menus = {
    register: ui.registerMenu,
    unregister: ui.unregisterMenu,
    registerItem: ui.registerMenuItem,
    unregisterItem: ui.unregisterMenuItem,
    updateItem: ui.updateMenuItem,
    getAll: ui.getMenus,
    subscribe: ui.subscribeToMenus,
    notifyChanged: ui.notifyMenusChanged,
  };
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "ui") {
        return new Proxy(inert() as Record<string, unknown>, {
          get: (u, p) => (p === "menus" ? menus : (u as Record<string | symbol, unknown>)[p as string]),
        });
      }
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

function formulasItems(): MenuItemDefinition[] {
  return ui.getMenus().find((m) => m.id === "formulas")?.items ?? [];
}

function action(id: string): () => unknown {
  const item = formulasItems().find((i) => i.id === id);
  if (!item?.action) throw new Error(`no Formulas menu action ${id}`);
  return item.action;
}

const toasts: ToastPayload[] = [];
let owns = false;
let releaseOwner: () => void = () => {};

beforeEach(() => {
  toasts.length = 0;
  owns = false;
  h.addPrecedentLevel.mockClear();
  h.addDependentLevel.mockClear();
  h.removeAllArrows.mockClear();
  registerToastSink((t) => void toasts.push(t));
  releaseOwner = registerSelectionOwner({
    id: "tracing-test-owner",
    label: "the test object's cells",
    ownsSelection: () => owns,
  });
});

afterEach(() => {
  extension.deactivate?.();
  releaseOwner();
  ui.unregisterMenuItem("formulas", "formulas:foreign");
});

describe("Tracing's Formulas menu lives exactly as long as the extension", () => {
  it("deactivate removes it; another extension's item survives and returns once", () => {
    ui.registerMenuItem("formulas", { id: "formulas:foreign", label: "Name Manager" });
    extension.activate(context());
    expect(formulasItems().map((i) => i.id)).toEqual(
      expect.arrayContaining(["formulas:tracePrecedents", "formulas:foreign"]),
    );

    extension.deactivate?.();
    expect(ui.getMenus().some((m) => m.id === "formulas"), "the Formulas menu outlived Tracing").toBe(false);

    extension.activate(context());
    expect(formulasItems().filter((i) => i.id === "formulas:foreign")).toHaveLength(1);
  });
});

describe("Trace Precedents / Dependents refuse while a selection owner holds the selection", () => {
  it("Trace Precedents: one toast, no trace", async () => {
    extension.activate(context());
    owns = true;
    await action("formulas:tracePrecedents")();
    expect(h.addPrecedentLevel).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("Trace Precedents");
  });

  it("Trace Dependents: one toast, no trace", async () => {
    extension.activate(context());
    owns = true;
    await action("formulas:traceDependents")();
    expect(h.addDependentLevel).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("Trace Dependents");
  });

  it("Remove Arrows is not the selection's: it still acts", async () => {
    extension.activate(context());
    owns = true;
    await action("formulas:removeArrows")();
    expect(h.removeAllArrows).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(0);
  });

  it("positive control: with nothing owning the selection both trace, silently", async () => {
    extension.activate(context());
    await action("formulas:tracePrecedents")();
    await action("formulas:traceDependents")();
    expect(h.addPrecedentLevel).toHaveBeenCalledTimes(1);
    expect(h.addDependentLevel).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(0);
  });
});
