//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabSections.test.tsx
// PURPOSE: buildSections(DEFAULT_LAYOUT) is today's Home tab, and the
//          customize dialog has a reachable entry point.
// CONTEXT: The owner's constraint is that the CURRENT appearance stays the
//          default; this makes that a property of the code rather than a note.
//          The entry-point assertions exist because the gear was dropped during
//          the sections/panel migration and nobody noticed for months — the
//          dialog stayed registered and listening, so nothing failed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// A launcher's refusal is shown with alertAsync; the real one would try to
// open a native dialog.
const alertAsync = vi.fn();
vi.mock("@api/dialogs", () => ({
  alertAsync: (...a: unknown[]) => alertAsync(...a),
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
import { CommandRegistry, CoreCommands } from "@api/commands";
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

  it("yields Excel's eight sections, Undo first", () => {
    expect(sections().map((s) => s.id)).toEqual([
      "home.undo",
      "home.clipboard",
      "home.font",
      "home.alignment",
      "home.number",
      "home.styles",
      "home.cells",
      "home.editing",
    ]);
    expect(sections().map((s) => s.label)).toEqual([
      "Undo",
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
    // useSectionFit sorts ASCENDING and demotes from the front, so these
    // numbers are the exact order in which groups become launchers on a
    // narrow band: right-to-left like Excel (owner decision 3) -- Styles,
    // Cells, Editing, Number, Alignment, Font, Clipboard, Undo last.
    expect(sections().map((s) => s.collapsePriority)).toEqual([80, 70, 60, 50, 40, 10, 20, 30]);
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
    const byId = Object.fromEntries(sections().map((s) => [s.id, glyphOf(s.icon).key]));
    // Font keeps its letters: the "Aa" drawing, not an abstract picture.
    expect(byId["home.font"]).toBe("Fonts");
    expect(byId["home.undo"]).toBe("Undo");
    // Cells collapses to Excel's Insert Cells picture, not Insert Row.
    expect(byId["home.cells"]).toBe("InsertCells");
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
// Excel's dialog launchers (CONTRACT 3.20)
// ============================================================================

describe("the Format Cells dialog launchers", () => {
  const byId = () => Object.fromEntries(buildSections(DEFAULT_LAYOUT).map((s) => [s.id, s]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Font, Alignment and Number each declare one, named, with no Ctrl+1 chip that would open another tab", () => {
    const sections = byId();
    const expected: Array<[string, string]> = [
      ["home.font", "Format Cells: Font"],
      ["home.alignment", "Format Cells: Alignment"],
      ["home.number", "Format Cells: Number"],
    ];
    for (const [id, label] of expected) {
      const launcher = sections[id].dialogLauncher;
      expect(launcher?.label, id).toBe(label);
      // NO shortcut chip. A chip shows the live binding of `commandId`, and
      // FORMAT_CELLS's (Ctrl+1) opens the dialog with NO tab, not the Font,
      // Alignment or Number tab the arrow opens -- the chip would promise a
      // key that does something else (review finding, 2026-10-04; the same
      // rule itemTooltip applies to Insert's Ctrl+Plus). No key opens one tab
      // today: a key binding carries no arguments.
      expect(launcher?.commandId, id).toBeUndefined();
      // No testId: the shell's default `dialog-launcher-<sectionId>` applies,
      // which is the name journeys use (never section-launcher-* or fmt-*).
      expect(launcher?.testId, id).toBeUndefined();
    }
  });

  it("every other group has none (Excel draws no arrow there; Clipboard's pane is deferred)", () => {
    const sections = byId();
    for (const id of ["home.undo", "home.clipboard", "home.styles", "home.cells", "home.editing"]) {
      expect(sections[id].dialogLauncher, id).toBeUndefined();
    }
  });

  it("each opens Format Cells on its own tab, through the FORMAT_CELLS command", async () => {
    // The ONE door to the dialog: it refuses (one toast, no dialog) while
    // something else owns the selection, so the launcher must not open the
    // dialog directly.
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
    const sections = byId();
    sections["home.font"].dialogLauncher!.onLaunch();
    sections["home.alignment"].dialogLauncher!.onLaunch();
    sections["home.number"].dialogLauncher!.onLaunch();
    await Promise.resolve();
    expect(execute.mock.calls).toEqual([
      [CoreCommands.FORMAT_CELLS, { tab: "font" }],
      [CoreCommands.FORMAT_CELLS, { tab: "alignment" }],
      [CoreCommands.FORMAT_CELLS, { tab: "number" }],
    ]);
  });

  it("a refusal from the command reaches the user, not just the console", async () => {
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("The sheet is protected."));
    byId()["home.font"].dialogLauncher!.onLaunch();
    await new Promise((r) => setTimeout(r, 0));
    expect(alertAsync).toHaveBeenCalledWith("The sheet is protected.");
  });

  it("comes from the LAYOUT: a group of the user's own can carry one, and an unknown id draws none", () => {
    const custom: HomeTabLayout = {
      version: 2,
      groups: [
        { id: "mine", label: "Mine", items: ["bold"], dialogLauncherId: "formatCells.number" },
        { id: "stale", label: "Stale", items: ["bold"], dialogLauncherId: "gone" as never },
        { id: "plain", label: "Plain", items: ["bold"] },
      ],
    };
    const [mine, stale, plain] = buildSections(custom);
    expect(mine.dialogLauncher?.label).toBe("Format Cells: Number");
    expect(stale.dialogLauncher).toBeUndefined();
    expect(plain.dialogLauncher).toBeUndefined();
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
