//! FILENAME: app/extensions/FormulaVisualizer/constants.ts
// PURPOSE: Visual configuration constants for the FormulaVisualizer.

/** Node dimensions. */
export const NODE_MIN_WIDTH = 160;
export const NODE_HEIGHT = 56;
export const NODE_PADDING_X = 12;
export const NODE_PADDING_Y = 8;
export const NODE_BORDER_RADIUS = 8;

/** Tree layout spacing. */
export const HORIZONTAL_GAP = 40;
export const VERTICAL_GAP = 80;
export const TREE_PADDING = 20;

/** Speed levels: delay in ms between steps (index 0-4). */
export const SPEED_LEVELS = [2000, 1200, 800, 500, 300];
export const DEFAULT_SPEED_INDEX = 2;

/** Animation durations in ms. */
export const HIGHLIGHT_DURATION = 200;
export const PARTICLE_DURATION = 400;
export const FADE_DURATION = 150;

/** Node state colors. */
export const STATE_COLORS = {
  pending: {
    fill: "#f9fafb",     // Gray 50
    stroke: "#9ca3af",   // Gray 400
    text: "#4b5563",     // Gray 600
  },
  active: {
    fill: "#7c3aed",     // Purple 600
    stroke: "#4c1d95",   // Purple 900
    text: "#ffffff",     // White
  },
  done: {
    fill: "#f0fdf4",     // Green 50
    stroke: "#16a34a",   // Green 600
    text: "#166534",     // Green 800
  },
  error: {
    fill: "#fef2f2",     // Red 50
    stroke: "#dc2626",   // Red 600
    text: "#991b1b",     // Red 800
  },
} as const;

/** Node type badge colors. */
export const BADGE_COLORS = {
  function: { bg: "#7c3aed", text: "#ffffff" }, // Purple
  operator: { bg: "#0d9488", text: "#ffffff" }, // Teal
  literal:  { bg: "#f97316", text: "#ffffff" }, // Orange
  cell_ref: { bg: "#2563eb", text: "#ffffff" }, // Blue
  range:    { bg: "#2563eb", text: "#ffffff" }, // Blue
  unary:    { bg: "#0d9488", text: "#ffffff" }, // Teal
} as const;

/** Badge labels. */
export const BADGE_LABELS: Record<string, string> = {
  function: "fn",
  operator: "op",
  literal: "val",
  cell_ref: "ref",
  range: "rng",
  unary: "op",
};

/** Edge colors. */
export const EDGE_DEFAULT_COLOR = "#9ca3af";
export const EDGE_ACTIVE_COLOR = "#16a34a";
export const EDGE_DEFAULT_WIDTH = 1.5;
export const EDGE_ACTIVE_WIDTH = 2;
export const PARTICLE_RADIUS = 4;
