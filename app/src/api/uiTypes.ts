//! FILENAME: app/src/api/uiTypes.ts
// PURPOSE: Canonical type definitions for UI extension contracts.
// CONTEXT: These interfaces define the API contract between Core registries
// and Extensions. Both sides import from here, ensuring a single source of truth.
// Previously these types lived in core/extensions/ and were re-exported by api/.

import React from "react";

// ============================================================================
// Task Pane Types
// ============================================================================

/**
 * Context keys for conditional pane visibility.
 * Panes can specify which contexts they should appear in.
 */
export type TaskPaneContextKey =
  | "pivot"           // Selection is within a pivot table
  | "chart"           // Selection is within a chart
  | "comment"         // Cell has a comment
  | "formatting"      // Formatting pane requested
  | "properties"      // Generic properties pane
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
  /** The React component to render */
  component: React.ComponentType<DialogProps>;
  /** Priority for z-index ordering (higher = on top) */
  priority?: number;
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
