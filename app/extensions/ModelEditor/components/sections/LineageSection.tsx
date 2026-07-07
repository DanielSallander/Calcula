// FILENAME: app/extensions/ModelEditor/components/sections/LineageSection.tsx
// PURPOSE: Lineage section of the Model Editor window: a model-wide dependency
//          graph over the expression-bearing entities (measures, global
//          variables, calculated columns, context columns). Renders a layered
//          SVG (dependencies to the left, dependants to the right); clicking a
//          node focuses it and lists what it depends on and what uses it.

import React, { useEffect, useMemo, useState } from "react";
import { biModelDependencyGraph } from "@api";
import type { DependencyGraphDto, DependencyNodeDto } from "@api";
import { styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

const NODE_W = 176;
const NODE_H = 38;
const COL_GAP = 220;
const ROW_GAP = 58;
const PAD = 20;

const TYPE_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  measure: { bg: "#e8f0fd", border: "#2f6fce", label: "Measure" },
  globalVariable: { bg: "#f0e8fd", border: "#7a3fce", label: "Global" },
  calculatedColumn: { bg: "#e6f6ea", border: "#2c9a4a", label: "Calc column" },
  contextColumn: { bg: "#fdf0e1", border: "#c9781f", label: "Context column" },
};

interface Positioned {
  node: DependencyNodeDto;
  x: number;
  y: number;
}

