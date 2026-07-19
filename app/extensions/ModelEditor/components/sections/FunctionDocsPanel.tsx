// FILENAME: app/extensions/ModelEditor/components/sections/FunctionDocsPanel.tsx
// PURPOSE: A wiki-like function-reference pane for the model expression
//          editors. Lists the engine's built-in functions (embedded into the
//          engine at BUILD time from its docs/functions/(category)/*.md),
//          grouped into collapsible per-category sections, and renders the
//          selected function's Markdown doc in a reader-friendly way, with
//          clickable cross-links between docs.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionDocDto } from "@api";
import { styles } from "../editorShared";
import { linkStyle, renderMarkdown } from "../markdownRender";


/** First non-heading, non-blank line of a doc — a one-line summary for the list. */
function summaryOf(md: string): string {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#")) return line.replace(/[*`]/g, "");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

// The panel is frameless: it fills whatever container it is placed in (the
// expression workspace mounts it inside a resizable/collapsible "Function
// reference" blade that supplies the title bar and collapse control), so it
// only owns the search box and the doc reader.
export function FunctionDocsPanel({
  docs,
  loading,
  onInsert,
}: {
  docs: FunctionDocDto[];
  loading: boolean;
  /** When set, double-clicking a function (or dragging it onto the editor)
   *  inserts `NAME(` at the cursor — the open paren triggers signature help. */
  onInsert?: (text: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // Opening the doc on single click UNMOUNTS the list row, so a double-click
  // could never land on it — when insertion is available, the open is delayed
  // one double-click window and cancelled by an actual double-click.
  const clickTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    },
    [],
  );
  const openDoc = (docName: string): void => {
    if (!onInsert) {
      setSelected(docName);
      return;
    }
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      setSelected(docName);
    }, 250);
  };
  const insertFromList = (docName: string): void => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    onInsert?.(`${docName}(`);
  };

  // Category sections start expanded; a header click toggles. While a search
  // query is active the collapse state is ignored so matches are never hidden.
  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim().length > 0;
  const toggleCategory = (category: string): void => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        summaryOf(d.markdown).toLowerCase().includes(q),
    );
  }, [docs, query]);

  // The docs arrive pre-grouped from the engine (categories in the docs
  // README's index order, names sorted within each), so grouping consecutive
  // runs preserves the canonical category order — also after filtering.
  const groups = useMemo(() => {
    const out: { category: string; docs: FunctionDocDto[] }[] = [];
    for (const d of filtered) {
      const last = out[out.length - 1];
      if (last && last.category === d.category) last.docs.push(d);
      else out.push({ category: d.category, docs: [d] });
    }
    return out;
  }, [filtered]);

  const current = selected ? docs.find((d) => d.name === selected) : null;
  const navigate = (name: string): void => {
    if (docs.some((d) => d.name === name)) setSelected(name);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
      }}
    >
      {current ? (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div
            style={{
              padding: "6px 8px",
              borderBottom: "1px solid #f0f0f0",
              display: "flex",
              gap: 10,
            }}
          >
            <a style={linkStyle} onClick={() => setSelected(null)}>
              &larr; All functions
            </a>
            <span style={{ ...styles.muted, fontSize: 11, alignSelf: "center" }}>{current.category}</span>
            {onInsert && (
              <a
                style={{ ...linkStyle, marginLeft: "auto" }}
                title={`Insert ${current.name}( at the cursor`}
                onClick={() => onInsert(`${current.name}(`)}
              >
                Insert
              </a>
            )}
          </div>
          <div style={{ padding: "8px 12px", overflowY: "auto", flex: 1, fontSize: 13, color: "#333" }}>
            {renderMarkdown(current.markdown, navigate)}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>
            <input
              style={{ ...styles.input, width: "100%" }}
              placeholder="Search functions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {loading && <div style={{ ...styles.muted, padding: 10, fontSize: 12 }}>Loading…</div>}
            {!loading && docs.length === 0 && (
              <div style={{ ...styles.muted, padding: 10, fontSize: 12 }}>
                No function docs found (none were embedded in this engine build).
              </div>
            )}
            {groups.map((group) => {
              const isCollapsed = !searching && collapsedCategories.has(group.category);
              return (
                <div key={group.category}>
                  <div
                    onClick={() => toggleCategory(group.category)}
                    title={isCollapsed ? `Expand ${group.category}` : `Collapse ${group.category}`}
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 10px",
                      background: "#f7f8fa",
                      borderBottom: "1px solid #e8e8e8",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <span style={{ fontSize: 9, color: "#888", width: 10 }}>
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: 11, color: "#555" }}>{group.category}</span>
                    <span style={{ ...styles.muted, fontSize: 10, marginLeft: "auto" }}>{group.docs.length}</span>
                  </div>
                  {!isCollapsed &&
                    group.docs.map((d) => (
                      <div
                        key={d.name}
                        onClick={() => openDoc(d.name)}
                        onDoubleClick={() => insertFromList(d.name)}
                        draggable={Boolean(onInsert)}
                        onDragStart={(e) => {
                          // The editor's drop handler accepts plain text — same
                          // channel the tables & columns tree uses.
                          e.dataTransfer.setData("text/plain", `${d.name}(`);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        style={{
                          padding: "6px 10px",
                          borderBottom: "1px solid #f2f2f2",
                          cursor: "pointer",
                        }}
                        title={
                          onInsert
                            ? `Open ${d.name} — double-click or drag onto the editor to insert`
                            : `Open ${d.name}`
                        }
                      >
                        <div style={{ fontWeight: 600, fontSize: 12, color: "#2f6fce" }}>{d.name}</div>
                        <div
                          style={{
                            ...styles.muted,
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {summaryOf(d.markdown)}
                        </div>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
