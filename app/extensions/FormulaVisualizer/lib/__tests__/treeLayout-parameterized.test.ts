//! FILENAME: app/extensions/FormulaVisualizer/lib/__tests__/treeLayout-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for tree layout engine:
//          tree shapes, node width estimation, and layer assignment.

import { describe, it, expect } from "vitest";
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

function makeNode(
  id: string,
  children: string[] = [],
  label = id,
  subtitle = "",
  sourceStart = 0,
): EvalPlanNode {
  return {
    id,
    nodeType: "function",
    label,
    subtitle,
    subtitleCompact: subtitle,
    subtitleValuesOnly: "",
    subtitleBare: "",
    value: "",
    rawValue: null,
    children,
    sourceStart,
    sourceEnd: sourceStart + label.length,
    evalOrder: 0,
    costPct: 0,
    isLeaf: children.length === 0,
  };
}

// ============================================================================
// 1. Tree shapes: 20 different topologies
// ============================================================================

describe("tree shapes parameterized", () => {
  const topologies: Array<{
    label: string;
    nodes: EvalPlanNode[];
    rootId: string;
    expectedNodeCount: number;
    expectedMaxLayer: number;
  }> = [
    {
      label: "single node",
      nodes: [makeNode("a")],
      rootId: "a",
      expectedNodeCount: 1,
      expectedMaxLayer: 0,
    },
    {
      label: "root + 1 child",
      nodes: [makeNode("a", ["b"]), makeNode("b")],
      rootId: "a",
      expectedNodeCount: 2,
      expectedMaxLayer: 1,
    },
    {
      label: "binary tree depth 2",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d", "e"]),
        makeNode("c"),
        makeNode("d"),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 2,
    },
    {
      label: "ternary root",
      nodes: [
        makeNode("a", ["b", "c", "d"]),
        makeNode("b"),
        makeNode("c"),
        makeNode("d"),
      ],
      rootId: "a",
      expectedNodeCount: 4,
      expectedMaxLayer: 1,
    },
    {
      label: "star (1 root, 5 leaves)",
      nodes: [
        makeNode("root", ["l1", "l2", "l3", "l4", "l5"]),
        makeNode("l1"),
        makeNode("l2"),
        makeNode("l3"),
        makeNode("l4"),
        makeNode("l5"),
      ],
      rootId: "root",
      expectedNodeCount: 6,
      expectedMaxLayer: 1,
    },
    {
      label: "chain of 5",
      nodes: [
        makeNode("a", ["b"]),
        makeNode("b", ["c"]),
        makeNode("c", ["d"]),
        makeNode("d", ["e"]),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 4,
    },
    {
      label: "chain of 3",
      nodes: [
        makeNode("a", ["b"]),
        makeNode("b", ["c"]),
        makeNode("c"),
      ],
      rootId: "a",
      expectedNodeCount: 3,
      expectedMaxLayer: 2,
    },
    {
      label: "balanced binary depth 3",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d", "e"]),
        makeNode("c", ["f", "g"]),
        makeNode("d"),
        makeNode("e"),
        makeNode("f"),
        makeNode("g"),
      ],
      rootId: "a",
      expectedNodeCount: 7,
      expectedMaxLayer: 2,
    },
    {
      label: "left-skewed",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d"]),
        makeNode("c"),
        makeNode("d", ["e"]),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 3,
    },
    {
      label: "right-skewed",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b"),
        makeNode("c", ["d"]),
        makeNode("d", ["e"]),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 3,
    },
    {
      label: "wide and shallow (8 children)",
      nodes: [
        makeNode("r", ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]),
        ...Array.from({ length: 8 }, (_, i) => makeNode(`c${i + 1}`)),
      ],
      rootId: "r",
      expectedNodeCount: 9,
      expectedMaxLayer: 1,
    },
    {
      label: "caterpillar graph",
      nodes: [
        makeNode("a", ["b", "x1"]),
        makeNode("b", ["c", "x2"]),
        makeNode("c", ["d", "x3"]),
        makeNode("d"),
        makeNode("x1"),
        makeNode("x2"),
        makeNode("x3"),
      ],
      rootId: "a",
      expectedNodeCount: 7,
      expectedMaxLayer: 3,
    },
    {
      label: "Y shape (root, 2 children each with 1 child)",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d"]),
        makeNode("c", ["e"]),
        makeNode("d"),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 2,
    },
    {
      label: "T shape (root with chain + leaf)",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b"),
        makeNode("c", ["d", "e"]),
        makeNode("d"),
        makeNode("e"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 2,
    },
    {
      label: "diamond (shared-like, 4 nodes)",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d"]),
        makeNode("c", ["d"]),
        makeNode("d"),
      ],
      rootId: "a",
      expectedNodeCount: 4,
      expectedMaxLayer: 2,
    },
    {
      label: "unbalanced ternary",
      nodes: [
        makeNode("a", ["b", "c", "d"]),
        makeNode("b", ["e", "f"]),
        makeNode("c"),
        makeNode("d", ["g"]),
        makeNode("e"),
        makeNode("f"),
        makeNode("g"),
      ],
      rootId: "a",
      expectedNodeCount: 7,
      expectedMaxLayer: 2,
    },
    {
      label: "comb (each node has 1 leaf + 1 chain node)",
      nodes: [
        makeNode("a", ["b", "l1"]),
        makeNode("b", ["c", "l2"]),
        makeNode("c"),
        makeNode("l1"),
        makeNode("l2"),
      ],
      rootId: "a",
      expectedNodeCount: 5,
      expectedMaxLayer: 2,
    },
    {
      label: "empty tree",
      nodes: [],
      rootId: "x",
      expectedNodeCount: 0,
      expectedMaxLayer: -1,
    },
    {
      label: "4-ary single level",
      nodes: [
        makeNode("r", ["a", "b", "c", "d"]),
        makeNode("a"),
        makeNode("b"),
        makeNode("c"),
        makeNode("d"),
      ],
      rootId: "r",
      expectedNodeCount: 5,
      expectedMaxLayer: 1,
    },
    {
      label: "deep chain of 7",
      nodes: [
        makeNode("n1", ["n2"]),
        makeNode("n2", ["n3"]),
        makeNode("n3", ["n4"]),
        makeNode("n4", ["n5"]),
        makeNode("n5", ["n6"]),
        makeNode("n6", ["n7"]),
        makeNode("n7"),
      ],
      rootId: "n1",
      expectedNodeCount: 7,
      expectedMaxLayer: 6,
    },
  ];

  it.each(topologies)(
    "$label",
    ({ nodes, rootId, expectedNodeCount, expectedMaxLayer }) => {
      const result = computeTreeLayout(nodes, rootId);
      expect(result.layoutNodes.length).toBe(expectedNodeCount);

      if (expectedNodeCount === 0) {
        expect(result.svgWidth).toBe(0);
        expect(result.svgHeight).toBe(0);
        return;
      }

      // Check max layer
      const maxLayer = Math.max(...result.layoutNodes.map((n) => n.layer));
      expect(maxLayer).toBe(expectedMaxLayer);

      // All nodes have valid positions
      for (const ln of result.layoutNodes) {
        expect(ln.x).toBeGreaterThanOrEqual(0);
        expect(ln.y).toBeGreaterThanOrEqual(0);
        expect(ln.width).toBeGreaterThanOrEqual(NODE_MIN_WIDTH);
        expect(ln.height).toBe(NODE_HEIGHT);
      }

      // SVG dimensions contain all nodes
      for (const ln of result.layoutNodes) {
        expect(ln.x + ln.width + TREE_PADDING).toBeLessThanOrEqual(result.svgWidth + 1); // +1 for float tolerance
        expect(ln.y + ln.height + TREE_PADDING).toBeLessThanOrEqual(result.svgHeight + 1);
      }

      // No two nodes on the same layer overlap horizontally
      const byLayer = new Map<number, typeof result.layoutNodes>();
      for (const ln of result.layoutNodes) {
        if (!byLayer.has(ln.layer)) byLayer.set(ln.layer, []);
        byLayer.get(ln.layer)!.push(ln);
      }
      for (const [, layerNodes] of byLayer) {
        const sorted = [...layerNodes].sort((a, b) => a.x - b.x);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width);
        }
      }
    },
  );
});

