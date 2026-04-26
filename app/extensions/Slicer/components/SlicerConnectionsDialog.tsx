//! FILENAME: app/extensions/Slicer/components/SlicerConnectionsDialog.tsx
// PURPOSE: "Report Connections" dialog for managing which PivotTables/Tables
//          a slicer filters. All connections are equal and freely toggleable.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "@api";
import { invokeBackend, getAllPivotTables } from "@api/backend";
import { getSlicerById, updateSlicerAsync } from "../lib/slicerStore";
import { broadcastSelectedSlicers } from "../handlers/selectionHandler";
import { syncReportConnections } from "../lib/slicerFilterBridge";
import type { Slicer, SlicerSourceType } from "../lib/slicerTypes";

// ============================================================================
// Types
// ============================================================================

interface ConnectionTarget {
  type: SlicerSourceType;
  id: number;
  name: string;
  hasField: boolean; // Whether this source has the slicer's field name
}

// ============================================================================
// Component
// ============================================================================

export function SlicerConnectionsDialog({
  isOpen,
  onClose,
  data,
}: DialogProps): React.ReactElement | null {
  const slicerId = data?.slicerId as number | undefined;

  const [slicer, setSlicer] = useState<Slicer | null>(null);
  const [targets, setTargets] = useState<ConnectionTarget[]>([]);
  const [connectedIds, setConnectedIds] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load slicer and compatible targets when dialog opens
  useEffect(() => {
    if (!isOpen || slicerId == null) return;
    setError(null);

    const s = getSlicerById(slicerId);
    if (!s) {
      setError("Slicer not found.");
      return;
    }
    setSlicer(s);
    setConnectedIds(new Set(s.connectedSourceIds ?? []));
    loadTargets(s);
  }, [isOpen, slicerId]);

  const loadTargets = async (s: Slicer) => {
    setIsLoading(true);
    try {
      const allTargets: ConnectionTarget[] = [];

      if (s.sourceType === "pivot") {
        // Load all pivot tables and check which have the same field
        const pivots = await getAllPivotTables<
          Array<{ id: number; name: string; sourceRange: string }>
        >();

        for (const pv of pivots) {
          let hasField = false;
          try {
            const info = await invokeBackend<{
              hierarchies: Array<{ index: number; name: string }>;
            }>("get_pivot_hierarchies", { pivotId: pv.id });
            // Match exact name or "table.column" → "column" fallback
            hasField = info.hierarchies.some((h) => {
              if (h.name === s.fieldName) return true;
              if (s.fieldName.includes(".")) {
                const colPart = s.fieldName.split(".").pop()!;
                return h.name === colPart;
              }
              return false;
            });
          } catch {
            // Pivot may not be accessible
          }

          allTargets.push({
            type: "pivot",
            id: pv.id,
            name: pv.name,
            hasField,
          });
        }
      } else {
        // For table slicers: load all tables and check field compatibility
        try {
          const tables = await invokeBackend<
            Array<{
              id: number;
              name: string;
              sheetIndex: number;
              columns: Array<{ name: string }>;
            }>
          >("get_all_tables", {});

          for (const t of tables) {
            const hasField = t.columns.some((c) => c.name === s.fieldName);
            allTargets.push({
              type: "table",
              id: t.id,
              name: t.name,
              hasField,
            });
          }
        } catch {
          // No tables available
        }
      }

      // Sort: compatible (hasField) first, then by name
      allTargets.sort((a, b) => {
        if (a.hasField !== b.hasField) return a.hasField ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      setTargets(allTargets);
    } catch (err) {
      console.error("[SlicerConnections] Error loading targets:", err);
      setError("Failed to load data sources.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = (targetId: number) => {
    setConnectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) {
        next.delete(targetId);
      } else {
        next.add(targetId);
      }
      return next;
    });
  };

  const handleClose = useCallback(() => {
    setError(null);
    onClose();
  }, [onClose]);

  const handleOk = async () => {
    if (!slicer) return;

    try {
      const oldIds = slicer.connectedSourceIds ?? [];
      const newIds = Array.from(connectedIds);

      await updateSlicerAsync(slicer.id, {
        connectedSourceIds: newIds,
      });

      // Clear filters on removed pivots, apply on newly added ones
      await syncReportConnections(slicer, oldIds, newIds);

      broadcastSelectedSlicers();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") handleClose();
    else if (e.key === "Enter") handleOk();
  };

  if (!isOpen) return null;

  const sourceLabel = slicer?.sourceType === "pivot" ? "PivotTable" : "Table";

  return (
    <div style={s.overlay} onClick={handleClose}>
      <div
        style={s.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={s.header}>
          <h2 style={s.title}>Report Connections</h2>
          <button style={s.closeButton} onClick={handleClose} aria-label="Close">
            x
          </button>
        </div>

        {/* Content */}
        <div style={s.content}>
          {slicer && (
            <div style={s.infoRow}>
              <span style={s.infoLabel}>Slicer:</span>
              <span style={s.infoValue}>{slicer.name}</span>
            </div>
          )}
          {slicer && (
            <div style={s.infoRow}>
              <span style={s.infoLabel}>Field:</span>
              <span style={s.infoValue}>{slicer.fieldName}</span>
            </div>
          )}

          <div style={s.separator} />

          <div style={s.sectionLabel}>
            Select {sourceLabel}s to connect to this slicer:
          </div>

          {isLoading ? (
            <div style={s.loadingText}>Loading data sources...</div>
          ) : targets.length === 0 ? (
            <div style={s.emptyText}>
              No {sourceLabel}s found in this workbook.
            </div>
          ) : (
            <div style={s.targetList}>
              {targets.map((target) => (
                <label
                  key={`${target.type}-${target.id}`}
                  style={{
                    ...s.targetRow,
                    ...(target.hasField ? {} : s.incompatible),
                  }}
                  title={
                    target.hasField
                      ? `Connect slicer to ${target.name}`
                      : `"${slicer?.fieldName}" field not found in ${target.name}`
                  }
                >
                  <input
                    type="checkbox"
                    checked={connectedIds.has(target.id)}
                    onChange={() => handleToggle(target.id)}
                    disabled={!target.hasField}
                    style={s.checkbox}
                  />
                  <span style={s.targetIcon}>
                    {target.type === "pivot" ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <rect x="1" y="1" width="14" height="14" rx="1" stroke="#888" strokeWidth="1" fill="none" />
                        <line x1="5" y1="1" x2="5" y2="15" stroke="#888" strokeWidth="1" />
                        <line x1="1" y1="5" x2="15" y2="5" stroke="#888" strokeWidth="1" />
                        <rect x="1" y="1" width="4" height="4" fill="#5b9bd5" rx="1" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <rect x="1" y="2" width="14" height="12" rx="1" stroke="#888" strokeWidth="1" fill="none" />
                        <rect x="1" y="2" width="14" height="3" fill="#4472c4" rx="1" />
                        <line x1="5.5" y1="5" x2="5.5" y2="14" stroke="#ddd" strokeWidth="0.5" />
                        <line x1="10.5" y1="5" x2="10.5" y2="14" stroke="#ddd" strokeWidth="0.5" />
                      </svg>
                    )}
                  </span>
                  <span style={s.targetName}>{target.name}</span>
                  {!target.hasField && (
                    <span style={s.incompatibleBadge}>no matching field</span>
                  )}
                </label>
              ))}
            </div>
          )}

          {error && <div style={s.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <button style={s.cancelButton} onClick={handleClose}>
            Cancel
          </button>
          <button style={s.okButton} onClick={handleOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Styles (matches existing dark-theme dialogs)
// ============================================================================

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    backgroundColor: "#2d2d2d",
    borderRadius: "8px",
    border: "1px solid #454545",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
    width: "400px",
    maxWidth: "90vw",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid #454545",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    color: "#ffffff",
  },
  closeButton: {
    background: "transparent",
    border: "none",
    color: "#888888",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  content: {
    padding: "16px 20px",
    overflowY: "auto",
    flex: 1,
  },
  infoRow: {
    display: "flex",
    gap: "8px",
    alignItems: "baseline",
    padding: "3px 0",
  },
  infoLabel: {
    fontSize: "12px",
    color: "#999999",
    minWidth: "40px",
  },
  infoValue: {
    fontSize: "13px",
    color: "#e0e0e0",
    fontWeight: 500,
  },
  separator: {
    height: "1px",
    background: "#3a3a3a",
    margin: "12px 0",
  },
  sectionLabel: {
    fontSize: "13px",
    color: "#cccccc",
    marginBottom: "10px",
    fontWeight: 500,
  },
  targetList: {
    maxHeight: "260px",
    overflowY: "auto",
    border: "1px solid #454545",
    borderRadius: "4px",
    backgroundColor: "#1e1e1e",
  },
  targetRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    cursor: "pointer",
    borderBottom: "1px solid #333333",
    fontSize: "13px",
    color: "#cccccc",
  },
  checkbox: {
    margin: 0,
    cursor: "pointer",
    flexShrink: 0,
  },
  targetIcon: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  targetName: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  incompatible: {
    opacity: 0.45,
    cursor: "default",
  },
  incompatibleBadge: {
    fontSize: "10px",
    color: "#888888",
    fontStyle: "italic",
    flexShrink: 0,
  },
  loadingText: {
    fontSize: "13px",
    color: "#888888",
    textAlign: "center",
    padding: "20px 0",
  },
  emptyText: {
    fontSize: "13px",
    color: "#888888",
    padding: "12px 0",
  },
  error: {
    marginTop: "12px",
    padding: "10px 12px",
    backgroundColor: "rgba(220, 53, 69, 0.15)",
    border: "1px solid #dc3545",
    borderRadius: "4px",
    color: "#ff6b6b",
    fontSize: "13px",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "14px 20px",
    borderTop: "1px solid #454545",
    flexShrink: 0,
  },
  cancelButton: {
    padding: "8px 16px",
    fontSize: "13px",
    backgroundColor: "transparent",
    border: "1px solid #454545",
    borderRadius: "4px",
    color: "#cccccc",
    cursor: "pointer",
  },
  okButton: {
    padding: "8px 20px",
    fontSize: "13px",
    backgroundColor: "#0e639c",
    border: "1px solid #0e639c",
    borderRadius: "4px",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 500,
  },
};

export default SlicerConnectionsDialog;
