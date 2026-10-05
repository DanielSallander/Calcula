//! FILENAME: app/extensions/BuiltIn/HomeTab/homeTabConfig.ts
// PURPOSE: Configuration and persistence for the Home tab layout.
// CONTEXT: Stores which groups/items are visible in the Home ribbon tab.
//
// ONE DEFAULT OBJECT. `DEFAULT_LAYOUT` is the whole default: which groups
// exist, in what order, holding which items, AND how each group presents
// (`iconId` for the launcher glyph, `collapsePriority` for width-overflow
// demotion order, `dialogLauncherId` for Excel's Format Cells corner arrow).
// It used to be a constant plus two lookup tables in
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
  /** Render as a full-height hero control in the ribbon band (Excel's large
   *  Paste, Conditional Formatting, Insert, Sort & Filter...). The group
   *  renders its items IN LAYOUT ORDER: each hero is its own control, and each
   *  run of consecutive non-hero items between them is one two-row grid. Which
   *  control a hero IS (a split, a menu, a gallery) is decided by its id in
   *  HomeTabGroupComponent, not here. */
  hero?: boolean;
  /**
   * The Segmented pill this command joins when it sits next to another
   * command of the same segment in one ribbon row (B|I|U|S, the alignment
   * runs, the indent pair, the decimals pair).
   *
   * CATALOG-ONLY: this lives on the catalog entry, never on a layout, so it
   * is never persisted and a saved `calcula.homeTab.layout` stays
   * byte-identical. The ribbon joins a run AFTER it has chunked the group
   * into rows, so a segment can never move a command to another row — a run
   * the user split with a row break simply becomes two pills.
   */
  segment?: string;
  /**
   * Excel's MEDIUM face: in the ribbon band, when this command sits in a
   * group that also holds a hero, it shows its label beside its icon ("Cut",
   * "Copy", "Format Painter" beside the Paste hero) -- Excel's Clipboard
   * stack. Every other command stays icon-only wherever it sits.
   *
   * CATALOG-ONLY, like `segment`: never persisted. It used to be decided per
   * GROUP ("a group with a hero labels every command"), so the heroes a
   * version-1 layout gained on upgrade turned Undo, Redo, Find & Replace,
   * Clear Formatting, Clear All and the four Insert/Delete Row/Column buttons
   * into wide labelled buttons, and the Editing and Cells groups ballooned
   * (review finding, 2026-10-04).
   */
  besideHero?: boolean;
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

/**
 * The Excel corner-arrow launchers a group may carry (CONTRACT 3.20). Each
 * opens Format Cells on one tab; index.ts resolves the id to the PanelSection's
 * `dialogLauncher` (label, command, tab). An ID is persisted, never the
 * launcher itself: a saved layout cannot hold a function.
 *
 * KEYS ONLY GROW, like the group glyph ids: a saved layout names one, and an id
 * that disappears silently takes that group's launcher away.
 */
export type HomeDialogLauncherId = "formatCells.font" | "formatCells.alignment" | "formatCells.number";

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
  /** Excel's dialog launcher -- the small corner arrow beside the group's
   *  caption (Font, Alignment, Number). Absent = the group has none, which is
   *  every group Excel draws without one (Undo, Clipboard, Styles, Cells,
   *  Editing). Presentation, like `iconId`: a group that predates it takes it
   *  from the shipped default. */
  dialogLauncherId?: HomeDialogLauncherId;
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
 *
 * 2 (2026-10-04): Excel's Home tab -- the Undo group, the Borders /
 * Orientation / Accounting splits, the Styles, Cells and Editing heroes and
 * menus, and the Format Cells dialog launchers.
 */
export const LAYOUT_VERSION = 2;

// ============================================================================
// Available Items Registry
// ============================================================================

/**
 * All available items that can be placed in the Home tab.
 *
 * Listed in the order of Excel's Home tab; `category` is the heading the
 * Customize dialog files an item under (catalog-only, never persisted). The
 * `addedIn: 2` block is CONTRACT section 2: its labels and tooltips are
 * Excel's own words, and the heroes among them carry no `shortLabel` because a
 * hero shows `shortLabel ?? label` and only the full words break onto Excel's
 * two lines ("Conditional / Formatting").
 */
