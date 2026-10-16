//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/ObjectPaneView.tsx
// PURPOSE: THE object pane's view: a header naming the object, a read-only
//          banner on a subscribed page, the tab strip (the family's BUILD tabs
//          + Format), the build slot and the Format tab.
// CONTEXT: The subject is read LIVE -- never from the task pane's `data`,
//          which is frozen at open: the host's subject (lib/paneState.ts)
//          names the object by region id, and the region itself is re-read
//          from @api/gridOverlays on every regions change and every selection
//          change, so a family re-publishing it (a drag, a binding resolving)
//          shows at once.
//
//          THE BUILD SLOT STAYS MOUNTED. The active build tab renders into ONE
//          slot, keyed by the object's region id, that stays mounted
//          (display:none) while Format is shown -- a pivot's Fields/Design
//          editor keeps its deferred edits and scroll across a Format visit,
//          and a provider that returns the same component type from two tabs
//          keeps ONE instance across them (React reconciliation).
//
//          The slot and the Format tab are SIBLINGS, so their keys carry a
//          prefix ("slot:" / "format:"): both keyed by the bare region id gave
//          React two children with one key whenever Format showed beside a kept
//          slot, and a commit from a Format row could be lost (found live,
//          object-pane-format J7, 2026-10-16).
//
//          THE PANE NEVER TAKES FOCUS on open; the grid keeps the keyboard.
//          Escape inside the pane (not consumed by a field) gives the keyboard
//          back to the grid. Focus inside the pane is focus OUTSIDE the grid,
//          so an object's Delete never fires from here (every Delete door asks
//          `isGridFocused()` -- the BUG-0125 class).

import React, { useEffect, useReducer, useRef } from "react";
import type { TaskPaneViewProps } from "@api/uiTypes";
import { SegmentedTabs } from "@api/layout";
import { onRegionChange, type GridRegion } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  getObjectPaneProvider,
  type ObjectPaneTab,
} from "@api/objectPane";
import { getSelectedObjectRegions, objectLabelOf, onObjectSelectionChanged } from "@api/objectSelection";
import { SIZE_POSITION_SUBSCRIBED } from "@api/objectPosition";
import { getLayoutSurface } from "@api/layoutSurface";
import { getGridStateSnapshot } from "@api/grid";
import { restoreFocusToGrid } from "@api/events";
import { getPaneSubject, subscribePaneSubject } from "../lib/paneState";
import { liveObjectRegion, selectObjectPaneTab } from "../lib/objectPaneHost";
import { FormatTab } from "./FormatTab";
import { paneStyles } from "./paneStyles";

/** The Format tab's label in the strip. */
export const FORMAT_TAB_LABEL = "Format";

/** What the pane says when it shows no object. */
export const OBJECT_PANE_EMPTY = "Select an object to see its settings.";

/** Whether the active page is a subscribed page (its layout is the publisher's). */
export function activePageReadOnly(): boolean {
  const surface = getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
  return !!surface && !surface.editable;
}

/** The pane header: the family's words, else the object's label, else its type. */
export function objectPaneHeader(region: GridRegion, selectedCount: number): { title: string; count: string | null } {
  const provider = getObjectPaneProvider(region);
  let title: string | null = null;
  if (provider?.headerOf) {
    try {
      title = provider.headerOf(region) || null;
    } catch (err) {
      console.error(`[ObjectPane] the "${region.type}" provider's headerOf() threw:`, err);
    }
  }
  title ??= objectLabelOf(region) ?? region.type;
  return { title, count: selectedCount > 1 ? `(1 of ${selectedCount} selected)` : null };
}

function safeTabs(region: GridRegion): readonly ObjectPaneTab[] {
  const provider = getObjectPaneProvider(region);
  if (!provider) return [];
  try {
    return (provider.tabs(region) ?? []).filter((t) => t.id !== OBJECT_PANE_FORMAT_TAB);
  } catch (err) {
    console.error(`[ObjectPane] the "${region.type}" provider's tabs() threw:`, err);
    return [];
  }
}

