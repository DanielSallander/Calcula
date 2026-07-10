// FILENAME: app/extensions/ModelEditor/components/sections/ExecutionPlanView.tsx
// PURPOSE: Execution-plan viewer for the Testing Ground: three views (Visual
//          graph / Tree / JSON) with Copy-JSON and Export-to-file, mirroring
//          Calcula Studio's plan panel. The visual view is a compact
//          left-to-right SVG node graph, color-coded per plan operation, with
//          click-to-inspect node properties.

import React, { useMemo, useState } from "react";
import { saveTextToFile } from "@api";
import type { ExecutionPlanDto, PlanNodeDto } from "@api";
import { styles } from "../editorShared";

// Color/badge per plan operation (aligned with Calcula Studio's palette).
// Keys are the engine's PascalCase PlanOperation names, verbatim.
/* eslint-disable @typescript-eslint/naming-convention */
const OP_CONFIG: Record<string, { color: string; badge: string }> = {
  Planning: { color: "#64748b", badge: "OUT" },
  PushdownDecision: { color: "#6b7280", badge: "PLAN" },
  SourceFetch: { color: "#3b82f6", badge: "DB" },
  SourceFetchCached: { color: "#10b981", badge: "MEM" },
  LocalJoin: { color: "#f59e0b", badge: "JOIN" },
  LocalAggregation: { color: "#6366f1", badge: "AGG" },
  PushedAggregation: { color: "#14b8a6", badge: "PUSH" },
  DataFusionExecution: { color: "#8b5cf6", badge: "SQL" },
  MultiGroupAggregation: { color: "#8b5cf6", badge: "SQL" },
  ContextResolution: { color: "#06b6d4", badge: "CTX" },
  MeasureEvaluation: { color: "#ec4899", badge: "CALC" },
  CalculatedColumnMaterialization: { color: "#d97706", badge: "COL" },
};
/* eslint-enable @typescript-eslint/naming-convention */
const OP_FALLBACK = { color: "#94a3b8", badge: "OP" };

type PlanViewMode = "visual" | "tree" | "json";

