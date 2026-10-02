//! FILENAME: app/extensions/Controls/__tests__/heldCodeObjectMenu.test.tsx
// PURPOSE: "Make this my own…" on a button CONTROL's right-click menu (owner
//          question 8, 2026-10-02): offered only on a button that HOLDS an
//          application's code, and running the Properties pane's own flow step
//          for step -- the confirm SHOWS the code (`requestHeldAdoption`, the
//          Tauri-shaped `confirmAsync`, awaited, failing closed), the texts it
//          showed are captured before it is asked and are what goes to Rust
//          (`adopt_held_button_code`, which makes it ONE undo step and writes the
//          always-on `ButtonCodeAdopted` row), a refusal is said in the pane's
//          words, and the open pane re-reads.
// CONTEXT: The menu is built synchronously at open time from the floating
//          store, which knows a control's type and geometry but never its
//          code. Whether a button holds an application's code is one backend
//          READ, so the listener hands the menu a second, refined list
//          (`refinedItems`) that the menu paints when the read answers. A button
//          CELL (Cell Type: Button) gets no such entry: its held action keeps
//          "give it an action of your own" (owner decision Q4), because
//          dropping its stamp would WIDEN what it runs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  /** What the backend stores for each control, by "row,col". */
  stored: new Map<string, { controlType: string; properties: Record<string, { valueType: string; value: string }> }>(),
  /** Every metadata read: (sheet, row, col). */
  reads: [] as unknown[][],
  /** When set, the metadata read fails with this. */
  readFailure: null as string | null,
  /** Every "Make this my own" sent: (sheet, row, col, shownOnSelect, shownMacroRef). */
  adopted: [] as unknown[][],
  /** When set, Rust refuses the adoption with this message. */
  adoptRefusal: null as string | null,
  confirm: vi.fn(),
  toasts: [] as { message: string; options: unknown }[],
  showOverlay: vi.fn(),
}));

/** The regions the real floatingStore publishes; what `getGridRegions` returns. */
let publishedRegions: unknown[] = [];

vi.mock("@api", () => ({
  ["AppEvents"]: { GRID_REFRESH: "grid:refresh" },
  registerOverlay: vi.fn(),
  unregisterOverlay: vi.fn(),
  showOverlay: (...args: unknown[]) => h.showOverlay(...args),
  gridExtensions: {
    registerContextMenuItems: vi.fn(),
    unregisterContextMenuItem: vi.fn(),
  },
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => {}),
}));

vi.mock("@api/gridOverlays", async () => {
  const actual = await vi.importActual<typeof import("@api/gridOverlays")>("@api/gridOverlays");
  return {
    getGridRegions: () => publishedRegions,
    getLiveGridRegions: () => publishedRegions,
    onPointModeViewChanged: () => () => undefined,
    floatingHitOrder: actual.floatingHitOrder,
    stackedFloatingRegions: actual.stackedFloatingRegions,
    replaceGridRegionsByType: (_type: string, regions: unknown[]) => {
      publishedRegions = regions;
    },
    removeGridRegionsByType: () => {
      publishedRegions = [];
    },
    requestOverlayRedraw: vi.fn(),
  };
});

const gridSnapshot = {
  surface: "grid" as "grid" | "canvas",
  displayHeadings: true,
  config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
  viewport: { scrollX: 0, scrollY: 0 },
  zoom: 1,
  sheetContext: { activeSheetIndex: 0 },
};
vi.mock("@api/grid", async () => {
  const header = await vi.importActual<
    typeof import("../../../src/core/lib/gridRenderer/layout/headerVisibility")
  >("../../../src/core/lib/gridRenderer/layout/headerVisibility");
  return {
    getGridStateSnapshot: () => gridSnapshot,
    rowHeaderGutter: header.rowHeaderGutter,
    colHeaderGutter: header.colHeaderGutter,
    resolveHeaderSizes: header.resolveHeaderSizes,
    paintedDisplayHeadings: header.paintedDisplayHeadings,
  };
});

