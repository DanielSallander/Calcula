//! FILENAME: app/extensions/BuiltIn/CollectionPreview/components/CollectionPreviewPanel.tsx
// PURPOSE: React component for the Collection Preview task pane.
// CONTEXT: Renders the structured contents of a List or Dict cell in a tree view.

import React, { useEffect, useState, useCallback } from "react";
import type { TaskPaneViewProps } from "../../../../src/api/uiTypes";
import { getGridStateSnapshot } from "../../../../src/api/grid";
import {
  getCellCollection,
  type CollectionItem,
  type CollectionPreviewResult,
} from "../../../../src/api/lib";
import { onAppEvent, AppEvents } from "../../../../src/api/events";
import { ExtensionRegistry } from "../../../../src/api/extensions";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    padding: "8px 12px",
    fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    fontSize: "12px",
    color: "#1e1e1e",
    height: "100%",
    overflow: "auto",
  } as React.CSSProperties,
  header: {
    fontSize: "13px",
    fontWeight: 600,
    marginBottom: "8px",
    color: "#333",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  } as React.CSSProperties,
  badge: {
    fontSize: "11px",
    fontWeight: 400,
    color: "#666",
    background: "#f0f0f0",
    borderRadius: "3px",
    padding: "1px 6px",
  } as React.CSSProperties,
  empty: {
    color: "#999",
    fontStyle: "italic" as const,
    padding: "16px 0",
  } as React.CSSProperties,
  listItem: {
    display: "flex",
    alignItems: "flex-start",
    padding: "2px 0",
    borderBottom: "1px solid #f0f0f0",
  } as React.CSSProperties,
  index: {
    color: "#888",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
    minWidth: "28px",
    textAlign: "right" as const,
    paddingRight: "8px",
    flexShrink: 0,
    userSelect: "none" as const,
  } as React.CSSProperties,
  dictKey: {
    color: "#0070c1",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
    minWidth: "60px",
    paddingRight: "8px",
    flexShrink: 0,
    fontWeight: 500,
  } as React.CSSProperties,
  value: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
    color: "#1e1e1e",
    wordBreak: "break-all" as const,
  } as React.CSSProperties,
  nestedContainer: {
    marginLeft: "16px",
    borderLeft: "2px solid #e0e0e0",
    paddingLeft: "8px",
  } as React.CSSProperties,
  expandToggle: {
    cursor: "pointer",
    userSelect: "none" as const,
    color: "#666",
    fontSize: "10px",
    marginRight: "4px",
    width: "12px",
    display: "inline-block",
    textAlign: "center" as const,
  } as React.CSSProperties,
  cellRef: {
    fontSize: "11px",
    color: "#999",
    marginBottom: "4px",
  } as React.CSSProperties,
};

// ============================================================================
// Sub-components
// ============================================================================

const ScalarValue: React.FC<{ display: string }> = ({ display }) => {
  if (!display) {
    return <span style={{ ...styles.value, color: "#ccc" }}>(empty)</span>;
  }
  // Color strings differently from numbers/booleans
  const isString = display.startsWith('"') && display.endsWith('"');
  const isBool = display === "TRUE" || display === "FALSE";
  const color = isString ? "#a31515" : isBool ? "#0000ff" : "#1e1e1e";
  return <span style={{ ...styles.value, color }}>{display}</span>;
};

const CollectionItemView: React.FC<{
  item: CollectionItem;
  depth: number;
}> = ({ item, depth }) => {
  const [expanded, setExpanded] = useState(depth < 2);

  if (item.type === "scalar") {
    return <ScalarValue display={item.display || ""} />;
  }

  if (item.type === "list") {
    const count = item.count || 0;
    return (
      <div>
        <span
          style={styles.expandToggle}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={styles.badge}>List({count})</span>
        {expanded && item.items && (
          <div style={styles.nestedContainer}>
            {item.items.map((child, i) => (
              <div key={i} style={styles.listItem}>
                <span style={styles.index}>{i}</span>
                <CollectionItemView item={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (item.type === "dict") {
    const count = item.count || 0;
    return (
      <div>
        <span
          style={styles.expandToggle}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={styles.badge}>Dict({count})</span>
        {expanded && item.entries && (
          <div style={styles.nestedContainer}>
            {item.entries.map((entry, i) => (
              <div key={i} style={styles.listItem}>
                <span style={styles.dictKey}>{entry.key}</span>
                <CollectionItemView item={entry.value} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
};

// ============================================================================
// Main Panel
// ============================================================================

export const CollectionPreviewPanel: React.ComponentType<TaskPaneViewProps> = ({
  data,
}) => {
  const [preview, setPreview] = useState<CollectionPreviewResult | null>(null);
  const [cellRef, setCellRef] = useState<string>("");

  const loadPreview = useCallback(async () => {
    const state = getGridStateSnapshot();
    if (!state?.selection) {
      setPreview(null);
      setCellRef("");
      return;
    }

    const { startRow, startCol } = state.selection;
    const colLetter = indexToColLetter(startCol);
    setCellRef(`${colLetter}${startRow + 1}`);

    try {
      const result = await getCellCollection(startRow, startCol);
      if (result.cellType === "list" || result.cellType === "dict") {
        setPreview(result);
      } else {
        setPreview(null);
      }
    } catch {
      setPreview(null);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  // Re-load when data changes (from openTaskPane)
  useEffect(() => {
    if (data?.row !== undefined) {
      loadPreview();
    }
  }, [data, loadPreview]);

  // Listen for selection changes via ExtensionRegistry
  useEffect(() => {
    const unsub = ExtensionRegistry.onSelectionChange(() => {
      loadPreview();
    });
    return unsub;
  }, [loadPreview]);

  // Listen for data changes (recalculation may update collection contents)
  useEffect(() => {
    const unsub = onAppEvent(AppEvents.CELLS_UPDATED, () => {
      loadPreview();
    });
    return unsub;
  }, [loadPreview]);

  if (!preview || !preview.root) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          Select a cell containing a List or Dict to preview its contents.
        </div>
      </div>
    );
  }

  const typeLabel =
    preview.cellType === "list" ? "List" : "Dict";
  const count =
    preview.root.type === "list"
      ? preview.root.count || 0
      : preview.root.entries?.length || 0;

  return (
    <div style={styles.container}>
      {cellRef && <div style={styles.cellRef}>{cellRef}</div>}
      <div style={styles.header}>
        <span>{typeLabel}</span>
        <span style={styles.badge}>{count} items</span>
      </div>

      {preview.root.type === "list" && preview.root.items && (
        <div>
          {preview.root.items.map((item, i) => (
            <div key={i} style={styles.listItem}>
              <span style={styles.index}>{i}</span>
              <CollectionItemView item={item} depth={1} />
            </div>
          ))}
        </div>
      )}

      {preview.root.type === "dict" && preview.root.entries && (
        <div>
          {preview.root.entries.map((entry, i) => (
            <div key={i} style={styles.listItem}>
              <span style={styles.dictKey}>{entry.key}</span>
              <CollectionItemView item={entry.value} depth={1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Helper to convert 0-based column index to letter (0=A, 1=B, ..., 25=Z, 26=AA)
function indexToColLetter(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}