export function ExecutionPlanView({ plan }: { plan: ExecutionPlanDto }): React.ReactElement {
  const [mode, setMode] = useState<PlanViewMode>("visual");
  const [copied, setCopied] = useState(false);

  const planJson = useMemo(() => JSON.stringify(plan, null, 2), [plan]);

  const copyJson = (): void => {
    void navigator.clipboard.writeText(planJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportPlan = (): void => {
    void saveTextToFile({
      title: "Export Execution Plan",
      defaultName: "execution-plan.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
      content: planJson,
    });
  };

  const tabStyle = (m: PlanViewMode): React.CSSProperties => ({
    ...styles.smallBtn,
    background: mode === m ? "#2f6fce" : "#fff",
    color: mode === m ? "#fff" : "#222",
    borderColor: mode === m ? "#2f6fce" : "#bbb",
  });

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={styles.label}>Execution plan</span>
        <span style={{ ...styles.muted, fontSize: 12 }}>
          — {plan.summary} ({plan.totalMs.toFixed(1)} ms)
        </span>
        <span style={{ flex: 1 }} />
        <button style={tabStyle("visual")} onClick={() => setMode("visual")}>
          Visual
        </button>
        <button style={tabStyle("tree")} onClick={() => setMode("tree")}>
          Tree
        </button>
        <button style={tabStyle("json")} onClick={() => setMode("json")}>
          JSON
        </button>
        <span style={{ width: 8 }} />
        <button style={styles.smallBtn} onClick={copyJson}>
          {copied ? "Copied!" : "Copy JSON"}
        </button>
        <button style={styles.smallBtn} onClick={exportPlan}>
          Export…
        </button>
      </div>

      {mode === "visual" && <PlanGraph plan={plan} />}
      {mode === "tree" && (
        <div style={{ maxHeight: 340, overflow: "auto" }}>
          <PlanTreeNode node={plan.root} depth={0} />
        </div>
      )}
      {mode === "json" && (
        <pre
          style={{
            maxHeight: 340,
            overflow: "auto",
            margin: 0,
            padding: 8,
            background: "#f7f8fa",
            border: "1px solid #eee",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "Consolas, 'Cascadia Code', monospace",
          }}
        >
          {planJson}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree view (indented labels + durations + properties)
// ---------------------------------------------------------------------------

function PlanTreeNode({ node, depth }: { node: PlanNodeDto; depth: number }): React.ReactElement {
  const cfg = OP_CONFIG[node.operation] ?? OP_FALLBACK;
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div style={{ fontSize: 12, padding: "1px 0", display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            background: cfg.color,
            color: "#fff",
            borderRadius: 3,
            padding: "0 5px",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          {cfg.badge}
        </span>
        <span style={{ fontWeight: 600 }}>{node.label}</span>
        <span style={styles.muted}>
          [{node.operation}] · {node.durationMs.toFixed(1)} ms
        </span>
      </div>
      {node.properties.length > 0 && (
        <div style={{ marginLeft: 40, fontSize: 11, ...styles.muted }}>
          {node.properties.map((p, i) => (
            <div key={i}>
              {p.key}: {p.value}
            </div>
          ))}
        </div>
      )}
      {node.children.map((c, i) => (
        <PlanTreeNode key={i} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual view: compact left-to-right SVG node graph. The plan tree flows from
// its leaves (fetches) on the right INTO the root (result) on the left in
// execution order — we mirror Studio and draw the ROOT leftmost, children to
// the right, elbow edges parent→child. Click a node to inspect properties.
// ---------------------------------------------------------------------------

const NODE_W = 168;
const NODE_H = 54;
const COL_GAP = 56;
const ROW_GAP = 14;
const PAD = 14;

interface LaidOutNode {
  node: PlanNodeDto;
  /** Path of child indices from the root — a stable identity for selection. */
  id: string;
  x: number;
  y: number;
}

/** Tidy-ish tree layout: leaves get consecutive rows, parents center on their
 *  children. Returns the nodes with pixel positions plus the canvas size. */
function layoutPlan(root: PlanNodeDto): { nodes: LaidOutNode[]; width: number; height: number } {
  const nodes: LaidOutNode[] = [];
  let nextRow = 0;
  let maxDepth = 0;

  const place = (node: PlanNodeDto, id: string, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    let row: number;
    if (node.children.length === 0) {
      row = nextRow;
      nextRow += 1;
    } else {
      const childRows = node.children.map((c, i) => place(c, `${id}.${i}`, depth + 1));
      row = (childRows[0] + childRows[childRows.length - 1]) / 2;
    }
    nodes.push({
      node,
      id,
      x: PAD + depth * (NODE_W + COL_GAP),
      y: PAD + row * (NODE_H + ROW_GAP),
    });
    return row;
  };

  place(root, "0", 0);
  const width = PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
  const height = PAD * 2 + Math.max(1, nextRow) * NODE_H + Math.max(0, nextRow - 1) * ROW_GAP;
  return { nodes, width, height };
}

function PlanGraph({ plan }: { plan: ExecutionPlanDto }): React.ReactElement {
  const { nodes, width, height } = useMemo(() => layoutPlan(plan.root), [plan]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selected = selectedId ? byId.get(selectedId) : undefined;

  // Parent→child elbow edges.
  const edges: { from: LaidOutNode; to: LaidOutNode }[] = [];
  for (const n of nodes) {
    n.node.children.forEach((_, i) => {
      const child = byId.get(`${n.id}.${i}`);
      if (child) edges.push({ from: n, to: child });
    });
  }

  return (
    <div>
      <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #eee", borderRadius: 4 }}>
        <svg width={width} height={height} style={{ display: "block" }}>
          {edges.map((e, i) => {
            const x1 = e.from.x + NODE_W;
            const y1 = e.from.y + NODE_H / 2;
            const x2 = e.to.x;
            const y2 = e.to.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="#c3cad4"
                strokeWidth={1.5}
              />
            );
          })}
          {nodes.map((n) => {
            const cfg = OP_CONFIG[n.node.operation] ?? OP_FALLBACK;
            const isSel = n.id === selectedId;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: "pointer" }}
                onClick={() => setSelectedId(isSel ? null : n.id)}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="#fff"
                  stroke={isSel ? "#2f6fce" : "#d7dbe0"}
                  strokeWidth={isSel ? 2 : 1}
                />
                <rect width={4} height={NODE_H} rx={2} fill={cfg.color} />
                <rect x={10} y={8} width={34} height={14} rx={3} fill={cfg.color} />
                <text x={27} y={18.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#fff">
                  {cfg.badge}
                </text>
                <text x={50} y={19} fontSize={10} fill="#667">
                  {n.node.durationMs.toFixed(1)} ms
                </text>
                <text x={10} y={38} fontSize={11} fontWeight={600} fill="#223">
                  {n.node.label.length > 26 ? `${n.node.label.slice(0, 25)}…` : n.node.label}
                  <title>{n.node.label}</title>
                </text>
                <text x={10} y={49} fontSize={9} fill="#99a">
                  {n.node.operation}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected && (
        <div
          style={{
            marginTop: 6,
            padding: 8,
            background: "#f7f8fa",
            border: "1px solid #eee",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {selected.node.label}{" "}
            <span style={styles.muted}>
              [{selected.node.operation}] · {selected.node.durationMs.toFixed(1)} ms
            </span>
          </div>
          {selected.node.properties.length === 0 ? (
            <div style={styles.muted}>No properties.</div>
          ) : (
            selected.node.properties.map((p, i) => (
              <div key={i}>
                <span style={styles.muted}>{p.key}: </span>
                {p.value}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
