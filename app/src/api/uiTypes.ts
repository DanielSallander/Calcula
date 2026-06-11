//! FILENAME: app/src/api/uiTypes.ts
// PURPOSE: Canonical type definitions for UI extension contracts.
// CONTEXT: These interfaces define the API contract between Core registries
// and Extensions. Both sides import from here, ensuring a single source of truth.

import React from "react";

// ============================================================================
// Menu Types
// ============================================================================

/**
 * Definition of a menu item.
 */
export interface MenuItemDefinition {
  /** Unique identifier for this menu item */
  id: string;
  /** Display label */
  label: string;
  /** The preferred way: execute a registered command */
  commandId?: string;
  /** Legacy/Simple way: direct callback */
  action?: () => void;
  /** Optional icon (SVG element or string) */
  icon?: React.ReactNode;
  /** Whether the item is disabled */
  disabled?: boolean;
  /** Whether the item is checked (for toggle items) */
  checked?: boolean;
  /** Whether this is a separator */
  separator?: boolean;
  /** Keyboard shortcut hint (e.g., "Ctrl+S") */
  shortcut?: string;
  /** Whether the item is hidden */
  hidden?: boolean;
  /** Sub-menu items (renders a flyout submenu on hover) */
  children?: MenuItemDefinition[];
  /** Custom content to render as the flyout submenu instead of children.
   *  Receives an onClose callback to close the entire menu when done. */
  customContent?: (onClose: () => void) => React.ReactNode;
  /** Optional clickable action icon rendered on the right side of the item. */
  rightAction?: {
    icon: React.ReactNode;
    onClick: () => void;
    title?: string;
  };
  /** Order for positioning within the menu (lower = higher up) */
  order?: number;
  /** Priority for ordering (higher = shown first) */
  priority?: number;
}

/**
 * Definition of a top-level menu.
 */
export interface MenuDefinition {
  /** Unique identifier for this menu */
  id: string;
  /** Display label */
  label: string;
  /** Order for positioning (lower = further left) */
  order: number;
  /** Menu items */
  items: MenuItemDefinition[];
  /** Whether the entire menu is hidden (used for contextual menus) */
  hidden?: boolean;
}

// ============================================================================
// Task Pane Types
// ============================================================================

/**
 * Context keys for conditional pane visibility.
 * Panes can specify which contexts they should appear in.
 */
export type TaskPaneContextKey =
  | "pivot"           // Selection is within a pivot table
  | "table"           // Selection is within a table
  | "chart"           // Selection is within a chart
  | "comment"         // Cell has a comment
  | "formatting"      // Formatting pane requested
  | "properties"      // Generic properties pane
  | "bi"              // BI (Business Intelligence) pane
  | "collection"      // Cell contains a List or Dict (3D cell)
  | "file-viewer"     // Virtual file viewer requested
  | "connections"     // BI Connections pane
  | "slicer"          // Slicer selected
  | "timeline-slicer" // Timeline slicer selected
  | "always";         // Always available

/**
 * Definition of a Task Pane view that can be registered.
 */
export interface TaskPaneViewDefinition {
  /** Unique identifier for this pane view */
  id: string;
  /** Display title shown in the tab/header */
  title: string;
  /** Icon to display (React element or string) */
  icon?: React.ReactNode;
  /** The component to render as pane content */
  component: React.ComponentType<TaskPaneViewProps>;
  /** Context keys that trigger this pane to become available */
  contextKeys: TaskPaneContextKey[];
  /** Priority for ordering (higher = shown first in tabs) */
  priority?: number;
  /** Whether this pane can be closed by the user */
  closable?: boolean;
}

/**
 * Props passed to Task Pane view components.
 */
export interface TaskPaneViewProps {
  /** Callback to close this pane */
  onClose?: () => void;
  /** Callback when the pane updates its content (e.g., pivot fields changed) */
  onUpdate?: () => void;
  /** Any additional data passed to the pane */
  data?: Record<string, unknown>;
}

// ============================================================================
// Dialog Types
// ============================================================================

/**
 * Props passed to dialog components.
 */
export interface DialogProps {
  /** Whether the dialog is currently open */
  isOpen: boolean;
  /** Callback to close the dialog */
  onClose: () => void;
  /** Additional data passed when opening the dialog */
  data?: Record<string, unknown>;
}

/**
 * Definition of a dialog that can be registered.
 */
export interface DialogDefinition {
  /** Unique identifier for the dialog */
  id: string;
  /** Optional title for the dialog */
  title?: string;
  /** The React component to render */
  component: React.ComponentType<DialogProps>;
  /** Priority for z-index ordering (higher = on top) */
  priority?: number;
  /** Optional default width in px */
  width?: number;
  /** Optional default height in px */
  height?: number;
}

// ============================================================================
// Overlay Types
// ============================================================================

/**
 * Anchor rectangle for positioning overlays.
 */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Props passed to overlay components.
 */
