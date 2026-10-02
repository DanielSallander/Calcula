//! FILENAME: app/extensions/BuiltIn/ObjectPosition/__tests__/gripMenu.test.tsx
// PURPOSE: The grip's menu (BUG-0258 design phase 5b), through the REAL
//          extension activate() and the real grip-click event Core dispatches:
//          - a `floatingObject:gripClick` shows the menu overlay anchored at the
//            grip (and nothing for an object no longer published);
//          - "Size and Position..." is the FIRST row, and choosing it opens the
//            dialog for THAT object (the extension is the seam's opener);
//          - registered grip items follow, under a rule, only where they apply;
//          - the keyboard: Arrow keys skip disabled rows, Enter runs, Escape
//            closes -- each consumed; a mousedown outside closes it; it takes
//            focus and gives it back;
//          - its object vanishing closes it;
//          - the `object.sizeAndPosition` command opens the dialog for the
//            selection's primary object;
//          - deactivate takes every door down.
// CONTEXT: The shell's overlay and dialog services are replaced by recording
//          fakes (@api/ui's IoC registration), and the menu component is
//          rendered from what the extension asked the overlay service to show.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ primary: null as unknown }));

vi.mock("@api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectSelection")>()),
  getPrimaryObjectRegion: () => h.primary,
}));

import type { ExtensionContext } from "@api/contract";
import type { AnchorRect, DialogDefinition, OverlayDefinition } from "@api/uiTypes";
import { CommandRegistry } from "@api/commands";
import { registerDialogService, registerOverlayService } from "@api/ui";
import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import { FLOATING_GRIP_CLICK_EVENT } from "@api/objectGrip";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import {
  SIZE_AND_POSITION_COMMAND,
  SIZE_AND_POSITION_LABEL,
  hasSizeAndPositionOpener,
  registerObjectGripMenuItem,
  resetObjectPosition,
} from "@api/objectPosition";
import extension, { GRIP_MENU_ID, SIZE_POSITION_DIALOG_ID } from "../index";
import { GripMenu } from "../components/GripMenu";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Recording fakes for the shell's services
// ---------------------------------------------------------------------------

const overlays = new Map<string, OverlayDefinition>();
const shown: Array<{ id: string; data?: Record<string, unknown>; anchorRect?: AnchorRect }> = [];
const hidden: string[] = [];
const dialogs = new Map<string, DialogDefinition>();
const opened: Array<{ id: string; data?: Record<string, unknown> }> = [];

registerOverlayService({
  registerOverlay: (d) => void overlays.set(d.id, d),
  unregisterOverlay: (id) => void overlays.delete(id),
  showOverlay: (id, o) => void shown.push({ id, data: o.data, anchorRect: o.anchorRect }),
  hideOverlay: (id) => void hidden.push(id),
  hideAllOverlays: () => {},
  getOverlay: (id) => overlays.get(id),
  getVisibleOverlays: () => [],
  getAllOverlays: () => [...overlays.values()],
  onChange: () => () => {},
});
registerDialogService({
  registerDialog: (d) => void dialogs.set(d.id, d),
  unregisterDialog: (id) => void dialogs.delete(id),
  openDialog: (id, data) => void opened.push({ id, data }),
  closeDialog: () => {},
  getDialog: (id) => dialogs.get(id),
  getVisibleDialogs: () => [],
  isDialogOpen: () => false,
  onChange: () => () => {},
});

function context(): ExtensionContext {
  return {
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
      has: (id: string) => CommandRegistry.has(id),
    },
  } as unknown as ExtensionContext;
}

const SLICER: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { slicerId: "s1" },
  floating: { x: 64, y: 32, width: 200, height: 100 },
};
const CHART_ON_CANVAS: GridRegion = { ...SLICER, id: "chart-c1", type: "chart", data: { chartId: "c1", onCanvas: true } };
const ANCHOR = { x: 140, y: 60, width: 24, height: 24 };

function gripClick(regionId: string, button: 0 | 2 = 0): void {
  window.dispatchEvent(
    new CustomEvent(FLOATING_GRIP_CLICK_EVENT, { detail: { regionId, regionType: "slicer", anchor: ANCHOR, button } }),
  );
}

let container: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];
const onClose = vi.fn();

