//! FILENAME: app/extensions/FilterPane/components/FilterDropdown.tsx
// PURPOSE: Dropdown checklist anchored below a ribbon filter card.
//          Includes search, select all/none, OK/Cancel, and actions.

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { SlicerItem, SlicerConnection } from "../lib/filterPaneTypes";

export interface FilterDropdownProps {
  fieldName: string;
  items: SlicerItem[];
  selectedItems: string[] | null;
  anchorRect: DOMRect;
  onApply: (selectedItems: string[] | null) => void;
  onClose: () => void;
  onDelete: () => void;
  onMoveScope: () => void;
  scopeLabel: string;
  connectedSources?: SlicerConnection[];
}

export function FilterDropdown({
  fieldName,
  items,
  selectedItems,
  anchorRect,
  onApply,
  onClose,
  onDelete,
  onMoveScope,
  scopeLabel,
  connectedSources,
}: FilterDropdownProps): React.ReactElement {
  // Local selection state for OK/Cancel pattern
  const allValues = useMemo(() => items.map((i) => i.value), [items]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => {
    if (selectedItems === null) return new Set(allValues);
    return new Set(selectedItems);
  });
  const [searchText, setSearchText] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing immediately from the toggle click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleToggle = useCallback((value: string) => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setLocalSelected(new Set(allValues));
  }, [allValues]);

  const handleSelectNone = useCallback(() => {
    setLocalSelected(new Set());
  }, []);

  const handleOk = useCallback(() => {
    // If all selected, clear filter (null = all)
    if (localSelected.size === allValues.length) {
      onApply(null);
    } else {
      onApply(Array.from(localSelected));
    }
  }, [localSelected, allValues, onApply]);

  const handleShowConnections = useCallback(() => {
    const connected = connectedSources ?? [];
    const count = connected.length;
    const label =
      count === 0
        ? "No report connections configured."
        : `Connected to ${count} source${count !== 1 ? "s" : ""}:\n${connected.map((c) => `  - ${c.sourceType} #${c.sourceId}`).join("\n")}`;
    alert(label);
  }, [connectedSources]);

  const filtered = useMemo(() => {
    if (!searchText) return items;
    const lower = searchText.toLowerCase();
    return items.filter((i) => i.value.toLowerCase().includes(lower));
  }, [items, searchText]);

  // Position: below the card, aligned left
  const top = anchorRect.bottom + 2;
  const left = Math.min(anchorRect.left, window.innerWidth - 260);

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: "fixed",
        left,
        top,
        width: 250,
        maxHeight: 420,
        backgroundColor: "#fff",
        border: "1px solid #d1d5db",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        fontSize: 13,
        color: "#333",
      }}
    >
      {/* Header */}
      <div style={styles.header}>{fieldName}</div>

      {/* Search */}
      {items.length > 8 && (
        <div style={styles.searchRow}>
          <input
            type="text"
            placeholder="Search..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={styles.searchInput}
            autoFocus
          />
        </div>
      )}

      {/* Select All / None */}
      <div style={styles.bulkRow}>
        <button onClick={handleSelectAll} style={styles.bulkButton}>
          Select All
        </button>
        <button onClick={handleSelectNone} style={styles.bulkButton}>
          Select None
        </button>
      </div>

      {/* Items */}
      <div style={styles.itemList}>
        {filtered.map((item) => (
          <label
            key={item.value}
            style={{
              ...styles.itemRow,
              opacity: item.hasData ? 1 : 0.45,
            }}
          >
            <input
              type="checkbox"
              checked={localSelected.has(item.value)}
              onChange={() => handleToggle(item.value)}
              style={{ marginRight: 8 }}
            />
            <span style={styles.itemLabel}>{item.value || "(Blank)"}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <div style={styles.noResults}>No matching values</div>
        )}
      </div>

      {/* OK / Cancel */}
      <div style={styles.footer}>
        <button onClick={handleOk} style={styles.okButton}>
          OK
        </button>
        <button onClick={onClose} style={styles.cancelButton}>
          Cancel
        </button>
      </div>

      {/* Actions separator */}
      <div style={styles.actionsDivider} />

      {/* Actions */}
      <div style={styles.actionsRow}>
        <button onClick={handleShowConnections} style={styles.actionLink}>
          Report Connections
        </button>
        <button onClick={onMoveScope} style={styles.actionLink}>
          {scopeLabel}
        </button>
        <button
          onClick={onDelete}
          style={{ ...styles.actionLink, color: "#c00" }}
        >
          Remove
        </button>
      </div>
    </div>,
    document.body,
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    padding: "8px 12px",
    borderBottom: "1px solid #e5e7eb",
    fontWeight: 600,
    fontSize: "12px",
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  searchRow: {
    padding: "6px 12px",
    borderBottom: "1px solid #e5e7eb",
  },
  searchInput: {
    width: "100%",
    padding: "5px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box" as const,
  },
  bulkRow: {
    padding: "4px 12px",
    borderBottom: "1px solid #e5e7eb",
    display: "flex",
    gap: "6px",
  },
  bulkButton: {
    padding: "3px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#f9fafb",
    cursor: "pointer",
    fontSize: 11,
    color: "#333",
  },
  itemList: {
    flex: 1,
    overflowY: "auto" as const,
    maxHeight: 200,
    padding: "4px 0",
  },
  itemRow: {
    display: "flex",
    alignItems: "center",
    padding: "3px 12px",
    cursor: "pointer",
    fontSize: 12,
  },
  itemLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  noResults: {
    padding: "8px 12px",
    color: "#999",
    fontStyle: "italic",
    fontSize: 12,
  },
  footer: {
    padding: "6px 12px",
    borderTop: "1px solid #e5e7eb",
    display: "flex",
    justifyContent: "flex-end",
    gap: "6px",
  },
  okButton: {
    padding: "4px 16px",
    border: "none",
    borderRadius: 3,
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
  },
  cancelButton: {
    padding: "4px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
  actionsDivider: {
    height: "1px",
    background: "#e5e7eb",
  },
  actionsRow: {
    padding: "4px 12px 6px",
    display: "flex",
    gap: "8px",
  },
  actionLink: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 11,
    color: "#0078d4",
    padding: "2px 0",
    textDecoration: "underline",
  },
};
