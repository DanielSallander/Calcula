//! FILENAME: app/extensions/FormulaVisualizer/lib/__tests__/treeLayoutEngine-exhaustive.test.ts
// PURPOSE: Exhaustive tests for treeLayoutEngine covering diverse topologies and edge cases.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api", () => ({}));

import { computeTreeLayout, estimateNodeWidth } from "../treeLayoutEngine";
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
    label: overrides.label ?? overrides.id,
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

/** Build a complete k-ary tree with given branching factor and depth. */
function buildKaryTree(k: number, depth: number): EvalPlanNode[] {
  const nodes: EvalPlanNode[] = [];
  let nextId = 0;

  function build(currentDepth: number): string {
    const id = `n${nextId++}`;
    const childIds: string[] = [];
    if (currentDepth < depth) {
      for (let i = 0; i < k; i++) {
        childIds.push(build(currentDepth + 1));
      }
    }
    nodes.push(makeNode({ id, label: id, children: childIds, sourceStart: nextId }));
    return id;
  }

  const rootId = build(0);
  // Root is the last pushed node; reorder so root is first for clarity
  const rootIdx = nodes.findIndex((n) => n.id === rootId);
  const root = nodes.splice(rootIdx, 1)[0];
  nodes.unshift(root);
  return nodes;
}

/** Assert no two nodes in the layout overlap (pairwise check within each layer). */
function assertNoOverlaps(layoutNodes: { id: string; x: number; y: number; width: number; height: number; layer: number }[]) {
  const byLayer = new Map<number, typeof layoutNodes>();
  for (const ln of layoutNodes) {
    if (!byLayer.has(ln.layer)) byLayer.set(ln.layer, []);
    byLayer.get(ln.layer)!.push(ln);
  }
  for (const [layer, group] of byLayer) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const prevRight = sorted[i - 1].x + sorted[i - 1].width;
      expect(sorted[i].x, `overlap on layer ${layer}: ${sorted[i - 1].id} and ${sorted[i].id}`).toBeGreaterThanOrEqual(prevRight);
    }
  }
}

// ============================================================================
// Empty, single, and two nodes
// ============================================================================

describe("trivial inputs", () => {
  it("empty input returns empty layout", () => {
    const { layoutNodes, svgWidth, svgHeight } = computeTreeLayout([], "root");
    expect(layoutNodes).toHaveLength(0);
    expect(svgWidth).toBe(0);
    expect(svgHeight).toBe(0);
  });

  it("single node layout", () => {
    const nodes = [makeNode({ id: "only" })];
    const { layoutNodes, svgHeight } = computeTreeLayout(nodes, "only");
    expect(layoutNodes).toHaveLength(1);
    expect(layoutNodes[0].layer).toBe(0);
    expect(layoutNodes[0].x).toBe(TREE_PADDING);
    expect(layoutNodes[0].y).toBe(TREE_PADDING);
    expect(svgHeight).toBe(TREE_PADDING + NODE_HEIGHT + TREE_PADDING);
  });

  it("two nodes: parent and child", () => {
    const nodes = [
      makeNode({ id: "p", children: ["c"], sourceStart: 0 }),
      makeNode({ id: "c", sourceStart: 1 }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "p");
    const parent = layoutNodes.find((n) => n.id === "p")!;
    const child = layoutNodes.find((n) => n.id === "c")!;
    expect(parent.layer).toBe(0);
    expect(child.layer).toBe(1);
    expect(child.y).toBeGreaterThan(parent.y);
  });
});

// ============================================================================
// Binary tree (5 levels, 31 nodes)
// ============================================================================

describe("binary tree (5 levels)", () => {
  const nodes = buildKaryTree(2, 4); // depth 0..4 = 5 levels, 31 nodes
  const rootId = nodes[0].id;

  it("produces 31 layout nodes", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    expect(layoutNodes).toHaveLength(31);
  });

  it("has no overlaps", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    assertNoOverlaps(layoutNodes);
  });

  it("root is at layer 0, leaves at layer 4", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    const root = layoutNodes.find((n) => n.id === rootId)!;
    expect(root.layer).toBe(0);
    // Leaves have no children
    const leaves = layoutNodes.filter((n) => {
      const orig = nodes.find((o) => o.id === n.id)!;
      return orig.children.length === 0;
    });
    expect(leaves).toHaveLength(16);
    for (const leaf of leaves) {
      expect(leaf.layer).toBe(4);
    }
  });

  it("SVG accommodates all nodes", () => {
    const { layoutNodes, svgWidth, svgHeight } = computeTreeLayout(nodes, rootId);
    for (const ln of layoutNodes) {
      expect(ln.x + ln.width + TREE_PADDING).toBeLessThanOrEqual(svgWidth);
      expect(ln.y + ln.height + TREE_PADDING).toBeLessThanOrEqual(svgHeight);
    }
  });
});

