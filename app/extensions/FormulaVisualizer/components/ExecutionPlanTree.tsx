//! FILENAME: app/extensions/FormulaVisualizer/components/ExecutionPlanTree.tsx
// PURPOSE: SVG tree renderer for the execution plan - nodes, edges, and animations.

import React, { useMemo } from "react";
import type { EvalPlanNode, FormulaEvalPlan } from "../../../src/api";
import type { LayoutNode, NodeVisualState, PlanEdgeData } from "../types";
import { useTreeLayout } from "../hooks/useTreeLayout";
import { PlanNode } from "./PlanNode";
import { PlanEdge } from "./PlanEdge";

const v = (name: string) => `var(${name})`;

interface ExecutionPlanTreeProps {
  plan: FormulaEvalPlan;
  currentStep: number;
  isComplete: boolean;
  hoveredNodeId: string | null;
  onHoverNode: (id: string | null) => void;
  showValues: boolean;
  showRefs: boolean;
  zoom: number;
}

export function ExecutionPlanTree({
  plan,
  currentStep,
  isComplete,
  hoveredNodeId,
  onHoverNode,
  showValues,
  showRefs,
  zoom,
}: ExecutionPlanTreeProps): React.ReactElement {
  const { layoutNodes, svgWidth, svgHeight } = useTreeLayout(plan.nodes, plan.rootId);

  // Build node map for quick lookup
  const nodeMap = useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const n of layoutNodes) map.set(n.id, n);
    return map;
  }, [layoutNodes]);

  // Compute visual states based on current step
  const nodeStates = useMemo(() => {
    const states = new Map<string, NodeVisualState>();
    // Build a map from node_id -> step index where it was evaluated
    const evalStepMap = new Map<string, number>();
    for (let i = 0; i < plan.steps.length; i++) {
      evalStepMap.set(plan.steps[i].nodeId, i);
    }

    for (const node of plan.nodes) {
      const stepIdx = evalStepMap.get(node.id);
      if (stepIdx === undefined) {
        // Node was never individually evaluated (e.g., range consumed by parent)
        states.set(node.id, "pending");
      } else if (isComplete && stepIdx <= currentStep) {
        // When playback is complete, all evaluated nodes (including the last) are done
        states.set(node.id, "done");
      } else if (stepIdx < currentStep) {
        states.set(node.id, "done");
      } else if (stepIdx === currentStep) {
        states.set(node.id, "active");
      } else {
        states.set(node.id, "pending");
      }
    }
    return states;
  }, [plan, currentStep, isComplete]);

  // Build edges
  const edges = useMemo(() => {
    const result: PlanEdgeData[] = [];
    for (const node of layoutNodes) {
      for (const childId of node.children) {
        const child = nodeMap.get(childId);
        if (!child) continue;
        result.push({
          fromId: childId,
          toId: node.id,
          fromX: child.x,
          fromY: child.y,
          fromWidth: child.width,
          fromHeight: child.height,
          toX: node.x,
          toY: node.y,
          toWidth: node.width,
          toHeight: node.height,
        });
      }
    }
    return result;
  }, [layoutNodes, nodeMap]);

  // Track which nodes just completed this step (for particle animation)
  const justCompletedIds = useMemo(() => {
    if (currentStep < 0 || currentStep >= plan.steps.length) return new Set<string>();
    return new Set([plan.steps[currentStep].nodeId]);
  }, [plan.steps, currentStep]);

  const scale = zoom / 100;

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        background: v("--grid-bg"),
        borderRadius: 4,
        border: `1px solid ${v("--border-default")}`,
        minHeight: 200,
      }}
    >
      <div
        style={{
          transformOrigin: "0 0",
          transform: `scale(${scale})`,
          width: svgWidth,
          height: svgHeight,
        }}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          style={{ display: "block" }}
        >
          {/* Edges first (below nodes) */}
          {edges.map((edge) => {
            const childState = nodeStates.get(edge.fromId) ?? "pending";
            return (
              <PlanEdge
                key={`${edge.fromId}-${edge.toId}`}
                edge={edge}
                isChildDone={childState === "done" || childState === "active"}
                justCompleted={justCompletedIds.has(edge.fromId)}
              />
            );
          })}

          {/* Nodes on top */}
          {layoutNodes.map((node) => (
            <PlanNode
              key={node.id}
              node={node}
              state={nodeStates.get(node.id) ?? "pending"}
              isHovered={hoveredNodeId === node.id}
              onMouseEnter={(id) => onHoverNode(id)}
              onMouseLeave={() => onHoverNode(null)}
              showValues={showValues}
              showRefs={showRefs}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
