//! FILENAME: app/src/shell/registries/__tests__/sheetTabMenuColorAndHide.test.tsx
// PURPOSE: The sheet-tab right-click menu's Tab Color is Excel's palette (a
//          ColorPopover with "No Color") that runs CoreCommands.SHEET_TAB_COLOR,
//          and its Hide Sheet greys on the VISIBLE sheet count.
// CONTEXT: Home tab 2026-10-04 (shell-sheets defects 5 and 6).
//          - Tab Color was a numbered TEXT prompt ("1. Red ... 9. No Color,
//            enter number (or hex color)") dispatching a raw
//            `sheet:requestTabColor` window event -- a second door beside the
//            command the Home tab's Format > Tab Color runs, with its own
//            eight off-palette colours and its own validation.
//          - Hide Sheet greyed on `totalSheets <= 1`, a count that includes
//            HIDDEN sheets: with Sheet2 hidden, right-clicking Sheet1 offered
//            Hide Sheet, which the backend then refused. Excel greys it.
//          The commands themselves are sheetCommands.test.ts's; this file
//          proves the MENU reaches them, through a fake strip controller (the
//          command acts through it, the raw event did not).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  prompt: vi.fn(async () => null),
  alert: vi.fn(async () => undefined),
}));

vi.mock("@api/dialogs", () => ({
  promptAsync: (...a: unknown[]) => h.prompt(...(a as [])),
  alertAsync: (...a: unknown[]) => h.alert(...(a as [])),
  confirmAsync: vi.fn(async () => false),
}));
// The theme palette is a Tauri round-trip in the app (color.test.tsx).
vi.mock("../../../api/theme", () => ({ getThemeColorPalette: async () => [] }));

import { sheetExtensions, registerCoreSheetContextMenu, type SheetContext } from "../sheetExtensions";
import {
  registerSheetTabsController,
  type SheetTabsController,
  type SheetTabsSnapshot,
} from "../../SheetTabs/sheetCommands";
import { getShellComponents } from "../../../api/ui";
import type { SheetInfo } from "../../../core/lib/tauri-api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const sheet = (index: number, name: string, visibility: SheetInfo["visibility"], tabColor = ""): SheetInfo => ({
  index,
  name,
  visibility,
  tabColor,
});

let snapshot: SheetTabsSnapshot;
let controller: SheetTabsController & { setTabColor: ReturnType<typeof vi.fn> };
let release: (() => void) | null = null;

function seat(sheets: SheetInfo[], activeIndex = 0): void {
  snapshot = { sheets, activeIndex, locked: false };
  release?.();
  controller = {
    snapshot: () => snapshot,
    insertSheetBefore: vi.fn(async () => {}),
    deleteSheet: vi.fn(async () => {}),
    renameSheet: vi.fn(async () => {}),
    hideSheet: vi.fn(async () => {}),
    openUnhideDialog: vi.fn(async () => {}),
    setTabColor: vi.fn(async () => {}),
    moveOrCopySheet: vi.fn(async () => {}),
  };
  release = registerSheetTabsController(controller);
}

/** The context the strip builds for a right-click on `index` (totalSheets counts EVERY sheet). */
function contextFor(index: number): SheetContext {
  const s = snapshot.sheets.find((x) => x.index === index)!;
  return { sheet: s, index, isActive: index === snapshot.activeIndex, totalSheets: snapshot.sheets.length };
}

function item(id: string, context: SheetContext) {
  const found = sheetExtensions.getContextMenuItemsForContext(context).find((i) => i.id === id);
  expect(found, `the tab menu has no ${id}`).toBeDefined();
  return found!;
}

beforeAll(() => {
  registerCoreSheetContextMenu();
});

afterEach(() => {
  release?.();
  release = null;
});

// ============================================================================
// Hide Sheet
// ============================================================================