// ============================================================================
// Ternary tree (3 levels)
// ============================================================================

describe("ternary tree (3 levels)", () => {
  const nodes = buildKaryTree(3, 2); // depth 0..2 = 3 levels, 1+3+9 = 13 nodes
  const rootId = nodes[0].id;

  it("produces 13 layout nodes", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    expect(layoutNodes).toHaveLength(13);
  });

  it("layer assignment matches BFS depth", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    const root = layoutNodes.find((n) => n.id === rootId)!;
    expect(root.layer).toBe(0);

    // All nodes reachable via one hop from root should be layer 1
    const rootNode = nodes.find((n) => n.id === rootId)!;
    for (const childId of rootNode.children) {
      const child = layoutNodes.find((n) => n.id === childId)!;
      expect(child.layer).toBe(1);
    }
  });

  it("no overlaps", () => {
    const { layoutNodes } = computeTreeLayout(nodes, rootId);
    assertNoOverlaps(layoutNodes);
  });
});

// ============================================================================
// Star topology (1 root, 100 children)
// ============================================================================

describe("star topology (100 children)", () => {
  const childIds = Array.from({ length: 100 }, (_, i) => `c${i}`);
  const nodes: EvalPlanNode[] = [
    makeNode({ id: "root", label: "SUM", children: childIds, sourceStart: 0 }),
    ...childIds.map((id, i) => makeNode({ id, label: `V${i}`, sourceStart: i + 1 })),
  ];

  it("produces 101 nodes", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "root");
    expect(layoutNodes).toHaveLength(101);
  });

  it("no overlaps among 100 children", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "root");
    assertNoOverlaps(layoutNodes);
  });

  it("root is centered over children", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "root");
    const root = layoutNodes.find((n) => n.id === "root")!;
    const children = layoutNodes.filter((n) => n.id !== "root");
    const childCenters = children.map((c) => c.x + c.width / 2);
    const expectedCenter = (Math.min(...childCenters) + Math.max(...childCenters)) / 2;
    const rootCenter = root.x + root.width / 2;
    expect(rootCenter).toBeCloseTo(expectedCenter, 0);
  });

  it("dimensions grow proportionally", () => {
    const small = computeTreeLayout(
      [
        makeNode({ id: "root", label: "SUM", children: ["c0", "c1"], sourceStart: 0 }),
        makeNode({ id: "c0", sourceStart: 1 }),
        makeNode({ id: "c1", sourceStart: 2 }),
      ],
      "root",
    );
    const large = computeTreeLayout(nodes, "root");
    expect(large.svgWidth).toBeGreaterThan(small.svgWidth);
    // Height should be similar (both 2 layers)
    expect(large.svgHeight).toBe(small.svgHeight);
  });
});

// ============================================================================
// Chain topology (A->B->C->...->Z, 26 nodes)
// ============================================================================

describe("chain topology (26 nodes)", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const nodes: EvalPlanNode[] = alphabet.map((letter, i) =>
    makeNode({
      id: letter,
      label: letter,
      children: i < 25 ? [alphabet[i + 1]] : [],
      sourceStart: i,
    }),
  );

  it("produces 26 nodes with correct layer assignment", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "A");
    expect(layoutNodes).toHaveLength(26);
    for (let i = 0; i < 26; i++) {
      const ln = layoutNodes.find((n) => n.id === alphabet[i])!;
      expect(ln.layer).toBe(i);
    }
  });

  it("all nodes are vertically aligned (single-child chain)", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "A");
    const xs = layoutNodes.map((n) => n.x);
    for (const x of xs) {
      expect(x).toBe(xs[0]);
    }
  });

  it("SVG height accommodates 26 layers", () => {
    const { svgHeight } = computeTreeLayout(nodes, "A");
    const minHeight = TREE_PADDING + 25 * (NODE_HEIGHT + VERTICAL_GAP) + NODE_HEIGHT + TREE_PADDING;
    expect(svgHeight).toBeGreaterThanOrEqual(minHeight);
  });
});

