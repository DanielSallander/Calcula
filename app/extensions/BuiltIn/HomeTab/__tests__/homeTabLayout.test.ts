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

describe("DEFAULT_LAYOUT is Excel's Home tab (CONTRACT section 1)", () => {
  it("has Excel's eight groups, Undo at the far left", () => {
    // Owner decision 2 (2026-10-04): Undo/Redo live in their own group at the
    // FAR LEFT -- Microsoft 365's layout when its Quick Access Toolbar is
    // hidden -- instead of inside Editing.
    expect(DEFAULT_LAYOUT.groups.map((g) => g.id)).toEqual([
      "undo",
      "clipboard",
      "font",
      "alignment",
      "number",
      "styles",
      "cells",
      "editing",
    ]);
    expect(DEFAULT_LAYOUT.groups.map((g) => g.label)).toEqual([
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

  it("holds exactly Excel's commands in Excel's order, rows split where Excel splits them", () => {
    // Every group spelled out. A run of consecutive non-hero items is one
    // two-row grid and a hero is its own control (HomeTabGroupComponent), so
    // this ORDER is also the left-to-right order on screen.
    expect(Object.fromEntries(DEFAULT_LAYOUT.groups.map((g) => [g.id, g.items]))).toEqual({
      undo: ["undo", "rowBreak", "redo"],
      clipboard: ["paste", "cut", "copy", "rowBreak", "formatPainter"],
      font: [
        "fontName", "fontSize", "increaseFontSize", "decreaseFontSize",
        "rowBreak",
        "bold", "italic", "underline", "borders", "backgroundColor", "textColor",
      ],
      alignment: [
        "alignTop", "alignMiddle", "alignBottom", "orientation", "wrapText",
        "rowBreak",
        "alignLeft", "alignCenter", "alignRight", "decreaseIndent", "increaseIndent", "mergeCells",
      ],
      number: [
        "numberFormat",
        "rowBreak",
        "accountingFormat", "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal",
      ],
      styles: ["conditionalFormatting", "formatAsTable", "cellStyles"],
      cells: ["insertCells", "deleteCells", "formatMenu"],
      editing: ["autoSum", "fill", "rowBreak", "clear", "sortFilter", "findSelect"],
    });
  });

  it("carries the collapse priorities on the groups themselves", () => {
    // Owner decision 3: a narrowing window collapses groups RIGHT-TO-LEFT like
    // Excel -- Styles first, then Cells, then Editing, then Number, Alignment,
    // Font, Clipboard, and Undo last. useSectionFit sorts ASCENDING, so the
    // lowest number goes first. Written out so it cannot drift.
    expect(
      Object.fromEntries(DEFAULT_LAYOUT.groups.map((g) => [g.id, g.collapsePriority]))
    ).toEqual({
      undo: 80,
      clipboard: 70,
      font: 60,
      alignment: 50,
      number: 40,
      styles: 10,
      cells: 20,
      editing: 30,
    });
    const shedOrder = [...DEFAULT_LAYOUT.groups]
      .sort((a, b) => (a.collapsePriority ?? 99) - (b.collapsePriority ?? 99))
      .map((g) => g.id);
    expect(shedOrder).toEqual([
      "styles", "cells", "editing", "number", "alignment", "font", "clipboard", "undo",
    ]);
  });

  it("names a launcher glyph for every group", () => {
    for (const g of DEFAULT_LAYOUT.groups) expect(g.iconId).toBe(g.id);
  });

  it("gives Font, Alignment and Number -- and only them -- a Format Cells dialog launcher", () => {
    // Excel's corner arrows. Clipboard has none (owner decision 1: no Office
    // Clipboard pane), nor do Undo, Styles, Cells or Editing.
    expect(
      Object.fromEntries(DEFAULT_LAYOUT.groups.map((g) => [g.id, g.dialogLauncherId]))
    ).toEqual({
      undo: undefined,
      clipboard: undefined,
      font: "formatCells.font",
      alignment: "formatCells.alignment",
      number: "formatCells.number",
      styles: undefined,
      cells: undefined,
      editing: undefined,
    });
  });

  it("references only items the catalog knows", () => {
    for (const g of DEFAULT_LAYOUT.groups) {
      for (const id of g.items) expect(ITEMS_BY_ID.has(id)).toBe(true);
    }
  });

  it("places the multi-instance row break six times", () => {
    const breaks = DEFAULT_LAYOUT.groups.flatMap((g) =>
      g.items.filter((id) => id === "rowBreak")
    );
    expect(breaks).toHaveLength(6);
    expect(isMultiInstanceItem(ITEMS_BY_ID.get("rowBreak"))).toBe(true);
  });

  it("keeps the commands it no longer shows in the catalog, so Customize can add them back", () => {
    const shown = new Set(DEFAULT_LAYOUT.groups.flatMap((g) => g.items));
    for (const id of [
      "strikethrough", "formatCells", "find", "clearContents", "clearFormatting", "clearAll",
      "insertRow", "insertColumn", "deleteRow", "deleteColumn", "superscript", "subscript",
    ]) {
      expect(ITEMS_BY_ID.has(id), `${id} is still in the catalog`).toBe(true);
      expect(shown.has(id), `${id} left the default layout`).toBe(false);
    }
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
// Segments: catalog-only pill membership
// ============================================================================

describe("segment (which Segmented pill a command joins)", () => {
  it("joins exactly the approved runs", () => {
    const segments = Object.fromEntries(
      ALL_ITEMS.filter((i) => i.segment !== undefined).map((i) => [i.id, i.segment])
    );
    expect(segments).toEqual({
      bold: "emphasis",
      italic: "emphasis",
      underline: "emphasis",
      strikethrough: "emphasis",
      alignTop: "valign",
      alignMiddle: "valign",
      alignBottom: "valign",
      alignLeft: "halign",
      alignCenter: "halign",
      alignRight: "halign",
      decreaseIndent: "indent",
      increaseIndent: "indent",
      increaseDecimal: "decimals",
      decreaseDecimal: "decimals",
    });
  });

  it("is never persisted: a saved layout is only group ids, labels and item ids", () => {
    saveLayout(DEFAULT_LAYOUT);
    const raw = localStorage.getItem(STORAGE_KEY) as string;
    expect(raw).not.toContain("segment");
    // Byte-compatible with a layout written before segments existed.
    expect(raw).toBe(JSON.stringify({ ...DEFAULT_LAYOUT, version: LAYOUT_VERSION }));
  });

  it("each default run is contiguous, so every pill in the shipped tab is whole", () => {
    for (const group of DEFAULT_LAYOUT.groups) {
      const seen = new Set<string>();
      let previous: string | undefined;
      for (const id of group.items) {
        const segment = ITEMS_BY_ID.get(id)?.segment;
        if (segment !== undefined && segment !== previous) {
          expect(seen.has(segment), `${group.id}: "${segment}" is split`).toBe(false);
          seen.add(segment);
        }
        previous = segment;
      }
    }
  });

  it("LAYOUT_VERSION is 2: Excel's Home tab shipped at version 2", () => {
    expect(LAYOUT_VERSION).toBe(2);
  });
});

// ============================================================================
// The version-2 catalog additions (CONTRACT section 2)
// ============================================================================

describe("the version-2 catalog additions", () => {
  /** CONTRACT section 2, spelled out: id -> [label, type, hero, tooltip]. */
  const ADDED: Record<string, [string, HomeTabItem["type"], boolean, string]> = {
    borders: ["Borders", "button", false, "Borders"],
    orientation: ["Orientation", "button", false, "Orientation"],
    accountingFormat: ["Accounting Number Format", "button", false, "Accounting Number Format"],
    conditionalFormatting: ["Conditional Formatting", "dropdown", true, "Conditional Formatting"],
    formatAsTable: ["Format as Table", "dropdown", true, "Format as Table"],
    insertCells: ["Insert", "button", true, "Insert Cells"],
    deleteCells: ["Delete", "button", true, "Delete Cells"],
    formatMenu: ["Format", "dropdown", true, "Format"],
    autoSum: ["AutoSum", "button", false, "AutoSum (Alt+=)"],
    fill: ["Fill", "dropdown", false, "Fill"],
    clear: ["Clear", "dropdown", false, "Clear"],
    sortFilter: ["Sort & Filter", "dropdown", true, "Sort & Filter"],
    findSelect: ["Find & Select", "dropdown", true, "Find & Select"],
  };

  it("adds exactly the contract's thirteen commands, each stamped addedIn 2", () => {
    const stamped = ALL_ITEMS.filter((i) => i.addedIn !== undefined).map((i) => i.id);
    expect(stamped.sort()).toEqual(Object.keys(ADDED).sort());
    for (const id of Object.keys(ADDED)) expect(ITEMS_BY_ID.get(id)?.addedIn, id).toBe(2);
  });

  it("gives each its contract label, type, hero flag and Excel's tooltip", () => {
    for (const [id, [label, type, hero, tooltip]] of Object.entries(ADDED)) {
      const item = ITEMS_BY_ID.get(id)!;
      expect(item.label, id).toBe(label);
      expect(item.type, id).toBe(type);
      expect(item.hero ?? false, id).toBe(hero);
      expect(item.tooltip, id).toBe(tooltip);
      // A hero shows `shortLabel ?? label`, and only the full words break
      // into Excel's two lines ("Conditional / Formatting").
      expect(item.shortLabel, `${id} has no shortLabel`).toBeUndefined();
    }
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
    expect(DEFAULT_LAYOUT.groups).toHaveLength(8);
    expect(DEFAULT_LAYOUT.groups[0].items).toEqual(["undo", "rowBreak", "redo"]);
    expect(resetLayout().groups).toHaveLength(8);
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

  it("fills a pre-version group's icon, collapse order and dialog launcher from the default", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ groups: [{ id: "font", label: "Font", items: ["bold"] }] })
    );
    const group = loadLayout().groups.find((g) => g.id === "font")!;
    expect(group.iconId).toBe("font");
    expect(group.collapsePriority).toBe(60);
    expect(group.dialogLauncherId).toBe("formatCells.font");
  });
});

// ============================================================================
// The real version-1 -> version-2 upgrade
// ============================================================================

/** The Home tab exactly as version 1 shipped it, as a user who pressed Save
 *  in Customize Home Tab once would have it stored. */
const SAVED_V1_DEFAULT: HomeTabLayout = {
  version: 1,
  groups: [
    { id: "clipboard", label: "Clipboard", iconId: "clipboard", collapsePriority: 10, items: ["paste", "cut", "copy", "formatPainter"] },
    {
      id: "font", label: "Font", iconId: "font", collapsePriority: 20,
      items: ["fontName", "fontSize", "increaseFontSize", "decreaseFontSize", "rowBreak",
        "bold", "italic", "underline", "strikethrough", "textColor", "backgroundColor", "formatCells"],
    },
    {
      id: "alignment", label: "Alignment", iconId: "alignment", collapsePriority: 30,
      items: ["alignTop", "alignMiddle", "alignBottom", "wrapText", "rowBreak",
        "alignLeft", "alignCenter", "alignRight", "decreaseIndent", "increaseIndent", "mergeCells"],
    },
    {
      id: "number", label: "Number", iconId: "number", collapsePriority: 40,
      items: ["numberFormat", "rowBreak", "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal"],
    },
    { id: "styles", label: "Styles", iconId: "styles", collapsePriority: 50, items: ["cellStyles"] },
    { id: "cells", label: "Cells", iconId: "cells", collapsePriority: 55, items: ["insertRow", "insertColumn", "rowBreak", "deleteRow", "deleteColumn"] },
    { id: "editing", label: "Editing", iconId: "editing", collapsePriority: 60, items: ["undo", "redo", "find", "rowBreak", "clearFormatting", "clearAll"] },
  ],
};

describe("a layout saved at version 1 meets Excel's Home tab", () => {
  const migrated = () => migrateLayout(SAVED_V1_DEFAULT, CURRENT_CATALOG);

  it("keeps every command the user had, in their order, and puts each new one where Excel's order puts it", () => {
    // Each new command goes just before the earliest item that FOLLOWS it in
    // the default group and is present in the saved one (a row break counts);
    // it is appended only when nothing that follows it is there. Appending
    // every new command (as this did) gave Styles = Cell Styles, Conditional
    // Formatting, Format as Table -- Excel's order backwards -- put Borders
    // after Format Cells, Accounting last and Orientation on row 2.
    const items = Object.fromEntries(migrated().groups.map((g) => [g.id, g.items]));
    expect(items).toEqual({
      clipboard: ["paste", "cut", "copy", "formatPainter"],
      font: ["fontName", "fontSize", "increaseFontSize", "decreaseFontSize", "rowBreak",
        "bold", "italic", "underline", "strikethrough", "borders", "textColor", "backgroundColor", "formatCells"],
      alignment: ["alignTop", "alignMiddle", "alignBottom", "orientation", "wrapText", "rowBreak",
        "alignLeft", "alignCenter", "alignRight", "decreaseIndent", "increaseIndent", "mergeCells"],
      number: ["numberFormat", "rowBreak", "accountingFormat", "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal"],
      styles: ["conditionalFormatting", "formatAsTable", "cellStyles"],
      // Nothing that follows the new Cells commands is in the saved group:
      // appended, in their default order.
      cells: [...SAVED_V1_DEFAULT.groups[5].items, "insertCells", "deleteCells", "formatMenu"],
      // AutoSum and Fill precede the default's row break, so they go before
      // the saved group's first break; Clear, Sort & Filter and Find & Select
      // have nothing after them there, so they are appended.
      editing: ["undo", "redo", "find", "autoSum", "fill", "rowBreak", "clearFormatting", "clearAll",
        "clear", "sortFilter", "findSelect"],
    });
    expect(migrated().version).toBe(2);
    // Nothing the user had moved relative to anything else they had.
    for (const saved of SAVED_V1_DEFAULT.groups) {
      const after = items[saved.id] as string[];
      expect(after.filter((id) => saved.items.includes(id)), saved.id).toEqual(saved.items);
    }
  });

  it("matches the k-th default row break with the k-th saved one", () => {
    // A new item that precedes the default's SECOND break lands before the
    // saved group's second break, not its first.
    const catalog: LayoutCatalog = {
      version: 2,
      items: [...ALL_ITEMS, { id: "zNew", label: "New", type: "button", category: "Font", addedIn: 2 }],
      defaults: {
        version: 2,
        groups: [{ id: "font", label: "Font", items: ["bold", "rowBreak", "italic", "zNew", "rowBreak", "underline"] }],
      },
    };
    const saved: HomeTabLayout = {
      version: 1,
      groups: [{ id: "font", label: "Font", items: ["bold", "rowBreak", "italic", "rowBreak", "strikethrough"] }],
    };
    expect(migrateLayout(saved, catalog).groups[0].items).toEqual([
      "bold", "rowBreak", "italic", "zNew", "rowBreak", "strikethrough",
    ]);
  });

  it("adds no Undo group: Undo and Redo were already placed, and additive means additive", () => {
    // They shipped at version 1, so the user's placement of them (inside
    // Editing) is theirs. Customize Home Tab's Reset gives the new default.
    expect(migrated().groups.map((g) => g.id)).not.toContain("undo");
    const all = migrated().groups.flatMap((g) => g.items).filter((id) => id !== "rowBreak");
    expect(new Set(all).size, "no command placed twice").toBe(all.length);
  });

  it("takes Excel's collapse order and the dialog launchers from the new default", () => {
    // collapsePriority is presentation the dialog never lets a user edit, so a
    // version-1 copy of it is a stale default, not a choice: left alone, a
    // narrowing window would still shed Clipboard FIRST (owner decision 3).
    const byId = Object.fromEntries(migrated().groups.map((g) => [g.id, g]));
    expect(byId.styles.collapsePriority).toBe(10);
    expect(byId.cells.collapsePriority).toBe(20);
    expect(byId.editing.collapsePriority).toBe(30);
    expect(byId.clipboard.collapsePriority).toBe(70);
    expect(byId.font.dialogLauncherId).toBe("formatCells.font");
    expect(byId.alignment.dialogLauncherId).toBe("formatCells.alignment");
    expect(byId.number.dialogLauncherId).toBe("formatCells.number");
    expect(byId.clipboard.dialogLauncherId).toBeUndefined();
  });

  it("keeps the icon a user CHOSE, and leaves a group of their own alone", () => {
    const saved: HomeTabLayout = {
      version: 1,
      groups: [
        { id: "font", label: "Font", iconId: "wrap", collapsePriority: 20, items: ["bold"] },
        { id: "my-macros", label: "My Macros", iconId: "merge", collapsePriority: 99, items: ["undo"] },
      ],
    };
    const byId = Object.fromEntries(migrateLayout(saved, CURRENT_CATALOG).groups.map((g) => [g.id, g]));
    expect(byId.font.iconId).toBe("wrap");
    expect(byId["my-macros"]).toEqual(saved.groups[1]);
  });

  it("revives a group the user had deleted, in its default place, holding only the new commands", () => {
    const saved: HomeTabLayout = {
      version: 1,
      groups: SAVED_V1_DEFAULT.groups.filter((g) => g.id !== "styles"),
    };
    const result = migrateLayout(saved, CURRENT_CATALOG);
    expect(result.groups.map((g) => g.id)).toEqual([
      "clipboard", "font", "alignment", "number", "styles", "cells", "editing",
    ]);
    // Cell Styles shipped at version 1 and was removed deliberately: it stays out.
    expect(result.groups.find((g) => g.id === "styles")!.items).toEqual([
      "conditionalFormatting",
      "formatAsTable",
    ]);
  });

  it("is idempotent, and the stamped result loads byte-for-byte unchanged", () => {
    const once = migrated();
    expect(migrateLayout(once, CURRENT_CATALOG)).toEqual(once);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVED_V1_DEFAULT));
    const loaded = loadLayout();
    expect(loaded).toEqual(once);
    const stamped = localStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(stamped as string).version).toBe(2);
    expect(loadLayout()).toEqual(once);
    expect(localStorage.getItem(STORAGE_KEY), "a current-version load writes nothing").toBe(stamped);
  });

  it("gives a group of the user's own no presentation keys it did not have", () => {
    // Strict: an `iconId: undefined` key would pass toEqual, and is exactly
    // the noise a current-version load must not add to what was stored.
    const own = { id: "my-macros", label: "My Macros", items: ["undo"] };
    const result = migrateLayout({ version: LAYOUT_VERSION, groups: [own] }, CURRENT_CATALOG);
    expect(result.groups[0]).toStrictEqual(own);
  });

  it("leaves a current-version layout's collapse order alone", () => {
    const saved: HomeTabLayout = {
      version: LAYOUT_VERSION,
      groups: [{ id: "font", label: "Font", collapsePriority: 5, items: ["bold"] }],
    };
    expect(migrateLayout(saved, CURRENT_CATALOG).groups[0].collapsePriority).toBe(5);
  });
});

// ============================================================================
// The additive migration
// ============================================================================

/** A synthetic "next release" (one past the shipped version): one new
 *  command, added to the Editing group. Saved layouts below are written at
 *  the SHIPPED version, so only this command is new to them. */
const NEXT_VERSION = LAYOUT_VERSION + 1;

const NEW_COMMAND: HomeTabItem = {
  id: "sortAscending",
  label: "Sort Ascending",
  tooltip: "Sort A to Z",
  type: "button",
  category: "Editing",
  addedIn: NEXT_VERSION,
};

const NEXT_CATALOG: LayoutCatalog = {
  version: NEXT_VERSION,
  items: [...ALL_ITEMS, NEW_COMMAND],
  defaults: {
    version: NEXT_VERSION,
    groups: DEFAULT_LAYOUT.groups.map((g) =>
      g.id === "editing" ? { ...g, items: [...g.items, NEW_COMMAND.id] } : { ...g }
    ),
  },
};

describe("migrateLayout", () => {
  it("surfaces a newly-shipped command in an existing saved layout", () => {
    const saved: HomeTabLayout = {
      version: LAYOUT_VERSION,
      groups: [
        { id: "font", label: "Font", items: ["bold", "italic"] },
        { id: "editing", label: "Editing", items: ["undo", "redo"] },
      ],
    };

    const migrated = migrateLayout(saved, NEXT_CATALOG);

    expect(migrated.version).toBe(NEXT_VERSION);
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
      version: LAYOUT_VERSION,
      groups: [{ id: "editing", label: "Editing", items: ["undo"] }],
    };
    const once = migrateLayout(saved, NEXT_CATALOG);
    const twice = migrateLayout(once, NEXT_CATALOG);
    expect(twice).toEqual(once);
  });

  it("leaves a command the user deliberately removed removed", () => {
    // "find" shipped long before the next version, so nothing brings it back.
    const saved: HomeTabLayout = {
      version: LAYOUT_VERSION,
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
      version: LAYOUT_VERSION,
      groups: [
        { id: "font", label: "Font", items: ["bold"] },
        { id: "cells", label: "Cells", items: ["insertRow"] },
      ],
    };
    const migrated = migrateLayout(saved, NEXT_CATALOG);
    // "editing" follows "cells" in the default layout, so it lands after it.
    expect(migrated.groups.map((g) => g.id)).toEqual(["font", "cells", "editing"]);
    expect(migrated.groups[2].items).toEqual(["sortAscending"]);
    expect(migrated.groups[2].collapsePriority).toBe(30);
  });

  it("does not add anything when the saved layout is already current", () => {
    const saved: HomeTabLayout = {
      version: NEXT_VERSION,
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
    const font = loaded.groups.find((g) => g.id === "font");
    expect(font?.items).toContain("bold");
    // ...and the version-2 commands still arrived, re-stamp or not.
    expect(font?.items).toContain("borders");
  });
});
