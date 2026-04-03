//! FILENAME: app/extensions/FormulaVisualizer/types.ts
// PURPOSE: Local types for the FormulaVisualizer extension.

import type { EvalPlanNode } from "@api";

/** A node with computed layout position and visual state. */
export interface LayoutNode extends EvalPlanNode {
  x: number;
  y: number;
  width: number;
  height: number;
  state: NodeVisualState;
  layer: number;
}

/** Visual states for tree nodes. */
export type NodeVisualState = "pending" | "active" | "done";

/** Playback state machine states. */
export type PlaybackStatus = "idle" | "playing" | "paused" | "complete";

/** Edge between two nodes. */
export interface PlanEdgeData {
  fromId: string;
  toId: string;
  fromX: number;
  fromY: number;
  fromWidth: number;
  fromHeight: number;
  toX: number;
  toY: number;
  toWidth: number;
  toHeight: number;
}