// ============================================================================
// Forest (disconnected components via unreachable nodes)
// ============================================================================

describe("forest (disconnected components)", () => {
  const nodes: EvalPlanNode[] = [
    makeNode({ id: "r1", label: "Root1", children: ["a1", "a2"], sourceStart: 0 }),
    makeNode({ id: "a1", label: "A1", sourceStart: 1 }),
    makeNode({ id: "a2", label: "A2", sourceStart: 2 }),
    // Disconnected tree
    makeNode({ id: "r2", label: "Root2", children: ["b1"], sourceStart: 10 }),
    makeNode({ id: "b1", label: "B1", sourceStart: 11 }),
    // Isolated node
    makeNode({ id: "iso", label: "Isolated", sourceStart: 20 }),
  ];

  it("unreachable nodes are placed at layer 0", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "r1");
    const r2 = layoutNodes.find((n) => n.id === "r2")!;
    const b1 = layoutNodes.find((n) => n.id === "b1")!;
    const iso = layoutNodes.find((n) => n.id === "iso")!;
    // r2, b1, iso are all unreachable from r1 so they go to layer 0
    expect(r2.layer).toBe(0);
    expect(b1.layer).toBe(0);
    expect(iso.layer).toBe(0);
  });

  it("all 6 nodes are present in output", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "r1");
    expect(layoutNodes).toHaveLength(6);
  });

  it("no overlaps despite mixed layers", () => {
    const { layoutNodes } = computeTreeLayout(nodes, "r1");
    assertNoOverlaps(layoutNodes);
  });
});

// ============================================================================
// Long labels and width estimation
// ============================================================================

describe("long labels", () => {
  it("node with 200+ char label gets proportional width", () => {
    const longLabel = "A".repeat(220);
    const nodes = [makeNode({ id: "r", label: longLabel })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    const expectedWidth = 220 * 8 + NODE_PADDING_X * 2;
    expect(layoutNodes[0].width).toBe(expectedWidth);
    expect(layoutNodes[0].width).toBeGreaterThan(NODE_MIN_WIDTH);
  });

  it("subtitle longer than title drives width", () => {
    const subtitle = "B".repeat(150);
    const nodes = [makeNode({ id: "r", label: "SUM", subtitle })];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    const expectedWidth = 150 * 8 + NODE_PADDING_X * 2;
    expect(layoutNodes[0].width).toBe(expectedWidth);
  });

  it("long-label nodes do not overlap siblings", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "R", children: ["wide", "narrow"], sourceStart: 0 }),
      makeNode({ id: "wide", label: "X".repeat(200), sourceStart: 1 }),
      makeNode({ id: "narrow", label: "Y", sourceStart: 2 }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "root");
    assertNoOverlaps(layoutNodes);
  });
});

// ============================================================================
// All nodes have the same label
// ============================================================================

describe("identical labels", () => {
  it("all nodes get distinct positions despite identical widths", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "SAME", children: ids, sourceStart: 0 }),
      ...ids.map((id, i) => makeNode({ id, label: "SAME", sourceStart: i + 1 })),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "root");
    // All children should have unique x positions
    const children = layoutNodes.filter((n) => n.id !== "root");
    const xs = new Set(children.map((c) => c.x));
    expect(xs.size).toBe(10);
  });
});

// ============================================================================
// Layout dimensions grow proportionally
// ============================================================================

describe("proportional growth", () => {
  it("svgWidth grows as children are added", () => {
    const widths: number[] = [];
    for (const count of [5, 10, 20, 40]) {
      const childIds = Array.from({ length: count }, (_, i) => `c${i}`);
      const nodes: EvalPlanNode[] = [
        makeNode({ id: "root", label: "R", children: childIds, sourceStart: 0 }),
        ...childIds.map((id, i) => makeNode({ id, sourceStart: i + 1 })),
      ];
      const { svgWidth } = computeTreeLayout(nodes, "root");
      widths.push(svgWidth);
    }
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });

  it("svgHeight grows as depth increases", () => {
    const heights: number[] = [];
    for (const depth of [2, 5, 10, 20]) {
      const chainNodes: EvalPlanNode[] = [];
      for (let i = 0; i < depth; i++) {
        chainNodes.push(
          makeNode({
            id: `n${i}`,
            children: i < depth - 1 ? [`n${i + 1}`] : [],
            sourceStart: i,
          }),
        );
      }
      const { svgHeight } = computeTreeLayout(chainNodes, "n0");
      heights.push(svgHeight);
    }
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]);
    }
  });
});

