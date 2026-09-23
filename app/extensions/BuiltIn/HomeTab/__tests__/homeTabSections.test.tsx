//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabSections.test.tsx
// PURPOSE: buildSections(DEFAULT_LAYOUT) is today's Home tab, and the
//          customize dialog has a reachable entry point.
// CONTEXT: The owner's constraint is that the CURRENT appearance stays the
//          default; this makes that a property of the code rather than a note.
//          The entry-point assertions exist because the gear was dropped during
//          the sections/panel migration and nobody noticed for months — the
//          dialog stayed registered and listening, so nothing failed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtensionContext } from "@api/contract";

// --- Mocks: keep the test on the layout, not on the whole @api graph --------

const registerPanel = vi.fn();
const unregisterPanel = vi.fn();
const registerMenuItem = vi.fn();
const unregisterMenuItem = vi.fn();
const showDialog = vi.fn();
const registerDialog = vi.fn();
const unregisterDialog = vi.fn();

vi.mock("@api/ui", () => ({
  registerPanel: (...a: unknown[]) => registerPanel(...a),
  unregisterPanel: (...a: unknown[]) => unregisterPanel(...a),
  registerMenuItem: (...a: unknown[]) => registerMenuItem(...a),
  unregisterMenuItem: (...a: unknown[]) => unregisterMenuItem(...a),
  showDialog: (...a: unknown[]) => showDialog(...a),
  DialogExtensions: {
    registerDialog: (...a: unknown[]) => registerDialog(...a),
    unregisterDialog: (...a: unknown[]) => unregisterDialog(...a),
  },
}));

vi.mock("@api/state", () => ({
  useGridState: () => ({ selection: null, editing: null }),
}));

// The two heavy leaves. Neither participates in section IDENTITY, which is
// what this file is about.
vi.mock("../components/HomeTabGroupComponent", () => ({
  HomeTabGroupComponent: () => null,
}));
vi.mock("../components/HomeTabCustomizeDialog", () => ({
  HomeTabCustomizeDialog: () => null,
}));

// homeTabIcons pulls the ribbon icon set off the @api barrel; a stub keeps the
// barrel (which reaches every extension) out of this test's module graph. One
// NAMED stub per key, so a test can tell which drawing a section chose.
vi.mock("@api", () => {
  const stubs = new Map<string, (() => null) & { displayName?: string }>();
  return {
    RibbonIcon: new Proxy(
      {},
      {
        get: (_target, key) => {
          const name = String(key);
          let stub = stubs.get(name);
          if (!stub) {
            stub = Object.assign(() => null, { displayName: name });
            stubs.set(name, stub);
          }
          return stub;
        },
      }
    ),
  };
});

import React from "react";
import { LAUNCHER_ICON_SIZE } from "@api/layout";
import extension, { buildSections } from "../index";
import { DEFAULT_LAYOUT, type HomeTabLayout } from "../homeTabConfig";

