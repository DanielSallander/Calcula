//! FILENAME: app/src/api/extensions.ts
// PURPOSE: Extension system exports for add-ins.
// CONTEXT: Extensions register themselves using these APIs.
// FIX: Uses IoC pattern - Shell registers implementations at startup.
// FIX: Types now match core/lib/gridCommands.ts definitions exactly.

import type { Selection } from "../core/types";
import type { GridCommand, CommandGuard, GridMenuContext } from "../core/lib/gridCommands";

// ============================================================================
// Type Definitions (Contracts) - Must match Shell implementations
// ============================================================================

export interface AddInManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  commands?: CommandDefinition[];
  ribbonTabs?: RibbonTabDefinition[];
  ribbonGroups?: RibbonGroupDefinition[];
  dependencies?: string[];
}

export interface CommandDefinition {
  id: string;
  name: string;
  shortcut?: string;
  isEnabled?: (context: CommandContext) => boolean;
  execute: (context: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  selection: Selection | null;
  getCellValue: (row: number, col: number) => Promise<string | null>;
  setCellValue: (row: number, col: number, value: string) => Promise<void>;
  refreshGrid: () => void;
}

export interface RibbonContext {
  selection: Selection | null;
  isDisabled: boolean;
  executeCommand: (commandId: string) => Promise<void>;
  refreshCells: () => Promise<void>;
}

export interface RibbonTabDefinition {
  id: string;
  label: string;
  order: number;
  component: React.ComponentType<{ context: RibbonContext }>;
  /**
   * Optional accent color for contextual tabs (e.g. "#217346" green for pivot tabs).
   * When set, the tab header displays a colored top border and tinted text.
   */
  color?: string;
  /**
   * Contextual tabs only: SELECT this tab when it first appears, and when it
   * disappears again return the ribbon to the tab that was selected before it.
   * A contextual tab normally appears WITHOUT stealing the selection (a pivot's
   * Analyze tab must not yank the user off Home on every click into a pivot);
   * a tab that belongs to a whole SURFACE -- the Canvas tab, shown for as long
   * as a canvas sheet is active -- is the exception.
   */
  activateOnRegister?: boolean;
}

export interface RibbonGroupDefinition {
  id: string;
  tabId: string;
  label: string;
  order: number;
  component: React.ComponentType<{ context: RibbonContext }>;
}

// ============================================================================
// Grid Menu Types
// ============================================================================

/**
 * The context a grid context-menu item is handed -- DERIVED from Core
 * (core/lib/gridCommands.ts), the way `GridCommand` below is. This used to be
 * a copy under a "MUST match exactly" banner, and it had drifted: Core fills
 * `dimensions` (the hidden rows and columns) on every right-click and the copy
 * did not declare it, so an extension could not read what it was handed.
 * Pinned by src/api/__tests__/gridMenuContextDrift.test.ts.
 */
export type { GridMenuContext } from "../core/lib/gridCommands";

/** A context menu item for the grid */
export interface GridContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label (static string or function for dynamic labels) */
  label: string | ((context: GridMenuContext) => string);
  /** Optional keyboard shortcut hint (display only) */
  shortcut?: string;
  /** Optional icon */
  icon?: React.ReactNode;
  /** Group for organizing items (items in same group stay together) */
  group?: string;
  /** Order within the group (lower = higher in menu) */
  order?: number;
  /** Whether the item is disabled */
  disabled?: boolean | ((context: GridMenuContext) => boolean);
  /** Whether the item is visible */
  visible?: boolean | ((context: GridMenuContext) => boolean);
  /** Whether to show a separator after this item */
  separatorAfter?: boolean;
  /** Click handler */
  onClick: (context: GridMenuContext) => void | Promise<void>;
  /** Sub-menu items. When present, this item acts as a sub-menu trigger. */
  children?: GridContextMenuItem[];
}

/**
 * Available grid command names, and the list itself -- DERIVED from Core
 * (core/lib/gridCommands.ts), the way api/types.ts re-exports Core's types.
 * This used to be a copied union under the "MUST match exactly" banner above,
 * and it had drifted to 8 of Core's 18 commands. Pinned by
 * src/api/__tests__/gridCommandDrift.test.ts.
 */
