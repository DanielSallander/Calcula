//! FILENAME: app/extensions/FormulaVisualizer/hooks/useTreeLayout.ts
// PURPOSE: Sugiyama-style layered tree layout algorithm for the execution plan tree.

import { useMemo } from "react";
import type { EvalPlanNode } from "../../../src/api";
import type { LayoutNode } from "../types";
import {
  NODE_MIN_WIDTH,
  NODE_HEIGHT,
  HORIZONTAL_GAP,
  VERTICAL_GAP,
  TREE_PADDING,
  NODE_PADDING_X,
} from "../constants";

/** Estimate node width based on label length. */
function estimateNodeWidth(node: EvalPlanNode): number {
  const labelLen = node.label.length;
  const subtitleLen = node.subtitle.length;
  const maxTextLen = Math.max(labelLen, subtitleLen);
  // Approximate 8px per character, plus padding
  return Math.max(NODE_MIN_WIDTH, maxTextLen * 8 + NODE_PADDING_X * 2);
}

/** Compute layered tree layout. Returns positioned nodes and total SVG dimensions. */
export function useTreeLayout(
  nodes: EvalPlanNode[],
  rootId: string,
): { layoutNodes: LayoutNode[]; svgWidth: number; svgHeight: number } {
  return useMemo(() => {
    if (nodes.length === 0) {
      return { layoutNodes: [], svgWidth: 0, svgHeight: 0 };
    }

    const nodeMap = new Map<string, EvalPlanNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    // Build parent map (child -> parent)
    const parentMap = new Map<string, string>();
    for (const n of nodes) {
      for (const childId of n.children) {
        parentMap.set(childId, n.id);
      }
    }

    // Step 1: Assign layers by depth from root (BFS, root at layer 0)
    const layerMap = new Map<string, number>();
    const queue: string[] = [rootId];
    layerMap.set(rootId, 0);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = nodeMap.get(id);
      if (!node) continue;
      const currentLayer = layerMap.get(id)!;
      for (const childId of node.children) {
        if (!layerMap.has(childId)) {
          layerMap.set(childId, currentLayer + 1);
          queue.push(childId);
        }
      }
    }

    // Handle nodes not reachable from root
    for (const n of nodes) {
      if (!layerMap.has(n.id)) {
        layerMap.set(n.id, 0);
      }
    }

    // Group nodes by layer
    const layers = new Map<number, string[]>();
    let maxLayer = 0;
    for (const [id, layer] of layerMap) {
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer)!.push(id);
      maxLayer = Math.max(maxLayer, layer);
    }

    // Step 2: Order within layers by sourceStart
    for (const [, ids] of layers) {
      ids.sort((a, b) => {
        const na = nodeMap.get(a)!;
        const nb = nodeMap.get(b)!;
        return na.sourceStart - nb.sourceStart;
      });
    }

    // Step 3: Compute widths
    const widthMap = new Map<string, number>();
    for (const n of nodes) {
      widthMap.set(n.id, estimateNodeWidth(n));
    }

    // Step 4: Assign X coordinates bottom-up
    // Leaf nodes get evenly spaced positions; parents center over children
    const xMap = new Map<string, number>();

    // Process from bottom layer to top
    for (let layer = maxLayer; layer >= 0; layer--) {
      const ids = layers.get(layer) ?? [];
      if (layer === maxLayer || ids.every((id) => (nodeMap.get(id)?.children.length ?? 0) === 0)) {
        // Leaf layer or bottom: space evenly
        let x = TREE_PADDING;
        for (const id of ids) {
          xMap.set(id, x);
          x += (widthMap.get(id) ?? NODE_MIN_WIDTH) + HORIZONTAL_GAP;
        }
      } else {
        // Interior layer: center parent over children
        for (const id of ids) {
          const node = nodeMap.get(id)!;
          if (node.children.length > 0) {
            const childXs = node.children
              .filter((cid) => xMap.has(cid))
              .map((cid) => xMap.get(cid)! + (widthMap.get(cid) ?? NODE_MIN_WIDTH) / 2);
            if (childXs.length > 0) {
              const centerX = (Math.min(...childXs) + Math.max(...childXs)) / 2;
              xMap.set(id, centerX - (widthMap.get(id) ?? NODE_MIN_WIDTH) / 2);
            } else {
              xMap.set(id, TREE_PADDING);
            }
          } else {
            xMap.set(id, TREE_PADDING);
          }
        }

        // Resolve overlaps within layer
        const sortedIds = [...ids].sort((a, b) => (xMap.get(a) ?? 0) - (xMap.get(b) ?? 0));
        for (let i = 1; i < sortedIds.length; i++) {
          const prevId = sortedIds[i - 1];
          const currId = sortedIds[i];
          const prevRight = (xMap.get(prevId) ?? 0) + (widthMap.get(prevId) ?? NODE_MIN_WIDTH) + HORIZONTAL_GAP;
          const currLeft = xMap.get(currId) ?? 0;
          if (currLeft < prevRight) {
            xMap.set(currId, prevRight);
          }
        }
      }
    }

    // Step 5: Assign Y coordinates (root at top)
    const yMap = new Map<string, number>();
    for (const [id, layer] of layerMap) {
      yMap.set(id, TREE_PADDING + layer * (NODE_HEIGHT + VERTICAL_GAP));
    }

    // Step 6: Build LayoutNodes
    const layoutNodes: LayoutNode[] = nodes.map((n) => ({
      ...n,
      x: xMap.get(n.id) ?? 0,
      y: yMap.get(n.id) ?? 0,
      width: widthMap.get(n.id) ?? NODE_MIN_WIDTH,
      height: NODE_HEIGHT,
      state: "pending" as const,
      layer: layerMap.get(n.id) ?? 0,
    }));

    // Compute SVG dimensions
    let svgWidth = 0;
    let svgHeight = 0;
    for (const ln of layoutNodes) {
      svgWidth = Math.max(svgWidth, ln.x + ln.width + TREE_PADDING);
      svgHeight = Math.max(svgHeight, ln.y + ln.height + TREE_PADDING);
    }
    svgWidth = Math.max(svgWidth, 680);

    return { layoutNodes, svgWidth, svgHeight };
  }, [nodes, rootId]);
}
