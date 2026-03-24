//! FILENAME: app/extensions/FormulaVisualizer/components/PlanNode.tsx
// PURPOSE: Single node in the execution plan tree (SVG rendered).

import React from "react";
import type { LayoutNode, NodeVisualState } from "../types";
import {
  NODE_BORDER_RADIUS,
  STATE_COLORS,
  BADGE_COLORS,
  BADGE_LABELS,
} from "../constants";

interface PlanNodeProps {
  node: LayoutNode;
  state: NodeVisualState;
  isHovered: boolean;
  onMouseEnter: (id: string) => void;
  onMouseLeave: () => void;
  showValues: boolean;
  showRefs: boolean;
}

export function PlanNode({
  node,
  state,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  showValues,
  showRefs,
}: PlanNodeProps): React.ReactElement {
  const isError = node.value.startsWith("#");
  const colors = isError && state === "done" ? STATE_COLORS.error : STATE_COLORS[state];
  const badge = BADGE_COLORS[node.nodeType as keyof typeof BADGE_COLORS] ?? BADGE_COLORS.literal;
  const badgeLabel = BADGE_LABELS[node.nodeType] ?? "?";

  const hoverScale = isHovered ? "scale(1.02)" : "scale(1)";

  // Pick subtitle variant based on toggle combination
  let displaySubtitle: string;
  if (showValues && showRefs) {
    displaySubtitle = node.subtitle;           // "452 (#2) + 452 (E2)"
  } else if (!showValues && showRefs) {
    displaySubtitle = node.subtitleCompact;    // "#2 + E2"
  } else if (showValues && !showRefs) {
    displaySubtitle = node.subtitleValuesOnly; // "452 + 452"
  } else {
    displaySubtitle = node.subtitleBare;       // original arg summary
  }

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      style={{ cursor: "pointer", transition: "transform 0.15s ease" }}
      onMouseEnter={() => onMouseEnter(node.id)}
      onMouseLeave={onMouseLeave}
    >
      {/* Node background */}
      <rect
        width={node.width}
        height={node.height}
        rx={NODE_BORDER_RADIUS}
        ry={NODE_BORDER_RADIUS}
        fill={colors.fill}
        stroke={isHovered ? "#6366f1" : colors.stroke}
        strokeWidth={isHovered ? 2.5 : 1.5}
        style={{
          transition: "fill 0.2s, stroke 0.2s, stroke-width 0.15s",
          transform: hoverScale,
          transformOrigin: `${node.width / 2}px ${node.height / 2}px`,
        }}
      />

      {/* Badge (top-right corner) */}
      <rect
        x={node.width - 30}
        y={4}
        width={26}
        height={16}
        rx={8}
        fill={badge.bg}
        opacity={0.9}
      />
      <text
        x={node.width - 17}
        y={15}
        textAnchor="middle"
        fill={badge.text}
        fontSize={9}
        fontWeight={600}
        fontFamily="'Segoe UI', system-ui, sans-serif"
      >
        {badgeLabel}
      </text>

      {/* Step number indicator (top-left) */}
      {node.stepNumber != null && (
        <>
          <rect
            x={4}
            y={4}
            width={22}
            height={16}
            rx={8}
            fill={state === "done" ? "#166534" : state === "active" ? "rgba(255,255,255,0.3)" : "#6b7280"}
            opacity={0.85}
          />
          <text
            x={15}
            y={15}
            textAnchor="middle"
            fill="#fff"
            fontSize={9}
            fontWeight={700}
            fontFamily="'Segoe UI', system-ui, sans-serif"
          >
            #{node.stepNumber}
          </text>
        </>
      )}

      {/* Label (function name or operator) */}
      <text
        x={node.stepNumber != null ? 30 : 8}
        y={18}
        fill={colors.text}
        fontSize={13}
        fontWeight={700}
        fontFamily="'Segoe UI', system-ui, sans-serif"
        style={{ transition: "fill 0.2s" }}
      >
        {truncate(node.label, node.stepNumber != null ? 14 : 18)}
      </text>

      {/* Subtitle (arguments) - only when value not shown or always */}
      <text
        x={8}
        y={32}
        fill={state === "active" ? "rgba(255,255,255,0.7)" : "#9ca3af"}
        fontSize={10}
        fontFamily="'Segoe UI', system-ui, sans-serif"
        style={{ transition: "fill 0.2s" }}
      >
        {truncate(displaySubtitle, 28)}
      </text>

      {/* Value (shown when done) */}
      {state === "done" && node.value && (
        <text
          x={8}
          y={48}
          fill={isError ? STATE_COLORS.error.text : "#166534"}
          fontSize={12}
          fontWeight={600}
          fontFamily="Consolas, 'Courier New', monospace"
          style={{ transition: "opacity 0.15s", opacity: 1 }}
        >
          = {truncate(node.value, 18)}
        </text>
      )}

      {/* Cost bar (thin line at bottom) */}
      {node.costPct > 0 && (
        <rect
          x={0}
          y={node.height - 3}
          width={Math.max(4, (node.costPct / 100) * node.width)}
          height={3}
          rx={1.5}
          fill={node.costPct > 50 ? "#ef4444" : node.costPct > 20 ? "#f59e0b" : "#10b981"}
          opacity={0.6}
        />
      )}
    </g>
  );
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}
