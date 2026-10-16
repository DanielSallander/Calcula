//! FILENAME: app/extensions/Slicer/components/SlicerFormatCards.tsx
// PURPOSE: The slicer's own "Visual" cards in the object pane's Format tab
//          (WP-C D-FORMAT): BUTTONS (columns) and STYLES (the Slicer Styles
//          gallery) -- the contextual Slicer ribbon panel's own sections,
//          rendered in a sidebar surface.
// CONTEXT: The host (BuiltIn/ObjectPane) wraps each card in its collapsible
//          frame; these components are the bodies only. The sections act on
//          the SELECTED slicers (the ribbon's rule, with a mixed value shown as
//          a dash), and the pane formats the primary one of that selection, so
//          the two agree. On a subscribed page the card is disabled with the
//          pane's reason.

import React from "react";
import type { FormatCardContribution, FormatCardProps } from "@api/objectFormat";
import type { PanelSectionProps } from "@api/uiTypes";
import { SlicerButtonsSection, SlicerStylesSection } from "./SlicerOptionsSections";

/** The contribution ids (the Format tab's `data-format-card`). */
export const SLICER_BUTTONS_CARD_ID = "slicer-buttons";
export const SLICER_STYLES_CARD_ID = "slicer-styles";

const SIDEBAR_SECTION: PanelSectionProps = { placement: "sidebar" };

const FIELDSET_STYLE: React.CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

function slicerIdOf(region: FormatCardProps["region"]): string | null {
  const id = (region.data as { slicerId?: unknown } | undefined)?.slicerId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The Buttons card: the ribbon's Buttons section (columns). */
export function SlicerButtonsCard({ region, readOnly, readOnlyReason }: FormatCardProps): React.ReactElement | null {
  if (!slicerIdOf(region)) return null;
  return (
    <fieldset
      disabled={readOnly}
      title={readOnly && readOnlyReason ? readOnlyReason : undefined}
      style={FIELDSET_STYLE}
      data-testid="slicer-format-buttons"
    >
      <SlicerButtonsSection {...SIDEBAR_SECTION} />
    </fieldset>
  );
}

/** The Styles card: the Slicer Styles gallery. */
export function SlicerStylesCard({ region, readOnly, readOnlyReason }: FormatCardProps): React.ReactElement | null {
  if (!slicerIdOf(region)) return null;
  return (
    <fieldset
      disabled={readOnly}
      title={readOnly && readOnlyReason ? readOnlyReason : undefined}
      style={FIELDSET_STYLE}
      data-testid="slicer-format-styles"
    >
      <SlicerStylesSection {...SIDEBAR_SECTION} />
    </fieldset>
  );
}

/** The slicer's visual cards, in the order the Format tab shows them. */
export const SLICER_FORMAT_CARDS: readonly FormatCardContribution[] = Object.freeze([
  { id: SLICER_STYLES_CARD_ID, title: "Slicer styles", order: 10, Component: SlicerStylesCard },
  { id: SLICER_BUTTONS_CARD_ID, title: "Buttons", order: 20, Component: SlicerButtonsCard },
]);
