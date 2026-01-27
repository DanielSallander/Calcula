//! FILENAME: app/src/core/extensions/types.ts
// PURPOSE: Type definitions for the extension point system.
// CONTEXT: Defines interfaces that add-ins implement to extend core functionality.

import type { Selection } from "../types";

// =============================================================================
// COMMAND SYSTEM
// =============================================================================

/**
 * A command that can be executed by the application.
 * Commands are the primary way add-ins expose functionality.
 */
export interface Command {
  /** Unique identifier for the command */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional keyboard shortcut (e.g., "Ctrl+B") */
  shortcut?: string;
  /** Whether the command is currently enabled */
  isEnabled?: (context: CommandContext) => boolean;
  /** Execute the command */
  execute: (context: CommandContext) => void | Promise<void>;
}

/**
 * Context passed to commands when executed.
 */
export interface CommandContext {
  /** Current selection */
  selection: Selection | null;
  /** Get cell value */
  getCellValue: (row: number, col: number) => Promise<string | null>;
  /** Set cell value */
  setCellValue: (row: number, col: number, value: string) => Promise<void>;
  /** Trigger a refresh of the grid */
  refreshGrid: () => void;
}

// =============================================================================
// RIBBON EXTENSION
// =============================================================================

/**
 * Context passed to all ribbon components.
 */
export interface RibbonContext {
  /** Current selection in the grid */
  selection: Selection | null;
  /** Whether ribbon controls should be disabled */
  isDisabled: boolean;
  /** Execute a registered command */
  executeCommand: (commandId: string) => Promise<void>;
  /** Trigger a refresh of cell data */
  refreshCells: () => Promise<void>;
}

/**
 * Definition of a ribbon tab.
 */
export interface RibbonTabDefinition {
  /** Unique identifier for the tab */
  id: string;
  /** Display label for the tab */
  label: string;
  /** Sort order (lower numbers appear first) */
  order: number;
  /** Component to render as tab content */
  component: React.ComponentType<{ context: RibbonContext }>;
}

/**
 * Definition of a ribbon group within a tab.
 */
export interface RibbonGroupDefinition {
  /** Unique identifier for the group */
  id: string;
  /** ID of the tab this group belongs to */
  tabId: string;
  /** Display label for the group */
  label: string;
  /** Sort order within the tab (lower numbers appear first) */
  order: number;
  /** Component to render as group content */
  component: React.ComponentType<{ context: RibbonContext }>;
}

// =============================================================================
// EVENT HOOKS
// =============================================================================

/**
 * Callback for selection change events.
 */
export type SelectionChangeCallback = (selection: Selection | null) => void;

/**
 * Callback for cell change events.
 */
export type CellChangeCallback = (row: number, col: number, oldValue: string | null, newValue: string | null) => void;

/**
 * Callback for before-edit events. Return false to cancel the edit.
 */
export type BeforeEditCallback = (row: number, col: number) => boolean | Promise<boolean>;

/**
 * Callback for after-edit events.
 */
export type AfterEditCallback = (row: number, col: number, value: string) => void | Promise<void>;

// =============================================================================
// ADD-IN MANIFEST
// =============================================================================

/**
 * Manifest describing an add-in's contributions.
 */
export interface AddInManifest {
  /** Unique identifier for the add-in */
  id: string;
  /** Human-readable name */
  name: string;
  /** Version string */
  version: string;
  /** Optional description */
  description?: string;
  /** Commands provided by this add-in */
  commands?: Command[];
  /** Ribbon tabs provided by this add-in */
  ribbonTabs?: RibbonTabDefinition[];
  /** Ribbon groups provided by this add-in */
  ribbonGroups?: RibbonGroupDefinition[];
  /** IDs of add-ins this one depends on */
  dependencies?: string[];
}