export const ALL_ITEMS: HomeTabItem[] = [
  // --- Undo (owner decision 2: its own group at the far left) ---
  { id: "undo", label: "Undo", tooltip: "Undo (Ctrl+Z)", type: "button", icon: "\u21B6", category: "Undo" },
  { id: "redo", label: "Redo", tooltip: "Redo (Ctrl+Y)", type: "button", icon: "\u21B7", category: "Undo" },

  // --- Clipboard ---
  { id: "cut", label: "Cut", shortLabel: "Cut", tooltip: "Cut (Ctrl+X)", type: "button", icon: "\u2702", category: "Clipboard", besideHero: true },
  { id: "copy", label: "Copy", shortLabel: "Copy", tooltip: "Copy (Ctrl+C)", type: "button", icon: "\u2398", category: "Clipboard", besideHero: true },
  { id: "paste", label: "Paste", shortLabel: "Paste", tooltip: "Paste (Ctrl+V)", type: "button", icon: "\u2399", category: "Clipboard", hero: true },
  { id: "formatPainter", label: "Format Painter", shortLabel: "Painter", tooltip: "Format Painter (Ctrl+Shift+C)", type: "button", icon: "\uD83D\uDD8C", category: "Clipboard", besideHero: true },

  // --- Font ---
  { id: "fontName", label: "Font", tooltip: "Font Name", type: "dropdown", category: "Font" },
  { id: "fontSize", label: "Font Size", tooltip: "Font Size", type: "dropdown", category: "Font" },
  { id: "increaseFontSize", label: "Increase Font Size", tooltip: "Increase Font Size", type: "button", icon: "A˄", category: "Font" },
  { id: "decreaseFontSize", label: "Decrease Font Size", tooltip: "Decrease Font Size", type: "button", icon: "A˅", category: "Font" },
  { id: "bold", label: "Bold", tooltip: "Bold (Ctrl+B)", type: "toggle", icon: "B", category: "Font", segment: "emphasis" },
  { id: "italic", label: "Italic", tooltip: "Italic (Ctrl+I)", type: "toggle", icon: "I", category: "Font", segment: "emphasis" },
  { id: "underline", label: "Underline", tooltip: "Underline (Ctrl+U)", type: "toggle", icon: "U", category: "Font", segment: "emphasis" },
  { id: "strikethrough", label: "Strikethrough", tooltip: "Strikethrough", type: "toggle", icon: "S", category: "Font", segment: "emphasis" },
  { id: "superscript", label: "Superscript", tooltip: "Superscript (Ctrl+Shift+=)", type: "toggle", icon: "x\u00B2", category: "Font" },
  { id: "subscript", label: "Subscript", tooltip: "Subscript (Ctrl+=)", type: "toggle", icon: "x\u2082", category: "Font" },
  // Excel's Borders split: the face re-applies the last border used; the
  // menu holds the thirteen presets, the pen and More Borders...
  { id: "borders", label: "Borders", tooltip: "Borders", type: "button", icon: "\u25A1", category: "Font", addedIn: 2 },
  { id: "textColor", label: "Text Color", tooltip: "Font Color", type: "color", icon: "A", category: "Font" },
  { id: "backgroundColor", label: "Fill Color", tooltip: "Fill Color", type: "color", icon: "\u2588", category: "Font" },
  { id: "formatCells", label: "Format Cells", shortLabel: "Format", tooltip: "Format Cells... (Ctrl+1)", type: "button", icon: "\u2630", category: "Font" },

  // --- Alignment ---
  { id: "alignTop", label: "Top Align", tooltip: "Align Top", type: "toggle", icon: "\u2912", category: "Alignment", segment: "valign" },
  { id: "alignMiddle", label: "Middle Align", tooltip: "Center Vertically", type: "toggle", icon: "\u21C5", category: "Alignment", segment: "valign" },
  { id: "alignBottom", label: "Bottom Align", tooltip: "Align Bottom", type: "toggle", icon: "\u2913", category: "Alignment", segment: "valign" },
  // The text fallbacks of Left and Right were both U+2261, so wherever
  // the drawn icon was unavailable the two read as the same command. They are
  // now a mirrored pair: the left half block and the right half block.
  { id: "alignLeft", label: "Align Left", tooltip: "Align Left", type: "toggle", icon: "\u258C", category: "Alignment", segment: "halign" },
  { id: "alignCenter", label: "Center", tooltip: "Center", type: "toggle", icon: "\u2550", category: "Alignment", segment: "halign" },
  { id: "alignRight", label: "Align Right", tooltip: "Align Right", type: "toggle", icon: "\u2590", category: "Alignment", segment: "halign" },
  // Excel's Orientation menu: the four angles, stacked text, Format Cell
  // Alignment.
  { id: "orientation", label: "Orientation", tooltip: "Orientation", type: "button", icon: "\u2197", category: "Alignment", addedIn: 2 },
  { id: "wrapText", label: "Wrap Text", tooltip: "Wrap Text", type: "toggle", icon: "\u21B5", category: "Alignment" },
  { id: "increaseIndent", label: "Increase Indent", tooltip: "Increase Indent", type: "button", icon: "\u21E5", category: "Alignment", segment: "indent" },
  { id: "decreaseIndent", label: "Decrease Indent", tooltip: "Decrease Indent", type: "button", icon: "\u21E4", category: "Alignment", segment: "indent" },
  // Excel's Merge & Center split button (2026-10-02). The id stays "mergeCells"
  // FOREVER: it is persisted in every customised layout. The ribbon renders it
  // as a split button whose menu holds Excel's four Merge commands
  // (components/MergeSplitButton.tsx); label and tooltip are catalog-only.
  { id: "mergeCells", label: "Merge & Center", tooltip: "Merge & Center", type: "button", icon: "\u29EA", category: "Alignment" },

  // --- Number ---
  { id: "numberFormat", label: "Number Format", tooltip: "Number Format", type: "dropdown", icon: "#", category: "Number" },
  // Excel's Accounting split: the face writes the locale's Accounting format;
  // the menu holds six currencies and More Accounting Formats...
  { id: "accountingFormat", label: "Accounting Number Format", tooltip: "Accounting Number Format", type: "button", icon: "$", category: "Number", addedIn: 2 },
  { id: "percentFormat", label: "Percent", tooltip: "Percent Style (%)", type: "button", icon: "%", category: "Number" },
  { id: "commaFormat", label: "Comma", tooltip: "Comma Style (,)", type: "button", icon: ",", category: "Number" },
  { id: "increaseDecimal", label: "Increase Decimal", tooltip: "Increase Decimal", type: "button", icon: ".0", category: "Number", segment: "decimals" },
  { id: "decreaseDecimal", label: "Decrease Decimal", tooltip: "Decrease Decimal", type: "button", icon: "0.", category: "Number", segment: "decimals" },

  // --- Styles ---
  // Conditional Formatting and Format as Table host the menu-bar items their
  // owning extensions register (Format > ...), so ribbon and menu show ONE
  // tree; Cell Styles opens the shared gallery.
  { id: "conditionalFormatting", label: "Conditional Formatting", tooltip: "Conditional Formatting", type: "dropdown", icon: "\u25A6", category: "Styles", hero: true, addedIn: 2 },
  { id: "formatAsTable", label: "Format as Table", tooltip: "Format as Table", type: "dropdown", icon: "\u25A4", category: "Styles", hero: true, addedIn: 2 },
  { id: "cellStyles", label: "Cell Styles", shortLabel: "Cell Styles", tooltip: "Cell Styles", type: "dropdown", icon: "\uD83C\uDFA8", category: "Styles", hero: true },

  // --- Cells ---
  // Excel's Insert / Delete splits (the picture runs Excel's selection-shape
  // rule; the menu holds Cells..., Sheet Rows, Sheet Columns, Sheet) and the
  // Format menu. The four single commands below them predate the splits and
  // stay addable through Customize Home Tab.
  { id: "insertCells", label: "Insert", tooltip: "Insert Cells", type: "button", icon: "\u229E", category: "Cells", hero: true, addedIn: 2 },
  { id: "deleteCells", label: "Delete", tooltip: "Delete Cells", type: "button", icon: "\u229F", category: "Cells", hero: true, addedIn: 2 },
  { id: "formatMenu", label: "Format", tooltip: "Format", type: "dropdown", icon: "\u2630", category: "Cells", hero: true, addedIn: 2 },
  { id: "insertRow", label: "Insert Row", tooltip: "Insert Row", type: "button", icon: "+R", category: "Cells" },
  { id: "insertColumn", label: "Insert Column", tooltip: "Insert Column", type: "button", icon: "+C", category: "Cells" },
  { id: "deleteRow", label: "Delete Row", tooltip: "Delete Row", type: "button", icon: "-R", category: "Cells" },
  { id: "deleteColumn", label: "Delete Column", tooltip: "Delete Column", type: "button", icon: "-C", category: "Cells" },

  // --- Editing ---
  { id: "autoSum", label: "AutoSum", tooltip: "AutoSum (Alt+=)", type: "button", icon: "\u03A3", category: "Editing", addedIn: 2 },
  { id: "fill", label: "Fill", tooltip: "Fill", type: "dropdown", icon: "\u2193", category: "Editing", addedIn: 2 },
  { id: "clear", label: "Clear", tooltip: "Clear", type: "dropdown", icon: "\u2715", category: "Editing", addedIn: 2 },
  { id: "sortFilter", label: "Sort & Filter", tooltip: "Sort & Filter", type: "dropdown", icon: "\u21C5", category: "Editing", hero: true, addedIn: 2 },
  { id: "findSelect", label: "Find & Select", tooltip: "Find & Select", type: "dropdown", icon: "\uD83D\uDD0D", category: "Editing", hero: true, addedIn: 2 },
  // The single commands Excel's Clear and Find & Select menus replaced; kept
  // so a saved layout naming them still renders and Customize can add them.
  { id: "find", label: "Find & Replace", shortLabel: "Find", tooltip: "Find & Replace (Ctrl+H)", type: "button", icon: "\uD83D\uDD0D", category: "Editing" },
  { id: "clearContents", label: "Clear Contents", shortLabel: "Clear", tooltip: "Clear Contents (Del)", type: "button", icon: "\u2715", category: "Editing" },
  { id: "clearFormatting", label: "Clear Formatting", shortLabel: "Clear Fmt", tooltip: "Clear Formatting", type: "button", icon: "\u2718", category: "Editing" },
  { id: "clearAll", label: "Clear All", shortLabel: "Clear All", tooltip: "Clear All (formatting + content + comments)", type: "button", icon: "\u2716", category: "Editing" },

  // --- Layout ---
  // A separator is MULTI-INSTANCE: the default layout already places six of
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

/**
 * Excel's Home tab (CONTRACT section 1), left to right.
 *
 * ORDER IS LAYOUT. HomeTabGroupComponent renders a group's items in this
 * order: each hero is its own full-height control, and each run of
 * consecutive non-hero items is one two-row grid split at its `rowBreak`s. So
 * Clipboard reads [Paste][Cut Copy / Format Painter] and Editing reads
 * [AutoSum Fill / Clear][Sort & Filter][Find & Select] -- Excel's order -- by
 * nothing more than where the ids sit here.
 *
 * COLLAPSE ORDER (owner decision 3). A narrowing window turns groups into
 * launchers RIGHT-TO-LEFT, as Excel does: Styles (10) first, then Cells (20),
 * Editing (30), Number (40), Alignment (50), Font (60), Clipboard (70), and
 * Undo (80) last. useSectionFit sorts ascending, so lower goes first. (Before
 * version 2 the order was left-to-right, 10..60, with Clipboard shed first.)
 *
 * Left out on purpose (CONTRACT section 1): strikethrough, Format Cells, Find
 * & Replace, the three single Clear buttons, Insert/Delete Row/Column,
 * superscript and subscript. Excel's Home tab has none of them as buttons --
 * they live in the new menus or behind the dialog launchers -- and all stay in
 * the catalog, so Customize Home Tab can put any of them back.
 */
export const DEFAULT_LAYOUT: HomeTabLayout = {
  version: LAYOUT_VERSION,
  groups: [
    {
      // Owner decision 2: Microsoft 365's Undo group, Undo above Redo, the
      // layout Excel shows when its Quick Access Toolbar is hidden.
      id: "undo",
      label: "Undo",
      iconId: "undo",
      collapsePriority: 80,
      items: ["undo", "rowBreak", "redo"],
    },
    {
      // No dialog launcher: Excel's opens the Office Clipboard pane, which is
      // deferred (owner decision 1, item 6).
      id: "clipboard",
      label: "Clipboard",
      iconId: "clipboard",
      collapsePriority: 70,
      items: ["paste", "cut", "copy", "rowBreak", "formatPainter"],
    },
    {
      id: "font",
      label: "Font",
      iconId: "font",
      collapsePriority: 60,
      dialogLauncherId: "formatCells.font",
      items: [
        "fontName", "fontSize", "increaseFontSize", "decreaseFontSize",
        "rowBreak",
        "bold", "italic", "underline", "borders", "backgroundColor", "textColor",
      ],
    },
    {
      id: "alignment",
      label: "Alignment",
      iconId: "alignment",
      collapsePriority: 50,
      dialogLauncherId: "formatCells.alignment",
      items: [
        "alignTop", "alignMiddle", "alignBottom", "orientation", "wrapText",
        "rowBreak",
        "alignLeft", "alignCenter", "alignRight", "decreaseIndent", "increaseIndent", "mergeCells",
      ],
    },
    {
      id: "number",
      label: "Number",
      iconId: "number",
      collapsePriority: 40,
      dialogLauncherId: "formatCells.number",
      items: [
        "numberFormat",
        "rowBreak",
        "accountingFormat", "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal",
      ],
    },
    {
      id: "styles",
      label: "Styles",
      iconId: "styles",
      collapsePriority: 10,
      items: ["conditionalFormatting", "formatAsTable", "cellStyles"],
    },
    {
      id: "cells",
      label: "Cells",
      iconId: "cells",
      collapsePriority: 20,
      items: ["insertCells", "deleteCells", "formatMenu"],
    },
    {
      id: "editing",
      label: "Editing",
      iconId: "editing",
      collapsePriority: 30,
      items: ["autoSum", "fill", "rowBreak", "clear", "sortFilter", "findSelect"],
    },
  ],
};

/** Deep copy so callers can never mutate DEFAULT_LAYOUT through a returned
 *  reference (both loadLayout and resetLayout hand it out). */
export function cloneLayout(layout: HomeTabLayout): HomeTabLayout {
  return {
    version: layout.version,
    // A spread, so every group field (dialogLauncherId included) survives a
    // save, a reset and a load without this function having to list them.
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

/** `items` with each row break numbered by occurrence ("rowBreak#0",
 *  "rowBreak#1", ...), so the k-th break of the default group answers for the
 *  k-th break of a saved one. Every other id is its own token. */
function orderTokens(items: readonly string[], byId: ReadonlyMap<string, HomeTabItem>): string[] {
  let breaks = 0;
  return items.map((id) => (isMultiInstanceItem(byId.get(id)) ? `${id}#${breaks++}` : id));
}

/**
 * Insert the new command `id` into a saved group's `items` (in place) where
 * the DEFAULT group's order puts it: just before the earliest saved item --
 * a row break included -- that follows `id` in `defaultItems`; appended when
 * none of those is in the saved group. Everything already there keeps its
 * relative order.
 *
 * It used to append every new command, which gave a saved version-1 layout
 * Styles = Cell Styles, Conditional Formatting, Format as Table (Excel's order
 * backwards), Borders after Format Cells, Accounting last in its row and
 * Orientation on row 2 (review finding, 2026-10-04).
 */
function insertInDefaultOrder(
  items: string[],
  id: string,
  defaultItems: readonly string[],
  byId: ReadonlyMap<string, HomeTabItem>,
): void {
  const defaults = orderTokens(defaultItems, byId);
  const following = new Set(defaults.slice(defaults.indexOf(id) + 1));
  const saved = orderTokens(items, byId);
  const at = saved.findIndex((token) => following.has(token));
  if (at < 0) items.push(id);
  else items.splice(at, 0, id);
}

/**
 * Bring a saved layout up to `catalog.version`. Pure -- no storage access.
 *
 * Three things happen, in order:
 *  1. SUBTRACT: item ids the catalog no longer knows are dropped, and
 *     structurally broken groups are discarded. Presentation the layout lacks
 *     (`iconId`, `collapsePriority`, `dialogLauncherId`) is filled from the
 *     shipped default of the same group id.
 *  2. ADD (this is the new half): every catalog item whose `addedIn` is
 *     greater than the saved layout's version is added to the group the
 *     DEFAULT layout puts it in, creating that group in its default position
 *     if the user had removed it. It goes where the default's ORDER puts it
 *     (insertInDefaultOrder): just before the earliest saved item that
 *     follows it in the default group, row breaks included; appended only
 *     when nothing that follows it is there. Separators are never added --
 *     where a user put their row breaks is their business.
 *  3. DROP EMPTY: a group left with no renderable item is removed. It used to
 *     survive as a labelled section that rendered nothing.
 *
 * WHAT AN UPGRADE KEEPS, AND WHAT IT REPLACES. Items, their order, row breaks,
 * group labels and a chosen `iconId` are the user's: Customize Home Tab edits
 * them, so they survive every upgrade untouched. `collapsePriority` is not:
 * the dialog has no control for it (a group the user CREATES gets 99 and
 * nothing else ever changes it), so a saved number on a default group is only
 * a copy of the default it was saved under. An upgrade therefore re-takes it
 * from the new default -- otherwise every layout saved at version 1 would keep
 * shedding Clipboard FIRST on a narrow window, the opposite of Excel's order
 * (owner decision 3). A layout already at the catalog's version is left alone.
 */
export function migrateLayout(saved: HomeTabLayout, catalog: LayoutCatalog): HomeTabLayout {
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const savedVersion =
    typeof saved.version === "number" && Number.isFinite(saved.version) ? saved.version : 1;
  const upgrading = savedVersion < catalog.version;

  const defaultsById = new Map(catalog.defaults.groups.map((g) => [g.id, g]));

  // --- 1. Subtract unknown ids / broken groups -----------------------------
  const groups: HomeTabGroup[] = (Array.isArray(saved.groups) ? saved.groups : [])
    .filter(
      (g): g is HomeTabGroup =>
        !!g && typeof g.id === "string" && typeof g.label === "string" && Array.isArray(g.items)
    )
    .map((g) => {
      const fromDefault = defaultsById.get(g.id);
      const group: HomeTabGroup = { ...g, items: g.items.filter((id) => byId.has(id)) };
      // Presentation is a DEFAULT, not user data: a group that predates
      // iconId/collapsePriority/dialogLauncherId takes them from the shipped
      // default. Set only when there is something to set, so a group of the
      // user's own gains no `undefined` keys (a current-version load must hand
      // back exactly what was stored).
      const iconId = g.iconId ?? fromDefault?.iconId;
      if (iconId !== undefined) group.iconId = iconId;
      const collapsePriority =
        upgrading && fromDefault?.collapsePriority !== undefined
          ? fromDefault.collapsePriority
          : (g.collapsePriority ?? fromDefault?.collapsePriority);
      if (collapsePriority !== undefined) group.collapsePriority = collapsePriority;
      const dialogLauncherId = g.dialogLauncherId ?? fromDefault?.dialogLauncherId;
      if (dialogLauncherId !== undefined) group.dialogLauncherId = dialogLauncherId;
      return group;
    });

  // --- 2. Additive migration ----------------------------------------------
  if (upgrading) {
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
        for (const id of newIds) insertInDefaultOrder(target.items, id, dg.items, byId);
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