// ============================================================================
// 2. Node width estimation: 30 label combos
// ============================================================================

describe("estimateNodeWidth parameterized", () => {
  const labelCases: Array<{
    label: string;
    subtitle: string;
    expectedMinWidth: number;
  }> = [
    { label: "", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "A", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "SUM", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "AVERAGE", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "VLOOKUP", subtitle: "A1:B10, 2, FALSE", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "+", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "IF", subtitle: "condition, true, false", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "CONCATENATE", subtitle: "A1, B1, C1, D1, E1", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "A1", subtitle: "42", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "Sheet1!A1:Z100", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "SUMPRODUCT", subtitle: "(A1:A100)*(B1:B100)", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "x", subtitle: "y", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "INDEX", subtitle: "MATCH(lookup, range, 0)", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "A very long function name here", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "fn", subtitle: "a very long subtitle that exceeds minimum width for sure yes", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "1234567890", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "IFERROR", subtitle: "VALUE, default", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "12", subtitle: "12", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "OFFSET", subtitle: "ref, rows, cols, h, w", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "INDIRECT", subtitle: "\"Sheet\"&A1&\"!B2\"", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "XXXXXXXXXXXXXXXXXXX", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "", subtitle: "XXXXXXXXXXXXXXXXXXXXXXXXXXX", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "ab", subtitle: "abcdefghijklmnopqrstuvwxyz", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "abcdefghijklmnopqrstuvwxyz", subtitle: "ab", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "MID", subtitle: "text, start, num_chars", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "ROUND", subtitle: "number, digits", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "NPV", subtitle: "rate, value1, value2, ...", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "PI", subtitle: "", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "HYPERLINK", subtitle: "url, friendly_name", expectedMinWidth: NODE_MIN_WIDTH },
    { label: "ThisIsAVeryVeryLongLabelName", subtitle: "AndThisIsAnEvenLongerSubtitle", expectedMinWidth: NODE_MIN_WIDTH },
  ];

  it.each(labelCases)(
    "label='$label' subtitle='$subtitle'",
    ({ label, subtitle, expectedMinWidth }) => {
      const node = makeNode("test", [], label, subtitle);
      const width = estimateNodeWidth(node);

      expect(width).toBeGreaterThanOrEqual(expectedMinWidth);

      // Width should be based on max text length
      const maxTextLen = Math.max(label.length, subtitle.length);
      const computedWidth = maxTextLen * 8 + NODE_PADDING_X * 2;
      expect(width).toBe(Math.max(NODE_MIN_WIDTH, computedWidth));
    },
  );
});