export type { GridCommand, CommandGuard } from "../core/lib/gridCommands";
export { GRID_COMMANDS } from "../core/lib/gridCommands";

// ============================================================================
// Sheet Context Types
// ============================================================================

export interface SheetContext {
  /**
   * The sheet the menu was opened on. `kind` is `"canvas"` for a canvas
   * sheet (objects only, no cells) and absent or `"worksheet"` otherwise, so
   * an item that acts on cells can hide itself with `visible`.
   */
  sheet: { name: string; index: number; kind?: "worksheet" | "canvas" };
  /**
   * The TRUE workbook index — what every backend sheet command takes. Correct
   * for the call you are about to make, and wrong as a cache key: an insert, a
   * delete or a move shifts it and nothing tells you.
   */
  index: number;
  /**
   * The sheet's stable identity, for anything an extension REMEMBERS about a
   * sheet.
   *
   * Collaboration cached "which application did this sheet come from?" by index
   * and refreshed it on open only. Drag a tab and the sheet menu then offered
   * `Detach from "vendor-kpis"` on a sheet that never came from an application,
   * while the real one — still wearing the badge, which keys on the id — showed
   * none of the three items the badge advertises.
   *
   * Optional because an older backend may not send it; a consumer that has no
   * id must show nothing rather than fall back to the index.
   */
  sheetId?: string;
  isActive: boolean;
  totalSheets: number;
}

export interface SheetContextMenuItem {
  id: string;
  label: string | ((context: SheetContext) => string);
  icon?: React.ReactNode;
  disabled?: boolean | ((context: SheetContext) => boolean);
  /**
   * Whether the item appears at all. Default: always.
   *
   * DISTINCT FROM `disabled`, and the difference matters for an item that only
   * applies to SOME sheets: "Detach from 'vendor-kpis'" greyed out on every
   * ordinary tab is clutter that teaches the reader to ignore the menu.
   * `disabled` is for "this applies here but you may not do it right now"
   * (Protection greys Rename); `visible` is for "this does not apply here".
   * `GridContextMenuItem` has carried both for the same reason.
   */
  visible?: (context: SheetContext) => boolean;
  separatorAfter?: boolean;
  onClick: (context: SheetContext) => void | Promise<void>;
}

/**
 * A menu item with every predicate already applied for one specific sheet.
 *
 * The renderer receives THIS, not the registration: a component should never
 * have to know that a label or a disabled flag might be a function.
 */
export interface ResolvedSheetContextMenuItem
  extends Omit<SheetContextMenuItem, "label" | "disabled" | "visible"> {
  label: string;
  disabled?: boolean;
}

// ============================================================================
// Service Interfaces (Contracts for Shell to implement)
// ============================================================================

export interface ExtensionRegistryService {
  registerAddIn(manifest: AddInManifest): void;
  unregisterAddIn(addinId: string): void;
  registerCommand(command: CommandDefinition): void;
  /** The inverse of registerCommand: take back THIS registration (the object
   *  that was registered), never another extension's of the same id. */
  unregisterCommand(command: CommandDefinition): void;
  getCommand(commandId: string): CommandDefinition | undefined;
  getAllCommands(): CommandDefinition[];
  registerRibbonTab(tab: RibbonTabDefinition): void;
  unregisterRibbonTab(tabId: string): void;
  registerRibbonGroup(group: RibbonGroupDefinition): void;
  getRibbonTabs(): RibbonTabDefinition[];
  getRibbonGroupsForTab(tabId: string): RibbonGroupDefinition[];
  notifySelectionChange(selection: Selection | null): void;
  onSelectionChange(callback: (selection: Selection | null) => void): () => void;
  onCellChange(callback: (row: number, col: number, oldValue: string | null, newValue: string | null) => void): () => void;
  onRegistryChange(callback: () => void): () => void;
}

