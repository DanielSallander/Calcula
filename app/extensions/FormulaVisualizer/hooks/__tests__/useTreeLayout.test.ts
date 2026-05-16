//! FILENAME: app/extensions/FormulaVisualizer/hooks/__tests__/useTreeLayout.test.ts
// PURPOSE: Tests for the Sugiyama-style tree layout algorithm.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({}));

import { computeTreeLayout as useTreeLayout } from "../../lib/treeLayoutEngine";
import type { EvalPlanNode } from "@api";
import {
  NODE_MIN_WIDTH,
  NODE_HEIGHT,
  TREE_PADDING,
  VERTICAL_GAP,
} from "../../constants";

// ============================================================================
// Test Helpers
// ============================================================================

function makeNode(overrides: Partial<EvalPlanNode> & { id: string }): EvalPlanNode {
  return {
    label: "X",
    nodeType: "literal",
    subtitle: "",
    value: "0",
    rawValue: null,
    children: [],
    sourceStart: 0,
    sourceEnd: 1,
    stepNumber: undefined,
    ...overrides,
  } as EvalPlanNode;
}

// ============================================================================
// useTreeLayout
// ============================================================================

describe("useTreeLayout", () => {
  it("returns empty layout for empty nodes", () => {
    const { layoutNodes, svgWidth, svgHeight } = useTreeLayout([], "root");
    expect(layoutNodes).toEqual([]);
    expect(svgWidth).toBe(0);
    expect(svgHeight).toBe(0);
  });

  it("lays out a single root node", () => {
    const nodes = [makeNode({ id: "root", label: "SUM" })];
    const { layoutNodes, svgWidth, svgHeight } = useTreeLayout(nodes, "root");

    expect(layoutNodes).toHaveLength(1);
    expect(layoutNodes[0].x).toBe(TREE_PADDING);
    expect(layoutNodes[0].y).toBe(TREE_PADDING);
    expect(layoutNodes[0].height).toBe(NODE_HEIGHT);
    expect(layoutNodes[0].layer).toBe(0);
    expect(layoutNodes[0].state).toBe("pending");
    expect(svgHeight).toBeGreaterThan(0);
  });

  it("places children on a deeper layer than the parent", () => {
    const nodes = [
      makeNode({ id: "root", label: "+", children: ["a", "b"] }),
      makeNode({ id: "a", label: "A1" }),
      makeNode({ id: "b", label: "A2" }),
    ];
    const { layoutNodes } = useTreeLayout(nodes, "root");

    const root = layoutNodes.find((n) => n.id === "root")!;
    const childA = layoutNodes.find((n) => n.id === "a")!;
    const childB = layoutNodes.find((n) => n.id === "b")!;

    expect(root.layer).toBe(0);
    expect(childA.layer).toBe(1);
    expect(childB.layer).toBe(1);
    expect(root.y).toBe(TREE_PADDING);
    expect(childA.y).toBe(TREE_PADDING + NODE_HEIGHT + VERTICAL_GAP);
  });

  it("centers parent over children horizontally", () => {
    const nodes = [
      makeNode({ id: "root", label: "+", children: ["a", "b"] }),
      makeNode({ id: "a", label: "A1", sourceStart: 0 }),
      makeNode({ id: "b", label: "A2", sourceStart: 5 }),
    ];
    const { layoutNodes } = useTreeLayout(nodes, "root");

    const root = layoutNodes.find((n) => n.id === "root")!;
    const childA = layoutNodes.find((n) => n.id === "a")!;
    const childB = layoutNodes.find((n) => n.id === "b")!;

    // Parent should be centered between the two children
    const childACenterX = childA.x + childA.width / 2;
    const childBCenterX = childB.x + childB.width / 2;
    const expectedCenter = (childACenterX + childBCenterX) / 2;
    const rootCenterX = root.x + root.width / 2;

    expect(rootCenterX).toBeCloseTo(expectedCenter, 0);
  });

  it("resolves overlapping nodes within a layer", () => {
    // Three children should not overlap
    const nodes = [
      makeNode({ id: "root", label: "F", children: ["a", "b", "c"] }),
      makeNode({ id: "a", label: "X", sourceStart: 0 }),
      makeNode({ id: "b", label: "Y", sourceStart: 3 }),
      makeNode({ id: "c", label: "Z", sourceStart: 6 }),
    ];
    const { layoutNodes } = useTreeLayout(nodes, "root");

    const children = layoutNodes
      .filter((n) => n.id !== "root")
      .sort((a, b) => a.x - b.x);

    for (let i = 1; i < children.length; i++) {
      const prevRight = children[i - 1].x + children[i - 1].width;
      expect(children[i].x).toBeGreaterThanOrEqual(prevRight);
    }
  });

  it("computes svgWidth at least 680", () => {
    const nodes = [makeNode({ id: "root", label: "X" })];
    const { svgWidth } = useTreeLayout(nodes, "root");
    expect(svgWidth).toBeGreaterThanOrEqual(680);
  });

  it("estimates wider width for long labels", () => {
    const shortNode = makeNode({ id: "s", label: "X" });
    const longNode = makeNode({ id: "l", label: "VERY_LONG_FUNCTION_NAME_HERE" });

    const { layoutNodes: shortLayout } = useTreeLayout([shortNode], "s");
    const { layoutNodes: longLayout } = useTreeLayout([longNode], "l");

    expect(longLayout[0].width).toBeGreaterThan(shortLayout[0].width);
  });
});