export function LineageSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, reportError } = ctx;
  // Tag the fetched graph with its connection so a stale result is ignored and
  // "loading" is derived (no synchronous setState in the effect body).
  const [tagged, setTagged] = useState<{ connId: string; data: DependencyGraphDto } | null>(null);
  const [failedConn, setFailedConn] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!connectionId) return;
    biModelDependencyGraph(connectionId)
      .then((g) => {
        if (!cancelled) {
          setTagged({ connId: connectionId, data: g });
          setFocus(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailedConn(connectionId);
          reportError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, reportError]);

  const graph = tagged && tagged.connId === connectionId ? tagged.data : null;
  const loading = !graph && failedConn !== connectionId;

  // Longest-path layering: a node's layer is 1 + the max layer of the nodes it
  // depends on (0 for leaves). Dependencies end up to the left of dependants.
  const { positioned, byId, width, height } = useMemo(() => {
    const empty = { positioned: [] as Positioned[], byId: new Map<string, Positioned>(), width: 0, height: 0 };
    if (!graph) return empty;
    const outs = new Map<string, string[]>();
    graph.edges.forEach((e) => {
      const arr = outs.get(e.fromId) ?? [];
      arr.push(e.toId);
      outs.set(e.fromId, arr);
    });
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const depth = (id: string): number => {
      const cached = layer.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      let d = 0;
      for (const t of outs.get(id) ?? []) d = Math.max(d, 1 + depth(t));
      visiting.delete(id);
      layer.set(id, d);
      return d;
    };
    graph.nodes.forEach((n) => depth(n.id));

    const byLayer = new Map<number, DependencyNodeDto[]>();
    graph.nodes.forEach((n) => {
      const l = layer.get(n.id) ?? 0;
      const arr = byLayer.get(l) ?? [];
      arr.push(n);
      byLayer.set(l, arr);
    });

    const positioned: Positioned[] = [];
    const byId = new Map<string, Positioned>();
    let maxRows = 0;
    const maxLayer = Math.max(0, ...graph.nodes.map((n) => layer.get(n.id) ?? 0));
    byLayer.forEach((ns, l) => {
      maxRows = Math.max(maxRows, ns.length);
      ns.forEach((node, i) => {
        // Dependencies (low layer) on the left, dependants (high layer) right.
        const x = PAD + (maxLayer - l) * COL_GAP;
        const y = PAD + i * ROW_GAP;
        const p: Positioned = { node, x, y };
        positioned.push(p);
        byId.set(node.id, p);
      });
    });
    const width = PAD * 2 + (maxLayer + 1) * COL_GAP;
    const height = PAD * 2 + Math.max(1, maxRows) * ROW_GAP;
    return { positioned, byId, width, height };
  }, [graph]);

  const neighbors = useMemo(() => {
    const dependsOn: DependencyNodeDto[] = [];
    const usedBy: DependencyNodeDto[] = [];
    if (graph && focus) {
      const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
      graph.edges.forEach((e) => {
        if (e.fromId === focus) {
          const n = nodeById.get(e.toId);
          if (n) dependsOn.push(n);
        }
        if (e.toId === focus) {
          const n = nodeById.get(e.fromId);
          if (n) usedBy.push(n);
        }
      });
    }
    return { dependsOn, usedBy };
  }, [graph, focus]);

  const isConnected = (id: string): boolean => {
    if (!focus || !graph) return false;
    if (id === focus) return true;
    return graph.edges.some(
      (e) => (e.fromId === focus && e.toId === id) || (e.toId === focus && e.fromId === id),
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Lineage</span>
        <div style={{ display: "flex", gap: 8 }}>
          {Object.entries(TYPE_COLORS).map(([k, c]) => (
            <span key={k} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: c.bg,
                  border: `1px solid ${c.border}`,
                }}
              />
              {c.label}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ ...styles.card, flex: 1, overflow: "auto", padding: 0, position: "relative" }}>
          {loading && <div style={{ ...styles.muted, padding: 10 }}>Loading dependency graph…</div>}
          {!loading && !graph && (
            <div style={{ ...styles.muted, padding: 10 }}>Could not load the dependency graph.</div>
          )}
          {!loading && graph && graph.nodes.length === 0 && (
            <div style={{ ...styles.muted, padding: 10 }}>
              No expression-bearing entities yet — add measures, calculated columns, globals or
              context columns.
            </div>
          )}
          {!loading && graph && graph.nodes.length > 0 && (
            <svg width={width} height={height} style={{ display: "block" }}>
              {/* Edges: from dependant to dependency. */}
              {graph.edges.map((e, i) => {
                const from = byId.get(e.fromId);
                const to = byId.get(e.toId);
                if (!from || !to) return null;
                const x1 = from.x;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x + NODE_W;
                const y2 = to.y + NODE_H / 2;
                const active = focus && (e.fromId === focus || e.toId === focus);
                const mx = (x1 + x2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke={active ? "#2f6fce" : "#c7cdd6"}
                    strokeWidth={active ? 2 : 1}
                  />
                );
              })}
              {/* Nodes. */}
              {positioned.map((p) => {
                const c = TYPE_COLORS[p.node.nodeType] ?? {
                  bg: "#eee",
                  border: "#999",
                  label: p.node.nodeType,
                };
                const dim = focus ? !isConnected(p.node.id) : false;
                return (
                  <g
                    key={p.node.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    style={{ cursor: "pointer", opacity: dim ? 0.35 : 1 }}
                    onClick={() => setFocus(p.node.id === focus ? null : p.node.id)}
                  >
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={4}
                      fill={c.bg}
                      stroke={p.node.id === focus ? "#111" : c.border}
                      strokeWidth={p.node.id === focus ? 2 : 1}
                    />
                    <text x={8} y={16} fontSize={12} fontWeight={600} fill="#222">
                      {truncate(p.node.name, 22)}
                    </text>
                    <text x={8} y={30} fontSize={10} fill="#777">
                      {p.node.table ?? c.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Detail panel */}
        <div style={{ ...styles.card, width: 240, flexShrink: 0, overflowY: "auto" }}>
          {!focus && <div style={styles.hint}>Click a node to see its lineage.</div>}
          {focus && graph && (
            <FocusDetail
              node={graph.nodes.find((n) => n.id === focus) ?? null}
              dependsOn={neighbors.dependsOn}
              usedBy={neighbors.usedBy}
              onPick={setFocus}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FocusDetail({
  node,
  dependsOn,
  usedBy,
  onPick,
}: {
  node: DependencyNodeDto | null;
  dependsOn: DependencyNodeDto[];
  usedBy: DependencyNodeDto[];
  onPick: (id: string) => void;
}): React.ReactElement {
  if (!node) return <div style={styles.hint}>Node not found.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{node.name}</div>
        <div style={styles.muted}>
          {(TYPE_COLORS[node.nodeType]?.label ?? node.nodeType) + (node.table ? ` · ${node.table}` : "")}
        </div>
      </div>
      {node.expression && (
        <div style={{ ...styles.muted, fontFamily: "Consolas, monospace", fontSize: 11, wordBreak: "break-word" }}>
          {node.expression}
        </div>
      )}
      <RefList title="Depends on" refs={dependsOn} onPick={onPick} empty="Nothing." />
      <RefList title="Used by" refs={usedBy} onPick={onPick} empty="Nothing references it." />
    </div>
  );
}

function RefList({
  title,
  refs,
  onPick,
  empty,
}: {
  title: string;
  refs: DependencyNodeDto[];
  onPick: (id: string) => void;
  empty: string;
}): React.ReactElement {
  return (
    <div>
      <div style={styles.label}>{title}</div>
      {refs.length === 0 ? (
        <div style={styles.hint}>{empty}</div>
      ) : (
        refs.map((r) => (
          <div
            key={r.id}
            style={{ ...styles.listRow, padding: "3px 6px" }}
            onClick={() => onPick(r.id)}
            title={r.expression ?? undefined}
          >
            {r.name}
            <span style={styles.muted}> · {TYPE_COLORS[r.nodeType]?.label ?? r.nodeType}</span>
          </div>
        ))
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
