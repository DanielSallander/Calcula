//! FILENAME: app/extensions/ControlsPane/components/AddItemMenu.tsx
// PURPOSE: The Controls pane's "Add" command: a menu offering every addable
//          item kind. "Filter..." opens the Add Filter dialog (BI-only,
//          disabled with a tooltip when the workbook has no model connections);
//          the five control kinds open the Add Control dialog pre-set to the
//          picked type.
// CONTEXT: An @api MenuButton — the trigger is a CommandButton (the 61px hero
//          in the ribbon band, a 28px button in the sidebar), the list a card
//          Popover + Menu with the menu keyboard model. It replaced a
//          hand-rolled position:fixed layer with its own outside-click and
//          Escape listeners and a 200ms reopen guard; the Popover owns
//          dismissal now, and a press on the trigger itself toggles.
//
//          The connection check runs when the menu OPENS, not when the pane
//          mounts: FilterMenuItem is only mounted while the menu is open, so
//          its mount effect is the open event. Until the answer arrives the
//          item stays disabled, exactly as before.

import React, { useEffect, useState } from "react";
import { showDialog, RibbonIcon } from "@api";
import {
  CommandButton,
  MenuButton,
  MenuItem,
  MenuSeparator,
  HERO_ICON_SIZE,
} from "@api/layout";
import { getBiConnections } from "../lib/filterPaneApi";
import type { PaneControlType } from "../lib/controlsPaneTypes";
import { ADD_FILTER_DIALOG_ID, ADD_CONTROL_DIALOG_ID } from "../manifest";

const MENU_WIDTH = 180;

const NO_CONNECTION_TOOLTIP =
  "Requires a model connection (Data > Business Intelligence)";

const CONTROL_ITEMS: Array<{ label: string; controlType: PaneControlType }> = [
  { label: "Button", controlType: "button" },
  { label: "Slider", controlType: "slider" },
  { label: "Dropdown", controlType: "dropdown" },
  { label: "Checkbox", controlType: "checkbox" },
  { label: "Custom...", controlType: "custom" },
];

/**
 * "Filter..." — enabled only once the workbook is confirmed to have at least
 * one model connection (the same source the Add Filter dialog lists).
 */
function FilterMenuItem(): React.ReactElement {
  // null = still loading (the item stays disabled until connections confirm).
  const [hasConnections, setHasConnections] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBiConnections()
      .then((conns) => {
        if (!cancelled) setHasConnections(conns.length > 0);
      })
      .catch(() => {
        if (!cancelled) setHasConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabled = hasConnections === true;
  return (
    <MenuItem
      testId="controls-pane-add-filter"
      disabled={!enabled}
      title={enabled ? undefined : NO_CONNECTION_TOOLTIP}
      onSelect={() => showDialog(ADD_FILTER_DIALOG_ID)}
    >
      Filter...
    </MenuItem>
  );
}

export function AddItemMenu(): React.ReactElement {
  return (
    <MenuButton
      width={MENU_WIDTH}
      ariaLabel="Add a filter or control"
      trigger={
        <CommandButton
          data-testid="controls-pane-add"
          icon={<RibbonIcon.Plus size={HERO_ICON_SIZE} />}
          label="Add"
          chevron
          tooltip="Add a filter or control"
          aria-label="Add a filter or control"
        />
      }
    >
      <FilterMenuItem />
      <MenuSeparator />
      {CONTROL_ITEMS.map((item) => (
        <MenuItem
          key={item.controlType}
          testId={`controls-pane-add-${item.controlType}`}
          onSelect={() =>
            showDialog(ADD_CONTROL_DIALOG_ID, { controlType: item.controlType })
          }
        >
          {item.label}
        </MenuItem>
      ))}
    </MenuButton>
  );
}
