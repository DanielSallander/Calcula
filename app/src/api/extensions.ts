//! FILENAME: app/src/api/extensions.ts
// PURPOSE: Extension system exports for add-ins.
// CONTEXT: Extensions register themselves using these APIs.
// FIX: Uses IoC pattern - Shell registers implementations at startup.
// FIX: Types now match core/lib/gridCommands.ts definitions exactly.

import type { Selection } from "../core/types";

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
}

export interface RibbonGroupDefinition {
  id: string;
  tabId: string;
  label: string;
  order: number;
  component: React.ComponentType<{ context: RibbonContext }>;
}

// ============================================================================
// Grid Menu Types - MUST match core/lib/gridCommands.ts exactly
// ============================================================================

/** Context passed to grid context menu callbacks */
export interface GridMenuContext {
  /** The current selection */
  selection: Selection | null;
  /** The cell that was right-clicked (may differ from selection start) */
  clickedCell: { row: number; col: number } | null;
  /** Whether the clicked cell is within the current selection */
  isWithinSelection: boolean;
  /** Active sheet index */
  sheetIndex: number;
  /** Active sheet name */
  sheetName: string;
}

/** A context menu item for the grid */
export interface GridContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
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
}

/** Available grid command names */
export type GridCommand =
  | "cut"
  | "copy"
  | "paste"
  | "clearContents"
  | "insertRow"
  | "insertColumn"
  | "deleteRow"
  | "deleteColumn";

// ============================================================================
// Sheet Context Types
// ============================================================================

export interface SheetContext {
  sheet: { name: string; index: number };
  index: number;
  isActive: boolean;
  totalSheets: number;
}

export interface SheetContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean | ((context: SheetContext) => boolean);
  separatorAfter?: boolean;
  onClick: (context: SheetContext) => void | Promise<void>;
}

// ============================================================================
// Service Interfaces (Contracts for Shell to implement)
// ============================================================================

export interface ExtensionRegistryService {
  registerAddIn(manifest: AddInManifest): void;
  unregisterAddIn(addinId: string): void;
  registerCommand(command: CommandDefinition): void;
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

export interface GridCommandsService {
  register(command: GridCommand, handler: () => void | Promise<void>): void;
  execute(command: GridCommand): Promise<boolean>;
  hasHandler(command: GridCommand): boolean;
}

export interface SheetExtensionsService {
  registerContextMenuItem(item: SheetContextMenuItem): void;
  unregisterContextMenuItem(id: string): void;
  getContextMenuItems(): SheetContextMenuItem[];
  getContextMenuItemsForContext(context: SheetContext): SheetContextMenuItem[];
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
  getContextMenuItemsForContext(context: SheetContext): SheetContextMenuItem[] {
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