/** Which RibbonIcon key a section's glyph element draws, and at what size. */
function glyphOf(icon: unknown): { key: string | undefined; size: unknown } {
  expect(React.isValidElement(icon), "a section glyph is a RibbonIcon element").toBe(true);
  const el = icon as React.ReactElement<{ size?: number }, { displayName?: string }>;
  return { key: el.type.displayName, size: el.props.size };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

// ============================================================================
// The default layout renders today's Home tab
// ============================================================================

describe("buildSections(DEFAULT_LAYOUT)", () => {
  const sections = () => buildSections(DEFAULT_LAYOUT);

  it("yields today's seven sections, in today's order", () => {
    expect(sections().map((s) => s.id)).toEqual([
      "home.clipboard",
      "home.font",
      "home.alignment",
      "home.number",
      "home.styles",
      "home.cells",
      "home.editing",
    ]);
    expect(sections().map((s) => s.label)).toEqual([
      "Clipboard",
      "Font",
      "Alignment",
      "Number",
      "Styles",
      "Cells",
      "Editing",
    ]);
  });

  it("carries the collapse priorities", () => {
    // useSectionFit sorts ASCENDING and demotes from the front, so this list
    // is the exact order in which groups become launchers on a narrow band.
    // Cells is 55 (D6) — it sheds after Styles and before Editing, instead of
    // clinging on last because of a missing lookup-table row.
    expect(sections().map((s) => s.collapsePriority)).toEqual([10, 20, 30, 40, 50, 55, 60]);
  });

  it("keeps every section inline in the ribbon band", () => {
    for (const s of sections()) expect(s.ribbonPresentation).toBe("inline");
  });

  it("gives every section a drawn launcher glyph at the launcher's 24px", () => {
    // The Clusters launcher and the sidebar header draw a section's icon in
    // a 34px slot at 24; a text glyph (Font used to be a bare "A") cannot be
    // sized with the rest of the set.
    expect(LAUNCHER_ICON_SIZE).toBe(24);
    for (const s of sections()) {
      const { key, size } = glyphOf(s.icon);
      expect(key, `${s.id} names a RibbonIcon key`).toBeTruthy();
      expect(size, `${s.id} glyph size`).toBe(LAUNCHER_ICON_SIZE);
    }
    // Font keeps its letters: the "Aa" drawing, not an abstract picture.
    expect(glyphOf(sections()[1].icon).key).toBe("Fonts");
  });

  it("falls back for a user-created group instead of rendering nothing", () => {
    const custom: HomeTabLayout = {
      version: 1,
      groups: [{ id: "my-macros", label: "My Macros", items: ["undo"] }],
    };
    const [section] = buildSections(custom);
    // The generic fallback id ("format") is the Format Cells drawing.
    expect(glyphOf(section.icon).key).toBe("FormatCells");
    // No collapsePriority declared => collapses last, so a group the user
    // asked for survives the squeeze.
    expect(section.collapsePriority).toBe(99);
  });

  it("honours a group's own icon choice", () => {
    const custom: HomeTabLayout = {
      version: 1,
      groups: [{ id: "my-macros", label: "My Macros", iconId: "font", items: ["undo"] }],
    };
    expect(glyphOf(buildSections(custom)[0].icon).key).toBe("Fonts");
  });
});

// ============================================================================
// The entry point
// ============================================================================

describe("the Customize entry point", () => {
  const activate = () => extension.activate?.({} as ExtensionContext);

  it("registers a View-menu item that opens the customize dialog", () => {
    activate();

    expect(registerMenuItem).toHaveBeenCalledTimes(1);
    const [menuId, item] = registerMenuItem.mock.calls[0] as [
      string,
      { id: string; label: string; action?: () => void; icon?: unknown },
    ];
    expect(menuId).toBe("view");
    expect(item.id).toBe("view.customizeHomeTab");
    expect(item.label).toBe("Customize Home Tab...");
    expect(item.icon).toBeTruthy();

    // The dialog it opens must be the one that is actually registered.
    const [dialogDef] = registerDialog.mock.calls[0] as [{ id: string }];
    item.action?.();
    expect(showDialog).toHaveBeenCalledWith(dialogDef.id);

    extension.deactivate?.();
  });

  it("removes the menu item on deactivate", () => {
    activate();
    extension.deactivate?.();
    expect(unregisterMenuItem).toHaveBeenCalledWith("view", "view.customizeHomeTab");
  });

  it("registers the Home panel from the saved layout", () => {
    activate();
    const [panel] = registerPanel.mock.calls[0] as [{ id: string; sections: { id: string }[] }];
    expect(panel.id).toBe("home");
    expect(panel.sections.map((s) => s.id)).toEqual(
      buildSections(DEFAULT_LAYOUT).map((s) => s.id)
    );
    extension.deactivate?.();
  });

  /**
   * The panel is re-registered IN PLACE — it must never be unregistered first.
   *
   * `registerPanel` upserts by id (the panel registry `set`s, and
   * `registerRibbonTab` overwrites), so a bare re-register replaces the tab
   * without it ever being absent. Unregistering first made the Home tab
   * momentarily NOT EXIST, and `RibbonContainer`'s active-tab reconciliation
   * falls back to the first non-contextual tab when the current one disappears
   * — so pressing Save in "Customize Home Tab..." dumped the user onto Page
   * Layout with their newly customised Home tab off screen. Found on the
   * running app (`e2e/journeys/shapes-hometab.spec.ts` test 8).
   */
  it("re-registers the panel IN PLACE on a layout change, never unregistering it first", () => {
    activate();
    registerPanel.mockClear();
    unregisterPanel.mockClear();

    window.dispatchEvent(new Event("homeTab:layoutChanged"));

    expect(registerPanel).toHaveBeenCalledTimes(1);
    expect(unregisterPanel).not.toHaveBeenCalled();
    extension.deactivate?.();
  });

  it("still unregisters the panel on deactivate", () => {
    activate();
    unregisterPanel.mockClear();
    extension.deactivate?.();
    expect(unregisterPanel).toHaveBeenCalledWith("home");
  });
});
