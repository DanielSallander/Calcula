//! FILENAME: app/extensions/FormulaVisualizer/utils/__tests__/exportPlan.test.ts
// PURPOSE: Tests for YAML export of formula evaluation plans.

import { describe, it, expect } from "vitest";

vi.mock("@api", () => ({}));

import { vi } from "vitest";
import { formatPlanAsYaml } from "../exportPlan";

// ============================================================================
// Test Helpers
// ============================================================================

function makeNode(overrides: Record<string, any> = {}) {
  return {
    id: "n1",
    label: "SUM",
    nodeType: "function",
    subtitle: "A1:A3",
    value: "6",
    rawValue: null as string | null,
    children: [] as string[],
    sourceStart: 0,
    sourceEnd: 10,
    stepNumber: undefined as number | undefined,
    ...overrides,
  };
}

// ============================================================================
// formatPlanAsYaml
// ============================================================================

describe("formatPlanAsYaml", () => {
  it("formats a simple single-node plan", () => {
    const plan = {
      formulaText: "=SUM(A1:A3)",
      rootId: "n1",
      nodes: [makeNode()],
      steps: [
        { nodeId: "n1", description: "Evaluate SUM of A1:A3" },
      ],
    };

    const yaml = formatPlanAsYaml(plan as any);

    expect(yaml).toContain('formula: "=SUM(A1:A3)"');
    expect(yaml).toContain("total_steps: 1");
    expect(yaml).toContain("operation: SUM");
    expect(yaml).toContain("type: function");
    expect(yaml).toContain('arguments: "A1:A3"');
    expect(yaml).toContain("result: 6");
    expect(yaml).toContain("expression_tree:");
  });

  it("includes rawValue when present", () => {
    const plan = {
      formulaText: "=A1",
      rootId: "n1",
      nodes: [makeNode({ label: "A1", nodeType: "cell_ref", subtitle: "", value: "42", rawValue: "42.0" })],
      steps: [{ nodeId: "n1", description: "Read A1" }],
    };

    const yaml = formatPlanAsYaml(plan as any);
    expect(yaml).toContain("raw_value: 42.0");
  });

  it("renders nested tree structure", () => {
    const plan = {
      formulaText: "=A1+A2",
      rootId: "root",
      nodes: [
        makeNode({ id: "root", label: "+", nodeType: "operator", subtitle: "", value: "3", children: ["left", "right"] }),
        makeNode({ id: "left", label: "A1", nodeType: "cell_ref", subtitle: "", value: "1", children: [] }),
        makeNode({ id: "right", label: "A2", nodeType: "cell_ref", subtitle: "", value: "2", children: [] }),
      ],
      steps: [
        { nodeId: "left", description: "Read A1" },
        { nodeId: "right", description: "Read A2" },
        { nodeId: "root", description: "Add" },
      ],
    };

    const yaml = formatPlanAsYaml(plan as any);

    expect(yaml).toContain("total_steps: 3");
    expect(yaml).toContain("- +:");
    expect(yaml).toContain("children:");
    expect(yaml).toContain("- A1:");
    expect(yaml).toContain("- A2:");
  });

  it("skips steps with missing nodes", () => {
    const plan = {
      formulaText: "=X",
      rootId: "n1",
      nodes: [makeNode()],
      steps: [
        { nodeId: "missing", description: "Ghost step" },
        { nodeId: "n1", description: "Real step" },
      ],
    };

    const yaml = formatPlanAsYaml(plan as any);

    // Should only have step 2 (the one with a valid nodeId)
    expect(yaml).toContain("step: 2");
    expect(yaml).not.toContain("Ghost step");
    expect(yaml).toContain("Real step");
  });

  it("handles empty steps", () => {
    const plan = {
      formulaText: "=1",
      rootId: "n1",
      nodes: [makeNode({ label: "1", nodeType: "literal", subtitle: "", value: "1" })],
      steps: [],
    };

    const yaml = formatPlanAsYaml(plan as any);
    expect(yaml).toContain("total_steps: 0");
  });

  it("includes step number in tree when present", () => {
    const plan = {
      formulaText: "=SUM(1,2)",
      rootId: "n1",
      nodes: [makeNode({ stepNumber: 3 })],
      steps: [],
    };

    const yaml = formatPlanAsYaml(plan as any);
    expect(yaml).toContain("(#3)");
  });
});
