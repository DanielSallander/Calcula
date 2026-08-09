//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabLayout.test.ts
// PURPOSE: The Home tab's layout config: the default is the shipped look, the
//          load-time migration is additive, and reset writes nothing.
// CONTEXT: The customize dialog was unreachable for a while, so this file is
//          the first coverage HomeTab has ever had. Two of these tests exist
//          because of specific defects: resetLayout used to clear localStorage
//          the instant it was called (so Reset-then-Cancel silently reset at
//          the next launch), and loadLayout only ever SUBTRACTED unknown ids —
//          so customizing once froze a user out of every command shipped
//          afterwards.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ALL_ITEMS,
  DEFAULT_LAYOUT,
  LAYOUT_VERSION,
  CURRENT_CATALOG,
  ITEMS_BY_ID,
  isMultiInstanceItem,
  loadLayout,
  saveLayout,
  resetLayout,
  migrateLayout,
  type HomeTabItem,
  type HomeTabLayout,
  type LayoutCatalog,
} from "../homeTabConfig";

/** Pinned deliberately: the persistence key is a compatibility surface — a
 *  rename silently discards every user's saved layout. */
const STORAGE_KEY = "calcula.homeTab.layout";

beforeEach(() => {
  localStorage.clear();
});

// ============================================================================
// The default IS the shipped Home tab
// ============================================================================

describe("DEFAULT_LAYOUT is the shipped Home tab", () => {
  it("has today's seven groups, in today's order", () => {
    expect(DEFAULT_LAYOUT.groups.map((g) => g.id)).toEqual([
      "clipboard",
      "font",
      "alignment",
      "number",
      "styles",
      "cells",
      "editing",
    ]);
    expect(DEFAULT_LAYOUT.groups.map((g) => g.label)).toEqual([
      "Clipboard",
      "Font",
      "Alignment",
      "Number",
      "Styles",
      "Cells",
      "Editing",
    ]);
  });

  it("carries the collapse priorities on the groups themselves", () => {
    // D6 settled `cells`: it used to inherit an accidental 99 (GROUP_ORDER had
    // no "cells" row, so it hit the fallback and Cells demoted LAST). 55 puts
    // it between Styles and Editing, matching the order Excel's Home tab sheds
    // groups as the window narrows. Written out here so it cannot drift again.
    expect(
      Object.fromEntries(DEFAULT_LAYOUT.groups.map((g) => [g.id, g.collapsePriority]))
    ).toEqual({
      clipboard: 10,
      font: 20,
      alignment: 30,
      number: 40,
      styles: 50,
      cells: 55,
      editing: 60,
    });
  });

  it("names a launcher glyph for every group", () => {
    for (const g of DEFAULT_LAYOUT.groups) expect(g.iconId).toBe(g.id);
  });

  it("references only items the catalog knows", () => {
    for (const g of DEFAULT_LAYOUT.groups) {
      for (const id of g.items) expect(ITEMS_BY_ID.has(id)).toBe(true);
    }
  });

  it("places the multi-instance row break five times", () => {
    const breaks = DEFAULT_LAYOUT.groups.flatMap((g) =>
      g.items.filter((id) => id === "rowBreak")
    );
    expect(breaks).toHaveLength(5);
    expect(isMultiInstanceItem(ITEMS_BY_ID.get("rowBreak"))).toBe(true);
  });

  it("is what an empty cache resolves to, and what reset returns", () => {
    // The owner's constraint stated as a property: the two readers of the
    // default are the same constant, so today's look cannot drift away from
    // the default by editing only one of them.
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    expect(resetLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

// ============================================================================
// resetLayout is pure
// ============================================================================

describe("resetLayout", () => {
  it("writes nothing", () => {
    const custom: HomeTabLayout = {
      version: LAYOUT_VERSION,
      groups: [{ id: "font", label: "Font", items: ["bold"] }],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    const before = localStorage.getItem(STORAGE_KEY);

    resetLayout();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it("returns a copy, so the caller cannot mutate DEFAULT_LAYOUT through it", () => {
    const a = resetLayout();
    a.groups[0].items.push("bold");
    a.groups.length = 1;
    expect(DEFAULT_LAYOUT.groups).toHaveLength(7);
    expect(DEFAULT_LAYOUT.groups[0].items).toEqual(["paste", "cut", "copy", "formatPainter"]);
    expect(resetLayout().groups).toHaveLength(7);
  });
});

// ============================================================================
// Persistence
// ============================================================================

describe("saveLayout / loadLayout", () => {
  it("round-trips a customized layout under the pinned key", () => {
    const custom: HomeTabLayout = {
      groups: [
        { id: "font", label: "Font", items: ["bold", "italic"], collapsePriority: 20 },
      ],
    };
    saveLayout(custom);
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();
    const loaded = loadLayout();
    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0].items).toEqual(["bold", "italic"]);
  });

  it("stamps the schema version on save", () => {
    saveLayout({ groups: [{ id: "font", label: "Font", items: ["bold"] }] });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as HomeTabLayout;
    expect(raw.version).toBe(LAYOUT_VERSION);
  });

  it("falls back to the default for garbage, and for a layout of unknown ids", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: LAYOUT_VERSION, groups: [{ id: "x", label: "X", items: ["nope"] }] })
    );
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("drops a group left with nothing to render instead of keeping an empty section", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_VERSION,
        groups: [
          { id: "font", label: "Font", items: ["bold"] },
          // every id gone from the catalog
          { id: "ghost", label: "Ghost", items: ["retiredCommand"] },
          // present, but a separator paints no button
          { id: "breaks", label: "Breaks", items: ["rowBreak", "rowBreak"] },
        ],
      })
    );
    expect(loadLayout().groups.map((g) => g.id)).toEqual(["font"]);
  });

  it("stamps the version back when it loads an unversioned layout", () => {
    // Without this stamp the additive step would re-run on every single load,
    // re-adding a command the user had deliberately removed.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groups: [{ id: "font", label: "Font", items: ["bold"] }] })
    );
    loadLayout();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as HomeTabLayout;
    expect(raw.version).toBe(LAYOUT_VERSION);
  });

  it("fills a pre-version group's icon and collapse order from the default", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groups: [{ id: "cells", label: "Cells", items: ["insertRow"] }] })
    );
    const [group] = loadLayout().groups;
    expect(group.iconId).toBe("cells");
    expect(group.collapsePriority).toBe(55);
  });
});

