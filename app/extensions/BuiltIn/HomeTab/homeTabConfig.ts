//! FILENAME: app/extensions/BuiltIn/HomeTab/homeTabConfig.ts
// PURPOSE: Configuration and persistence for the Home tab layout.
// CONTEXT: Stores which groups/items are visible in the Home ribbon tab.
//
// ONE DEFAULT OBJECT. `DEFAULT_LAYOUT` is the whole default: which groups
// exist, in what order, holding which items, AND how each group presents
// (`iconId` for the launcher glyph, `collapsePriority` for width-overflow
// demotion order). It used to be a constant plus two lookup tables in
// index.ts, and they had already drifted apart once -- `GROUP_ORDER` omitted
// "cells", which silently fell to the 99 fallback. Keeping presentation on the
// group is also what lets a user-created group choose a real icon.
//
// Icons themselves stay an id -> ReactNode map in components/homeTabIcons.tsx:
// a persisted layout must never contain React elements.

// ============================================================================
// Types
// ============================================================================

/** A single command item shown in the ribbon */
export interface HomeTabItem {
  /** Unique item ID */
  id: string;
  /** Display label */
  label: string;
  /** Short label for compact display */
  shortLabel?: string;
  /** Tooltip text */
  tooltip?: string;
  /** Type of control */
  type: "button" | "toggle" | "dropdown" | "color" | "separator";
  /** Icon character or text */
  icon?: string;
  /** Category for grouping in the customize dialog */
  category: string;
  /** Render as the group's full-height hero command in the ribbon band
   *  (Excel's big Paste). Plain click actions only. */
  hero?: boolean;
  /**
   * Layout version this command first shipped in (default 1 = "was already
   * there when layouts became versioned").
   *
   * This is what makes the load-time migration ADDITIVE without being
   * annoying: a saved layout is topped up with everything introduced AFTER
   * the version it was saved at, so customizing once no longer freezes a user
   * out of every command shipped afterwards -- while a command they
   * deliberately REMOVED stays removed, because it was not introduced after
   * their layout's version. Bump LAYOUT_VERSION and stamp `addedIn` with the
   * new number whenever you add an entry to ALL_ITEMS.
   */
  addedIn?: number;
}

/** A group of items in the ribbon */
export interface HomeTabGroup {
  /** Unique group ID */
  id: string;
  /** Display label shown below the group */
  label: string;
  /** Item IDs in this group */
  items: string[];
  /** Launcher glyph id (resolved through components/homeTabIcons.tsx).
   *  Falls back to the group id, then to the generic fallback glyph. */
  iconId?: string;
  /** Width-overflow demotion order: LOWER collapses to a launcher first
   *  (the shell's useSectionFit sorts ascending). Default 99. */
  collapsePriority?: number;
}

/** The full Home tab layout configuration */
export interface HomeTabLayout {
  /** Layout schema version this object was written at. See HomeTabItem.addedIn. */
  version?: number;
  /** Ordered list of groups */
  groups: HomeTabGroup[];
}

/**
 * Current layout schema version.
 *
 * Bump this **and** stamp the new ALL_ITEMS entries with `addedIn: <new>`
 * whenever a command is added, so existing saved layouts pick it up.
 */
export const LAYOUT_VERSION = 1;

// ============================================================================
// Available Items Registry
// ============================================================================

