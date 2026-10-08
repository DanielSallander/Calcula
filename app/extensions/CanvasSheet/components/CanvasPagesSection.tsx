//! FILENAME: app/extensions/CanvasSheet/components/CanvasPagesSection.tsx
// PURPOSE: The Canvas tab's PAGES group (Power BI's Insert > Pages): New Page,
//          a blank report page -- a new canvas sheet, made active.
// CONTEXT: One hero. The sheet strip owns adding a sheet (the switch, the tab,
//          SHEET_CHANGED); the page is asked for through the public sheet
//          command, core.sheet.insert (a canvas, at the end), which the tab
//          menu's "Insert Canvas" runs too (lib/canvasActions.ts
//          `addBlankCanvasPage`).
//
//          Power BI's New page v also offers Duplicate page. Calcula cannot
//          duplicate a canvas yet -- the backend refuses it, because the copy
//          would be an empty page presented as a copy (copy_sheet,
//          app/src-tauri/src/sheets.rs; canvas-sheets.md section 10) -- so the
//          menu is LEFT OUT rather than shown with a row that always fails
//          (the Home precedent: built, or left out, never shown disabled).
//
//          A subscribed canvas does not disable it: a new page is a sheet of
//          the reader's own, not a change to the publisher's layout.

import React from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { ActionRow, CommandButton, GAP_XS, HERO_ICON_SIZE, ICON_SIZE_SM, useSurfaceLayout } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { addBlankCanvasPage } from "../lib/canvasActions";
import { useCanvasSheet } from "./canvasHooks";

export function CanvasPagesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active } = useCanvasSheet();
  const band = useSurfaceLayout().container === "band";
  if (!active) return null;
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.NewPage size={band ? HERO_ICON_SIZE : ICON_SIZE_SM} />}
        label="New Page"
        tooltip="Add a blank report page: a new canvas sheet after the last sheet"
        data-testid="canvas-new-page"
        onClick={() => void addBlankCanvasPage()}
      />
    </ActionRow>
  );
}