// ============================================================================
// 3. Layer assignment verification: 15 trees
// ============================================================================

describe("layer assignment parameterized", () => {
  const layerCases: Array<{
    label: string;
    nodes: EvalPlanNode[];
    rootId: string;
    expectedLayers: Record<string, number>;
  }> = [
    {
      label: "single root at layer 0",
      nodes: [makeNode("a")],
      rootId: "a",
      expectedLayers: { a: 0 },
    },
    {
      label: "parent-child: 0 and 1",
      nodes: [makeNode("a", ["b"]), makeNode("b")],
      rootId: "a",
      expectedLayers: { a: 0, b: 1 },
    },
    {
      label: "3-level chain",
      nodes: [makeNode("a", ["b"]), makeNode("b", ["c"]), makeNode("c")],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 2 },
    },
    {
      label: "binary: root 0, children 1, grandchildren 2",
      nodes: [
        makeNode("r", ["l", "r2"]),
        makeNode("l", ["ll", "lr"]),
        makeNode("r2"),
        makeNode("ll"),
        makeNode("lr"),
      ],
      rootId: "r",
      expectedLayers: { r: 0, l: 1, r2: 1, ll: 2, lr: 2 },
    },
    {
      label: "star: all children at layer 1",
      nodes: [
        makeNode("c", ["a", "b", "d"]),
        makeNode("a"),
        makeNode("b"),
        makeNode("d"),
      ],
      rootId: "c",
      expectedLayers: { c: 0, a: 1, b: 1, d: 1 },
    },
    {
      label: "4-level chain",
      nodes: [
        makeNode("a", ["b"]),
        makeNode("b", ["c"]),
        makeNode("c", ["d"]),
        makeNode("d"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 2, d: 3 },
    },
    {
      label: "mixed depths",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b"),
        makeNode("c", ["d"]),
        makeNode("d"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 1, d: 2 },
    },
    {
      label: "ternary with varied depths",
      nodes: [
        makeNode("r", ["a", "b", "c"]),
        makeNode("a", ["d"]),
        makeNode("b"),
        makeNode("c", ["e", "f"]),
        makeNode("d"),
        makeNode("e"),
        makeNode("f"),
      ],
      rootId: "r",
      expectedLayers: { r: 0, a: 1, b: 1, c: 1, d: 2, e: 2, f: 2 },
    },
    {
      label: "deep left branch",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b", ["d"]),
        makeNode("c"),
        makeNode("d", ["e"]),
        makeNode("e"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 1, d: 2, e: 3 },
    },
    {
      label: "deep right branch",
      nodes: [
        makeNode("a", ["b", "c"]),
        makeNode("b"),
        makeNode("c", ["d"]),
        makeNode("d", ["e"]),
        makeNode("e"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 1, d: 2, e: 3 },
    },
    {
      label: "5-way fan",
      nodes: [
        makeNode("r", ["a", "b", "c", "d", "e"]),
        makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d"), makeNode("e"),
      ],
      rootId: "r",
      expectedLayers: { r: 0, a: 1, b: 1, c: 1, d: 1, e: 1 },
    },
    {
      label: "balanced depth 3",
      nodes: [
        makeNode("r", ["a", "b"]),
        makeNode("a", ["c", "d"]),
        makeNode("b", ["e", "f"]),
        makeNode("c"), makeNode("d"), makeNode("e"), makeNode("f"),
      ],
      rootId: "r",
      expectedLayers: { r: 0, a: 1, b: 1, c: 2, d: 2, e: 2, f: 2 },
    },
    {
      label: "5-level chain",
      nodes: [
        makeNode("a", ["b"]), makeNode("b", ["c"]),
        makeNode("c", ["d"]), makeNode("d", ["e"]), makeNode("e"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, c: 2, d: 3, e: 4 },
    },
    {
      label: "caterpillar layers",
      nodes: [
        makeNode("a", ["b", "x"]),
        makeNode("b", ["c", "y"]),
        makeNode("c"),
        makeNode("x"),
        makeNode("y"),
      ],
      rootId: "a",
      expectedLayers: { a: 0, b: 1, x: 1, c: 2, y: 2 },
    },
    {
      label: "complete binary depth 2",
      nodes: [
        makeNode("1", ["2", "3"]),
        makeNode("2", ["4", "5"]),
        makeNode("3", ["6", "7"]),
        makeNode("4"), makeNode("5"), makeNode("6"), makeNode("7"),
      ],
      rootId: "1",
      expectedLayers: { "1": 0, "2": 1, "3": 1, "4": 2, "5": 2, "6": 2, "7": 2 },
    },
  ];

  it.each(layerCases)(
    "$label",
    ({ nodes, rootId, expectedLayers }) => {
      const result = computeTreeLayout(nodes, rootId);

      for (const ln of result.layoutNodes) {
        const expected = expectedLayers[ln.id];
        expect(ln.layer).toBe(expected);

        // Verify Y position matches layer
        const expectedY = TREE_PADDING + expected * (NODE_HEIGHT + VERTICAL_GAP);
        expect(ln.y).toBe(expectedY);
      }
    },
  );
});
