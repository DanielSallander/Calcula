//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabFormatCellsDoors.test.tsx
// PURPOSE: The Home tab's Format Cells doors -- Number's "More Number
//          Formats...", Fill's "More Fill Options..." and the Font, Alignment
//          and Number groups' corner-arrow dialog launchers (Excel's, since
//          2026-10-04) -- open Format Cells on their tab through the
//          FORMAT_CELLS command, the ONE door to the
//          dialog, so they refuse (one toast, no dialog) while a selection owner
//          holds the selection, exactly like Ctrl+1 and Format > Format Cells.
// CONTEXT: Review of BUG-0185 (K1). Both rows called
//          DialogExtensions.openDialog("format-cells", ...) directly, past the
//          command's owner check: with a floating grid's cell selected, Format
//          Cells opened with no toast over Core's HIDDEN cell, showing that
//          cell's format, and only OK refused. Runs the REAL component, the
//          REAL Format Cells extension's command and the REAL selection-owner
//          seam; only the dialog host is doubled (openDialog is counted).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for DialogExtensions and the
 * CellStylesGallery component, whose real names are PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ openDialog: vi.fn() }));

vi.mock("@api", async () => ({
  // Fill Color's split draws its face from the real icon set.
  RibbonIcon: (await import("@api/ribbonIcons")).RibbonIcon,
  useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/ui", () => ({
  DialogExtensions: {
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    openDialog: (...a: unknown[]) => h.openDialog(...a),
  },
}));
vi.mock("@api/undoState", () => ({
  useUndoAvailability: () => ({ canUndo: false, canRedo: false }),
}));
vi.mock("@api/numberFormats", () => ({
  getRibbonNumberFormats: async () => [{ preset: "general", displayName: "General", sample: "1234" }],
}));
vi.mock("@api/locale", () => ({
  onLocaleChanged: () => () => {},
}));
vi.mock("@api/theme", () => ({
  getThemeColorPalette: async () => [],
}));
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle: { numberFormat: "General", backgroundColor: "#ffffff" },
    currentCellData: null,
    handleItemClick: vi.fn(),
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange: vi.fn(),
    handleFontSizeChange: vi.fn(),
    handleNumberFormatChange: vi.fn(),
    isActive: () => false,
    applyFormat: vi.fn(),
    getItemById: vi.fn(),
  }),
}));
vi.mock("../components/homeTabIcons", () => ({
  homeTabIcon: () => null,
  // buildSections draws each section's glyph (the launcher tests read the sections).
  groupIconFor: () => null,
  HomeTabCustomizeIcon: () => null,
  LAUNCHER_ICON_SIZE: 24,
}));
vi.mock("../../../_shared/components/CellStylesGallery", () => ({
  CellStylesGallery: () => null,
}));

import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { initKeybindings } from "@api/keybindings";
import { MORE_NUMBER_FORMATS_VALUE } from "../components/numberFormatOptions";
import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";
import formatCellsExtension from "../../FormatCellsDialog/index";
import { buildSections } from "../index";
import { DEFAULT_LAYOUT } from "../homeTabConfig";

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.openDialog.mockReset();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  formatCellsExtension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  release?.();
  release = null;
  formatCellsExtension.deactivate?.();
  CommandRegistry.unregister("core.format.cells");
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function claim(): void {
  release = registerSelectionOwner({
    id: "test-owner",
    label: "the test object's cells",
    ownsSelection: () => true,
  });
}

async function render(itemIds: string[]): Promise<void> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout(1200)}>
        <HomeTabGroupComponent context={{} as never} itemIds={itemIds} />
      </SurfaceLayoutProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

/** Number: open the dropdown and pick its last row. */
async function moreNumberFormats(): Promise<void> {
  await render(["numberFormat"]);
  await click(byTestId("fmt-numberFormat"));
  await click(byTestId(`fmt-numberFormat-option-${MORE_NUMBER_FORMATS_VALUE}`));
}

/** Fill: open the split's palette (its chevron half) and pick "More Fill Options...". */
async function moreFillOptions(): Promise<void> {
  await render(["backgroundColor"]);
  await click(byTestId("fmt-backgroundColor-options"));
  const more = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "More Fill Options...",
  );
  if (!more) throw new Error("no More Fill Options... row");
  await click(more);
}

/** A group's corner arrow (CONTRACT 3.20): the launcher the shell draws for
 *  the section, run exactly as the shell runs it. */
function launcher(sectionId: string): () => Promise<void> {
  return async () => {
    const section = buildSections(DEFAULT_LAYOUT).find((s) => s.id === sectionId)!;
    await act(async () => {
      section.dialogLauncher!.onLaunch();
      for (let i = 0; i < 4; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  };
}

const DOORS: [string, () => Promise<void>, string][] = [
  ["More Number Formats...", moreNumberFormats, "number"],
  ["More Fill Options...", moreFillOptions, "fill"],
  ["the Font dialog launcher", launcher("home.font"), "font"],
  ["the Alignment dialog launcher", launcher("home.alignment"), "alignment"],
  ["the Number dialog launcher", launcher("home.number"), "number"],
];

describe("while a selection owner holds the selection", () => {
  for (const [label, run] of DOORS) {
    it(`${label}: Format Cells does not open, and one toast says why`, async () => {
      claim();
      await run();
      expect(h.openDialog, `${label} opened Format Cells over Core's hidden selection`).not.toHaveBeenCalled();
      expect(toasts.length, `${label} refused ${toasts.length} times`).toBe(1);
      expect(toasts[0].message).toContain("the test object's cells");
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, run, tab] of DOORS) {
    it(`${label}: opens Format Cells on the ${tab} tab, no toast`, async () => {
      await run();
      expect(h.openDialog).toHaveBeenCalledTimes(1);
      expect(h.openDialog).toHaveBeenCalledWith("format-cells", { tab });
      expect(toasts).toEqual([]);
    });
  }
});
