//! FILENAME: app/extensions/ControlsPane/components/ControlsPaneSection.tsx
// PURPOSE: Panel section hosting the merged Controls-pane strip: ribbon filter
//          cards (untouched RibbonFilterCard) and pane control cards
//          (ControlCard, with CustomControlHost for scripted controls), in
//          shared-`order` merged sort (getPaneItems, D3).
//          Ribbon band: single horizontal strip of fixed-height cards.
//          Sidebar / launcher flyout: add-menu row on top, cards stacked below;
//          when filters span more than one model connection, the FILTER subset
//          keeps its per-connection grouping headers while controls list first
//          in their own implicit group.
// CONTEXT: "+" opens the AddItemMenu (Filter... / control kinds). Drag-reorder
//          v1: every card is wrapped in an HTML5-draggable wrapper; a drop
//          rewrites `order` via each entity's own update command (midpoint
//          integer when a gap exists, else a sequential rewrite of all orders).

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { PanelSectionProps } from "@api/ui";
import { Stack, ControlRow, StatusText, useSurfaceLayout } from "@api/layout";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { ControlsPaneEvents } from "../lib/controlsPaneEvents";
import { getConnectionName, refreshCache } from "../lib/filterPaneStore";
import { getPaneItems, refreshControlsCache } from "../lib/controlsPaneStore";
import { updateRibbonFilter } from "../lib/filterPaneApi";
import { updatePaneControl } from "../lib/controlsPaneApi";
import type { PaneControl, PaneItem } from "../lib/controlsPaneTypes";
import { RibbonFilterCard } from "./RibbonFilterCard";
import { ControlCard } from "./ControlCard";
import {
  CustomControlHost,
  openControlScriptEditor,
} from "./CustomControlHost";
import { AddItemMenu } from "./AddItemMenu";

/** Stable React key for a merged-strip item. */
function keyOf(item: PaneItem): string {
  return item.kind === "filter" ? `f-${item.filter.id}` : `c-${item.control.id}`;
}

/** Persist one item's new strip position (ONLY the order field — the frozen
 *  filter entity is never otherwise written by this feature). */
function setItemOrder(item: PaneItem, order: number): Promise<unknown> {
  return item.kind === "filter"
    ? updateRibbonFilter(item.filter.id, { order })
    : updatePaneControl(item.control.id, { order });
}

/**
 * Persist a drag move: item at `from` lands at `to` in the merged strip.
 * Prefers a single write (an integer strictly between the new neighbors);
 * when no integer gap exists, sequentially rewrites every item's order to its
 * index. Both caches refresh afterwards, which re-renders the strip.
 */
async function persistMove(
  items: PaneItem[],
  from: number,
  to: number,
): Promise<void> {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  const before: PaneItem | undefined = next[to - 1];
  const after: PaneItem | undefined = next[to + 1];

  // Midpoint integer between the new neighbors (orders are non-negative
  // integers backend-side, so "before the first item" needs first.order > 0).
  let newOrder: number | null = null;
  if (!before && after) {
    newOrder = after.order > 0 ? after.order - 1 : null;
  } else if (before && !after) {
    newOrder = before.order + 1;
  } else if (before && after) {
    newOrder =
      after.order - before.order >= 2
        ? Math.floor((before.order + after.order) / 2)
        : null;
  }

  try {
    if (newOrder !== null) {
      await setItemOrder(moved, newOrder);
    } else {
      for (let i = 0; i < next.length; i++) {
        if (next[i].order !== i) {
          await setItemOrder(next[i], i);
        }
      }
    }
  } catch (err) {
    console.error("[ControlsPane] Failed to reorder items:", err);
  }

  await Promise.all([refreshCache(), refreshControlsCache()]);
}