export interface GridExtensionsService {
  registerContextMenuItem(item: GridContextMenuItem): void;
  registerContextMenuItems(items: GridContextMenuItem[]): void;
  unregisterContextMenuItem(id: string): void;
  getContextMenuItems(): GridContextMenuItem[];
  getContextMenuItemsForContext(context: GridMenuContext): GridContextMenuItem[];
  onChange(callback: () => void): () => void;
}

// `CommandGuard` (a guard receives the current selection and returns true to
// allow, or a sentence to block) is Core's type, re-exported with GridCommand
// above.

export interface GridCommandsService {
  register(command: GridCommand, handler: () => void | Promise<void>): void;
  execute(command: GridCommand): Promise<boolean>;
  hasHandler(command: GridCommand): boolean;
  registerGuard(commands: GridCommand[], guard: CommandGuard): () => void;
  setSelection(selection: Selection | null): void;
}

export interface SheetExtensionsService {
  registerContextMenuItem(item: SheetContextMenuItem): void;
  unregisterContextMenuItem(id: string): void;
  getContextMenuItems(): SheetContextMenuItem[];
  getContextMenuItemsForContext(context: SheetContext): ResolvedSheetContextMenuItem[];
}

// ============================================================================
// Service Registration (IoC pattern)
// ============================================================================

let extensionRegistryService: ExtensionRegistryService | undefined;
let gridExtensionsService: GridExtensionsService | undefined;
let gridCommandsService: GridCommandsService | undefined;
let sheetExtensionsService: SheetExtensionsService | undefined;

// Registration functions called by Shell at startup
export function registerExtensionRegistryService(service: ExtensionRegistryService): void {
  extensionRegistryService = service;
}

export function registerGridExtensionsService(service: GridExtensionsService): void {
  gridExtensionsService = service;
}

export function registerGridCommandsService(service: GridCommandsService): void {
  gridCommandsService = service;
}

export function registerSheetExtensionsService(service: SheetExtensionsService): void {
  sheetExtensionsService = service;
}

// ============================================================================
// Public API (delegates to registered services)
// ============================================================================

// Extension Registry
export const ExtensionRegistry = {
  registerAddIn(manifest: AddInManifest): void {
    extensionRegistryService?.registerAddIn(manifest);
  },
  unregisterAddIn(addinId: string): void {
    extensionRegistryService?.unregisterAddIn(addinId);
  },
  registerCommand(command: CommandDefinition): void {
    extensionRegistryService?.registerCommand(command);
  },
  /**
   * Take back a command this extension registered with registerCommand --
   * call it on deactivation, as for menu items and panes. Without it a command
   * outlived its extension: a ribbon or cell-type button bound to it, or a
   * script naming it, still ran the torn-down extension's code (X20, wave D).
   *
   * Pass the SAME object you registered: the removal is tied to that
   * registration, not to the id. Another extension that registered the same
   * id over yours keeps its command when you go; if yours was the one on top,
   * the one it had overwritten is live again. A command already taken back is
   * ignored. An add-in's commands go with unregisterAddIn instead.
   */
  unregisterCommand(command: CommandDefinition): void {
    extensionRegistryService?.unregisterCommand(command);
  },
  getCommand(commandId: string): CommandDefinition | undefined {
    return extensionRegistryService?.getCommand(commandId);
  },
  getAllCommands(): CommandDefinition[] {
    return extensionRegistryService?.getAllCommands() ?? [];
  },
  registerRibbonTab(tab: RibbonTabDefinition): void {
    extensionRegistryService?.registerRibbonTab(tab);
  },
  unregisterRibbonTab(tabId: string): void {
    extensionRegistryService?.unregisterRibbonTab(tabId);
  },
  registerRibbonGroup(group: RibbonGroupDefinition): void {
    extensionRegistryService?.registerRibbonGroup(group);
  },
  getRibbonTabs(): RibbonTabDefinition[] {
    return extensionRegistryService?.getRibbonTabs() ?? [];
  },
  getRibbonGroupsForTab(tabId: string): RibbonGroupDefinition[] {
    return extensionRegistryService?.getRibbonGroupsForTab(tabId) ?? [];
  },
  notifySelectionChange(selection: Selection | null): void {
    extensionRegistryService?.notifySelectionChange(selection);
  },
  onSelectionChange(callback: (selection: Selection | null) => void): () => void {
    return extensionRegistryService?.onSelectionChange(callback) ?? (() => {});
  },
  onCellChange(callback: (row: number, col: number, oldValue: string | null, newValue: string | null) => void): () => void {
    return extensionRegistryService?.onCellChange(callback) ?? (() => {});
  },
  onRegistryChange(callback: () => void): () => void {
    return extensionRegistryService?.onRegistryChange(callback) ?? (() => {});
  },
};

