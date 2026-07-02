//! FILENAME: app/extensions/FilterPane/components/FilterPaneSection.tsx
// PURPOSE: Panel section hosting the dynamic filter cards.
//          Ribbon band: horizontal strip of fixed-height cards (band-designed).
//          Sidebar / launcher flyout: add-button row on top, cards stacked below.
// CONTEXT: Each card shows field name + selection summary + dropdown arrow
//          (see RibbonFilterCard); "+" opens the Add Filter dialog.

import React, { useState, useEffect, useCallback } from "react";
import type { PanelSectionProps } from "@api/ui";
import { showDialog } from "@api";
import {
  Button,
  ControlRow,
  Stack,
  StatusText,
  useSurfaceLayout,
} from "@api/layout";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { getAllFilters } from "../lib/filterPaneStore";
import { ADD_FILTER_DIALOG_ID } from "../manifest";
import { RibbonFilterCard } from "./RibbonFilterCard";
import type { RibbonFilter } from "../lib/filterPaneTypes";

export function FilterPaneSection(
  _props: PanelSectionProps,
): React.ReactElement {
  const [filters, setFilters] = useState<RibbonFilter[]>([]);
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const refreshList = useCallback(() => {
    setFilters([...getAllFilters()]);
  }, []);

  useEffect(() => {
    refreshList();
    const events = [
      FilterPaneEvents.FILTER_CREATED,
      FilterPaneEvents.FILTER_DELETED,
      FilterPaneEvents.FILTER_UPDATED,
      FilterPaneEvents.FILTERS_REFRESHED,
    ];
    events.forEach((ev) => window.addEventListener(ev, refreshList));
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, refreshList));
    };
  }, [refreshList]);

  const handleAddFilter = useCallback(() => {
    showDialog(ADD_FILTER_DIALOG_ID);
  }, []);

  const addButton = (
    <Button
      title="Add a filter"
      onClick={handleAddFilter}
      style={styles.addButton}
    >
      <span style={styles.addIcon}>+</span>
    </Button>
  );

  const emptyHint =
    filters.length === 0 ? (
      <StatusText>Click + to add filters</StatusText>
    ) : null;

  const cards = filters.map((f) => (
    <RibbonFilterCard key={f.id} filter={f} />
  ));

  // Band: the cards ARE band-designed content (fixed 56px height) — host them
  // as a single horizontal strip. The shell owns overflow handling.
  if (band) {
    return (
      <div style={styles.bandStrip}>
        {addButton}
        {emptyHint}
        {cards}
      </div>
    );
  }

  // Sidebar / launcher flyout: add-button row on top, cards stacked vertically.
  return (
    <Stack gap={6}>
      <ControlRow gap={6}>
        {addButton}
        {emptyHint}
      </ControlRow>
      {cards}
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
  addButton: {
    width: 28,
    flexShrink: 0,
  },
  addIcon: {
    fontWeight: "bold",
    fontSize: "16px",
    lineHeight: 1,
  },
};
