//! FILENAME: app/extensions/ControlsPane/components/RibbonFilterCard.tsx
// PURPOSE: Compact filter chip-card in the Controls pane — field name, the
//          selection summary as a Chip ("3 of 12", "(All)"), a dropdown
//          chevron, plus the model connection the filter is sourced from
//          (visible so multi-model workbooks stay unambiguous).
//          The chevron opens the filter checklist in a card Popover anchored
//          below the card.
// CONTEXT: Chrome is the pane's shared chip-card (paneChrome.ts): the 56px
//          band height the section's "inline" presentation relies on, tokens
//          only, the pressed wash while a selection is active. The checklist's
//          dismissal belongs to the Popover — a press on the card (its anchor)
//          never dismisses it, so the chevron toggles without the old 200ms
//          reopen guard.

import React, { useState, useCallback, useEffect } from "react";
import { RibbonIcon } from "@api";
import { Chip, DropdownChevron, IconButton, LT, useSurfaceLayout } from "@api/layout";
import type { RibbonFilter, SlicerItem } from "../lib/filterPaneTypes";
import {
  getCachedItems,
  refreshFilterItems,
  updateFilterSelectionAsync,
  deleteFilterAsync,
  getFilterById,
  getConnectionName,
} from "../lib/filterPaneStore";
import { FilterDropdown } from "./FilterDropdown";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { cardTitleStyle, paneCardStyle } from "./paneChrome";

interface Props {
  filter: RibbonFilter;
}