/** All available items that can be placed in the Home tab */
export const ALL_ITEMS: HomeTabItem[] = [
  // --- Clipboard ---
  { id: "cut", label: "Cut", shortLabel: "Cut", tooltip: "Cut (Ctrl+X)", type: "button", icon: "\u2702", category: "Clipboard" },
  { id: "copy", label: "Copy", shortLabel: "Copy", tooltip: "Copy (Ctrl+C)", type: "button", icon: "\u2398", category: "Clipboard" },
  { id: "paste", label: "Paste", shortLabel: "Paste", tooltip: "Paste (Ctrl+V)", type: "button", icon: "\u2399", category: "Clipboard", hero: true },
  { id: "formatPainter", label: "Format Painter", shortLabel: "Painter", tooltip: "Format Painter (Ctrl+Shift+C)", type: "button", icon: "\uD83D\uDD8C", category: "Clipboard" },

  // --- Font ---
  { id: "fontName", label: "Font", tooltip: "Font Name", type: "dropdown", category: "Font" },
  { id: "fontSize", label: "Font Size", tooltip: "Font Size", type: "dropdown", category: "Font" },
  { id: "increaseFontSize", label: "Increase Font Size", tooltip: "Increase Font Size", type: "button", icon: "A˄", category: "Font" },
  { id: "decreaseFontSize", label: "Decrease Font Size", tooltip: "Decrease Font Size", type: "button", icon: "A˅", category: "Font" },
  { id: "bold", label: "Bold", tooltip: "Bold (Ctrl+B)", type: "toggle", icon: "B", category: "Font" },
  { id: "italic", label: "Italic", tooltip: "Italic (Ctrl+I)", type: "toggle", icon: "I", category: "Font" },
  { id: "underline", label: "Underline", tooltip: "Underline (Ctrl+U)", type: "toggle", icon: "U", category: "Font" },
  { id: "strikethrough", label: "Strikethrough", tooltip: "Strikethrough", type: "toggle", icon: "S", category: "Font" },
  { id: "superscript", label: "Superscript", tooltip: "Superscript (Ctrl+Shift+=)", type: "toggle", icon: "x\u00B2", category: "Font" },
  { id: "subscript", label: "Subscript", tooltip: "Subscript (Ctrl+=)", type: "toggle", icon: "x\u2082", category: "Font" },
  { id: "textColor", label: "Text Color", tooltip: "Font Color", type: "color", icon: "A", category: "Font" },
  { id: "backgroundColor", label: "Fill Color", tooltip: "Fill Color", type: "color", icon: "\u2588", category: "Font" },
  { id: "formatCells", label: "Format Cells", shortLabel: "Format", tooltip: "Format Cells... (Ctrl+1)", type: "button", icon: "\u2630", category: "Font" },

  // --- Alignment ---
  { id: "alignTop", label: "Top Align", tooltip: "Align Top", type: "toggle", icon: "\u2912", category: "Alignment" },
  { id: "alignMiddle", label: "Middle Align", tooltip: "Center Vertically", type: "toggle", icon: "\u21C5", category: "Alignment" },
  { id: "alignBottom", label: "Bottom Align", tooltip: "Align Bottom", type: "toggle", icon: "\u2913", category: "Alignment" },
  { id: "alignLeft", label: "Align Left", tooltip: "Align Left", type: "toggle", icon: "\u2261", category: "Alignment" },
  { id: "alignCenter", label: "Center", tooltip: "Center", type: "toggle", icon: "\u2550", category: "Alignment" },
  { id: "alignRight", label: "Align Right", tooltip: "Align Right", type: "toggle", icon: "\u2261", category: "Alignment" },
  { id: "wrapText", label: "Wrap Text", tooltip: "Wrap Text", type: "toggle", icon: "\u21B5", category: "Alignment" },
  { id: "increaseIndent", label: "Increase Indent", tooltip: "Increase Indent", type: "button", icon: "\u21E5", category: "Alignment" },
  { id: "decreaseIndent", label: "Decrease Indent", tooltip: "Decrease Indent", type: "button", icon: "\u21E4", category: "Alignment" },
  { id: "mergeCells", label: "Merge Cells", tooltip: "Merge Cells", type: "button", icon: "\u29EA", category: "Alignment" },

  // --- Number ---
  { id: "numberFormat", label: "Number Format", tooltip: "Number Format", type: "dropdown", icon: "#", category: "Number" },
  { id: "percentFormat", label: "Percent", tooltip: "Percent Style (%)", type: "button", icon: "%", category: "Number" },
  { id: "commaFormat", label: "Comma", tooltip: "Comma Style (,)", type: "button", icon: ",", category: "Number" },
  { id: "increaseDecimal", label: "Increase Decimal", tooltip: "Increase Decimal", type: "button", icon: ".0", category: "Number" },
  { id: "decreaseDecimal", label: "Decrease Decimal", tooltip: "Decrease Decimal", type: "button", icon: "0.", category: "Number" },

  // --- Editing ---
  { id: "undo", label: "Undo", tooltip: "Undo (Ctrl+Z)", type: "button", icon: "\u21B6", category: "Editing" },
  { id: "redo", label: "Redo", tooltip: "Redo (Ctrl+Y)", type: "button", icon: "\u21B7", category: "Editing" },
  { id: "find", label: "Find & Replace", shortLabel: "Find", tooltip: "Find & Replace (Ctrl+H)", type: "button", icon: "\uD83D\uDD0D", category: "Editing" },
  { id: "clearContents", label: "Clear Contents", shortLabel: "Clear", tooltip: "Clear Contents (Del)", type: "button", icon: "\u2715", category: "Editing" },
  { id: "clearFormatting", label: "Clear Formatting", shortLabel: "Clear Fmt", tooltip: "Clear Formatting", type: "button", icon: "\u2718", category: "Editing" },
  { id: "clearAll", label: "Clear All", shortLabel: "Clear All", tooltip: "Clear All (formatting + content + comments)", type: "button", icon: "\u2716", category: "Editing" },

  // --- Styles ---
  { id: "cellStyles", label: "Cell Styles", shortLabel: "Cell Styles", tooltip: "Cell Styles", type: "dropdown", icon: "\uD83C\uDFA8", category: "Styles", hero: true },

  // --- Insert ---
  { id: "insertRow", label: "Insert Row", tooltip: "Insert Row", type: "button", icon: "+R", category: "Insert" },
  { id: "insertColumn", label: "Insert Column", tooltip: "Insert Column", type: "button", icon: "+C", category: "Insert" },
  { id: "deleteRow", label: "Delete Row", tooltip: "Delete Row", type: "button", icon: "-R", category: "Insert" },
  { id: "deleteColumn", label: "Delete Column", tooltip: "Delete Column", type: "button", icon: "-C", category: "Insert" },

  // --- Layout ---
  // A separator is MULTI-INSTANCE: the default layout already places five of
  // them. Anything keyed on "is this id already used" must exempt separators.
  { id: "rowBreak", label: "Row Break", tooltip: "Starts a new ribbon row at this position", type: "separator", category: "Layout" },
];

