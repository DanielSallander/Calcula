//! FILENAME: app/src/shell/registries/sheetTabColorPicker.tsx
// PURPOSE: The sheet-tab menu's Tab Color: Excel's colour palette (Theme
//          Colors, Standard Colors, No Color, More Colors...) dropping from the
//          right-clicked tab, running CoreCommands.SHEET_TAB_COLOR.
// CONTEXT: Home tab 2026-10-04 (shell-sheets defect 6). The tab menu's Tab
//          Color was a numbered TEXT prompt ("1. Red ... 9. No Color, enter
//          number (or hex color)") with eight colours of its own, dispatching a
//          raw `sheet:requestTabColor` window event: a second door beside
//          core.sheet.setTabColor, which the Home tab's Format > Tab Color runs,
//          with its own validation. Now both doors run the ONE command (which
//          acts through the strip's own handler, sheetCommands.ts), and the
//          palette is the kit's ColorPopover -- the one every colour in the
//          app is picked from.
//
//          The tab menu is the strip's own list of plain rows (no submenus), so
//          choosing Tab Color closes it and opens this palette ANCHORED ON THE
//          TAB, upward (the tabs sit at the bottom of the window). The palette
//          is a shell component (@api/ui registerShellComponent -- the frame
//          mounts every one), opened through a tiny store, because the menu row
//          is a plain callback with no React tree of its own: the
//          insertFunctionHost.tsx pattern.
//
//          - A theme pick is stored as its resolved hex: SHEET_TAB_COLOR takes
//            "#hex" or null (the tab colour has no theme slot to keep), so
//            onThemeColorChange is not given and ColorPopover hands onChange
//            the hex.
//          - "No Color" is the palette's automatic row with an empty chip,
//            after Standard Colors (where Excel's fill-family palettes put it).
//          - The sheet's CURRENT colour is marked selected (read from the
//            strip's snapshot when the menu row runs).
//          - The custom colour field reports live while the OS picker is
//            dragged, as everywhere ColorPopover is used; each report runs the
//            command (the strip coalesces nothing), so that path can leave
//            several undo steps.

import React, { useCallback, useSyncExternalStore } from "react";
import { ColorPopover } from "@api/layout";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerShellComponent } from "@api/ui";

/** The shell component's id (one palette for the whole strip). */
export const SHEET_TAB_COLOR_PICKER_ID = "core.sheetTabColorPicker";
/** data-testid of the palette body (rows suffix it: `-automatic`, `-custom`, `-hex`). */
export const SHEET_TAB_COLOR_PICKER_TEST_ID = "sheet-tab-color-popover";

interface TabColorRequest {
  open: boolean;
  /** The TRUE workbook index of the sheet whose tab was right-clicked. */
  index: number;
  /** Its current colour ("#hex"), or null for No Color. */
  value: string | null;
  /** Bumped on every open, so a reopen starts a fresh palette. */
  seq: number;
}

let request: TabColorRequest = { open: false, index: -1, value: null, seq: 0 };
const listeners = new Set<() => void>();

function setRequest(next: TabColorRequest): void {
  request = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getRequest = (): TabColorRequest => request;

/** Open the palette on sheet `index`'s tab; `current` marks its colour ("" = none). */
export function openSheetTabColorPicker(index: number, current: string | null | undefined): void {
  setRequest({ open: true, index, value: current ? current : null, seq: request.seq + 1 });
}

/** Close it (a pick, Escape and an outside press all end here). */
export function closeSheetTabColorPicker(): void {
  if (request.open) setRequest({ ...request, open: false });
}

/** The tab the palette drops from: the strip renders each as `button[data-sheet-tab="<index>"]`. */
function tabElement(index: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`button[data-sheet-tab="${index}"]`);
}

/** The palette. Renders nothing while closed. */
export function SheetTabColorPickerHost(): React.ReactElement | null {
  const current = useSyncExternalStore(subscribe, getRequest, getRequest);
  const { open, index, value, seq } = current;

  const run = useCallback(
    (color: string | null) => {
      // The ONE door: the command validates the colour and acts through the
      // strip's own handler (sheetCommands.ts). Its refusals are its toasts.
      void CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, { index, color });
    },
    [index],
  );

  if (!open) return null;
  return (
    <ColorPopover
      key={seq}
      anchorEl={tabElement(index)}
      open
      onClose={closeSheetTabColorPicker}
      value={value}
      onChange={(hex) => run(hex)}
      allowAutomatic
      automaticLabel="No Color"
      automaticChip="none"
      automaticPlacement="afterColors"
      onAutomatic={() => run(null)}
      placement="top-start"
      ariaLabel="Tab Color"
      testId={SHEET_TAB_COLOR_PICKER_TEST_ID}
    />
  );
}

/** Mount the palette's host in the frame (registerCoreSheetContextMenu does, once). */
export function installSheetTabColorPicker(): void {
  registerShellComponent({ id: SHEET_TAB_COLOR_PICKER_ID, component: SheetTabColorPickerHost });
}