// ============================================================================
// Parent centered over children
// ============================================================================

describe("parent centering", () => {
  it("parent is centered over two children", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "p", label: "ADD", children: ["l", "r"], sourceStart: 0 }),
      makeNode({ id: "l", label: "A1", sourceStart: 1 }),
      makeNode({ id: "r", label: "B1", sourceStart: 2 }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "p");
    const parent = layoutNodes.find((n) => n.id === "p")!;
    const left = layoutNodes.find((n) => n.id === "l")!;
    const right = layoutNodes.find((n) => n.id === "r")!;

    const childMidpoint = (left.x + left.width / 2 + right.x + right.width / 2) / 2;
    const parentCenter = parent.x + parent.width / 2;
    expect(parentCenter).toBeCloseTo(childMidpoint, 0);
  });

  it("parent is centered over three children", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "p", label: "IF", children: ["a", "b", "c"], sourceStart: 0 }),
      makeNode({ id: "a", sourceStart: 1 }),
      makeNode({ id: "b", sourceStart: 2 }),
      makeNode({ id: "c", sourceStart: 3 }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "p");
    const parent = layoutNodes.find((n) => n.id === "p")!;
    const children = layoutNodes.filter((n) => n.id !== "p");
    const centers = children.map((c) => c.x + c.width / 2);
    const expectedCenter = (Math.min(...centers) + Math.max(...centers)) / 2;
    const parentCenter = parent.x + parent.width / 2;
    expect(parentCenter).toBeCloseTo(expectedCenter, 0);
  });

  it("parent centering holds in a binary tree", () => {
    const nodes = buildKaryTree(2, 2); // 7 nodes
    const rootId = nodes[0].id;
    const { layoutNodes } = computeTreeLayout(nodes, rootId);

    // Check every non-leaf parent
    for (const n of nodes) {
      if (n.children.length === 0) continue;
      const parent = layoutNodes.find((ln) => ln.id === n.id)!;
      const childLayouts = n.children
        .map((cid) => layoutNodes.find((ln) => ln.id === cid)!)
        .filter(Boolean);
      if (childLayouts.length === 0) continue;
      const centers = childLayouts.map((c) => c.x + c.width / 2);
      const expectedCenter = (Math.min(...centers) + Math.max(...centers)) / 2;
      const parentCenter = parent.x + parent.width / 2;
      // Allow some tolerance due to overlap resolution
      expect(Math.abs(parentCenter - expectedCenter)).toBeLessThan(
        NODE_MIN_WIDTH + HORIZONTAL_GAP,
      );
    }
  });
});

// ============================================================================
// SVG dimensions accommodate all nodes (no clipping)
// ============================================================================

describe("no clipping", () => {
  const topologies = [
    { name: "binary 4-deep", nodes: buildKaryTree(2, 3) },
    { name: "ternary 2-deep", nodes: buildKaryTree(3, 2) },
    {
      name: "star 50",
      nodes: (() => {
        const ids = Array.from({ length: 50 }, (_, i) => `c${i}`);
        return [
          makeNode({ id: "root", label: "R", children: ids, sourceStart: 0 }),
          ...ids.map((id, i) => makeNode({ id, sourceStart: i + 1 })),
        ];
      })(),
    },
  ];

  for (const { name, nodes } of topologies) {
    it(`all nodes fit within SVG bounds: ${name}`, () => {
      const rootId = nodes[0].id;
      const { layoutNodes, svgWidth, svgHeight } = computeTreeLayout(nodes, rootId);
      for (const ln of layoutNodes) {
        expect(ln.x + ln.width + TREE_PADDING).toBeLessThanOrEqual(svgWidth);
        expect(ln.y + ln.height + TREE_PADDING).toBeLessThanOrEqual(svgHeight);
      }
    });
  }
});

// ============================================================================
// estimateNodeWidth direct tests
// ============================================================================