export function ControlsPaneSection(
  _props: PanelSectionProps,
): React.ReactElement {
  const [items, setItems] = useState<PaneItem[]>([]);
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const refreshList = useCallback(() => {
    setItems(getPaneItems());
  }, []);

  // Value-change events: skip transient preview frames (mid-drag slider
  // updates render inside the card via its own local state; re-rendering the
  // whole merged strip per pointermove frame is pure overhead).
  const refreshOnCommittedValue = useCallback(
    (e: Event) => {
      const detail = (e as CustomEvent<{ transient?: boolean }>).detail;
      if (detail?.transient) return;
      refreshList();
    },
    [refreshList],
  );

  useEffect(() => {
    refreshList();
    const events = [
      FilterPaneEvents.FILTER_CREATED,
      FilterPaneEvents.FILTER_DELETED,
      FilterPaneEvents.FILTER_UPDATED,
      FilterPaneEvents.FILTERS_REFRESHED,
      ControlsPaneEvents.CONTROL_CREATED,
      ControlsPaneEvents.CONTROL_DELETED,
      ControlsPaneEvents.CONTROL_UPDATED,
      ControlsPaneEvents.CONTROLS_REFRESHED,
      // Shell fanout after undo/redo restores pane-control state (index.ts
      // refreshes the cache on it; re-read here as well for ordering safety).
      "controlspane:controls-refreshed",
    ];
    events.forEach((ev) => window.addEventListener(ev, refreshList));
    window.addEventListener(
      ControlsPaneEvents.CONTROL_VALUE_CHANGED_LOCAL,
      refreshOnCommittedValue,
    );
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, refreshList));
      window.removeEventListener(
        ControlsPaneEvents.CONTROL_VALUE_CHANGED_LOCAL,
        refreshOnCommittedValue,
      );
    };
  }, [refreshList, refreshOnCommittedValue]);

  // ---- drag-reorder v1 (HTML5 draggable wrappers, both layouts) ----
  const itemsRef = useRef<PaneItem[]>(items);
  itemsRef.current = items;
  const dragIndexRef = useRef<number | null>(null);

  const handleDragStart = useCallback(
    (index: number) => (e: React.DragEvent<HTMLDivElement>) => {
      // Never hijack a drag that starts on an interactive element (slider
      // thumbs, dropdown inputs, buttons, script iframes) — cancel the HTML5
      // drag so the control's own pointer interaction proceeds untouched.
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(
          "input, select, textarea, button, iframe, [contenteditable='true']",
        )
      ) {
        e.preventDefault();
        return;
      }
      dragIndexRef.current = index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", keyOf(itemsRef.current[index]));
    },
    [],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (dragIndexRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (index: number) => (e: React.DragEvent<HTMLDivElement>) => {
      const from = dragIndexRef.current;
      dragIndexRef.current = null;
      if (from === null) return;
      e.preventDefault();
      if (from === index) return;
      void persistMove(itemsRef.current, from, index);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    dragIndexRef.current = null;
  }, []);

  const renderCustom = useCallback(
    (control: PaneControl) => (
      <CustomControlHost control={control} embedded />
    ),
    [],
  );

  const handleEditCode = useCallback((control: PaneControl) => {
    void openControlScriptEditor(control);
  }, []);

  const renderItem = useCallback(
    (item: PaneItem): React.ReactNode =>
      item.kind === "filter" ? (
        <RibbonFilterCard filter={item.filter} />
      ) : (
        <ControlCard
          control={item.control}
          onEditCode={handleEditCode}
          renderCustom={renderCustom}
        />
      ),
    [handleEditCode, renderCustom],
  );

  /** A draggable card wrapper carrying the item's index in the MERGED strip
   *  (grouped sidebar rendering still reorders within the merged order space). */
  const renderDraggableItem = useCallback(
    (item: PaneItem): React.ReactNode => {
      const index = items.indexOf(item);
      return (
        <div
          key={keyOf(item)}
          draggable
          onDragStart={handleDragStart(index)}
          onDragOver={handleDragOver}
          onDrop={handleDrop(index)}
          onDragEnd={handleDragEnd}
          style={band ? styles.dragWrapperBand : styles.dragWrapperSidebar}
        >
          {renderItem(item)}
        </div>
      );
    },
    [
      items,
      band,
      handleDragStart,
      handleDragOver,
      handleDrop,
      handleDragEnd,
      renderItem,
    ],
  );

  const emptyHint =
    items.length === 0 ? (
      <StatusText>Click + to add filters and controls</StatusText>
    ) : null;

  // Band: one horizontal strip of band-designed 56px cards in merged order.
  // The shell owns overflow handling.
  if (band) {
    return (
      <div style={styles.bandStrip}>
        <AddItemMenu />
        {emptyHint}
        {items.map((item) => renderDraggableItem(item))}
      </div>
    );
  }

  // Sidebar / launcher flyout: add-menu row on top, cards stacked vertically.
  // With filters from more than one model connection, the filter subset keeps
  // its per-connection grouping headers (controls list first, merged order,
  // in their own implicit group); otherwise one merged vertical stack.
  const filterItems = items.filter((i) => i.kind === "filter");
  const connectionIds = [
    ...new Set(
      filterItems.map((i) => (i.kind === "filter" ? i.filter.connectionId : "")),
    ),
  ];
  const grouped = connectionIds.length > 1;
  const controlItems = items.filter((i) => i.kind === "control");

  return (
    <Stack gap={6}>
      <ControlRow gap={6}>
        <AddItemMenu />
        {emptyHint}
      </ControlRow>
      {grouped ? (
        <>
          {controlItems.map((item) => renderDraggableItem(item))}
          {connectionIds.map((connId) => (
            <React.Fragment key={connId}>
              <div style={styles.groupHeader}>
                {getConnectionName(connId) ?? "(connection missing)"}
              </div>
              {filterItems
                .filter(
                  (i) => i.kind === "filter" && i.filter.connectionId === connId,
                )
                .map((item) => renderDraggableItem(item))}
            </React.Fragment>
          ))}
        </>
      ) : (
        items.map((item) => renderDraggableItem(item))
      )}
    </Stack>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bandStrip: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    gap: "6px",
    padding: "0 4px",
  },
  dragWrapperBand: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    minWidth: 0,
  },
  dragWrapperSidebar: {
    width: "100%",
    minWidth: 0,
  },
  groupHeader: {
    fontSize: "10px",
    fontWeight: 600,
    color: "#777",
    textTransform: "uppercase" as const,
    letterSpacing: "0.4px",
    marginTop: "4px",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