export function RibbonFilterCard({ filter }: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const [items, setItems] = useState<SlicerItem[]>(
    getCachedItems(filter.id) ?? [],
  );
  const [localSelectedItems, setLocalSelectedItems] = useState<string[] | null>(
    filter.selectedItems,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // The card is the popover's anchor: the checklist hangs below the whole
  // card, and a press anywhere on it is never an "outside" press.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

  // Sync local selection when filter prop changes
  useEffect(() => {
    setLocalSelectedItems(filter.selectedItems);
  }, [filter.selectedItems]);

  // Load items lazily — only when dropdown is opened, not on mount.
  // This avoids taking the BI engine during card creation which would
  // conflict with pivot operations the user might be doing.
  const [itemsLoaded, setItemsLoaded] = useState(false);

  useEffect(() => {
    // Refresh on cross-filter events from OTHER filters or slicers
    const onFilterChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filterId && detail.filterId !== filter.id && itemsLoaded) {
        refreshFilterItems(filter.id).then(() => {
          const cached = getCachedItems(filter.id);
          if (cached) setItems(cached);
        });
      }
    };
    const onSlicerChanged = () => {
      if (itemsLoaded) {
        refreshFilterItems(filter.id).then(() => {
          const cached = getCachedItems(filter.id);
          if (cached) setItems(cached);
        });
      }
    };
    window.addEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onFilterChanged);
    window.addEventListener("slicer:selectionChanged", onSlicerChanged);
    return () => {
      window.removeEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onFilterChanged);
      window.removeEventListener("slicer:selectionChanged", onSlicerChanged);
    };
  }, [filter.id, itemsLoaded]);

  const toggleDropdown = useCallback(async () => {
    if (!dropdownOpen) {
      // Load items on first open (lazy loading)
      if (!itemsLoaded) {
        await refreshFilterItems(filter.id);
        const cached = getCachedItems(filter.id);
        if (cached) setItems(cached);
        setItemsLoaded(true);
      }
    }
    setDropdownOpen((prev) => !prev);
  }, [dropdownOpen, itemsLoaded, filter.id]);

  const handleDropdownClose = useCallback(() => {
    setDropdownOpen(false);
  }, []);

  const handleSelectionApply = useCallback(
    (selectedItems: string[] | null) => {
      setLocalSelectedItems(selectedItems);
      setDropdownOpen(false);
      updateFilterSelectionAsync(filter.id, selectedItems);
    },
    [filter.id],
  );

  const handleDelete = useCallback(async () => {
    setDropdownOpen(false);
    await deleteFilterAsync(filter.id);
  }, [filter.id]);

  // Build summary text
  const hasFilter = localSelectedItems !== null;
  const totalCount = items.length;
  let summary: React.ReactNode;
  let summaryText: string;
  if (!hasFilter) {
    summaryText = "(All)";
    summary = summaryText;
  } else if (localSelectedItems.length === 0) {
    summaryText = "(None)";
    summary = summaryText;
  } else if (localSelectedItems.length === 1) {
    summaryText = localSelectedItems[0];
    summary = summaryText;
  } else {
    summaryText = `${localSelectedItems.length} of ${totalCount}`;
    summary = (
      <>
        <b>{localSelectedItems.length}</b> of {totalCount}
      </>
    );
  }

  // Shorten field name: "dim_customer.city" -> "city"
  const shortName = filter.fieldName.includes(".")
    ? filter.fieldName.split(".").pop()!
    : filter.fieldName;

  // Model connection attribution — always visible so it's unambiguous
  // which model each filter comes from when several connections exist.
  const connectionName = getConnectionName(filter.connectionId);
  const connectionMissing = connectionName === undefined;
  const pinned = (filter.filterLevel ?? 1) >= 2;

  return (
    <>
      <div
        ref={setCardEl}
        style={paneCardStyle(band, hasFilter)}
        data-pane-card="filter"
        data-filtered={hasFilter ? "true" : "false"}
        title={
          `${filter.fieldName}\nModel: ${connectionName ?? "(connection missing)"}\n` +
          (hasFilter
            ? `Filtered: ${localSelectedItems?.length ?? 0} of ${totalCount}`
            : "No filter applied") +
          (pinned
            ? `\nPinned (level ${filter.filterLevel}) — survives CLEAR in measures`
            : "")
        }
      >
        {/* Title row (24, the chip's height) + gap (2) + connection line (12)
            sits centred in the card's 46px content box. */}
        <div style={styles.cardBody}>
          <div style={styles.topRow}>
            {pinned && (
              <span
                role="img"
                aria-label={`Pinned filter (level ${filter.filterLevel})`}
                style={styles.pin}
              >
                <RibbonIcon.Lock size={14} />
              </span>
            )}
            <span style={cardTitleStyle}>{shortName}</span>
            <Chip
              tone={hasFilter ? "info" : "neutral"}
              title={summaryText}
              testId="controls-pane-filter-summary"
              style={styles.summaryChip}
            >
              {summary}
            </Chip>
          </div>
          <div
            style={{
              ...styles.connectionRow,
              ...(connectionMissing ? styles.connectionMissing : {}),
            }}
          >
            {connectionName ?? "(connection missing)"}
          </div>
        </div>
        <IconButton
          size="sm"
          label={`Filter ${shortName}`}
          icon={
            <span style={{ ...styles.chevron, transform: dropdownOpen ? "rotate(180deg)" : undefined }}>
              <DropdownChevron size={9} />
            </span>
          }
          aria-haspopup="dialog"
          aria-expanded={dropdownOpen}
          data-testid="controls-pane-filter-open"
          onClick={() => void toggleDropdown()}
        />
      </div>

      {/* Checklist — read fresh filter from store to avoid stale props.
          Mounted only while open, so its local selection state starts fresh
          from the filter on every open. */}
      {dropdownOpen && cardEl && (() => {
        const f = getFilterById(filter.id) ?? filter;
        return (
          <FilterDropdown
            fieldName={f.fieldName}
            items={items}
            selectedItems={localSelectedItems}
            anchorEl={cardEl}
            onApply={handleSelectionApply}
            onClose={handleDropdownClose}
            filterId={f.id}
            onDelete={handleDelete}
            connectionId={f.connectionId}
            connectionMode={f.connectionMode ?? "manual"}
            crossFilterTargets={f.crossFilterTargets ?? []}
            crossFilterSlicerTargets={f.crossFilterSlicerTargets ?? []}
            advancedFilter={f.advancedFilter ?? null}
            fieldDataType={f.fieldDataType ?? "unknown"}
            connectedPivots={f.connectedPivots}
            connectedSheets={f.connectedSheets}
            hideNoData={f.hideNoData ?? false}
            indicateNoData={f.indicateNoData ?? true}
            sortNoDataLast={f.sortNoDataLast ?? true}
            showSelectAll={f.showSelectAll ?? false}
            singleSelect={f.singleSelect ?? false}
            filterLevel={f.filterLevel ?? 1}
          />
        );
      })()}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cardBody: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  pin: {
    display: "inline-flex",
    flex: "none",
    color: LT.textSecondary,
  },
  // The chip may shrink (its text ellipsises) so a long single-value summary
  // never pushes the chevron out of the card.
  summaryChip: {
    flex: "0 1 auto",
    minWidth: 0,
  },
  connectionRow: {
    fontSize: 10,
    lineHeight: "12px",
    color: LT.textSecondary,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  connectionMissing: {
    color: LT.dangerFg,
    fontStyle: "italic",
  },
  chevron: {
    display: "inline-flex",
    transition: `transform ${LT.motionHover}`,
  },
};
