//! FILENAME: app/src/shell/components/SectionChrome.tsx
// PURPOSE: The ribbon CLUSTER: one rounded, softly tinted card holding a
//          section's content, with the group caption underneath.
// CONTEXT: One component for every ribbon cell, inline or demoted to a
//          launcher, so the two align and the renderer's width model has one
//          chrome to account for (cellChromeWidth below).
//
//          DOM, and why each piece is where it is:
//
//            div[data-section-cell]      the measured cell. padding-right is
//            |                           the gap to the next cluster, so the
//            |                           gap lives INSIDE offsetWidth and the
//            |                           ResizeObserver's width is the whole
//            |                           horizontal cost of the cell.
//            +- div[role=group]          the card: CLUSTER_PAD on ALL FOUR
//            |                           sides (the fill rule), radius
//            |                           --radius-cluster, --ribbon-cluster-bg,
//            |                           a hairline on hover drawn as an inset
//            |                           shadow so it never moves layout.
//            +- div                      the caption. ALWAYS the last element
//                                        child: shapes-hometab and the width
//                                        probe tests read a cell's label as
//                                        `lastElementChild.textContent`.
//
//          The fill rule (app/src/api/layout/tokens.ts): band 100 - padding
//          4+4 = 92 = card 77 + caption 15; card 77 - padding 8+8 = content 61.
//
//          Hide-labels mode (the user's `calcula.appearance.ribbonLabels`
//          preference, stamped on <html data-ribbon-labels>): the caption keeps
//          its TEXT (so the lastElementChild contract and screen readers are
//          unchanged) but collapses to zero height, and the card carries the
//          label as its `title`. A section whose caption is load-bearing
//          declares `captionMode: "always"` and keeps it visible.

import React, { useSyncExternalStore } from "react";
import { css, cx } from "@emotion/css";
import type { SectionCaptionMode } from "../../api/uiTypes";
import {
  LT,
  CLUSTER_GAP,
  CLUSTER_PAD,
  FONT_FAMILY,
  GROUP_LABEL_FONT_SIZE,
} from "../../api/layout";
import { subscribeToAppearance } from "../../api/appearance";

/**
 * The horizontal space a cell adds around its content: the card's padding on
 * both sides, plus the gap to the next cluster unless this is the last cell.
 * The renderer's pre-measurement width model adds this to a section's natural
 * content width; the real rendered cell width replaces the estimate as soon as
 * the cell probe reports. `isFirst` is part of the signature because the first
 * cell is where a leading inset would go if the band ever needs one again.
 */
export function cellChromeWidth(isFirst: boolean, isLast: boolean): number {
  void isFirst;
  return 2 * CLUSTER_PAD + (isLast ? 0 : CLUSTER_GAP);
}

// ============================================================================
// Label-mode subscription
// ============================================================================

/** Read from the attribute the skin loader stamps, not from its module state:
 *  the attribute is what the CSS and every other surface key off, so the
 *  ribbon cannot disagree with them. */
function readLabelsHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.ribbonLabels === "hide";
}

/** Whether the user has hidden the ribbon group captions (live). */
function useRibbonLabelsHidden(): boolean {
  return useSyncExternalStore(subscribeToAppearance, readLabelsHidden, () => false);
}

// ============================================================================
// Styles (tokens only)
// ============================================================================

const cellClass = css`
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  box-sizing: border-box;
  height: 100%;
  min-width: 0;
`;

const cardClass = css`
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: ${CLUSTER_PAD}px;
  border-radius: ${LT.radiusCluster};
  background: ${LT.clusterBg};
  transition: box-shadow ${LT.motionHover};

  &:hover {
    box-shadow: inset 0 0 0 1px ${LT.clusterBorderHover};
  }
`;

const captionClass = css`
  flex: none;
  margin-top: 2px;
  font-family: ${FONT_FAMILY};
  font-size: ${GROUP_LABEL_FONT_SIZE}px;
  font-weight: 500;
  line-height: 13px;
  color: ${LT.groupLabel};
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

/** Hidden caption: zero height, text kept. */
const captionHiddenClass = css`
  height: 0;
  margin: 0;
  overflow: hidden;
`;

// ============================================================================
// Component
// ============================================================================

export interface SectionChromeProps {
  /** The section's label: the caption under the card and the card's
   *  accessible name. Launcher cells pass the section label too, so the
   *  caption is present in both forms. */
  label: string;
  isFirst: boolean;
  isLast: boolean;
  /** "always" keeps the caption visible when the user hides group labels. */
  captionMode?: SectionCaptionMode;
  /** Ref to the cell's root element — the ribbon renderer's real rendered-width
   *  probe attaches here (measures the actual cell, launcher or inline). */
  measureRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}

export function SectionChrome({
  label,
  isFirst,
  isLast,
  captionMode = "default",
  measureRef,
  children,
}: SectionChromeProps): React.ReactElement {
  const labelsHidden = useRibbonLabelsHidden();
  const captionHidden = labelsHidden && captionMode !== "always";

  return (
    <div
      ref={measureRef}
      data-section-cell=""
      data-section-first={isFirst ? "" : undefined}
      className={cellClass}
      style={{ paddingRight: isLast ? 0 : CLUSTER_GAP }}
    >
      <div
        role="group"
        aria-label={label}
        title={captionHidden ? label : undefined}
        className={cardClass}
      >
        {children}
      </div>
      <div
        className={cx(captionClass, captionHidden && captionHiddenClass)}
        data-section-caption=""
      >
        {label}
      </div>
    </div>
  );
}