vi.mock("@api/objectClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canvasOwnsObjectClipboard: () => gridSnapshot.surface === "canvas",
}));

// Core's AFTER-press announcement: its `notifyGridCellPressed` is Core-only (an
// extension listens, never presses), so the test holds the listeners Controls
// registered and plays Core's part (selectedObjectKeys.test.ts's precedent).
const pressListeners = vi.hoisted(() => new Set<(press: import("@api/cellClickInterceptors").GridCellPress) => void>());
vi.mock("@api/cellClickInterceptors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/cellClickInterceptors")>();
  return {
    ...orig,
    onGridCellPressed: (listener: Parameters<typeof orig.onGridCellPressed>[0]) => {
      pressListeners.add(listener);
      const off = orig.onGridCellPressed(listener);
      return () => {
        pressListeners.delete(listener);
        off();
      };
    },
  };
});
/** Core announces a handled sheet press. */
function notifyGridCellPressed(press: import("@api/cellClickInterceptors").GridCellPress): void {
  for (const listener of [...pressListeners]) listener(press);
}

// The Tauri shape of the confirm: a Promise, never a synchronous boolean.
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));

vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: unknown) => h.toasts.push({ message, options }),
}));

vi.mock("../lib/controlApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/controlApi")>()),
  getControlMetadata: async (sheetIndex: number, row: number, col: number) => {
    h.reads.push([sheetIndex, row, col]);
    if (h.readFailure) throw h.readFailure;
    return h.stored.get(`${row},${col}`) ?? null;
  },
  // Rust MOVES the held code into the live slot (one undo step, audited).
  adoptHeldButtonCode: async (...a: unknown[]) => {
    h.adopted.push(a);
    if (h.adoptRefusal) throw h.adoptRefusal;
    return {
      controlType: "button",
      properties: { onSelect: { valueType: "static", value: String(a[3] ?? "") } },
    };
  },
}));

import { installControlObjectMenu } from "../lib/controlObjectMenu";
import {
  buildControlObjectMenu,
  makeHeldButtonCodeOwn,
  MAKE_HELD_CODE_OWN_ITEM_ID,
  refineControlObjectMenu,
  registerControlContextMenu,
  type ControlMenuItem,
} from "../lib/controlContextMenu";
import { ControlContextMenu } from "../components/ControlContextMenu";
import { addFloatingControl, resetFloatingStore, syncFloatingControlRegions } from "../lib/floatingStore";
import { deselectFloatingControl } from "../Button/floatingSelection";
import { readHeldButtonCode } from "@api/heldButtonCode";
import { gridExtensions } from "@api";
import type { GridContextMenuItem, GridMenuContext } from "@api/extensions";
import { forgetInCellButtons, noteControlAt } from "../lib/heldEmbeddedButtons";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BUTTON_ID = "control-0-1-1";
const OWN_BUTTON_ID = "control-0-5-5";
const SHAPE_ID = "control-0-3-3";

/** Canvas point inside the held button's painted rect (150..230, 74..98). */
const ON_BUTTON = { clientX: 160, clientY: 80 };
/** Canvas point inside the shape (sheet 300..420, 200..260 -> canvas 350..470, 224..284). */
const ON_SHAPE = { clientX: 360, clientY: 240 };

const STAMP = JSON.stringify({ workspace: "ws", application: "Sales", version: "1.2.0" });

type Props = Record<string, { valueType: string; value: string }>;

/** A button whose code came with the application 'Sales': HELD, no live code. */
function heldButton(onSelect = "Report();"): Props {
  return {
    text: { valueType: "static", value: "Run report" },
    heldOnSelect: { valueType: "static", value: onSelect },
    heldFrom: { valueType: "static", value: STAMP },
  };
}

