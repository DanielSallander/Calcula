//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabMergePersistence.test.tsx
// PURPOSE: A Home layout a user customised BEFORE Merge became Excel's split
//          button still loads, keeps its Merge command, and renders the split.
// CONTEXT: On 2026-10-02 the catalog item "mergeCells" became Excel's Merge &
//          Center split button, and the frozen RibbonIcon key "MergeCells" was
//          redrawn as Excel's plain Merge Cells. Both names are persisted: the
//          item id in `calcula.homeTab.layout`, and the "merge" launcher glyph id
//          a user group may name beside it. A rename of either would silently
//          drop the user's button or turn their launcher into the fallback
//          glyph, and nothing else in the suite stores a layout that names them.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for RibbonIcon and CellStylesGallery, whose
 * real names are PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

// The real icon set without the @api barrel (which reaches every extension).
vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/undoState", () => ({ useUndoAvailability: () => ({ canUndo: true, canRedo: false }) }));
vi.mock("@api/numberFormats", () => ({ getRibbonNumberFormats: async () => [] }));
vi.mock("@api/locale", () => ({ onLocaleChanged: () => () => {} }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: async () => [] }));
// The split button's own reads: nothing merged, nothing protected.
vi.mock("@api/grid", () => ({
  useGridState: () => ({
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 2, type: "cells" },
    editing: null,
  }),
}));
vi.mock("@api/lib", () => ({
  readSelectionMergeState: async () => ({ touchesMerge: false }),
  isSheetProtected: async () => false,
}));

const handleItemClick = vi.fn();
const handleMergeCommand = vi.fn();
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle: { fontFamily: "Calibri", fontSize: 11, numberFormat: "General" },
    currentCellData: null,
    handleItemClick,
    handleColorSelect: vi.fn(),
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange: vi.fn(),
    handleFontSizeChange: vi.fn(),
    handleNumberFormatChange: vi.fn(),
    handleMergeCommand,
    isActive: () => false,
    getCurrentColor: () => "#000000",
    applyFormat: vi.fn(),
    getItemById: vi.fn(),
  }),
}));
vi.mock("../../../_shared/components/CellStylesGallery", () => ({ CellStylesGallery: () => null }));

import { RibbonIcon } from "@api/ribbonIcons";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { LAYOUT_VERSION, loadLayout, type HomeTabLayout } from "../homeTabConfig";
import { groupIconFor, homeTabIcon, GROUP_ICON_FALLBACK_ID, groupIcon } from "../components/homeTabIcons";
import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";

/** Pinned deliberately (see homeTabLayout.test.ts): a rename discards every
 *  user's saved layout. */
const STORAGE_KEY = "calcula.homeTab.layout";

/** A layout saved before 2026-10-02: Merge moved to the front of Alignment,
 *  and a user group of their own that names Merge and the "merge" glyph. Every
 *  field the saver writes is spelled out, so a load that needs no migration
 *  must hand back exactly this. */
const SAVED_BEFORE_THE_SPLIT: HomeTabLayout = {
  version: LAYOUT_VERSION,
  groups: [
    {
      id: "alignment",
      label: "Alignment",
      items: ["mergeCells", "alignLeft", "alignCenter", "alignRight", "rowBreak", "wrapText"],
      iconId: "alignment",
      collapsePriority: 30,
    },
    {
      id: "user-titles",
      label: "Titles",
      items: ["paste", "mergeCells", "wrapText", "bold"],
      iconId: "merge",
      collapsePriority: 35,
    },
  ],
};

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  localStorage.clear();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handleItemClick.mockClear();
  handleMergeCommand.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("a layout saved before Merge became Excel's split button", () => {
  it("loads unchanged: both groups keep mergeCells, and nothing is rewritten", () => {
    const bytes = JSON.stringify(SAVED_BEFORE_THE_SPLIT);
    localStorage.setItem(STORAGE_KEY, bytes);

    const loaded = loadLayout();

    expect(loaded).toEqual(SAVED_BEFORE_THE_SPLIT);
    expect(localStorage.getItem(STORAGE_KEY), "a current-version load writes nothing").toBe(bytes);
  });

  it("an unversioned layout naming mergeCells keeps it through the migration", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groups: [{ id: "user-titles", label: "Titles", items: ["mergeCells"], iconId: "merge" }] }),
    );
    const [group] = loadLayout().groups;
    expect(group.items).toContain("mergeCells");
    expect(group.iconId).toBe("merge");
  });

  it("the frozen icon key MergeCells is still exported, and the 'merge' glyph still draws it", () => {
    expect(typeof RibbonIcon.MergeCells).toBe("function");
    const glyph = markup(groupIconFor({ id: "user-titles", iconId: "merge" }));
    expect(glyph).toBe(markup(groupIcon("merge")));
    expect(glyph).toBe(markup(<RibbonIcon.MergeCells size={24} />));
    expect(glyph, "not the fallback glyph").not.toBe(markup(groupIcon(GROUP_ICON_FALLBACK_ID)));
  });

  it("the item's face is Merge & Center; the menu's third row keeps the MergeCells drawing", () => {
    expect(markup(homeTabIcon("mergeCells", 20))).toBe(markup(<RibbonIcon.MergeCenter size={20} />));
    expect(markup(<RibbonIcon.MergeCenter size={20} />)).not.toBe(markup(<RibbonIcon.MergeCells size={20} />));
  });

  it("the user's own group, hero and all, renders the split button and runs Merge & Center", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVED_BEFORE_THE_SPLIT));
    const titles = loadLayout().groups.find((g) => g.id === "user-titles")!;

    await act(async () => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout(1200)}>
          <HomeTabGroupComponent context={{} as never} itemIds={titles.items} />
        </SurfaceLayoutProvider>,
      );
    });

    const main = container.querySelector<HTMLElement>('[data-testid="fmt-mergeCells"]');
    const chevron = container.querySelector<HTMLElement>('[data-testid="fmt-mergeCells-options"]');
    expect(main?.tagName).toBe("BUTTON");
    expect(main?.getAttribute("aria-label")).toBe("Merge & Center");
    expect(chevron?.getAttribute("aria-label")).toBe("Merge options");
    // The hero beside it still renders: the split did not displace the group.
    expect(container.querySelector('[data-testid="fmt-paste"]')).not.toBeNull();

    await act(async () => {
      main!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(handleItemClick).toHaveBeenCalledTimes(1);
    expect(handleItemClick.mock.calls[0][0]).toMatchObject({ id: "mergeCells" });
  });
});
