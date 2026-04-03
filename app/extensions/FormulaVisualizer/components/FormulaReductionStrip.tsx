//! FILENAME: app/extensions/FormulaVisualizer/components/FormulaReductionStrip.tsx
// PURPOSE: Formula bar that shows progressive reduction with highlighted spans.

import React, { useMemo } from "react";
import type { FormulaEvalPlan, EvalPlanNode } from "@api";

const v = (name: string) => `var(${name})`;

interface FormulaReductionStripProps {
  plan: FormulaEvalPlan;
  currentStep: number;
  hoveredNodeId: string | null;
  onHoverNode: (id: string | null) => void;
}

export function FormulaReductionStrip({
  plan,
  currentStep,
  hoveredNodeId,
  onHoverNode,
}: FormulaReductionStripProps): React.ReactElement {
  // The formula text to display depends on the current step
  const displayFormula = useMemo(() => {
    if (currentStep < 0) return plan.formula;
    if (currentStep >= plan.steps.length) {
      // After all steps, show last formula_after
      return plan.steps.length > 0
        ? plan.steps[plan.steps.length - 1].formulaAfter
        : plan.formula;
    }
    // Show the formula_after of the current step
    return plan.steps[currentStep].formulaAfter;
  }, [plan, currentStep]);

  // The highlighted region in the current step
  const highlight = useMemo(() => {
    if (currentStep < 0 || currentStep >= plan.steps.length) return null;
    const step = plan.steps[currentStep];
    return { start: step.highlightStart, end: step.highlightEnd };
  }, [plan.steps, currentStep]);

  // Hover highlight: find the node's source span in the original formula
  const hoverHighlight = useMemo(() => {
    if (!hoveredNodeId || currentStep >= 0) return null;
    const node = plan.nodes.find((n) => n.id === hoveredNodeId);
    if (!node) return null;
    return { start: node.sourceStart, end: node.sourceEnd };
  }, [hoveredNodeId, plan.nodes, currentStep]);

  // Build node map for hover detection on formula fragments
  const nodeSpans = useMemo(() => {
    // Only useful before any steps have been taken (original formula)
    if (currentStep >= 0) return [];
    return plan.nodes
      .filter((n) => n.sourceStart < n.sourceEnd)
      .sort((a, b) => a.sourceStart - b.sourceStart);
  }, [plan.nodes, currentStep]);

  // Step description
  const stepDescription = useMemo(() => {
    if (currentStep < 0) return "Ready";
    if (currentStep >= plan.steps.length) {
      return `Complete! Result: ${plan.result}`;
    }
    return `Step ${currentStep + 1}/${plan.steps.length}: ${plan.steps[currentStep].description}`;
  }, [plan, currentStep]);

  // Render formula with highlights
  const renderedFormula = useMemo(() => {
    const text = displayFormula;
    const hl = highlight || hoverHighlight;
    if (!hl || hl.start >= hl.end || hl.start >= text.length) {
      return <span>{text}</span>;
    }

    const before = text.slice(0, hl.start);
    const highlighted = text.slice(hl.start, Math.min(hl.end, text.length));
    const after = text.slice(Math.min(hl.end, text.length));

    const hlStyle: React.CSSProperties = highlight
      ? {
          background: "#7c3aed",
          color: "#ffffff",
          borderRadius: 2,
          padding: "0 2px",
          transition: "background 0.2s, color 0.2s",
        }
      : {
          background: "rgba(99, 102, 241, 0.15)",
          borderRadius: 2,
          padding: "0 2px",
          transition: "background 0.2s",
        };

    return (
      <>
        <span>{before}</span>
        <span style={hlStyle}>{highlighted}</span>
        <span>{after}</span>
      </>
    );
  }, [displayFormula, highlight, hoverHighlight]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* Formula display */}
      <div
        style={{
          background: v("--grid-bg"),
          border: `1px solid ${v("--border-default")}`,
          borderRadius: 4,
          padding: "8px 12px",
          fontFamily: "Consolas, 'Courier New', monospace",
          fontSize: 14,
          lineHeight: 1.6,
          minHeight: 36,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          overflowY: "auto",
          maxHeight: 80,
        }}
      >
        <span style={{ color: v("--text-secondary"), marginRight: 2 }}>=</span>
        {renderedFormula}
      </div>

      {/* Step description */}
      <div
        style={{
          fontSize: 11,
          color: v("--text-secondary"),
          fontStyle: "italic",
          paddingLeft: 2,
        }}
      >
        {stepDescription}
      </div>
    </div>
  );
}