// ============================================================================
// The additive migration
// ============================================================================

/** A synthetic "next release": one new command, added to the Editing group. */
const NEW_COMMAND: HomeTabItem = {
  id: "sortAscending",
  label: "Sort Ascending",
  tooltip: "Sort A to Z",
  type: "button",
  category: "Editing",
  addedIn: 2,
};

const NEXT_CATALOG: LayoutCatalog = {
  version: 2,
  items: [...ALL_ITEMS, NEW_COMMAND],
  defaults: {
    version: 2,
    groups: DEFAULT_LAYOUT.groups.map((g) =>
      g.id === "editing" ? { ...g, items: [...g.items, NEW_COMMAND.id] } : { ...g }
    ),
  },
};

describe("migrateLayout", () => {
  it("surfaces a newly-shipped command in an existing saved layout", () => {
    const saved: HomeTabLayout = {
      version: 1,
      groups: [
        { id: "font", label: "Font", items: ["bold", "italic"] },
        { id: "editing", label: "Editing", items: ["undo", "redo"] },
      ],
    };

    const migrated = migrateLayout(saved, NEXT_CATALOG);

    expect(migrated.version).toBe(2);
    expect(migrated.groups.find((g) => g.id === "editing")?.items).toEqual([
      "undo",
      "redo",
      "sortAscending",
    ]);
    // and it did not disturb anything the user had arranged
    expect(migrated.groups.find((g) => g.id === "font")?.items).toEqual(["bold", "italic"]);
    expect(migrated.groups.map((g) => g.id)).toEqual(["font", "editing"]);
  });

  it("is idempotent once the layout has been stamped at the new version", () => {
    const saved: HomeTabLayout = {
      version: 1,
      groups: [{ id: "editing", label: "Editing", items: ["undo"] }],
    };
    const once = migrateLayout(saved, NEXT_CATALOG);
    const twice = migrateLayout(once, NEXT_CATALOG);
    expect(twice).toEqual(once);
  });

  it("leaves a command the user deliberately removed removed", () => {
    // "find" shipped long before version 2, so nothing brings it back.
    const saved: HomeTabLayout = {
      version: 1,
      groups: [{ id: "editing", label: "Editing", items: ["undo", "redo"] }],
    };
    const migrated = migrateLayout(saved, NEXT_CATALOG);
    expect(migrated.groups[0].items).not.toContain("find");
    expect(migrated.groups[0].items).not.toContain("clearAll");
  });

  it("never re-adds a separator — where the row breaks go is the user's business", () => {
    const catalogWithNewBreak: LayoutCatalog = {
      version: 2,
      items: [...ALL_ITEMS],
      defaults: {
        version: 2,
        groups: [{ id: "font", label: "Font", items: ["bold", "rowBreak", "italic"] }],
      },
    };
    const saved: HomeTabLayout = {
      version: 1,
      groups: [{ id: "font", label: "Font", items: ["bold", "italic"] }],
    };
    expect(migrateLayout(saved, catalogWithNewBreak).groups[0].items).toEqual([
      "bold",
      "italic",
    ]);
  });

  it("revives a deleted group in its default position when a command lands in it", () => {
    const saved: HomeTabLayout = {
      version: 1,
      groups: [
        { id: "font", label: "Font", items: ["bold"] },
        { id: "cells", label: "Cells", items: ["insertRow"] },
      ],
    };
    const migrated = migrateLayout(saved, NEXT_CATALOG);
    // "editing" follows "cells" in the default layout, so it lands after it.
    expect(migrated.groups.map((g) => g.id)).toEqual(["font", "cells", "editing"]);
    expect(migrated.groups[2].items).toEqual(["sortAscending"]);
    expect(migrated.groups[2].collapsePriority).toBe(60);
  });

  it("does not add anything when the saved layout is already current", () => {
    const saved: HomeTabLayout = {
      version: 2,
      groups: [{ id: "editing", label: "Editing", items: ["undo"] }],
    };
    expect(migrateLayout(saved, NEXT_CATALOG).groups[0].items).toEqual(["undo"]);
  });

  it("still subtracts ids the catalog no longer knows", () => {
    const saved: HomeTabLayout = {
      version: CURRENT_CATALOG.version,
      groups: [{ id: "font", label: "Font", items: ["bold", "retiredCommand", "italic"] }],
    };
    expect(migrateLayout(saved, CURRENT_CATALOG).groups[0].items).toEqual(["bold", "italic"]);
  });
});

