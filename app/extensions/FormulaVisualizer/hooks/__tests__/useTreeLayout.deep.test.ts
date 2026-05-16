//! FILENAME: app/extensions/FormulaVisualizer/hooks/__tests__/computeTreeLayout.deep.test.ts
// PURPOSE: Deep tests for tree layout: deep trees, wide trees, DAGs, unbalanced, single-path.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({}));

import { computeTreeLayout } from "../../lib/treeLayoutEngine";
import type { EvalPlanNode } from "@api";
import {
  NODE_MIN_WIDTH,
  NODE_HEIGHT,
  HORIZONTAL_GAP,
  VERTICAL_GAP,
  TREE_PADDING,
  NODE_PADDING_X,
} from "../../constants";

// ============================================================================
// Helpers
// ============================================================================

function makeNode(overrides: Partial<EvalPlanNode> & { id: string }): EvalPlanNode {
  return {
    label: overrides.id,
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

/** Build a linear chain: root -> n1 -> n2 -> ... -> nN */
function buildChain(depth: number): EvalPlanNode[] {
  const nodes: EvalPlanNode[] = [];
  for (let i = 0; i < depth; i++) {
    const id = i === 0 ? "root" : `n${i}`;
    const childId = i < depth - 1 ? (i + 1 === 1 ? "n1" : `n${i + 1}`) : undefined;
    nodes.push(
      makeNode({
        id,
        label: `L${i}`,
        children: childId ? [childId] : [],
        sourceStart: i,
      }),
    );
  }
  return nodes;
}

/** Build a wide tree: root with N leaf children */
function buildWideTree(childCount: number): EvalPlanNode[] {
  const childIds = Array.from({ length: childCount }, (_, i) => `c${i}`);
  const nodes: EvalPlanNode[] = [
    makeNode({ id: "root", label: "SUM", children: childIds }),
  ];
  for (let i = 0; i < childCount; i++) {
    nodes.push(makeNode({ id: `c${i}`, label: `C${i}`, sourceStart: i }));
  }
  return nodes;
}

// ============================================================================
// Deep trees (20+ levels)
// ============================================================================

describe("deep trees", () => {
  it("assigns correct layers to a 25-level chain", () => {
    const nodes = buildChain(25);
    const { layoutNodes } = computeTreeLayout(nodes, "root");

    expect(layoutNodes).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      const id = i === 0 ? "root" : `n${i}`;
      const ln = layoutNodes.find((n) => n.id === id)!;
      expect(ln.layer).toBe(i);
    }
  });

  it("each layer is vertically spaced correctly in a deep chain", () => {
    const nodes = buildChain(20);
    const { layoutNodes } = computeTreeLayout(nodes, "root");

    for (let i = 0; i < 20; i++) {
      const id = i === 0 ? "root" : `n${i}`;
      const ln = layoutNodes.find((n) => n.id === id)!;
      expect(ln.y).toBe(TREE_PADDING + i * (NODE_HEIGHT + VERTICAL_GAP));
    }
  });

  it("svgHeight accommodates all 25 layers", () => {
    const nodes = buildChain(25);
    const { svgHeight } = computeTreeLayout(nodes, "root");

    const expectedMinHeight = TREE_PADDING + 24 * (NODE_HEIGHT + VERTICAL_GAP) + NODE_HEIGHT + TREE_PADDING;
    expect(svgHeight).toBeGreaterThanOrEqual(expectedMinHeight);
  });
});

// ============================================================================
// Wide trees (50+ children)
// ============================================================================

describe("wide trees", () => {
  it("lays out 50 children without overlap", () => {
    const nodes = buildWideTree(50);
    const { layoutNodes } = computeTreeLayout(nodes, "root");

    const children = layoutNodes
      .filter((n) => n.id !== "root")
      .sort((a, b) => a.x - b.x);

    expect(children).toHaveLength(50);
    for (let i = 1; i < children.length; i++) {
      const prevRight = children[i - 1].x + children[i - 1].width;
      expect(children[i].x).toBeGreaterThanOrEqual(prevRight);
    }
  });

  it("root is centered over 50 children", () => {
    const nodes = buildWideTree(50);
    const { layoutNodes } = computeTreeLayout(nodes, "root");

    const root = layoutNodes.find((n) => n.id === "root")!;
    const children = layoutNodes.filter((n) => n.id !== "root");
    const childCenters = children.map((c) => c.x + c.width / 2);
    const expectedCenter = (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
    const rootCenter = root.x + root.width / 2;

    expect(rootCenter).toBeCloseTo(expectedCenter, 0);
  });

  it("svgWidth grows with number of children", () => {
    const { svgWidth: w10 } = computeTreeLayout(buildWideTree(10), "root");
    const { svgWidth: w50 } = computeTreeLayout(buildWideTree(50), "root");
    expect(w50).toBeGreaterThan(w10);
  });
});

// ============================================================================
// Unbalanced trees
// ============================================================================

describe("unbalanced trees", () => {
  it("handles one deep branch and one shallow branch", () => {
    // root -> [left, deep0]
    // deep0 -> deep1 -> deep2 -> deep3 -> deep4
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "IF", children: ["left", "deep0"], sourceStart: 0 }),
      makeNode({ id: "left", label: "A1", sourceStart: 1 }),
      makeNode({ id: "deep0", label: "F0", children: ["deep1"], sourceStart: 5 }),
      makeNode({ id: "deep1", label: "F1", children: ["deep2"], sourceStart: 6 }),
      makeNode({ id: "deep2", label: "F2", children: ["deep3"], sourceStart: 7 }),
      makeNode({ id: "deep3", label: "F3", children: ["deep4"], sourceStart: 8 }),
      makeNode({ id: "deep4", label: "LEAF", sourceStart: 9 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");

    const root = layoutNodes.find((n) => n.id === "root")!;
    const left = layoutNodes.find((n) => n.id === "left")!;
    const deep4 = layoutNodes.find((n) => n.id === "deep4")!;

    expect(root.layer).toBe(0);
    expect(left.layer).toBe(1);
    expect(deep4.layer).toBe(5);
  });

  it("no nodes overlap in an unbalanced tree", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "+", children: ["a", "b", "c"], sourceStart: 0 }),
      makeNode({ id: "a", label: "A", sourceStart: 1 }),
      makeNode({ id: "b", label: "B", children: ["b1", "b2"], sourceStart: 3 }),
      makeNode({ id: "c", label: "C", sourceStart: 5 }),
      makeNode({ id: "b1", label: "B1", children: ["b1a"], sourceStart: 3 }),
      makeNode({ id: "b2", label: "B2", sourceStart: 4 }),
      makeNode({ id: "b1a", label: "B1A", sourceStart: 3 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");

    // Check no overlap within each layer
    const byLayer = new Map<number, typeof layoutNodes>();
    for (const ln of layoutNodes) {
      if (!byLayer.has(ln.layer)) byLayer.set(ln.layer, []);
      byLayer.get(ln.layer)!.push(ln);
    }
    for (const [, group] of byLayer) {
      const sorted = [...group].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width);
      }
    }
  });
});

