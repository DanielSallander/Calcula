//! FILENAME: app/extensions/BuiltIn/HomeTab/homeTabConfig.ts
// PURPOSE: Configuration and persistence for the Home tab layout.
// CONTEXT: Stores which groups/items are visible in the Home ribbon tab.

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
}

/** A group of items in the ribbon */
export interface HomeTabGroup {
  /** Unique group ID */
  id: string;
  /** Display label shown below the group */
  label: string;
  /** Item IDs in this group */
  items: string[];
}

/** The full Home tab layout configuration */
export interface HomeTabLayout {
  /** Ordered list of groups */
  groups: HomeTabGroup[];
}

// ============================================================================
// Available Items Registry
// ============================================================================

/** All available items that can be placed in the Home tab */
export const ALL_ITEMS: HomeTabItem[] = [
  // --- Clipboard ---
  { id: "cut", label: "Cut", shortLabel: "Cut", tooltip: "Cut (Ctrl+X)", type: "button", icon: "\u2702", category: "Clipboard" },
  { id: "copy", label: "Copy", shortLabel: "Copy", tooltip: "Copy (Ctrl+C)", type: "button", icon: "\u2398", category: "Clipboard" },
  { id: "paste", label: "Paste", shortLabel: "Paste", tooltip: "Paste (Ctrl+V)", type: "button", icon: "\u2399", category: "Clipboard" },
  { id: "formatPainter", label: "Format Painter", shortLabel: "Painter", tooltip: "Format Painter (Ctrl+Shift+C)", type: "button", icon: "\uD83D\uDD8C", category: "Clipboard" },

  // --- Font ---
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
  { id: "alignLeft", label: "Align Left", tooltip: "Align Left", type: "toggle", icon: "\u2261", category: "Alignment" },
  { id: "alignCenter", label: "Center", tooltip: "Center", type: "toggle", icon: "\u2550", category: "Alignment" },
  { id: "alignRight", label: "Align Right", tooltip: "Align Right", type: "toggle", icon: "\u2261", category: "Alignment" },
  { id: "wrapText", label: "Wrap Text", tooltip: "Wrap Text", type: "toggle", icon: "\u21B5", category: "Alignment" },
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

  // --- Styles ---
  { id: "cellStyles", label: "Cell Styles", shortLabel: "Styles", tooltip: "Cell Styles", type: "dropdown", icon: "\uD83C\uDFA8", category: "Styles" },

  // --- Insert ---
  { id: "insertRow", label: "Insert Row", tooltip: "Insert Row", type: "button", icon: "+R", category: "Insert" },
  { id: "insertColumn", label: "Insert Column", tooltip: "Insert Column", type: "button", icon: "+C", category: "Insert" },
  { id: "deleteRow", label: "Delete Row", tooltip: "Delete Row", type: "button", icon: "-R", category: "Insert" },
  { id: "deleteColumn", label: "Delete Column", tooltip: "Delete Column", type: "button", icon: "-C", category: "Insert" },
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

// ============================================================================
// Default Layout
// ============================================================================

export const DEFAULT_LAYOUT: HomeTabLayout = {
  groups: [
    {
      id: "clipboard",
      label: "Clipboard",
      items: ["paste", "cut", "copy", "formatPainter"],
    },
    {
      id: "font",
      label: "Font",
      items: ["bold", "italic", "underline", "strikethrough", "superscript", "subscript", "textColor", "backgroundColor", "formatCells"],
    },
    {
      id: "alignment",
      label: "Alignment",
      items: ["alignLeft", "alignCenter", "alignRight", "wrapText", "mergeCells"],
    },
    {
      id: "number",
      label: "Number",
      items: ["percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal"],
    },
    {
      id: "styles",
      label: "Styles",
      items: ["cellStyles"],
    },
    {
      id: "editing",
      label: "Editing",
      items: ["undo", "redo", "find"],
    },
  ],
};

// ============================================================================
// Persistence (localStorage)
// ============================================================================

const STORAGE_KEY = "calcula.homeTab.layout";

/** Load saved layout from localStorage, falling back to default */
export function loadLayout(): HomeTabLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as HomeTabLayout;
      // Validate that all item IDs still exist
      if (parsed.groups && Array.isArray(parsed.groups)) {
        const validated: HomeTabLayout = {
          groups: parsed.groups
            .filter((g) => g.id && g.label && Array.isArray(g.items))
            .map((g) => ({
              ...g,
              items: g.items.filter((id) => ITEMS_BY_ID.has(id)),
            })),
        };
        if (validated.groups.length > 0) return validated;
      }
    }
  } catch {
    // Ignore parse errors, return default
  }
  return DEFAULT_LAYOUT;
}

/** Save layout to localStorage */
export function saveLayout(layout: HomeTabLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    console.warn("[HomeTab] Failed to save layout to localStorage");
  }
}

/** Reset layout to default */
export function resetLayout(): HomeTabLayout {
  localStorage.removeItem(STORAGE_KEY);
  return DEFAULT_LAYOUT;
}