/** Lookup map for quick access */
export const ITEMS_BY_ID = new Map<string, HomeTabItem>(
  ALL_ITEMS.map((item) => [item.id, item])
);

/** Get all unique categories */
export function getCategories(): string[] {
  const cats = new Set<string>();
  for (const item of ALL_ITEMS) cats.add(item.category);
  return Array.from(cats);
}

/** True for items that may appear more than once in a group (row breaks). */
export function isMultiInstanceItem(item: HomeTabItem | undefined): boolean {
  return item?.type === "separator";
}

// ============================================================================
// Default Layout
// ============================================================================

export const DEFAULT_LAYOUT: HomeTabLayout = {
  version: LAYOUT_VERSION,
  groups: [
    {
      id: "clipboard",
      label: "Clipboard",
      iconId: "clipboard",
      collapsePriority: 10,
      items: ["paste", "cut", "copy", "formatPainter"],
    },
    {
      id: "font",
      label: "Font",
      iconId: "font",
      collapsePriority: 20,
      items: [
        "fontName", "fontSize", "increaseFontSize", "decreaseFontSize",
        "rowBreak",
        "bold", "italic", "underline", "strikethrough", "textColor", "backgroundColor", "formatCells",
      ],
    },
    {
      id: "alignment",
      label: "Alignment",
      iconId: "alignment",
      collapsePriority: 30,
      items: [
        "alignTop", "alignMiddle", "alignBottom", "wrapText",
        "rowBreak",
        "alignLeft", "alignCenter", "alignRight", "decreaseIndent", "increaseIndent", "mergeCells",
      ],
    },
    {
      id: "number",
      label: "Number",
      iconId: "number",
      collapsePriority: 40,
      items: [
        "numberFormat",
        "rowBreak",
        "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal",
      ],
    },
    {
      id: "styles",
      label: "Styles",
      iconId: "styles",
      collapsePriority: 50,
      items: ["cellStyles"],
    },
    {
      id: "cells",
      label: "Cells",
      iconId: "cells",
      // 99 is TODAY'S SHIPPED VALUE, not a considered choice: the old
      // GROUP_ORDER table simply had no "cells" row, so it hit the fallback
      // and Cells demotes LAST on a narrow band. It is written out here so it
      // can no longer drift silently. Changing it changes narrow-window
      // behaviour, which is a product call, so it is left as-is.
      collapsePriority: 99,
      items: ["insertRow", "insertColumn", "rowBreak", "deleteRow", "deleteColumn"],
    },
    {
      id: "editing",
      label: "Editing",
      iconId: "editing",
      collapsePriority: 60,
      items: ["undo", "redo", "find", "rowBreak", "clearFormatting", "clearAll"],
    },
  ],
};