describe("estimateNodeWidth", () => {
  it("empty string returns NODE_MIN_WIDTH", () => {
    const w = estimateNodeWidth(makeNode({ id: "x", label: "", subtitle: "" }));
    expect(w).toBe(NODE_MIN_WIDTH);
  });

  it("single char returns NODE_MIN_WIDTH", () => {
    const w = estimateNodeWidth(makeNode({ id: "x", label: "A", subtitle: "" }));
    expect(w).toBe(NODE_MIN_WIDTH);
  });

  it("100 chars returns proportional width", () => {
    const label = "X".repeat(100);
    const w = estimateNodeWidth(makeNode({ id: "x", label, subtitle: "" }));
    expect(w).toBe(100 * 8 + NODE_PADDING_X * 2);
  });

  it("unicode characters counted by length", () => {
    const label = "\u{1F600}".repeat(30); // emoji, each is 2 chars in JS
    const w = estimateNodeWidth(makeNode({ id: "x", label, subtitle: "" }));
    const expectedLen = label.length; // 60 for 30 emoji
    expect(w).toBe(Math.max(NODE_MIN_WIDTH, expectedLen * 8 + NODE_PADDING_X * 2));
  });

  it("subtitle drives width when longer than label", () => {
    const w = estimateNodeWidth(makeNode({ id: "x", label: "AB", subtitle: "C".repeat(80) }));
    expect(w).toBe(80 * 8 + NODE_PADDING_X * 2);
  });

  it("label drives width when longer than subtitle", () => {
    const w = estimateNodeWidth(makeNode({ id: "x", label: "D".repeat(80), subtitle: "EF" }));
    expect(w).toBe(80 * 8 + NODE_PADDING_X * 2);
  });
});

// ============================================================================
// Exhaustive pairwise no-overlap check
// ============================================================================

describe("exhaustive pairwise overlap check", () => {
  it("no two nodes overlap in a complex mixed tree", () => {
    // Build a tree with varying branching factors
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "root", label: "ROOT", children: ["a", "b", "c", "d"], sourceStart: 0 }),
      makeNode({ id: "a", label: "A_LONG_NAME", children: ["a1", "a2", "a3"], sourceStart: 1 }),
      makeNode({ id: "b", label: "B", sourceStart: 5 }),
      makeNode({ id: "c", label: "C", children: ["c1"], sourceStart: 8 }),
      makeNode({ id: "d", label: "D_MEDIUM", children: ["d1", "d2"], sourceStart: 12 }),
      makeNode({ id: "a1", label: "A1", sourceStart: 2 }),
      makeNode({ id: "a2", label: "A2_WIDER_LABEL_HERE", sourceStart: 3 }),
      makeNode({ id: "a3", label: "A3", sourceStart: 4 }),
      makeNode({ id: "c1", label: "C1_DEEP", children: ["c1a"], sourceStart: 9 }),
      makeNode({ id: "d1", label: "D1", sourceStart: 13 }),
      makeNode({ id: "d2", label: "D2", sourceStart: 14 }),
      makeNode({ id: "c1a", label: "LEAF", sourceStart: 10 }),
    ];

    const { layoutNodes } = computeTreeLayout(nodes, "root");

    // Full pairwise check across ALL nodes (not just same layer)
    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i];
        const b = layoutNodes[j];
        // Only check overlap if on same layer (same y)
        if (a.y === b.y) {
          const aRight = a.x + a.width;
          const bRight = b.x + b.width;
          const xOverlap = a.x < bRight && b.x < aRight;
          expect(xOverlap, `overlap between ${a.id} and ${b.id}`).toBe(false);
        }
      }
    }
  });
});

// ============================================================================
// Layer assignment matches BFS depth
// ============================================================================

describe("BFS layer correctness", () => {
  it("layers match manual BFS for a known tree", () => {
    const nodes: EvalPlanNode[] = [
      makeNode({ id: "r", children: ["a", "b"], sourceStart: 0 }),
      makeNode({ id: "a", children: ["c"], sourceStart: 1 }),
      makeNode({ id: "b", children: ["d", "e"], sourceStart: 2 }),
      makeNode({ id: "c", sourceStart: 3 }),
      makeNode({ id: "d", sourceStart: 4 }),
      makeNode({ id: "e", sourceStart: 5 }),
    ];
    const { layoutNodes } = computeTreeLayout(nodes, "r");
    const layerOf = (id: string) => layoutNodes.find((n) => n.id === id)!.layer;

    expect(layerOf("r")).toBe(0);
    expect(layerOf("a")).toBe(1);
    expect(layerOf("b")).toBe(1);
    expect(layerOf("c")).toBe(2);
    expect(layerOf("d")).toBe(2);
    expect(layerOf("e")).toBe(2);
  });
});
