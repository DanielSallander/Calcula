// FILENAME: app/extensions/ModelEditor/components/CliReferencePane.tsx
// PURPOSE: The command line's reference guide as a right-side pane of the
//          Model Editor window (the CLI sibling of the expression editors'
//          function-reference blade). Grouped, searchable topic list; topics
//          render through the shared Markdown renderer and cross-link with
//          `topic.md` targets. Opened from the CLI panel's Reference button.

import React, { useCallback, useMemo, useState } from "react";
import { styles } from "./editorShared";
import { renderMarkdown } from "./markdownRender";
import { CLI_REFERENCE } from "../cli/referenceDocs";
import type { CliRefTopic } from "../cli/referenceDocs";

const WIDTH_KEY = "calcula.modelEditor.cliRef.width";
const MIN_WIDTH = 260;
const MAX_WIDTH = 640;

const GROUPS: Array<CliRefTopic["group"]> = ["Guide", "Verbs", "Objects"];

function loadWidth(): number {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : 380;
}

export function CliReferencePane({ onClose }: { onClose: () => void }): React.ReactElement {
  const [width, setWidth] = useState(loadWidth);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CLI_REFERENCE;
    return CLI_REFERENCE.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.markdown.toLowerCase().includes(q),
    );
  }, [query]);

  const current = selectedId ? CLI_REFERENCE.find((t) => t.id === selectedId) : null;

  const navigate = useCallback((id: string) => {
    if (CLI_REFERENCE.some((t) => t.id === id)) setSelectedId(id);
  }, []);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const move = (ev: MouseEvent): void => {
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - ev.clientX))));
      };
      const up = (ev: MouseEvent): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const finalW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (startX - ev.clientX)));
        localStorage.setItem(WIDTH_KEY, String(finalW));
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [width],
  );

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: "flex",
        minWidth: 0,
        minHeight: 0,
        borderLeft: "1px solid #ddd",
        background: "#fff",
      }}
    >
      <div
        onMouseDown={onDragStart}
        title="Drag to resize"
        style={{ width: 4, cursor: "ew-resize", flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px 6px 4px",
            borderBottom: "1px solid #eee",
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 12 }}>CLI Reference</span>
          <div style={{ flex: 1 }} />
          <button style={styles.btn} onClick={onClose} title="Close the reference pane">
            ✕
          </button>
        </div>

        {current ? (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            <div style={{ padding: "6px 10px", borderBottom: "1px solid #f0f0f0", flexShrink: 0 }}>
              <a
                style={{ color: "#2f6fce", cursor: "pointer", fontSize: 12 }}
                onClick={() => setSelectedId(null)}
              >
                &larr; All topics
              </a>
            </div>
            <div style={{ padding: "8px 12px", overflowY: "auto", flex: 1, fontSize: 13, color: "#333" }}>
              {renderMarkdown(current.markdown, navigate)}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            <div style={{ padding: 8, borderBottom: "1px solid #f0f0f0", flexShrink: 0 }}>
              <input
                style={{ ...styles.input, width: "100%" }}
                placeholder="Search the reference…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {GROUPS.map((group) => {
                const topics = filtered.filter((t) => t.group === group);
                if (topics.length === 0) return null;
                return (
                  <div key={group}>
                    <div
                      style={{
                        padding: "6px 10px 3px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#6b7280",
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                      }}
                    >
                      {group}
                    </div>
                    {topics.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        style={{ padding: "5px 10px", borderBottom: "1px solid #f4f4f4", cursor: "pointer" }}
                        title={`Open ${t.title}`}
                      >
                        <div style={{ fontWeight: 600, fontSize: 12, color: "#2f6fce" }}>{t.title}</div>
                        <div
                          style={{
                            ...styles.muted,
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t.summary}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ ...styles.muted, padding: 10, fontSize: 12 }}>
                  Nothing matches &lsquo;{query}&rsquo;.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
