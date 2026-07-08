// FILENAME: app/extensions/ModelEditor/components/diagram/layoutEngine.ts
// PURPOSE: Deterministic auto-layout for the relationship diagram. Replaces the
//          old manual drag + localStorage positioning. Semantic models are
//          almost always star/snowflake, so the default ("auto") centers the
//          fact table and orbits its dimensions on concentric rings (RADIAL);
//          multi-fact / flat / cyclic schemas fall back to a layered
//          (Sugiyama-lite) arrangement. Positions are computed from
//          tables+relationships alone (a pure function called inside a useMemo)
//          — nothing is stored, so the same model always draws the same shape.
//
// FACT DETECTION (the subtle part): in this codebase `fromTable` is the MANY
// side and `toTable` is the ONE side of a relationship (see the RelationshipModal
// "From table (many side)" / "To table (one side)" labels). A star's fact table
// holds the foreign keys, so a Fact->Dim join is manyToOne with fromTable=Fact.
// The fact is therefore the table that appears most often on the MANY side — NOT
// the many-to-one target. We score each table by its many-side participation.

import type { ModelRelationshipInfo, ModelTableInfo } from "@api";
import { getNodeHeight, getNodeWidth, NODE_WIDTH } from "./nodeGeometry";

export interface Position {
  x: number;
  y: number;
}

/** "auto" picks radial for star-shaped components, layered otherwise. */
export type LayoutMode = "auto" | "radial" | "layered";

// Snap grid — a clean factor of the 40px SVG background grid so nodes and edge
// bends land on visible sub-grid lines.
export const GRID = 20;
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

const RING_MARGIN = 70; // clear space between a ring's nodes and the ring inside it
const ARC_MARGIN = 44; // clear space between two adjacent nodes on the same ring
const LAYER_GAP = 160; // horizontal gap between layers (added to per-layer width)
const LAYER_GAP_Y = 60; // vertical gap added between stacked nodes in a layer
const COMPONENT_MARGIN = 120; // gap between packed disconnected components
const PAD = 40; // padding from the canvas top-left origin

interface LocalBox {
  pos: Map<string, Position>;
  w: number;
  h: number;
  nodes: string[];
}

// Radius of the circle that circumscribes a node's rectangle. If two nodes'
// circumscribing circles are disjoint, the rectangles cannot overlap — so using
// this for ring/arc spacing guarantees a non-overlapping radial layout for
// nodes of any height (fact tables with many columns are tall).
function nodeCircle(t: ModelTableInfo): number {
  return 0.5 * Math.hypot(getNodeWidth(t), getNodeHeight(t));
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/** True when the two names are the same non-empty table (self relationship). */
function isSelfRel(rel: ModelRelationshipInfo): boolean {
  return rel.fromTable === rel.toTable;
}

/** Undirected adjacency over real (non-self) relationships; every table is a key. */
function buildAdjacency(
  tables: ModelTableInfo[],
  relationships: ModelRelationshipInfo[],
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const t of tables) adj.set(t.name, new Set<string>());
  for (const rel of relationships) {
    if (isSelfRel(rel)) continue;
    const a = adj.get(rel.fromTable);
    const b = adj.get(rel.toTable);
    if (!a || !b) continue; // dangling reference — ignore
    a.add(rel.toTable);
    b.add(rel.fromTable);
  }
  return adj;
}

/**
 * Many-side participation per table. The fact table of a star scores highest
 * because it is on the many side of a join to each of its dimensions.
 *   manyToOne  -> fromTable is the many side
 *   oneToMany  -> toTable   is the many side
 */
function buildManySideScore(relationships: ModelRelationshipInfo[]): Map<string, number> {
  const score = new Map<string, number>();
  const bump = (name: string): void => {
    score.set(name, (score.get(name) ?? 0) + 1);
  };
  for (const rel of relationships) {
    if (isSelfRel(rel)) continue;
    if (rel.cardinality === "manyToOne") bump(rel.fromTable);
    else if (rel.cardinality === "oneToMany") bump(rel.toTable);
  }
  return score;
}