export function ObjectPaneView(_props: TaskPaneViewProps): React.ReactElement {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  /** The build tab the slot shows while Format is up (the last build tab shown). */
  const lastBuildTab = useRef<{ regionId: string; tabId: string } | null>(null);

  useEffect(() => {
    const cleanups = [
      subscribePaneSubject(() => rerender()),
      onRegionChange(() => rerender()),
      onObjectSelectionChanged(() => rerender()),
    ];
    return () => {
      for (const c of cleanups) c();
    };
  }, []);

  const subject = getPaneSubject();
  const region = subject.open ? liveObjectRegion(subject.regionId) : null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation();
      restoreFocusToGrid();
    }
  };

  if (!region) {
    return (
      <div style={paneStyles.root} data-testid="object-pane" onKeyDown={onKeyDown}>
        <div style={paneStyles.empty} data-testid="object-pane-empty">
          {OBJECT_PANE_EMPTY}
        </div>
      </div>
    );
  }

  const tabs = safeTabs(region);
  const activeTab =
    subject.tabId && (subject.tabId === OBJECT_PANE_FORMAT_TAB || tabs.some((t) => t.id === subject.tabId))
      ? subject.tabId
      : (tabs[0]?.id ?? OBJECT_PANE_FORMAT_TAB);
  const formatShown = activeTab === OBJECT_PANE_FORMAT_TAB;

  // The build tab in the slot: the active one, or (under Format) the last one shown.
  let slotTabId: string | null = null;
  if (!formatShown) {
    slotTabId = activeTab;
    lastBuildTab.current = { regionId: region.id, tabId: activeTab };
  } else if (lastBuildTab.current?.regionId === region.id && tabs.some((t) => t.id === lastBuildTab.current!.tabId)) {
    slotTabId = lastBuildTab.current.tabId;
  }
  const slotTab = slotTabId ? (tabs.find((t) => t.id === slotTabId) ?? null) : null;

  const readOnly = activePageReadOnly();
  const readOnlyReason = readOnly ? SIZE_POSITION_SUBSCRIBED : null;
  const header = objectPaneHeader(region, getSelectedObjectRegions().length);
  const stripTabs = [...tabs.map((t) => ({ id: t.id, label: t.label })), { id: OBJECT_PANE_FORMAT_TAB, label: FORMAT_TAB_LABEL }];

  let slotContent: React.ReactNode = null;
  if (slotTab) {
    try {
      slotContent = slotTab.render({ region, readOnly, readOnlyReason, activeTabId: activeTab });
    } catch (err) {
      console.error(`[ObjectPane] the "${region.type}" tab "${slotTab.id}" failed to render:`, err);
      slotContent = <div style={paneStyles.note}>This tab could not be shown.</div>;
    }
  }

  return (
    <div
      style={paneStyles.root}
      data-testid="object-pane"
      data-region-id={region.id}
      data-region-type={region.type}
      data-active-tab={activeTab}
      onKeyDown={onKeyDown}
    >
      <div style={paneStyles.header} data-testid="object-pane-header" title={header.title}>
        {header.title}
        {header.count && <span style={paneStyles.headerCount}> {header.count}</span>}
      </div>
      {readOnly && (
        <div style={paneStyles.banner} role="note" data-testid="object-pane-readonly">
          {SIZE_POSITION_SUBSCRIBED}
        </div>
      )}
      <div style={paneStyles.tabs} data-testid="object-pane-tabs">
        <SegmentedTabs
          tabs={stripTabs}
          value={activeTab}
          ariaLabel="Object pane tabs"
          testIdPrefix="object-pane-tab-"
          onChange={(id) => selectObjectPaneTab(id)}
        />
      </div>
      <div style={paneStyles.body}>
        {slotTab && (
          <div
            key={`slot:${region.id}`}
            data-testid="object-pane-build-slot"
            data-tab-id={slotTab.id}
            style={{ display: formatShown ? "none" : "block" }}
          >
            {slotContent}
          </div>
        )}
        {formatShown && (
          <FormatTab key={`format:${region.id}`} region={region} readOnly={readOnly} readOnlyReason={readOnlyReason} />
        )}
      </div>
    </div>
  );
}
