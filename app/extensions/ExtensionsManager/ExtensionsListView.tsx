//! FILENAME: app/extensions/ExtensionsManager/ExtensionsListView.tsx
// PURPOSE: Extensions list view for the Activity Bar side panel
// CONTEXT: Shows all loaded extensions with their status

import React, { useCallback, useEffect, useState } from "react";
import type { ActivityViewProps } from "../../src/api/uiTypes";
import { ExtensionManager } from "../../src/api";
import type { LoadedExtension, ExtensionStatus } from "../../src/api";

/** Status badge colors */
const STATUS_COLORS: Record<ExtensionStatus, { bg: string; text: string }> = {
  active: { bg: "#e6f4ea", text: "#137333" },
  pending: { bg: "#fef7e0", text: "#b06000" },
  error: { bg: "#fce8e6", text: "#c5221f" },
  inactive: { bg: "#f1f3f4", text: "#5f6368" },
};

/**
 * Extensions List View - shows all loaded extensions.
 */
export function ExtensionsListView(_props: ActivityViewProps): React.ReactElement {
  const [extensions, setExtensions] = useState<LoadedExtension[]>([]);

  const refresh = useCallback(() => {
    setExtensions([...ExtensionManager.getExtensions()]);
  }, []);

  useEffect(() => {
    refresh();
    const unsub = ExtensionManager.subscribe(refresh);
    return unsub;
  }, [refresh]);

  const activeCount = extensions.filter((e) => e.status === "active").length;
  const errorCount = extensions.filter((e) => e.status === "error").length;

  return (
    <div style={styles.container}>
      {/* Summary */}
      <div style={styles.summary}>
        <span style={styles.summaryText}>
          {extensions.length} extension{extensions.length !== 1 ? "s" : ""}
        </span>
        {errorCount > 0 && (
          <span style={styles.errorBadge}>{errorCount} error{errorCount !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Extension list */}
      <div style={styles.list}>
        {extensions.length === 0 ? (
          <div style={styles.emptyState}>No managed extensions loaded</div>
        ) : (
          extensions.map((ext) => (
            <ExtensionItem key={ext.id} extension={ext} />
          ))
        )}
      </div>

      {/* Info footer */}
      <div style={styles.footer}>
        <div style={styles.footerText}>
          Extensions are loaded from the extensions/ directory.
          Third-party extension support is coming soon.
        </div>
      </div>
    </div>
  );
}

function ExtensionItem({ extension }: { extension: LoadedExtension }): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const statusColor = STATUS_COLORS[extension.status];

  return (
    <div
      style={{
        ...styles.item,
        backgroundColor: isHovered ? "#f0f0f0" : "transparent",
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={styles.itemHeader}>
        <span style={styles.itemName}>{extension.name}</span>
        <span style={{
          ...styles.statusBadge,
          backgroundColor: statusColor.bg,
          color: statusColor.text,
        }}>
          {extension.status}
        </span>
      </div>
      <div style={styles.itemMeta}>
        <span style={styles.itemVersion}>v{extension.version}</span>
        <span style={styles.itemId}>{extension.id}</span>
      </div>
      {extension.error && (
        <div style={styles.itemError}>{extension.error.message}</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  summaryText: {
    fontSize: 12,
    color: "#444",
    fontWeight: 500,
  },
  errorBadge: {
    fontSize: 10,
    color: "#c5221f",
    backgroundColor: "#fce8e6",
    padding: "1px 6px",
    borderRadius: 8,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 0",
  },
  item: {
    padding: "8px 12px",
    cursor: "default",
    borderBottom: "1px solid #f0f0f0",
  },
  itemHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  itemName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  statusBadge: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 8,
    flexShrink: 0,
  },
  itemMeta: {
    display: "flex",
    gap: 8,
    marginTop: 2,
  },
  itemVersion: {
    fontSize: 11,
    color: "#888",
  },
  itemId: {
    fontSize: 11,
    color: "#aaa",
  },
  itemError: {
    fontSize: 11,
    color: "#c5221f",
    marginTop: 4,
    padding: "3px 6px",
    backgroundColor: "#fce8e6",
    borderRadius: 3,
  },
  emptyState: {
    padding: "24px 12px",
    textAlign: "center" as const,
    color: "#999",
    fontSize: 12,
  },
  footer: {
    padding: "8px 12px",
    borderTop: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  footerText: {
    fontSize: 11,
    color: "#999",
    lineHeight: "1.4",
  },
};