/** Connected components (undirected). Isolated tables are size-1 components. */
function connectedComponents(tables: ModelTableInfo[], adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  // Stable iteration order (sorted by name) so re-fetches don't reshuffle.
  const names = tables.map((t) => t.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const start of names) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function pickFact(
  comp: string[],
  manyScore: Map<string, number>,
  adj: Map<string, Set<string>>,
): string {
  // argmax by (many-side score, undirected degree, name asc for determinism).
  let best = comp[0];
  let bestScore = -1;
  let bestDeg = -1;
  for (const name of comp) {
    const s = manyScore.get(name) ?? 0;
    const deg = adj.get(name)?.size ?? 0;
    if (
      s > bestScore ||
      (s === bestScore && deg > bestDeg) ||
      (s === bestScore && deg === bestDeg && name < best)
    ) {
      best = name;
      bestScore = s;
      bestDeg = deg;
    }
  }
  return best;
}

/** Star iff exactly one table in the component sits on the many side ≥2 times. */
function isStar(comp: string[], manyScore: Map<string, number>): boolean {
  const hubs = comp.filter((n) => (manyScore.get(n) ?? 0) >= 2);
  return hubs.length === 1;
}

// ---------------------------------------------------------------------------
// Radial layout (default for star / snowflake components)
// ---------------------------------------------------------------------------

function radialLayout(
  comp: string[],
  tableByName: Map<string, ModelTableInfo>,
  adj: Map<string, Set<string>>,
  manyScore: Map<string, number>,
): Map<string, Position> {
  const pos = new Map<string, Position>();
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  const fact = pickFact(comp, manyScore, adj);

  // BFS depth + parent from the fact.
  const depth = new Map<string, number>();
  const parent = new Map<string, string | null>();
  depth.set(fact, 0);
  parent.set(fact, null);
  const queue = [fact];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const neighbors = [...(adj.get(cur) ?? [])].sort(cmp);
    for (const nb of neighbors) {
      if (!depth.has(nb)) {
        depth.set(nb, (depth.get(cur) ?? 0) + 1);
        parent.set(nb, cur);
        queue.push(nb);
      }
    }
  }

  // Place the fact at the local origin (center).
  const factTable = tableByName.get(fact) as ModelTableInfo;
  pos.set(fact, { x: -getNodeWidth(factTable) / 2, y: -getNodeHeight(factTable) / 2 });
  const angleOf = new Map<string, number>();
  angleOf.set(fact, 0);

  // Group by depth and lay each ring out so its nodes clear both the ring
  // inside it (radial spacing) and their neighbours on the ring (arc spacing).
  const maxDepth = Math.max(0, ...[...depth.values()]);
  let prevRadius = 0;
  let prevCircle = nodeCircle(factTable); // the center node's circle

  for (let d = 1; d <= maxDepth; d++) {
    const ring = comp.filter((n) => depth.get(n) === d);
    // Order siblings by their parent's angle (keeps children near parents),
    // then by name for determinism.
    ring.sort((a, b) => {
      const pa = angleOf.get(parent.get(a) ?? "") ?? 0;
      const pb = angleOf.get(parent.get(b) ?? "") ?? 0;
      return pa - pb || cmp(a, b);
    });
    const n = ring.length;
    const ringCircle = Math.max(
      ...ring.map((nm) => nodeCircle(tableByName.get(nm) as ModelTableInfo)),
    );
    // Radial clearance: this ring's inner edge must clear the previous ring's
    // (or the center's) outer edge by RING_MARGIN.
    let radius = prevRadius + prevCircle + RING_MARGIN + ringCircle;
    // Arc clearance: two adjacent nodes are 2*r*sin(pi/n) apart (chord); keep
    // that at least the sum of their circles plus a margin.
    if (n > 1) {
      const needed = (2 * ringCircle + ARC_MARGIN) / (2 * Math.sin(Math.PI / n));
      if (radius < needed) radius = needed;
    }
    // Rotate odd rings a half-step to reduce spoke overlap between rings.
    const depthOffset = d % 2 === 0 ? 0 : Math.PI / n;
    for (let i = 0; i < n; i++) {
      const name = ring[i];
      const angle = depthOffset + (2 * Math.PI * i) / n;
      angleOf.set(name, angle);
      const cx = radius * Math.cos(angle);
      const cy = radius * Math.sin(angle);
      const nt = tableByName.get(name) as ModelTableInfo;
      pos.set(name, { x: cx - getNodeWidth(nt) / 2, y: cy - getNodeHeight(nt) / 2 });
    }
    prevRadius = radius;
    prevCircle = ringCircle;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Layered layout (fallback: multi-fact / flat / cyclic components)
// ---------------------------------------------------------------------------

function layeredLayout(
  comp: string[],
  tableByName: Map<string, ModelTableInfo>,
  relationships: ModelRelationshipInfo[],
): Map<string, Position> {
  const inComp = new Set(comp);
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  // Directed edges along the many->one axis (the "one" side is downstream).
  //   manyToOne -> from->to ; oneToMany -> to->from ; oneToOne -> from->to.
  //   manyToMany is skipped for layering (still drawn as an edge elsewhere).
  const children = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of comp) {
    children.set(n, new Set<string>());
    indeg.set(n, 0);
  }
  const addEdge = (u: string, v: string): void => {
    if (!inComp.has(u) || !inComp.has(v) || u === v) return;
    const set = children.get(u) as Set<string>;
    if (!set.has(v)) {
      set.add(v);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  };
  for (const rel of relationships) {
    if (isSelfRel(rel)) continue;
    if (rel.cardinality === "manyToOne" || rel.cardinality === "oneToOne")
      addEdge(rel.fromTable, rel.toTable);
    else if (rel.cardinality === "oneToMany") addEdge(rel.toTable, rel.fromTable);
  }

  // Longest-path layering via Kahn's topological order.
  const layer = new Map<string, number>();
  for (const n of comp) layer.set(n, 0);
  const remaining = new Map(indeg);
  const ready = comp.filter((n) => (remaining.get(n) ?? 0) === 0).sort(cmp);
  const processed = new Set<string>();
  while (ready.length > 0) {
    const u = ready.shift() as string;
    if (processed.has(u)) continue;
    processed.add(u);
    for (const v of [...(children.get(u) as Set<string>)].sort(cmp)) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
      remaining.set(v, (remaining.get(v) ?? 0) - 1);
      if ((remaining.get(v) ?? 0) === 0) ready.push(v);
    }
    ready.sort(cmp);
  }
  // Any nodes left in a cycle: park them one layer past the current max.
  const leftover = comp.filter((n) => !processed.has(n)).sort(cmp);
  if (leftover.length > 0) {
    const maxLayer = Math.max(0, ...[...layer.values()]);
    leftover.forEach((n, i) => layer.set(n, maxLayer + 1 + Math.floor(i / 6)));
  }

  // Bucket into layers.
  const byLayer = new Map<number, string[]>();
  for (const n of comp) {
    const l = layer.get(n) ?? 0;
    const bucket = byLayer.get(l) ?? [];
    bucket.push(n);
    byLayer.set(l, bucket);
  }
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  for (const l of layerKeys) (byLayer.get(l) as string[]).sort(cmp);

  // Barycenter ordering (2 passes) to reduce crossings against the prev layer.
  for (let pass = 0; pass < 2; pass++) {
    for (let li = 1; li < layerKeys.length; li++) {
      const prev = byLayer.get(layerKeys[li - 1]) as string[];
      const prevIndex = new Map(prev.map((n, i) => [n, i] as const));
      const cur = byLayer.get(layerKeys[li]) as string[];
      const bary = (n: string): number => {
        // neighbors in the previous layer (either direction).
        const linked: number[] = [];
        for (const rel of relationships) {
          if (isSelfRel(rel)) continue;
          let other: string | null = null;
          if (rel.fromTable === n && prevIndex.has(rel.toTable)) other = rel.toTable;
          else if (rel.toTable === n && prevIndex.has(rel.fromTable)) other = rel.fromTable;
          if (other !== null) linked.push(prevIndex.get(other) as number);
        }
        if (linked.length === 0) return Number.MAX_SAFE_INTEGER; // keep unlinked at the end
        return linked.reduce((s, v) => s + v, 0) / linked.length;
      };
      cur.sort((a, b) => bary(a) - bary(b) || cmp(a, b));
    }
  }

  // Positions: each layer is a column; nodes stack vertically. Shorter layers
  // are centered against the tallest so the arrangement reads symmetrically.
  // Column x is cumulative — each layer is as wide as its widest node.
  const layerHeights = layerKeys.map((l) => {
    const nodes = byLayer.get(l) as string[];
    return nodes.reduce(
      (s, n) => s + getNodeHeight(tableByName.get(n) as ModelTableInfo) + LAYER_GAP_Y,
      -LAYER_GAP_Y,
    );
  });
  const layerWidths = layerKeys.map((l) => {
    const nodes = byLayer.get(l) as string[];
    return Math.max(...nodes.map((n) => getNodeWidth(tableByName.get(n) as ModelTableInfo)));
  });
  const layerX: number[] = [];
  let xCursor = 0;
  layerKeys.forEach((_, li) => {
    layerX[li] = xCursor;
    xCursor += layerWidths[li] + LAYER_GAP;
  });
  const maxH = Math.max(0, ...layerHeights);
  const pos = new Map<string, Position>();
  layerKeys.forEach((l, li) => {
    const nodes = byLayer.get(l) as string[];
    let y = (maxH - layerHeights[li]) / 2;
    for (const n of nodes) {
      pos.set(n, { x: layerX[li], y });
      y += getNodeHeight(tableByName.get(n) as ModelTableInfo) + LAYER_GAP_Y;
    }
  });
  return pos;
}

// ---------------------------------------------------------------------------
// Component normalization + packing
// ---------------------------------------------------------------------------

function toLocalBox(
  comp: string[],
  local: Map<string, Position>,
  tableByName: Map<string, ModelTableInfo>,
): LocalBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of comp) {
    const p = local.get(n);
    if (!p) continue;
    const t = tableByName.get(n) as ModelTableInfo;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + getNodeWidth(t));
    maxY = Math.max(maxY, p.y + getNodeHeight(t));
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = NODE_WIDTH;
    maxY = 60;
  }
  // Shift so the component's box starts at (0,0).
  const shifted = new Map<string, Position>();
  for (const n of comp) {
    const p = local.get(n);
    if (p) shifted.set(n, { x: p.x - minX, y: p.y - minY });
  }
  return { pos: shifted, w: maxX - minX, h: maxY - minY, nodes: comp };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeLayout(
  tables: ModelTableInfo[],
  relationships: ModelRelationshipInfo[],
  mode: LayoutMode = "auto",
): Record<string, Position> {
  const result: Record<string, Position> = {};
  if (tables.length === 0) return result;

  const tableByName = new Map(tables.map((t) => [t.name, t] as const));
  const adj = buildAdjacency(tables, relationships);
  const manyScore = buildManySideScore(relationships);
  const comps = connectedComponents(tables, adj);

  // Lay out each component locally, then normalize to a (0,0)-anchored box.
  const boxes: LocalBox[] = comps.map((comp) => {
    const useRadial = mode === "radial" || (mode === "auto" && isStar(comp, manyScore));
    const local =
      comp.length <= 1
        ? new Map<string, Position>([[comp[0], { x: 0, y: 0 }]])
        : useRadial
          ? radialLayout(comp, tableByName, adj, manyScore)
          : layeredLayout(comp, tableByName, relationships);
    return toLocalBox(comp, local, tableByName);
  });

  // Pack components in a stable grid (largest first for a tidy top-left).
  boxes.sort((a, b) => b.nodes.length - a.nodes.length || (a.nodes[0] < b.nodes[0] ? -1 : 1));
  const cols = Math.max(1, Math.ceil(Math.sqrt(boxes.length)));
  let colCursorX = 0;
  let rowY = 0;
  let rowMaxH = 0;
  let colInRow = 0;
  for (const box of boxes) {
    if (colInRow === cols) {
      rowY += rowMaxH + COMPONENT_MARGIN;
      colCursorX = 0;
      rowMaxH = 0;
      colInRow = 0;
    }
    const offX = colCursorX + PAD;
    const offY = rowY + PAD;
    for (const n of box.nodes) {
      const p = box.pos.get(n);
      if (p) result[n] = { x: snap(p.x + offX), y: snap(p.y + offY) };
    }
    colCursorX += box.w + COMPONENT_MARGIN;
    rowMaxH = Math.max(rowMaxH, box.h);
    colInRow++;
  }
  return result;
}
