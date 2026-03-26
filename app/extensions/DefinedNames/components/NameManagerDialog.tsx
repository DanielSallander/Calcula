//! FILENAME: app/extensions/DefinedNames/components/NameManagerDialog.tsx
// PURPOSE: Name Manager dialog listing all defined names with CRUD operations.
// CONTEXT: Opened from Formulas > Name Manager menu item.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  getAllNamedRanges,
  deleteNamedRange,
  updateNamedRange,
  getSheets,
  showDialog,
  AppEvents,
  emitAppEvent,
  onAppEvent,
} from "../../../src/api";
import type { NamedRange } from "../../../src/api";
import { formatScope, formatRangeDisplay } from "../lib/nameUtils";
import { isCustomFunction, formatFunctionSignature } from "../lib/lambdaUtils";

const v = (name: string) => `var(${name})`;

// ---------------------------------------------------------------------------
// SVG icon helpers
// ---------------------------------------------------------------------------

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      style={{
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
        flexShrink: 0,
      }}
    >
      <path d="M2 1 L6 4 L2 7 Z" fill="currentColor" />
    </svg>
  );
}

function FolderIcon({ open }: { open?: boolean }) {
  if (open) {
    return (
      <svg
        width={14}
        height={12}
        viewBox="0 0 14 12"
        style={{ flexShrink: 0 }}
      >
        <path
          d="M1 1 H5 L6.5 2.5 H12 V4 H3 L1 10 V1 Z"
          fill={v("--text-secondary")}
          stroke="none"
        />
        <path
          d="M3 4 H13 L11 10 H1 Z"
          fill={v("--text-secondary")}
          stroke="none"
          opacity="0.6"
        />
      </svg>
    );
  }
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" style={{ flexShrink: 0 }}>
      <path
        d="M1 1 H5 L6.5 3 H13 V11 H1 Z"
        fill={v("--text-secondary")}
        stroke="none"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Drag-and-drop types
// ---------------------------------------------------------------------------

type DropTargetType =
  | { type: "folder"; folder: string }
  | { type: "root" };

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 560,
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    flex: 1,
    overflow: "hidden",
  },
  filterInput: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    width: "100%",
    boxSizing: "border-box" as const,
  },
  tableContainer: {
    flex: 1,
    overflow: "auto",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    minHeight: 200,
    maxHeight: 400,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
  },
  th: {
    textAlign: "left" as const,
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    fontWeight: 600,
    fontSize: 11,
    color: v("--text-secondary"),
    position: "sticky" as const,
    top: 0,
    background: v("--panel-bg"),
    zIndex: 1,
  },
  td: {
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 150,
  },
  tdIndented: {
    padding: "6px 10px 6px 36px",
    borderBottom: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 150,
  },
  row: {
    cursor: "grab",
  },
  rowSelected: {
    background: v("--accent-primary"),
    color: "#ffffff",
  },
  buttonBar: {
    display: "flex",
    gap: 8,
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnDanger: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: "#e74c3c",
    color: "#ffffff",
    border: "1px solid #c0392b",
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  emptyMessage: {
    padding: "24px 16px",
    textAlign: "center" as const,
    color: v("--text-secondary"),
    fontStyle: "italic" as const,
  },
  // Folder header row
  folderHeaderRow: {
    cursor: "pointer",
    userSelect: "none" as const,
  },
  folderHeaderTd: {
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    fontWeight: 600,
    fontSize: 12,
  },
  folderNameContent: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  folderCount: {
    color: v("--text-secondary"),
    fontWeight: 400 as const,
    fontSize: 11,
    marginLeft: 2,
  },
  folderEmptyTd: {
    padding: "6px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
  },
  // Drag-and-drop visual feedback
  dragPreview: {
    position: "fixed" as const,
    padding: "4px 10px",
    background: v("--accent-primary"),
    color: "#ffffff",
    borderRadius: 4,
    fontSize: 12,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    pointerEvents: "none" as const,
    zIndex: 10000,
    whiteSpace: "nowrap" as const,
    opacity: 0.9,
  },
  rootDropZone: {
    padding: "8px 10px",
    borderBottom: `1px solid ${v("--border-default")}`,
    color: v("--text-secondary"),
    fontStyle: "italic" as const,
    fontSize: 11,
    textAlign: "center" as const,
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NameManagerDialog(
  props: DialogProps
): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const [names, setNames] = useState<NamedRange[]>([]);
  const [sheetNamesList, setSheetNamesList] = useState<string[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set()
  );

  // Drag-and-drop state
  const [dragStart, setDragStart] = useState<{
    x: number;
    y: number;
    name: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPreviewPos, setDragPreviewPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetType | null>(null);

  // Refs for hit-testing drop targets
  const folderRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const rootDropRef = useRef<HTMLTableRowElement>(null);

  const loadData = useCallback(async () => {
    try {
      const [allNames, sheetsResult] = await Promise.all([
        getAllNamedRanges(),
        getSheets(),
      ]);
      setNames(allNames);
      setSheetNamesList(sheetsResult.sheets.map((s) => s.name));
    } catch (error) {
      console.error("[NameManager] Failed to load data:", error);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadData();
    setSelectedName(null);
    setFilter("");
  }, [isOpen, loadData]);

  // Listen for named ranges changed events (e.g., after NewNameDialog creates one)
  useEffect(() => {
    if (!isOpen) return;
    return onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => {
      loadData();
    });
  }, [isOpen, loadData]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        dialogRef.current &&
        !dialogRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  const handleNew = useCallback(() => {
    showDialog("define-name", { mode: "new" });
  }, []);

  const handleNewFunction = useCallback(() => {
    showDialog("define-function", { mode: "new" });
  }, []);

  const openEditDialog = useCallback((nr: NamedRange) => {
    if (isCustomFunction(nr)) {
      showDialog("define-function", {
        mode: "edit",
        editName: nr.name,
        editRefersTo: nr.refersTo,
        editSheetIndex: nr.sheetIndex,
        editComment: nr.comment ?? "",
      });
    } else {
      showDialog("define-name", {
        mode: "edit",
        editName: nr.name,
        editRefersTo: nr.refersTo,
        editSheetIndex: nr.sheetIndex,
        editComment: nr.comment ?? "",
        editFolder: nr.folder ?? "",
      });
    }
  }, []);

  const handleEdit = useCallback(() => {
    if (!selectedName) return;
    const nr = names.find((n) => n.name === selectedName);
    if (!nr) return;
    openEditDialog(nr);
  }, [selectedName, names, openEditDialog]);

  const handleDelete = useCallback(async () => {
    if (!selectedName) return;
    try {
      const result = await deleteNamedRange(selectedName);
      if (result.success) {
        setSelectedName(null);
        emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
        await loadData();
      }
    } catch (error) {
      console.error("[NameManager] Failed to delete:", error);
    }
  }, [selectedName, loadData]);

  const toggleFolder = useCallback((folderName: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) {
        next.delete(folderName);
      } else {
        next.add(folderName);
      }
      return next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // Drag-and-drop handlers
  // -----------------------------------------------------------------------

  const handleDrop = useCallback(
    async (nrName: string, target: DropTargetType) => {
      const nr = names.find((n) => n.name === nrName);
      if (!nr) return;

      const newFolder =
        target.type === "folder" ? target.folder : undefined;

      // Skip if already in target folder
      if ((nr.folder ?? undefined) === newFolder) return;

      try {
        const result = await updateNamedRange(
          nr.name,
          nr.sheetIndex,
          nr.refersTo,
          nr.comment ?? undefined,
          newFolder
        );
        if (result.success) {
          emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
          await loadData();
        }
      } catch (error) {
        console.error("[NameManager] Failed to move named range:", error);
      }
    },
    [names, loadData]
  );

  const findDropTarget = useCallback(
    (x: number, y: number): DropTargetType | null => {
      // Check folder header rows
      for (const [folderName, element] of folderRowRefs.current) {
        const rect = element.getBoundingClientRect();
        if (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        ) {
          // Don't allow dropping on the folder the item is already in
          const nr = names.find((n) => n.name === dragStart?.name);
          if (nr?.folder === folderName) return null;
          return { type: "folder", folder: folderName };
        }
      }

      // Check root drop zone row
      if (rootDropRef.current) {
        const rect = rootDropRef.current.getBoundingClientRect();
        if (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        ) {
          return { type: "root" };
        }
      }

      // Check if mouse is in the table container but not over any folder
      // and the dragged item is in a folder -- treat as root drop
      if (tableContainerRef.current) {
        const rect = tableContainerRef.current.getBoundingClientRect();
        if (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        ) {
          const nr = names.find((n) => n.name === dragStart?.name);
          if (nr?.folder) {
            return { type: "root" };
          }
        }
      }

      return null;
    },
    [names, dragStart]
  );

  const handleRowMouseDown = useCallback(
    (e: React.MouseEvent, nrName: string) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;

      setDragStart({ x: e.clientX, y: e.clientY, name: nrName });
      setSelectedName(nrName);
    },
    []
  );

  // Global mouse listeners for drag
  useEffect(() => {
    if (!dragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (!isDragging && distance > 4) {
        setIsDragging(true);
      }

      if (distance > 4) {
        setDragPreviewPos({ x: e.clientX, y: e.clientY });
        const target = findDropTarget(e.clientX, e.clientY);
        setDropTarget(target);
      }
    };

    const handleMouseUp = async () => {
      if (isDragging && dropTarget && dragStart) {
        await handleDrop(dragStart.name, dropTarget);
      }
      setDragStart(null);
      setIsDragging(false);
      setDragPreviewPos(null);
      setDropTarget(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragStart, isDragging, dropTarget, findDropTarget, handleDrop]);

  // Clean up drag state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setDragStart(null);
      setIsDragging(false);
      setDragPreviewPos(null);
      setDropTarget(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredNames = filter
    ? names.filter(
        (nr) =>
          nr.name.toLowerCase().includes(filter.toLowerCase()) ||
          nr.refersTo.toLowerCase().includes(filter.toLowerCase()) ||
          (nr.folder ?? "").toLowerCase().includes(filter.toLowerCase())
      )
    : names;

  // Group names by folder
  const ungrouped: NamedRange[] = [];
  const folderGroups = new Map<string, NamedRange[]>();
  for (const nr of filteredNames) {
    if (nr.folder) {
      const existing = folderGroups.get(nr.folder);
      if (existing) {
        existing.push(nr);
      } else {
        folderGroups.set(nr.folder, [nr]);
      }
    } else {
      ungrouped.push(nr);
    }
  }

  // Sort folder names alphabetically
  const sortedFolders = Array.from(folderGroups.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  const draggedNr = dragStart
    ? names.find((n) => n.name === dragStart.name)
    : null;
  const showRootDropZone = isDragging && draggedNr?.folder;

  const renderRow = (nr: NamedRange, inFolder: boolean) => {
    const isSelected = nr.name === selectedName;
    const isBeingDragged = isDragging && dragStart?.name === nr.name;
    const isFn = isCustomFunction(nr);
    return (
      <tr
        key={nr.name}
        style={{
          ...styles.row,
          ...(isSelected ? styles.rowSelected : {}),
          ...(isBeingDragged ? { opacity: 0.4 } : {}),
        }}
        onMouseDown={(e) => handleRowMouseDown(e, nr.name)}
        onClick={() => {
          if (!isDragging) setSelectedName(nr.name);
        }}
        onDoubleClick={() => openEditDialog(nr)}
      >
        <td style={inFolder ? styles.tdIndented : styles.td}>
          {isFn && (
            <span
              style={{
                display: "inline-block",
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 4px",
                borderRadius: 3,
                marginRight: 6,
                background: "var(--accent-primary)",
                color: "#fff",
                verticalAlign: "middle",
                lineHeight: "14px",
              }}
            >
              fn
            </span>
          )}
          {nr.name}
        </td>
        <td style={styles.td}>
          {isFn ? formatFunctionSignature(nr) : formatRangeDisplay(nr.refersTo)}
        </td>
        <td style={styles.td}>
          {formatScope(nr.sheetIndex, sheetNamesList)}
        </td>
        <td style={styles.td}>{nr.comment ?? ""}</td>
      </tr>
    );
  };

  const setFolderRowRef = (folderName: string, el: HTMLTableRowElement | null) => {
    if (el) {
      folderRowRefs.current.set(folderName, el);
    } else {
      folderRowRefs.current.delete(folderName);
    }
  };

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>Name Manager</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.buttonBar}>
            <button style={styles.btn} onClick={handleNew}>
              New...
            </button>
            <button style={styles.btn} onClick={handleNewFunction}>
              New Function...
            </button>
            <button
              style={
                selectedName
                  ? styles.btn
                  : { ...styles.btn, ...styles.btnDisabled }
              }
              onClick={handleEdit}
              disabled={!selectedName}
            >
              Edit...
            </button>
            <button
              style={
                selectedName
                  ? styles.btnDanger
                  : { ...styles.btnDanger, ...styles.btnDisabled }
              }
              onClick={handleDelete}
              disabled={!selectedName}
            >
              Delete
            </button>
          </div>

          <input
            style={styles.filterInput}
            type="text"
            placeholder="Filter names..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <div style={styles.tableContainer} ref={tableContainerRef}>
            {filteredNames.length === 0 ? (
              <div style={styles.emptyMessage}>
                {names.length === 0
                  ? "No named ranges defined."
                  : "No matches found."}
              </div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Refers To</th>
                    <th style={styles.th}>Scope</th>
                    <th style={styles.th}>Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Folders first (sorted alphabetically) */}
                  {sortedFolders.map(([folderName, folderNames]) => {
                    const isCollapsed = collapsedFolders.has(folderName);
                    const isFolderDropTarget =
                      isDragging &&
                      dropTarget?.type === "folder" &&
                      dropTarget.folder === folderName;

                    return (
                      <React.Fragment key={`folder-${folderName}`}>
                        <tr
                          ref={(el) => setFolderRowRef(folderName, el)}
                          style={{
                            ...styles.folderHeaderRow,
                            ...(isFolderDropTarget
                              ? {
                                  outline: "2px solid rgba(0, 120, 212, 0.6)",
                                  outlineOffset: -2,
                                }
                              : {}),
                          }}
                          onClick={() => toggleFolder(folderName)}
                        >
                          <td
                            style={{
                              ...styles.folderHeaderTd,
                              ...(isFolderDropTarget
                                ? {
                                    background: "rgba(0, 120, 212, 0.12)",
                                  }
                                : {}),
                            }}
                          >
                            <div style={styles.folderNameContent}>
                              <ChevronIcon expanded={!isCollapsed} />
                              <FolderIcon open={!isCollapsed} />
                              <span>{folderName}</span>
                              <span style={styles.folderCount}>
                                ({folderNames.length})
                              </span>
                            </div>
                          </td>
                          <td
                            style={{
                              ...styles.folderEmptyTd,
                              ...(isFolderDropTarget
                                ? {
                                    background: "rgba(0, 120, 212, 0.12)",
                                  }
                                : {}),
                            }}
                          />
                          <td
                            style={{
                              ...styles.folderEmptyTd,
                              ...(isFolderDropTarget
                                ? {
                                    background: "rgba(0, 120, 212, 0.12)",
                                  }
                                : {}),
                            }}
                          />
                          <td
                            style={{
                              ...styles.folderEmptyTd,
                              ...(isFolderDropTarget
                                ? {
                                    background: "rgba(0, 120, 212, 0.12)",
                                  }
                                : {}),
                            }}
                          />
                        </tr>
                        {!isCollapsed &&
                          folderNames.map((nr) => renderRow(nr, true))}
                      </React.Fragment>
                    );
                  })}

                  {/* Ungrouped (root-level) named ranges */}
                  {ungrouped.map((nr) => renderRow(nr, false))}

                  {/* Root drop zone - visible only during drag of a folder item */}
                  {showRootDropZone && (
                    <tr ref={rootDropRef}>
                      <td
                        colSpan={4}
                        style={{
                          ...styles.rootDropZone,
                          ...(dropTarget?.type === "root"
                            ? {
                                background: "rgba(0, 120, 212, 0.12)",
                                outline: "2px solid rgba(0, 120, 212, 0.6)",
                                outlineOffset: -2,
                              }
                            : {}),
                        }}
                      >
                        Drop here to remove from folder
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* Floating drag preview */}
      {isDragging && dragPreviewPos && dragStart && (
        <div
          style={{
            ...styles.dragPreview,
            left: dragPreviewPos.x + 12,
            top: dragPreviewPos.y + 12,
          }}
        >
          {dragStart.name}
        </div>
      )}
    </div>
  );
}
