//! FILENAME: app/extensions/Table/components/FormatAsTableGallery.tsx
// PURPOSE: Home > Format as Table's gallery (Excel's Styles group): every
//          table style Excel offers, as the grouped grid Excel shows.
// CONTEXT: Registered as the customContent of Format > "Format as Table"
//          (handlers/formatAsTable.ts). The Home tab hosts that item through
//          the kit's RegisteredMenuButton, whose card IS this gallery's popover
//          -- the Home tab may not import the Table extension, and this way
//          the menu bar and the ribbon show one gallery owned here.
//
//          ALWAYS A GRID. A popover portalled out of the ribbon band still
//          inherits the band's surface layout through React context, and
//          StyleGallery in a band draws its 61px strip + expand button. So the
//          gallery sets its own popover layout (width 0: the column count is
//          the one asked for, Excel's 7), exactly as CellStylesGallery does.
//
//          ITS OWN SURFACE. In the ribbon the card around it is LT.surface; in
//          the menu bar the flyout is dark in every skin. The gallery paints
//          LT.surface itself -- seamless in the card, legible in the menu bar.
//
//          A PICK GOES THROUGH THE COMMAND. `table.formatAsTable { styleId }`
//          decides what a pick means (restyle the table at the active cell, or
//          open Create Table in that style), so the gallery, the keyboard, a
//          macro and a script share one handler. The card closes FIRST, so the
//          focus it hands back to its trigger cannot land after -- and over --
//          the Create Table dialog the command may open.
//
//          Excel's set without "None" (that tile belongs to Table Design, where
//          it removes a table's style; there is nothing to remove a style from
//          when making one). New Table Style... / New PivotTable Style... are
//          deferred (owner decision 7) and not shown.

import React, { useCallback, useMemo } from "react";
import { css } from "@emotion/css";
import { ExtensionCommands, CommandRegistry } from "@api";
import {
  LT,
  FONT_FAMILY,
  StyleGallery,
  SurfaceLayoutProvider,
  popoverLayout,
} from "@api/layout";
import { EXCEL_TABLE_STYLE_ITEMS } from "./TableStylesGallery";

/** Excel's Format as Table grid is seven thumbnails wide. */
const COLUMNS = 7;

const galleryRoot = css`
  box-sizing: border-box;
  max-height: 480px;
  overflow-y: auto;
  padding: 4px;
  background: ${LT.surface};
  color: ${LT.text};
  border-radius: ${LT.radiusControl};
  font-family: ${FONT_FAMILY};
`;

export interface FormatAsTableGalleryProps {
  /** Close the menu / card that hosts the gallery. */
  onClose: () => void;
}

export function FormatAsTableGallery({ onClose }: FormatAsTableGalleryProps): React.ReactElement {
  const layout = useMemo(() => popoverLayout(), []);

  const handleChoose = useCallback(
    (styleId: string) => {
      onClose();
      CommandRegistry.execute(ExtensionCommands.FORMAT_AS_TABLE, { styleId }).catch((err: unknown) => {
        console.error("[Table] Format as Table failed:", err);
      });
    },
    [onClose],
  );

  return (
    <div className={galleryRoot} data-testid="format-as-table-gallery">
      <SurfaceLayoutProvider value={layout}>
        <StyleGallery
          items={EXCEL_TABLE_STYLE_ITEMS}
          value={null}
          onChange={handleChoose}
          label="Format as Table"
          columns={COLUMNS}
          testIdPrefix="format-as-table"
        />
      </SurfaceLayoutProvider>
    </div>
  );
}