/** Deep copy so callers can never mutate DEFAULT_LAYOUT through a returned
 *  reference (both loadLayout and resetLayout hand it out). */
export function cloneLayout(layout: HomeTabLayout): HomeTabLayout {
  return {
    version: layout.version,
    groups: layout.groups.map((g) => ({ ...g, items: [...g.items] })),
  };
}

// ============================================================================
// Migration
// ============================================================================

/** The catalog a layout is migrated against. Parameterised so tests can drive
 *  the migration with a synthetic "next release" instead of waiting for one. */
export interface LayoutCatalog {
  items: HomeTabItem[];
  defaults: HomeTabLayout;
  version: number;
}

export const CURRENT_CATALOG: LayoutCatalog = {
  items: ALL_ITEMS,
  defaults: DEFAULT_LAYOUT,
  version: LAYOUT_VERSION,
};

/**
 * Bring a saved layout up to `catalog.version`. Pure -- no storage access.
 *
 * Three things happen, in order:
 *  1. SUBTRACT: item ids the catalog no longer knows are dropped, and
 *     structurally broken groups are discarded.
 *  2. ADD (this is the new half): every catalog item whose `addedIn` is
 *     greater than the saved layout's version is appended to the group the
 *     DEFAULT layout puts it in, creating that group in its default position
 *     if the user had removed it. Separators are never added -- where a user
 *     put their row breaks is their business.
 *  3. DROP EMPTY: a group left with no renderable item is removed. It used to
 *     survive as a labelled section that rendered nothing.
 */
export function migrateLayout(saved: HomeTabLayout, catalog: LayoutCatalog): HomeTabLayout {
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const savedVersion =
    typeof saved.version === "number" && Number.isFinite(saved.version) ? saved.version : 1;

  const defaultsById = new Map(catalog.defaults.groups.map((g) => [g.id, g]));

  // --- 1. Subtract unknown ids / broken groups -----------------------------
  const groups: HomeTabGroup[] = (Array.isArray(saved.groups) ? saved.groups : [])
    .filter(
      (g): g is HomeTabGroup =>
        !!g && typeof g.id === "string" && typeof g.label === "string" && Array.isArray(g.items)
    )
    .map((g) => {
      const fromDefault = defaultsById.get(g.id);
      return {
        ...g,
        // Presentation is a DEFAULT, not user data: a group that predates
        // iconId/collapsePriority takes them from the shipped default.
        iconId: g.iconId ?? fromDefault?.iconId,
        collapsePriority: g.collapsePriority ?? fromDefault?.collapsePriority,
        items: g.items.filter((id) => byId.has(id)),
      };
    });

  // --- 2. Additive migration ----------------------------------------------
  if (savedVersion < catalog.version) {
    const present = new Set<string>();
    for (const g of groups) for (const id of g.items) present.add(id);

    catalog.defaults.groups.forEach((dg, defaultIdx) => {
      const newIds = dg.items.filter((id) => {
        const item = byId.get(id);
        if (!item || isMultiInstanceItem(item)) return false;
        if (present.has(id)) return false;
        return (item.addedIn ?? 1) > savedVersion;
      });
      if (newIds.length === 0) return;
      for (const id of newIds) present.add(id);

      const target = groups.find((g) => g.id === dg.id);
      if (target) {
        target.items.push(...newIds);
        return;
      }
      // The group itself is new (or the user deleted it and a command has
      // since been added to it). Re-create it after the nearest preceding
      // default group that still exists, so it lands where it belongs.
      const revived: HomeTabGroup = { ...dg, items: [...newIds] };
      let insertAt = 0;
      for (let i = defaultIdx - 1; i >= 0; i--) {
        const anchor = groups.findIndex((g) => g.id === catalog.defaults.groups[i].id);
        if (anchor >= 0) {
          insertAt = anchor + 1;
          break;
        }
      }
      groups.splice(insertAt, 0, revived);
    });
  }

  // --- 3. Drop groups with nothing to render -------------------------------
  const renderable = groups.filter((g) =>
    g.items.some((id) => !isMultiInstanceItem(byId.get(id)))
  );

  if (renderable.length === 0) return cloneLayout(catalog.defaults);
  return { version: catalog.version, groups: renderable };
}