export interface OverlayProps {
  /** Callback to close the overlay */
  onClose: () => void;
  /** Additional data passed when showing the overlay */
  data?: Record<string, unknown>;
  /** Anchor position for the overlay */
  anchorRect?: AnchorRect;
}

/**
 * Overlay layer for z-index ordering.
 */
export type OverlayLayer = "dropdown" | "popover" | "modal" | "tooltip";

/**
 * Definition of an overlay that can be registered.
 */
export interface OverlayDefinition {
  /** Unique identifier for the overlay */
  id: string;
  /** The React component to render */
  component: React.ComponentType<OverlayProps>;
  /** Z-index layer */
  layer?: OverlayLayer;
}

// ============================================================================
// Status Bar Types
// ============================================================================

/**
 * Alignment zone for status bar items.
 */
export type StatusBarAlignment = "left" | "right";

/**
 * Definition of a status bar item that can be registered by extensions.
 */
export interface StatusBarItemDefinition {
  /** Unique identifier for this status bar item */
  id: string;
  /** The React component to render in the status bar */
  component: React.ComponentType;
  /** Which side of the status bar to render on */
  alignment: StatusBarAlignment;
  /** Priority for ordering (higher = rendered first within its alignment zone) */
  priority?: number;
}

// ============================================================================
// Activity Bar Types
// ============================================================================

/**
 * Props passed to Activity View components rendered in the Side Panel.
 */
export interface ActivityViewProps {
  /** Callback to close this view */
  onClose?: () => void;
  /** Any additional data passed to the view */
  data?: Record<string, unknown>;
  /** Current placement when hosted by the panel system ("sidebar" or "ribbon"). */
  placement?: PanelPlacement;
}

/**
 * Definition of an Activity View that can be registered by extensions.
 */
export interface ActivityViewDefinition {
  /** Unique identifier (e.g., "explorer", "search", "extensions") */
  id: string;
  /** Display title shown in tooltip and panel header */
  title: string;
  /** SVG icon as React element for the Activity Bar icon */
  icon: React.ReactNode;
  /** The component to render in the Side Panel */
  component: React.ComponentType<ActivityViewProps>;
  /** Sort priority (higher = closer to top of Activity Bar). Default: 0 */
  priority?: number;
  /** Whether the view appears in the bottom section of the Activity Bar (like VS Code's settings gear) */
  bottom?: boolean;
  /** If true, the view is registered but not shown in the Activity Bar icon strip.
   *  It can still be opened programmatically (e.g., from a menu item). */
  hidden?: boolean;
}

// ============================================================================
// Panel Types (Location-Agnostic Extension Panels)
// ============================================================================

/**
 * Allowed placement locations for a panel.
 * - "sidebar": Left activity bar + side panel (vertical layout)
 * - "ribbon": Top ribbon tab area (horizontal layout, 92px tall)
 */
export type PanelPlacement = "sidebar" | "ribbon";

/**
 * Props passed to panel section components.
 * Each section receives its current placement so it can adapt its layout.
 */
export interface PanelSectionProps {
  /** Current placement — "ribbon" means horizontal 92px, "sidebar" means vertical full-height */
  placement: PanelPlacement;
}

/**
 * A named section within a panel.
 * Sections are the universal building block: the Shell renders them
 * horizontally in the ribbon or vertically (collapsible) in the sidebar.
 */
export interface PanelSection {
  /** Unique section identifier within the panel */
  id: string;
  /** Display label (shown as group label in ribbon, collapsible header in sidebar) */
  label: string;
  /** Optional icon for the section */
  icon?: React.ReactNode;
  /** The component to render as section content */
  component: React.ComponentType<PanelSectionProps>;
}

/**
 * Unified panel definition that extensions register once.
 * The Shell decides where to render it based on user preference.
 * Users can move panels between sidebar and ribbon via right-click context menu.
 *
 * Content is declared as **sections** — the Shell transposes them between
 * horizontal layout (ribbon) and vertical layout (sidebar) automatically.
 */
export interface PanelDefinition {
  /** Unique panel identifier */
  id: string;
  /** Display title */
  title: string;
  /** Icon (React element) for activity bar icons and ribbon tabs */
  icon: React.ReactNode;
  /** Sections that compose this panel's content.
   *  The Shell renders them horizontally (ribbon) or vertically (sidebar).
   *  A panel with a single section renders the content directly without
   *  group labels or collapsible headers. */
  sections: PanelSection[];
  /** Where this panel appears by default before any user customization */
  defaultPlacement: PanelPlacement;
  /** Sort priority (higher = more prominent). Default: 0 */
  priority?: number;
  /** Whether the user can close this panel. Default: true */
  closable?: boolean;
  /** Whether the user can move this panel between locations. Default: true */
  movable?: boolean;
  /** Ribbon-specific: accent color for contextual tabs (e.g., "#217346") */
  ribbonColor?: string;
  /** Ribbon-specific: sort order when displayed as a ribbon tab (lower = first) */
  ribbonOrder?: number;
  /** Sidebar-specific: show in bottom section (like VS Code settings gear) */
  sidebarBottom?: boolean;
}