// ============================================================================
// saveLayout reports failure instead of swallowing it
// ============================================================================

describe("saveLayout reports whether the write landed", () => {
  /** Reject every write, the way a full quota or a private-mode store does.
   *  Patched on `Storage.prototype`, NOT on the `localStorage` instance: jsdom
   *  serves the instance through a proxy that drops own-property assignment,
   *  so `localStorage.setItem = ...` silently keeps the real implementation and
   *  the test passes for the wrong reason. */
  const rejectWrites = () =>
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when localStorage accepts the write", () => {
    expect(saveLayout({ version: LAYOUT_VERSION, groups: [] })).toBe(true);
  });

  it("returns false when localStorage throws, and does not rethrow", () => {
    rejectWrites();
    expect(saveLayout({ version: LAYOUT_VERSION, groups: [] })).toBe(false);
  });

  it("a failed save leaves no half-written entry behind", () => {
    rejectWrites();
    saveLayout({ version: LAYOUT_VERSION, groups: [] });
    vi.restoreAllMocks();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("loadLayout still returns a correct migrated layout when the re-stamp fails", () => {
    // The one caller that deliberately ignores the return value: the write is
    // a version stamp, not the user's edit, and losing it costs only a repeat
    // of an idempotent migration.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, groups: [{ id: "font", label: "Font", items: ["bold"] }] })
    );
    rejectWrites();
    const loaded = loadLayout();
    expect(loaded.groups.some((g) => g.id === "font")).toBe(true);
    expect(loaded.groups[0].items).toContain("bold");
  });
});