// ============================================================================
// Persistence (localStorage)
// ============================================================================

const STORAGE_KEY = "calcula.homeTab.layout";

/**
 * Load the saved layout, migrated to the current catalog; the default layout
 * when nothing is saved or the stored value is unusable.
 *
 * The ONE write this function may perform is stamping the migrated version
 * back, and only when the stored layout was at an older version. Without that
 * stamp the additive step would re-add, on every single load, a command the
 * user had deliberately removed.
 */
export function loadLayout(): HomeTabLayout {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (!stored) return cloneLayout(DEFAULT_LAYOUT);

  let parsed: HomeTabLayout | null = null;
  try {
    parsed = JSON.parse(stored) as HomeTabLayout;
  } catch {
    return cloneLayout(DEFAULT_LAYOUT);
  }
  if (!parsed || !Array.isArray(parsed.groups)) return cloneLayout(DEFAULT_LAYOUT);

  const migrated = migrateLayout(parsed, CURRENT_CATALOG);
  // Best-effort version stamp. The return value is deliberately ignored HERE
  // and only here: this write is not user-initiated, and a load that cannot
  // re-stamp still returns a correct migrated layout. The cost of failure is
  // that the migration runs again next launch, which is idempotent.
  if (parsed.version !== CURRENT_CATALOG.version) void saveLayout(migrated);
  return migrated;
}

/**
 * Save layout to localStorage, stamped with the current schema version.
 * Returns whether the write actually landed.
 *
 * WHY THIS RETURNS A BOOLEAN. It used to swallow the failure into a
 * `console.warn`, and the only caller that matters — the Customize dialog's
 * Save — then closed the dialog and fired `homeTab:layoutChanged` regardless.
 * The ribbon repainted from the in-memory layout, so the customization looked
 * saved, survived until the next reload, and was gone at the following launch
 * with no message at any point. localStorage genuinely does throw here
 * (QuotaExceededError, and Safari/WebView private modes reject every write), so
 * this is a reachable path, not a defensive one. The caller must decide; it
 * cannot decide from a console line the user never sees.
 */
export function saveLayout(layout: HomeTabLayout): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...cloneLayout(layout), version: LAYOUT_VERSION })
    );
    return true;
  } catch (error) {
    console.warn("[HomeTab] Failed to save layout to localStorage", error);
    return false;
  }
}

/**
 * The default layout. PURE -- it writes nothing.
 *
 * It used to `localStorage.removeItem` immediately, so "Reset to Default"
 * followed by "Cancel" wiped the saved layout, left the ribbon unchanged, and
 * the reset then appeared at the next launch. The write belongs in the
 * dialog's Save, like every other field.
 */
export function resetLayout(): HomeTabLayout {
  return cloneLayout(DEFAULT_LAYOUT);
}