// ============================================================================
// Single-path tree (each node has exactly 1 child)
// ============================================================================

describe("single-path tree", () => {
  it("all nodes are vertically aligned", () => {
    const nodes = buildChain(10);
    const { layoutNodes } = computeTreeLayout(nodes, "root");

    // In a single chain, parents center over their single child.
    // Bottom node gets x = TREE_PADDING, and every parent centers over it.
    // Since each parent has one child of the same width, all x values should be equal.
    const xs = layoutNodes.map((n) => n.x);
    for (const x of xs) {
      expect(x).toBe(xs[0]);
    }
  });
});

// ============================================================================
// Diamond / DAG patterns (shared children)
// ============================================================================

describe("diamond / DAG patterns", () => {
  it("shared child is only placed once", () => {
    // root -> [a, b], a -> [shared], b -> [shared]
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "+", children: ["a", "b"], sourceStart: 0 }),
      makeNode({ id: "a", label: "F1", children: ["shared"], sourceStart: 1 }),
      makeNode({ id: "b", label: "F2", children: ["shared"], sourceStart: 5 }),
      makeNode({ id: "shared", label: "A1", sourceStart: 3 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");
    const sharedNodes = layoutNodes.filter((n) => n.id === "shared");
    expect(sharedNodes).toHaveLength(1);
  });

  it("shared child is assigned to layer of first parent encountered (BFS)", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "+", children: ["a", "b"], sourceStart: 0 }),
      makeNode({ id: "a", label: "F1", children: ["shared"], sourceStart: 1 }),
      makeNode({ id: "b", label: "F2", children: ["shared"], sourceStart: 5 }),
      makeNode({ id: "shared", label: "A1", sourceStart: 3 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");
    const shared = layoutNodes.find((n) => n.id === "shared")!;
    // BFS from root: root(0) -> a(1), b(1) -> shared(2)
    expect(shared.layer).toBe(2);
  });
});