// Grid Extensions
export const gridExtensions = {
  registerContextMenuItem(item: GridContextMenuItem): void {
    gridExtensionsService?.registerContextMenuItem(item);
  },
  registerContextMenuItems(items: GridContextMenuItem[]): void {
    gridExtensionsService?.registerContextMenuItems(items);
  },
  unregisterContextMenuItem(id: string): void {
    gridExtensionsService?.unregisterContextMenuItem(id);
  },
  getContextMenuItems(): GridContextMenuItem[] {
    return gridExtensionsService?.getContextMenuItems() ?? [];
  },
  getContextMenuItemsForContext(context: GridMenuContext): GridContextMenuItem[] {
    return gridExtensionsService?.getContextMenuItemsForContext(context) ?? [];
  },
  onChange(callback: () => void): () => void {
    return gridExtensionsService?.onChange(callback) ?? (() => {});
  },
};

// Grid Commands
export const gridCommands = {
  register(command: GridCommand, handler: () => void | Promise<void>): void {
    gridCommandsService?.register(command, handler);
  },
  execute(command: GridCommand): Promise<boolean> {
    return gridCommandsService?.execute(command) ?? Promise.resolve(false);
  },
  hasHandler(command: GridCommand): boolean {
    return gridCommandsService?.hasHandler(command) ?? false;
  },
  registerGuard(commands: GridCommand[], guard: CommandGuard): () => void {
    return gridCommandsService?.registerGuard(commands, guard) ?? (() => {});
  },
  setSelection(selection: Selection | null): void {
    gridCommandsService?.setSelection(selection);
  },
};

// Sheet Extensions
export const sheetExtensions = {
  registerContextMenuItem(item: SheetContextMenuItem): void {
    sheetExtensionsService?.registerContextMenuItem(item);
  },
  unregisterContextMenuItem(id: string): void {
    sheetExtensionsService?.unregisterContextMenuItem(id);
  },
  getContextMenuItems(): SheetContextMenuItem[] {
    return sheetExtensionsService?.getContextMenuItems() ?? [];
  },
  getContextMenuItemsForContext(context: SheetContext): ResolvedSheetContextMenuItem[] {
    return sheetExtensionsService?.getContextMenuItemsForContext(context) ?? [];
  },
};

// ============================================================================
// Constants
// ============================================================================

/** Groups for organizing menu items */
export const GridMenuGroups = {
  CLIPBOARD: "clipboard",
  EDIT: "edit",
  INSERT: "insert",
  FORMAT: "format",
  DATA: "data",
  DEVELOPER: "developer",
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a click position (row, col) is within the given selection.
 */
export function isClickWithinSelection(
  row: number,
  col: number,
  selection: Selection | null
): boolean {
  if (!selection) return false;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

// ============================================================================
// Core Menu Registration (placeholders - actual implementation in Shell)
// ============================================================================

/**
 * Register core grid context menu items.
 * NOTE: This is a placeholder. Actual implementation is in Shell bootstrap.
 */
export function registerCoreGridContextMenu(): void {
  console.warn("[API] registerCoreGridContextMenu should be called from Shell bootstrap");
}

/**
 * Register core sheet context menu items.
 * NOTE: This is a placeholder. Actual implementation is in Shell bootstrap.
 */
export function registerCoreSheetContextMenu(): void {
  console.warn("[API] registerCoreSheetContextMenu should be called from Shell bootstrap");
}