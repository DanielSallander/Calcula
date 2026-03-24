//! FILENAME: app/extensions/FormulaVisualizer/components/PlanLegend.tsx
// PURPOSE: Color legend for the execution plan tree.

import React from "react";
import { BADGE_COLORS, STATE_COLORS } from "../constants";

const v = (name: string) => `var(${name})`;

const legendStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  padding: "6px 12px",
  fontSize: 11,
  color: v("--text-secondary"),
  borderTop: `1px solid ${v("--border-default")}`,
  flexWrap: "wrap",
  alignItems: "center",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

function Swatch({ color, border }: { color: string; border?: string }): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: 3,
        background: color,
        border: border ? `1.5px solid ${border}` : "none",
      }}
    />
  );
}

export function PlanLegend(): React.ReactElement {
  return (
    <div style={legendStyle}>
      <span style={{ fontWeight: 600, marginRight: 4 }}>Type:</span>
      <span style={itemStyle}>
        <Swatch color={BADGE_COLORS.function.bg} /> Function
      </span>
      <span style={itemStyle}>
        <Swatch color={BADGE_COLORS.operator.bg} /> Operator
      </span>
      <span style={itemStyle}>
        <Swatch color={BADGE_COLORS.literal.bg} /> Constant
      </span>
      <span style={itemStyle}>
        <Swatch color={BADGE_COLORS.cell_ref.bg} /> Reference
      </span>

      <span style={{ width: 1, height: 14, background: v("--border-default"), margin: "0 4px" }} />

      <span style={{ fontWeight: 600, marginRight: 4 }}>State:</span>
      <span style={itemStyle}>
        <Swatch color={STATE_COLORS.pending.fill} border={STATE_COLORS.pending.stroke} /> Pending
      </span>
      <span style={itemStyle}>
        <Swatch color={STATE_COLORS.active.fill} border={STATE_COLORS.active.stroke} /> Active
      </span>
      <span style={itemStyle}>
        <Swatch color={STATE_COLORS.done.fill} border={STATE_COLORS.done.stroke} /> Done
      </span>
    </div>
  );
}