// ============================================================================
// Label width estimation
// ============================================================================

describe("label width estimation", () => {
  it("uses NODE_MIN_WIDTH for very short labels", () => {
    const nodes = [makeNode({ id: "r", label: "X", subtitle: "" })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    expect(layoutNodes[0].width).toBe(NODE_MIN_WIDTH);
  });

  it("grows width for long labels", () => {
    const longLabel = "VERY_LONG_FUNCTION_NAME_EXCEEDING_MINIMUM";
    const expectedWidth = longLabel.length * 8 + NODE_PADDING_X * 2;
    const nodes = [makeNode({ id: "r", label: longLabel, subtitle: "" })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    expect(layoutNodes[0].width).toBe(Math.max(NODE_MIN_WIDTH, expectedWidth));
    expect(layoutNodes[0].width).toBeGreaterThan(NODE_MIN_WIDTH);
  });

  it("uses subtitle width when it exceeds label width", () => {
    const nodes = [
      makeNode({ id: "r", label: "SUM", subtitle: "This is a very long subtitle text that is wider" }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    const subtitleWidth = 47 * 8 + NODE_PADDING_X * 2;
    expect(layoutNodes[0].width).toBe(Math.max(NODE_MIN_WIDTH, subtitleWidth));
  });

  it("handles empty label and subtitle", () => {
    const nodes = [makeNode({ id: "r", label: "", subtitle: "" })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    expect(layoutNodes[0].width).toBe(NODE_MIN_WIDTH);
  });

  it("handles labels with wide characters (estimates by length)", () => {
    // The estimator uses character count * 8, so multi-byte chars are same width
    const label = "WWWWWWWWWWWWWWWWWWWW"; // 20 wide chars
    const nodes = [makeNode({ id: "r", label, subtitle: "" })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    expect(layoutNodes[0].width).toBe(Math.max(NODE_MIN_WIDTH, 20 * 8 + NODE_PADDING_X * 2));
  });
});

// ============================================================================
// Unreachable nodes
// ============================================================================

describe("unreachable nodes", () => {
  it("places unreachable nodes at layer 0", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "+", children: ["a"] }),
      makeNode({ id: "a", label: "A1" }),
      makeNode({ id: "orphan", label: "ORPHAN", sourceStart: 99 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");
    const orphan = layoutNodes.find((n) => n.id === "orphan")!;
    expect(orphan.layer).toBe(0);
  });
});

// ============================================================================
// SVG dimension correctness
// ============================================================================

describe("SVG dimensions", () => {
  it("svgWidth is at least 680 even for narrow trees", () => {
    const { svgWidth } = computeTreeLayout([makeNode({ id: "r", label: "X" })], "r");
    expect(svgWidth).toBe(680);
  });

  it("svgWidth exceeds 680 for wide trees", () => {
    const nodes = buildWideTree(20);
    const { svgWidth } = computeTreeLayout(nodes, "root");
    expect(svgWidth).toBeGreaterThan(680);
  });

  it("svgHeight is zero for empty input", () => {
    const { svgHeight } = computeTreeLayout([], "root");
    expect(svgHeight).toBe(0);
  });
});
