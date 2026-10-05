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
//            +- button[data-dialog-launcher]   ONLY when the section declares
//            |                           a dialog launcher (Excel's corner
//            |                           arrow, PanelSection.dialogLauncher):
//            |                           absolutely positioned at the cell's
//            |                           bottom-right, so it adds no width
//            |                           and no height. BEFORE the caption,
//            |                           never after it and never inside it.
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
//
//          The DIALOG LAUNCHER (a section's `dialogLauncher`) and the goldens:
//          everything it needs — the button, the cell's positioning context,
//          the caption's symmetric padding — is applied ONLY when one is
//          declared. A section without one renders the DOM and the rules it
//          always did, so no existing ribbon moves by a pixel. With one:
//          - labels shown: the button sits in the caption row at the right
//            (its 13px height is the caption's line box), and the caption
//            pads both sides by DIALOG_LAUNCHER_CAPTION_PAD so its text stays
//            centred and never runs under the arrow. The padding can widen a
//            group only when caption + 36px is wider than the group's content,
//            which no Home group is; the cell probe measures the real width
//            either way, so the collapse math stays right.
//          - labels hidden: the caption is 0 tall, so a button INSIDE it would
//            vanish; this one is the caption's sibling and simply lands in the
//            card's free bottom strip, inset by DIALOG_LAUNCHER_HIDDEN_INSET to
//            stay inside the card's rounded corner. Still on screen, still in
//            the Tab order.
//          The collapsed (launcher) form does NOT get one here: SectionCell
//          hands it to the Launcher's flyout heading instead, which is where
//          Excel's collapsed group shows it, and the collapsed cell keeps its
//          exact measured width.

import React, { useSyncExternalStore } from "react";
import { css, cx } from "@emotion/css";
import type { PanelSectionDialogLauncher, SectionCaptionMode } from "../../api/uiTypes";
import {
  LT,
  CLUSTER_GAP,
  CLUSTER_PAD,
  FONT_FAMILY,
  GROUP_LABEL_FONT_SIZE,
} from "../../api/layout";
import {
  DialogLauncherButton,
  DIALOG_LAUNCHER_CAPTION_PAD,
  DIALOG_LAUNCHER_HIDDEN_INSET,
} from "../../api/layout/primitives/Launcher";
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

/**
 * The data-testid of a section's dialog launcher: the section's own `testId`
 * when it declares one, else `dialog-launcher-<sectionId>`
 * (`dialog-launcher-home.font`). One spelling for the ribbon cell, the
 * collapsed group's flyout heading and the sidebar header — only one of them
 * is mounted for a section at a time, since a panel lives on one surface and a
 * group is either inline or collapsed. Deliberately NOT `section-launcher-*`
 * (the width probes read that prefix as "this group is collapsed") and NOT
 * `fmt-*` (shapes-hometab counts a group's rows from its `fmt-` buttons).
 */
export function dialogLauncherTestId(
  sectionId: string,
  launcher: PanelSectionDialogLauncher,
): string {
  return launcher.testId ?? `dialog-launcher-${sectionId}`;
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

/** Only with a dialog launcher: the cell becomes the launcher's containing
 *  block. Never applied otherwise — a positioning context changes the paint
 *  order of everything inside the cell, and a section without a launcher must
 *  render exactly as before. */
const cellWithDialogLauncherClass = css`
  position: relative;
`;

/** Only with a dialog launcher: room for the arrow on the right, the same on
 *  the left so the text stays centred. Kept in hide mode as well, so toggling
 *  the label preference never changes a group's width. */
const captionWithDialogLauncherClass = css`
  padding-left: ${DIALOG_LAUNCHER_CAPTION_PAD}px;
  padding-right: ${DIALOG_LAUNCHER_CAPTION_PAD}px;
`;

/** The launcher's anchor: the cell's bottom edge. `right` is set inline from
 *  the cell's padding-right (the gap to the next cluster), because the
 *  containing block is the padding box and the arrow must sit over the CARD's
 *  right edge, not out in the gap. */
const dialogLauncherAnchorClass = css`
  position: absolute;
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
  /** Excel's group dialog launcher, drawn at the bottom-right of the cell.
   *  Its `testId` is used AS GIVEN: SectionCell resolves the
   *  `dialog-launcher-<sectionId>` default (dialogLauncherTestId) first.
   *  Omitted: no launcher, and the cell is exactly what it was before the
   *  feature existed. */
  dialogLauncher?: PanelSectionDialogLauncher;
  children: React.ReactNode;
}

export function SectionChrome({
  label,
  isFirst,
  isLast,
  captionMode = "default",
  measureRef,
  dialogLauncher,
  children,
}: SectionChromeProps): React.ReactElement {
  const labelsHidden = useRibbonLabelsHidden();
  const captionHidden = labelsHidden && captionMode !== "always";
  const gap = isLast ? 0 : CLUSTER_GAP;
  const inset = captionHidden ? DIALOG_LAUNCHER_HIDDEN_INSET : 0;

  return (
    <div
      ref={measureRef}
      data-section-cell=""
      data-section-first={isFirst ? "" : undefined}
      className={dialogLauncher ? cx(cellClass, cellWithDialogLauncherClass) : cellClass}
      style={{ paddingRight: gap }}
    >
      <div
        role="group"
        aria-label={label}
        title={captionHidden ? label : undefined}
        className={cardClass}
      >
        {children}
      </div>
      {dialogLauncher && (
        <DialogLauncherButton
          label={dialogLauncher.label}
          onClick={dialogLauncher.onLaunch}
          commandId={dialogLauncher.commandId}
          testId={dialogLauncher.testId}
          className={dialogLauncherAnchorClass}
          style={{ bottom: inset, right: gap + inset }}
        />
      )}
      <div
        className={cx(
          captionClass,
          dialogLauncher && captionWithDialogLauncherClass,
          captionHidden && captionHiddenClass,
        )}
        data-section-caption=""
      >
        {label}
      </div>
    </div>
  );
}