let layer: HTMLDivElement;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  h.stored.clear();
  h.reads.length = 0;
  h.readFailure = null;
  h.adopted.length = 0;
  h.adoptRefusal = null;
  h.confirm.mockReset();
  h.toasts.length = 0;
  h.showOverlay.mockReset();
  publishedRegions = [];
  gridSnapshot.surface = "grid";

  resetFloatingStore();
  deselectFloatingControl();
  addFloatingControl({ id: BUTTON_ID, sheetIndex: 0, row: 1, col: 1, x: 100, y: 50, width: 80, height: 24, controlType: "button" });
  addFloatingControl({ id: OWN_BUTTON_ID, sheetIndex: 0, row: 5, col: 5, x: 600, y: 50, width: 80, height: 24, controlType: "button" });
  addFloatingControl({ id: SHAPE_ID, sheetIndex: 0, row: 3, col: 3, x: 300, y: 200, width: 120, height: 60, controlType: "shape" });
  syncFloatingControlRegions();

  h.stored.set("1,1", { controlType: "button", properties: heldButton() });
  h.stored.set("5,5", { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } });
  // A shape's code is held for a faithful push too -- but only a button's can be made your own.
  h.stored.set("3,3", { controlType: "shape", properties: heldButton() });

  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  uninstall = installControlObjectMenu();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  layer.remove();
});

function rightClickOnGrid(at: { clientX: number; clientY: number }): void {
  layer.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...at }));
}

const ids = (items: readonly ControlMenuItem[] | null | undefined) => (items ?? []).map((i) => i.id);