beforeEach(async () => {
  overlays.clear();
  dialogs.clear();
  shown.length = 0;
  hidden.length = 0;
  opened.length = 0;
  onClose.mockClear();
  h.primary = null;
  resetObjectPosition();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectGeometryProvider({ types: ["slicer", "chart"], commit: async () => {} }));
  setGridRegions([SLICER, CHART_ON_CANVAS]);
  await extension.activate(context());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  await extension.deactivate?.();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

/** Render the menu the way the shell's OverlayContainer would, from the last show. */
function renderShownMenu(): HTMLElement {
  const last = shown[shown.length - 1];
  expect(last?.id).toBe(GRIP_MENU_ID);
  act(() => {
    root.render(<GripMenu onClose={onClose} data={last.data} anchorRect={last.anchorRect} />);
  });
  const menu = document.querySelector<HTMLElement>("[data-object-grip-menu]");
  if (!menu) throw new Error("the grip menu rendered nothing");
  return menu;
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const key = (k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
};

describe("the grip's menu", () => {
  it("a grip click shows the menu, anchored at the grip -- for a left click and a right-click alike", () => {
    gripClick(SLICER.id);
    expect(shown).toEqual([{ id: GRIP_MENU_ID, data: { regionId: SLICER.id }, anchorRect: ANCHOR }]);
    gripClick(SLICER.id, 2);
    expect(shown).toHaveLength(2);
  });

  it("a click on the grip of an object no longer published shows nothing", () => {
    gripClick("slicer-gone");
    expect(shown).toEqual([]);
  });

  it("'Size and Position...' is the FIRST row, and choosing it opens the dialog for THAT object", () => {
    expect(hasSizeAndPositionOpener(), "activate installed no opener").toBe(true);
    gripClick(SLICER.id);
    renderShownMenu();
    expect(rows()[0].textContent).toBe(SIZE_AND_POSITION_LABEL);
    act(() => rows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClose, "the menu closes before the dialog opens").toHaveBeenCalledTimes(1);
    expect(opened).toEqual([{ id: SIZE_POSITION_DIALOG_ID, data: { regionId: SLICER.id } }]);
  });

  it("registered items follow under a rule, only where they apply, and act on THAT object", async () => {
    const ran: string[] = [];
    cleanups.push(
      registerObjectGripMenuItem({
        id: "test.canvasOnly",
        label: "Bring Forward",
        order: 10,
        visible: (r) => r.data?.onCanvas === true,
        run: (r) => {
          ran.push(r.id);
        },
      }),
    );
    gripClick(SLICER.id);
    renderShownMenu();
    expect(rows().map((r) => r.textContent)).toEqual([SIZE_AND_POSITION_LABEL]);
    expect(document.querySelector('[role="separator"]'), "a rule under nothing").toBeNull();

    gripClick(CHART_ON_CANVAS.id);
    renderShownMenu();
    expect(rows().map((r) => r.textContent)).toEqual([SIZE_AND_POSITION_LABEL, "Bring Forward"]);
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
    act(() => rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ran).toEqual([CHART_ON_CANVAS.id]);
  });

  it("the keyboard: the menu takes focus; ArrowDown skips a disabled row; Enter runs the active one -- consumed", async () => {
    const ran: string[] = [];
    for (const [id, enabled] of [
      ["test.disabled", false],
      ["test.lock", true],
    ] as const) {
      cleanups.push(
        registerObjectGripMenuItem({ id, label: id, enabled: () => enabled, run: () => void ran.push(id) }),
      );
    }
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    gripClick(SLICER.id);
    const menu = renderShownMenu();
    expect(document.activeElement, "the menu did not take focus").toBe(menu);
    expect(rows()[0].dataset.active).toBe("true");

    const down = key("ArrowDown");
    expect(down.defaultPrevented, "ArrowDown was not consumed").toBe(true);
    expect(rows()[2].dataset.active, "ArrowDown did not skip the disabled row").toBe("true");
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    key("Enter");
    window.removeEventListener("keydown", outer);
    expect(outer, "Enter reached the window behind the menu").not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ran).toEqual(["test.lock"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes it, consumed, and focus goes back to where it was", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    gripClick(SLICER.id);
    renderShownMenu();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    const esc = key("Escape");
    window.removeEventListener("keydown", outer);
    expect(esc.defaultPrevented).toBe(true);
    expect(outer, "Escape reached the window behind the menu").not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(<></>));
    expect(document.activeElement, "focus was not given back").toBe(before);
  });

  it("a mousedown outside closes it; one inside does not", async () => {
    gripClick(SLICER.id);
    const menu = renderShownMenu();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("its object vanishing (deleted, another sheet) closes it", () => {
    gripClick(SLICER.id);
    renderShownMenu();
    act(() => setGridRegions([CHART_ON_CANVAS]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the object.sizeAndPosition command opens the dialog for the selection's PRIMARY object", async () => {
    h.primary = CHART_ON_CANVAS;
    await CommandRegistry.execute(SIZE_AND_POSITION_COMMAND);
    expect(opened).toEqual([{ id: SIZE_POSITION_DIALOG_ID, data: { regionId: CHART_ON_CANVAS.id } }]);
    h.primary = null;
    await CommandRegistry.execute(SIZE_AND_POSITION_COMMAND);
    expect(opened).toHaveLength(1);
  });

  it("the app loads it: the built-in manifest imports it and lists it in the activation order", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const manifest = readFileSync(path.resolve(__dirname, "../../../manifest.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(manifest).toMatch(/import ObjectPositionExtension from "\.\/BuiltIn\/ObjectPosition";/);
    const list = manifest.slice(manifest.indexOf("export const builtInExtensions"));
    expect(list, "imported but never activated").toMatch(/\n\s*ObjectPositionExtension,\n/);
  });

  it("deactivate takes every door down: no listener, no opener, no command, no overlay, no dialog", async () => {
    await extension.deactivate?.();
    gripClick(SLICER.id);
    expect(shown).toEqual([]);
    expect(hasSizeAndPositionOpener()).toBe(false);
    expect(CommandRegistry.has(SIZE_AND_POSITION_COMMAND)).toBe(false);
    expect(overlays.has(GRIP_MENU_ID)).toBe(false);
    expect(dialogs.has(SIZE_POSITION_DIALOG_ID)).toBe(false);
    await extension.activate(context());
  });
});
