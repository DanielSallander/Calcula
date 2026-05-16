//! FILENAME: app/extensions/FormulaVisualizer/hooks/useTreeLayout.ts
// PURPOSE: Sugiyama-style layered tree layout algorithm for the execution plan tree.
// CONTEXT: Delegates to the pure computeTreeLayout engine; wraps result in useMemo.

import { useMemo } from "react";
import type { EvalPlanNode } from "@api";
import type { LayoutNode } from "../types";
import { computeTreeLayout } from "../lib/treeLayoutEngine";

/** Compute layered tree layout. Returns positioned nodes and total SVG dimensions. */
export function useTreeLayout(
  nodes: EvalPlanNode[],
  rootId: string,
): { layoutNodes: LayoutNode[]; svgWidth: number; svgHeight: number } {
  return useMemo(() => computeTreeLayout(nodes, rootId), [nodes, rootId]);
}