/** The data the listener handed the overlay on its first open. */
function openedData(): { items: ControlMenuItem[]; refinedItems?: unknown } {
  return h.showOverlay.mock.calls[0][1].data as { items: ControlMenuItem[]; refinedItems?: unknown };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

describe("the offer: only a button control that holds an application's code", () => {
  it("places Make this my own… just before Delete once the button's held code is known", () => {
    const held = readHeldButtonCode(heldButton());
    const items = buildControlObjectMenu(BUTTON_ID, { heldCode: held });
    const at = ids(items).indexOf(MAKE_HELD_CODE_OWN_ITEM_ID);
    expect(at, "no Make this my own entry on a held button").toBeGreaterThanOrEqual(0);
    expect(items[at].label).toBe("Make this my own…");
    expect(ids(items)[at + 1]).toBe("controls.delete");
    // The destructive Delete stays in its own group below it.
    expect(items[at].separatorAfter).toBe(true);
  });

  it("is never offered without the read: the synchronous menu does not guess", () => {
    expect(ids(buildControlObjectMenu(BUTTON_ID))).not.toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
  });

  it("is never offered on a shape, even one holding code", () => {
    const held = readHeldButtonCode(heldButton());
    expect(ids(buildControlObjectMenu(SHAPE_ID, { heldCode: held }))).not.toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
  });

  // SABOTAGE: in refineControlObjectMenu, skip the metadata read and resolve
  // null -> the held button's refined list never carries the entry -> red.
  it("the refined list of a HELD button carries it; one of the author's own does not", async () => {
    const refined = await refineControlObjectMenu(BUTTON_ID);
    expect(ids(refined)).toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
    expect(h.reads).toEqual([[0, 1, 1]]);

    expect(ids(await refineControlObjectMenu(OWN_BUTTON_ID))).not.toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
  });

  it("a shape is not even read: only a button's code can be made your own", async () => {
    expect(await refineControlObjectMenu(SHAPE_ID)).toBeNull();
    expect(h.reads).toEqual([]);
  });

  it("a read that fails offers nothing more (the menu keeps the list it opened with)", async () => {
    h.readFailure = "backend unavailable";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await refineControlObjectMenu(BUTTON_ID)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  // SABOTAGE: drop `refinedItems` from the data the listener hands showOverlay
  // (lib/controlObjectMenu.ts) -> the entry is unreachable by right-click -> red.
  it("a right-click on the held button opens the menu at once and hands it the refined list", async () => {
    rightClickOnGrid(ON_BUTTON);
    expect(h.showOverlay).toHaveBeenCalledTimes(1);
    const data = openedData();
    // Opens synchronously, without the entry it cannot know yet.
    expect(ids(data.items)).toContain("controls.delete");
    expect(ids(data.items)).not.toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
    expect(data.refinedItems, "the menu was handed no refined list").toBeInstanceOf(Promise);
    expect(ids(await (data.refinedItems as Promise<ControlMenuItem[] | null>))).toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
  });

  it("a right-click on a shape refines to nothing", async () => {
    rightClickOnGrid(ON_SHAPE);
    expect(await (openedData().refinedItems as Promise<unknown>)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The painted menu
// ---------------------------------------------------------------------------

describe("the menu paints the refined list when the read answers", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  function paint(data: Record<string, unknown>, onClose: () => void = () => {}): void {
    act(() => {
      root.render(React.createElement(ControlContextMenu, { onClose, data }));
    });
  }

  const painted = () =>
    [...host.querySelectorAll("[data-control-menu-item]")].map((e) => e.getAttribute("data-control-menu-item"));

  // SABOTAGE: ControlContextMenu ignores `data.refinedItems` -> red.
  it("adds Make this my own… once the refined list arrives, just before Delete", async () => {
    paint({
      controlId: BUTTON_ID,
      screenX: 160,
      screenY: 80,
      items: buildControlObjectMenu(BUTTON_ID),
      refinedItems: refineControlObjectMenu(BUTTON_ID),
    });
    await act(async () => {
      await flush();
    });
    const rows = painted();
    expect(rows).toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
    expect(rows[rows.indexOf(MAKE_HELD_CODE_OWN_ITEM_ID) + 1]).toBe("controls.delete");
    expect(host.querySelector(`[data-control-menu-item='${MAKE_HELD_CODE_OWN_ITEM_ID}']`)?.textContent).toBe(
      "Make this my own…",
    );
  });

  it("never paints a refined list that belongs to an earlier opening", async () => {
    let lateAnswer!: (items: ControlMenuItem[]) => void;
    const late = new Promise<ControlMenuItem[]>((r) => (lateAnswer = r));
    paint({ controlId: BUTTON_ID, screenX: 160, screenY: 80, items: buildControlObjectMenu(BUTTON_ID), refinedItems: late });
    // The menu re-opens on the author's OWN button before the first read answers.
    paint({
      controlId: OWN_BUTTON_ID,
      screenX: 160,
      screenY: 80,
      items: buildControlObjectMenu(OWN_BUTTON_ID),
      refinedItems: Promise.resolve(null),
    });
    await act(async () => {
      lateAnswer(buildControlObjectMenu(BUTTON_ID, { heldCode: readHeldButtonCode(heldButton()) }));
      await flush();
    });
    expect(painted()).not.toContain(MAKE_HELD_CODE_OWN_ITEM_ID);
  });

  it("clicking the painted entry closes the menu and asks the confirm", async () => {
    const onClose = vi.fn();
    h.confirm.mockReturnValue(Promise.resolve(false));
    paint(
      {
        controlId: BUTTON_ID,
        screenX: 160,
        screenY: 80,
        items: buildControlObjectMenu(BUTTON_ID),
        refinedItems: refineControlObjectMenu(BUTTON_ID),
      },
      onClose,
    );
    await act(async () => {
      await flush();
    });
    await act(async () => {
      host.querySelector<HTMLElement>(`[data-control-menu-item='${MAKE_HELD_CODE_OWN_ITEM_ID}']`)!.click();
      await flush();
    });
    expect(onClose).toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.adopted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The flow: the Properties pane's, step for step
// ---------------------------------------------------------------------------

describe("running it: the Properties pane's flow", () => {
  // SABOTAGE: call adoptHeldButtonCode without awaiting requestHeldAdoption in
  // makeHeldButtonCodeOwn -> adopted on a no -> red.
  it("shows the code in the pane's confirm and moves it only on a yes", async () => {
    h.confirm.mockReturnValue(Promise.resolve(false));
    await makeHeldButtonCodeOwn(BUTTON_ID);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const [message, options] = h.confirm.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("This button's code came with the application 'Sales' (v1.2.0):");
    expect(message).toContain("OnSelect:\nReport();");
    expect(message).toContain("This step is recorded in the audit trail.");
    expect(options).toEqual({ title: "Make the application's code your own", kind: "warning", okLabel: "Make it my own" });
    expect(h.adopted, "adopted without a yes").toEqual([]);

    h.confirm.mockReturnValue(Promise.resolve(true));
    await makeHeldButtonCodeOwn(BUTTON_ID);
    expect(h.adopted).toEqual([[0, 1, 1, "Report();", null]]);
    expect(h.toasts).toEqual([]);
  });

  it("fails CLOSED: a confirm that cannot be shown, or answers anything but true, moves nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.confirm.mockImplementation(() => Promise.reject(new Error("no dialog")));
      await makeHeldButtonCodeOwn(BUTTON_ID);
      h.confirm.mockReturnValue(Promise.resolve("yes" as unknown as boolean));
      await makeHeldButtonCodeOwn(BUTTON_ID);
    } finally {
      warn.mockRestore();
    }
    expect(h.adopted).toEqual([]);
  });

  // SABOTAGE: read the held code again AFTER the confirm and send that ->
  // the code that replaced it under the open dialog goes to Rust -> red.
  it("sends the texts the confirm SHOWED, never a later read, and says Rust's refusal in the pane's words", async () => {
    let answer!: (yes: boolean) => void;
    h.confirm.mockReturnValue(new Promise<boolean>((r) => (answer = r)));
    const running = makeHeldButtonCodeOwn(BUTTON_ID);
    await flush();
    // Under the open dialog the button's held code becomes something else.
    h.stored.set("1,1", { controlType: "button", properties: heldButton("Exfiltrate();") });
    const refusal =
      "The application's code on the button at Sheet1!B2 changed after it was shown; nothing was changed. " +
      "Review it again before making it your own.";
    h.adoptRefusal = refusal;
    answer(true);
    await running;
    expect(h.adopted, "the menu sent code the confirm never showed").toEqual([[0, 1, 1, "Report();", null]]);
    expect(h.toasts.map((t) => t.message)).toEqual([`Could not make the application's code your own: ${refusal}`]);
  });

  it("reads the button when the entry is chosen, so the confirm shows what it holds NOW", async () => {
    h.stored.set("1,1", { controlType: "button", properties: heldButton("Newer();") });
    h.confirm.mockReturnValue(Promise.resolve(true));
    await makeHeldButtonCodeOwn(BUTTON_ID);
    expect(String(h.confirm.mock.calls[0][0])).toContain("OnSelect:\nNewer();");
    expect(h.adopted).toEqual([[0, 1, 1, "Newer();", null]]);
  });

  it("a button that no longer holds an application's code is said, with no confirm and nothing sent", async () => {
    h.stored.set("1,1", { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } });
    await makeHeldButtonCodeOwn(BUTTON_ID);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.adopted).toEqual([]);
    expect(h.toasts.map((t) => t.message)).toEqual([
      "This button no longer holds code that came with an application; nothing was changed.",
    ]);
  });

  it("a read that fails is said, with no confirm and nothing sent", async () => {
    h.readFailure = "backend unavailable";
    await makeHeldButtonCodeOwn(BUTTON_ID);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.adopted).toEqual([]);
    expect(h.toasts.map((t) => t.message)).toEqual([
      "Could not make the application's code your own: backend unavailable",
    ]);
  });

  // An open Properties pane on this button shows the held view and its own
  // "Make this my own…" step; after the menu moved the code it must re-read,
  // or it offers a second adoption Rust refuses ("holds no code").
  //
  // SABOTAGE: drop the controls:metadata-refresh dispatch -> red.
  it("tells an open Properties pane to re-read the button, after a yes and after a refusal", async () => {
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("controls:metadata-refresh", listen);
    try {
      h.confirm.mockReturnValue(Promise.resolve(true));
      await makeHeldButtonCodeOwn(BUTTON_ID);
      h.adoptRefusal = "refused";
      await makeHeldButtonCodeOwn(BUTTON_ID);
      // No yes, nothing moved: nothing to re-read.
      h.confirm.mockReturnValue(Promise.resolve(false));
      await makeHeldButtonCodeOwn(BUTTON_ID);
    } finally {
      window.removeEventListener("controls:metadata-refresh", listen);
    }
    expect(heard).toEqual([
      { sheetIndex: 0, row: 1, col: 1 },
      { sheetIndex: 0, row: 1, col: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// An IN-CELL button control: the entry is on Core's CELL menu
// ---------------------------------------------------------------------------
//
// Its right-click IS the cell menu, whose `visible()` is synchronous, so the
// answer is read AHEAD of the right-click (lib/heldEmbeddedButtons.ts): noted
// from the load's read (inCellButtonCellMenu.test.ts drives that through the
// real activate), and read again on a RIGHT press on the cell and on
// `controls:metadata-refresh`. Choosing it reads the button again.

describe("an in-cell button control: Make this my own… on the cell menu", () => {
  const cellAt = (sheetIndex: number, row: number | null, col = 2): GridMenuContext =>
    ({
      selection: null,
      clickedCell: row === null ? null : { row, col },
      isWithinSelection: true,
      sheetIndex,
      sheetName: "Sheet1",
      dimensions: {},
    }) as unknown as GridMenuContext;
  let off: (() => void) | null = null;
  let item: GridContextMenuItem;
  const offered = (context: GridMenuContext) =>
    typeof item.visible === "function" ? item.visible(context) : item.visible !== false;
  const rightPress = (row: number, col: number, button = 2) =>
    notifyGridCellPressed({ row, col, button, shiftKey: false, ctrlKey: false, target: "cell", keptSelection: false });

  beforeEach(() => {
    forgetInCellButtons();
    const register = vi.mocked(gridExtensions.registerContextMenuItems);
    register.mockClear();
    off = registerControlContextMenu();
    const registered = register.mock.calls.flat(2) as GridContextMenuItem[];
    item = registered.find((i) => i.id === MAKE_HELD_CODE_OWN_ITEM_ID)!;
  });

  afterEach(() => {
    off?.();
    off = null;
    forgetInCellButtons();
  });

  // SABOTAGE: drop the item from registerControlContextMenu -> red.
  it("registers Paste and Make this my own…, and unregisters both", () => {
    expect(item, "the cell menu carries no Make this my own item").toBeDefined();
    expect(item.label).toBe("Make this my own…");
    const unregister = vi.mocked(gridExtensions.unregisterContextMenuItem);
    unregister.mockClear();
    off!();
    off = null;
    expect(unregister.mock.calls.map((c) => c[0]).sort()).toEqual(["controls.makeHeldCodeOwn", "controls.paste"]);
  });

  it("offered only where an IN-CELL button CONTROL holds an application's code", () => {
    noteControlAt(0, 7, 2, "button", heldButton());
    noteControlAt(0, 8, 2, "button", { onSelect: { valueType: "static", value: "Mine();" } });
    noteControlAt(0, 9, 2, "button", { ...heldButton(), embedded: { valueType: "static", value: "false" } });
    noteControlAt(0, 10, 2, "shape", heldButton());
    expect(offered(cellAt(0, 7)), "the held in-cell button is not offered").toBe(true);
    expect(offered(cellAt(0, 8)), "offered on the author's own button").toBe(false);
    expect(offered(cellAt(0, 9)), "offered on a FLOATING button's cell (its object menu carries it)").toBe(false);
    expect(offered(cellAt(0, 10)), "offered on a shape").toBe(false);
    expect(offered(cellAt(1, 7)), "offered on another sheet's cell").toBe(false);
    expect(offered(cellAt(0, null)), "offered with no clicked cell").toBe(false);
    // A button CELL (Cell Type: Button) is not a control: nothing notes it.
    expect(offered(cellAt(0, 11)), "offered on a cell no control was found at").toBe(false);
  });

  // SABOTAGE: have the item's onClick go through makeHeldButtonCodeOwn (the
  // floating store) -> an in-cell button is never found -> red.
  it("choosing it runs the pane's flow on that cell's control, and the open pane re-reads", async () => {
    h.stored.set("7,2", { controlType: "button", properties: heldButton() });
    noteControlAt(0, 7, 2, "button", heldButton());
    h.confirm.mockReturnValue(Promise.resolve(true));
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("controls:metadata-refresh", listen);
    try {
      await item.onClick(cellAt(0, 7));
      await flush();
      await flush();
    } finally {
      window.removeEventListener("controls:metadata-refresh", listen);
    }
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(String(h.confirm.mock.calls[0][0])).toContain("OnSelect:\nReport();");
    expect(h.adopted).toEqual([[0, 7, 2, "Report();", null]]);
    expect(heard).toEqual([{ sheetIndex: 0, row: 7, col: 2 }]);
  });

  it("a stale offer reads again when chosen: no longer held is said, with no confirm and nothing sent", async () => {
    noteControlAt(0, 7, 2, "button", heldButton());
    h.stored.set("7,2", { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } });
    await item.onClick(cellAt(0, 7));
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.adopted).toEqual([]);
    expect(h.toasts.map((t) => t.message)).toEqual([
      "This button no longer holds code that came with an application; nothing was changed.",
    ]);
  });

  // SABOTAGE: drop the right-press listener from installInCellButtonUpkeep -> red.
  it("a RIGHT press on a cell reads it again; a left press reads nothing", async () => {
    // Noted as held, then made the author's own elsewhere (the pane).
    noteControlAt(0, 7, 2, "button", heldButton());
    h.stored.set("7,2", { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } });
    rightPress(7, 2, 0);
    await flush();
    expect(h.reads, "a LEFT press read the cell").toEqual([]);
    expect(offered(cellAt(0, 7))).toBe(true);
    rightPress(7, 2);
    await flush();
    expect(h.reads).toEqual([[0, 7, 2]]);
    expect(offered(cellAt(0, 7)), "the right press did not refresh the stale offer").toBe(false);

    // A button made in-cell after the load (toggled) is found by the right press on it.
    h.stored.set("12,2", { controlType: "button", properties: heldButton() });
    rightPress(12, 2);
    await flush();
    expect(offered(cellAt(0, 12))).toBe(true);
  });

  // SABOTAGE: drop the controls:metadata-refresh listener -> red.
  it("controls:metadata-refresh reads the cell it names again, with or without its sheet", async () => {
    noteControlAt(0, 7, 2, "button", heldButton());
    h.stored.set("7,2", { controlType: "button", properties: { onSelect: { valueType: "static", value: "Mine();" } } });
    window.dispatchEvent(new CustomEvent("controls:metadata-refresh", { detail: { row: 7, col: 2 } }));
    await flush();
    expect(offered(cellAt(0, 7))).toBe(false);
    h.stored.set("7,2", { controlType: "button", properties: heldButton() });
    window.dispatchEvent(new CustomEvent("controls:metadata-refresh", { detail: { sheetIndex: 0, row: 7, col: 2 } }));
    await flush();
    expect(offered(cellAt(0, 7))).toBe(true);
  });

  it("a read that fails offers nothing at that cell", async () => {
    noteControlAt(0, 7, 2, "button", heldButton());
    h.readFailure = "backend unavailable";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      rightPress(7, 2);
      await flush();
    } finally {
      warn.mockRestore();
    }
    expect(offered(cellAt(0, 7))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No entry for button CELLS (owner decision Q4)
// ---------------------------------------------------------------------------

describe("a button CELL keeps 'give it an action of your own'", () => {

  it("no CellTypes source reaches the adoption", () => {
    const root = resolve(__dirname, "..", "..", "CellTypes");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/adoptHeldButtonCode|adopt_held_button_code|makeHeldButtonCodeOwn|MAKE_HELD_CODE_OWN_ITEM_ID/.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