describe("Hide Sheet greys on the VISIBLE sheet count", () => {
  it("greyed when the right-clicked sheet is the only VISIBLE one, though the workbook has two", () => {
    seat([sheet(0, "Sheet1", "visible"), sheet(1, "Sheet2", "hidden")]);
    expect(item("core:hideSheet", contextFor(0)).disabled).toBe(true);
  });

  it("a veryHidden sheet does not count either", () => {
    seat([sheet(0, "Sheet1", "visible"), sheet(1, "Code", "veryHidden"), sheet(2, "Old", "hidden")]);
    expect(item("core:hideSheet", contextFor(0)).disabled).toBe(true);
  });

  it("enabled with another visible sheet (positive control), whatever is hidden besides", () => {
    seat([sheet(0, "Sheet1", "visible"), sheet(1, "Sheet2", "hidden"), sheet(2, "Sheet3", "visible")]);
    expect(item("core:hideSheet", contextFor(0)).disabled).toBe(false);
    expect(item("core:hideSheet", contextFor(2)).disabled).toBe(false);
  });

  it("with no strip seated it falls back to the workbook's count (one sheet: greyed)", () => {
    seat([sheet(0, "Sheet1", "visible")]);
    const lone = contextFor(0);
    release!();
    release = null;
    expect(item("core:hideSheet", lone).disabled).toBe(true);
    expect(item("core:hideSheet", { ...lone, totalSheets: 2 }).disabled).toBe(false);
  });
});

// ============================================================================
// Tab Color
// ============================================================================

describe("Tab Color opens Excel's palette and runs core.sheet.setTabColor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let tab: HTMLButtonElement;

  beforeEach(async () => {
    h.prompt.mockClear();
    seat([sheet(0, "Sheet1", "visible"), sheet(1, "Data", "visible", "#00b050")]);
    // The right-clicked tab, which the palette drops from (as the strip renders it).
    tab = document.createElement("button");
    tab.setAttribute("data-sheet-tab", "1");
    document.body.appendChild(tab);
    const picker = getShellComponents().find((c) => c.id === "core.sheetTabColorPicker");
    expect(picker, "the palette's host is not a shell component (the frame would never mount it)").toBeDefined();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(picker!.component));
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    tab.remove();
    document.body.querySelectorAll('[data-testid="sheet-tab-color-popover"]').forEach((n) => n.remove());
  });

  async function openFromMenu(): Promise<HTMLElement> {
    await act(async () => {
      await item("core:tabColor", contextFor(1)).onClick(contextFor(1));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const body = document.querySelector<HTMLElement>('[data-testid="sheet-tab-color-popover"]');
    expect(body, "Tab Color opened no palette").not.toBeNull();
    return body!;
  }

  it("asks no text question (the numbered prompt is gone)", async () => {
    await openFromMenu();
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("a Standard Colors swatch sets THAT sheet's colour through the command (the strip's controller), then closes", async () => {
    const body = await openFromMenu();
    const red = body.querySelector<HTMLButtonElement>('button[aria-label="Red"]');
    expect(red, "no Red swatch in the palette").not.toBeNull();
    await act(async () => {
      red!.click();
    });
    expect(controller.setTabColor).toHaveBeenCalledTimes(1);
    expect(controller.setTabColor).toHaveBeenCalledWith(1, "#ff0000");
    expect(document.querySelector('[data-testid="sheet-tab-color-popover"]'), "the palette stayed open").toBeNull();
  });

  it("\"No Color\" clears it (the command stores \"\")", async () => {
    const body = await openFromMenu();
    const none = body.querySelector<HTMLButtonElement>('[data-testid="sheet-tab-color-popover-automatic"]');
    expect(none, "no No Color row").not.toBeNull();
    expect(none!.textContent).toContain("No Color");
    await act(async () => {
      none!.click();
    });
    expect(controller.setTabColor).toHaveBeenCalledWith(1, "");
  });

  it("marks the sheet's CURRENT colour selected", async () => {
    const body = await openFromMenu();
    const green = body.querySelector<HTMLButtonElement>('button[aria-label="Green"]');
    expect(green?.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens UPWARD from the right-clicked tab (the tabs sit at the bottom of the window)", async () => {
    // Where the strip drew sheet 1's tab; jsdom lays nothing out itself.
    tab.getBoundingClientRect = () =>
      ({ left: 120, top: 700, right: 200, bottom: 724, width: 80, height: 24, x: 120, y: 700, toJSON: () => ({}) }) as DOMRect;
    const body = await openFromMenu();
    const card = body.closest<HTMLElement>('[aria-label="Tab Color"]');
    expect(card, "the palette is not labelled Tab Color").not.toBeNull();
    expect(card!.style.left).toBe("120px");
    // Held by its BOTTOM edge above the tab's top: an upward placement.
    expect(card!.style.bottom).not.toBe("");
    expect(card!.style.visibility).toBe("visible");
  });
});
