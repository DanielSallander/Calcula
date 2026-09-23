//! FILENAME: app/src/shell/Ribbon/RibbonContainer.styles.ts
// PURPOSE: Styled components for the ribbon frame — the tab strip (flat text
//          tabs, hover pill, a 2px accent indicator under the active tab, an
//          optional badge beside a tab, a trailing collapse control) above the
//          fixed-height content band of rounded clusters.
// CONTEXT: Every colour is a theme token (the hex ban in eslint.boundaries.js
//          covers this folder), so a skin restyles the whole frame.
//
//          CONTRACTS relied on by E2E/soak tooling — do not break these:
//          - tabs are <button> elements whose ONLY text is the label
//            (invariants/stateSnapshot.ts finds a tab by
//            `button.textContent.trim() === tab.label`). A tab's badge is an
//            aria-hidden SIBLING of the button inside a position:relative
//            TabSlot span, never a child, so a badged tab still matches.
//          - the ACTIVE tab computes font-weight 600.
//          - the tab strip is the FIRST <div> inside the ribbon container
//            ([data-ribbon-content].parentElement.querySelector("div")), and
//            [data-ribbon-content] is a direct child of that container.
//          - a trailing NON-TAB control is allowed after the tabs (the
//            "Collapse ribbon" IconButton): it has no text content, only an
//            aria-label, so no label-matching probe can mistake it for a tab.
//            The first <button> in the strip is always a tab (the
//            elementFromPoint probe clicks the first one).
//          - the band ([data-ribbon-content]) is RIBBON_BAND_HEIGHT (100px)
//            tall with padding `4px 8px`; minimizing it ends at computed
//            `display: none` (it may animate its height first).
//          - the first <div> INSIDE the band is the section strip whose
//            children are the section cells (owner-decisions D6 reads
//            `band.querySelector("div").children`), which is why BandContent
//            below is a <section>, not a <div>.

import styled, { css, keyframes } from 'styled-components';
import { FONT_FAMILY } from '../../api/layout/tokens';
import { LT } from '../../api/layout/theme';

/** Hover wash of a tab: the ribbon's own hover token (slightly lighter than a
 *  control's, because a tab is a destination, not a command). */
const TAB_HOVER_BG = 'var(--ribbon-button-hover-bg, rgba(0, 0, 0, 0.05))';
const TAB_ACTIVE_BG = 'var(--ribbon-button-active-bg, rgba(0, 0, 0, 0.09))';
/** The active tab's indicator when the tab has no contextual accent. */
const TAB_INDICATOR = 'var(--ribbon-tab-indicator, #047857)';

/** Outer ribbon frame: tab strip + content band. */
export const RibbonFrame = styled.div`
  background-color: ${LT.ribbonFrame};
  border-bottom: 1px solid ${LT.border};
  position: relative;
  z-index: 10;
`;

/** The tab header strip. Fixed height so contextual tabs never shift layout.
 *  35px total = 34px content + 1px bottom border (global border-box sizing);
 *  the 26px TabButton centers with exactly 4px slack, so its indicator at
 *  bottom:-4px lands flush on the strip's bottom edge. */
export const TabStrip = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  height: 35px;
  background-color: ${LT.ribbonFrame};
  border-bottom: 1px solid ${LT.border};
  overflow: hidden;
  user-select: none;
`;

/** Wraps one tab so its badge can sit at the tab's top-right corner as a
 *  sibling of the <button> (the button's text stays exactly the label). */
export const TabSlot = styled.span`
  position: relative;
  display: inline-flex;
  flex: none;
`;

/** Pushes the trailing strip controls to the right edge. */
export const StripSpacer = styled.span`
  flex: 1 1 auto;
  min-width: 8px;
`;

interface TabButtonProps {
  $isActive: boolean;
  /** Contextual-tab accent (e.g. `var(--tab-accent-pivot, #1a7a43)`);
   *  undefined for regular tabs. */
  $accent?: string;
}

/**
 * A flat text tab. Active state = semibold + a 2px accent indicator pinned to
 * the strip's bottom edge; hover = a subtle rounded wash. A contextual tab
 * draws its label in its FULL accent colour (the accents are chosen for
 * 4.5:1 on the frame) and uses it for its indicator too.
 */
export const TabButton = styled.button<TabButtonProps>`
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: ${LT.radiusControl};
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-family: ${FONT_FAMILY};
  line-height: 1;
  white-space: nowrap;
  font-weight: ${({ $isActive }) => ($isActive ? 600 : 400)};
  color: ${({ $isActive, $accent }) =>
    $accent ? $accent : $isActive ? LT.text : LT.textSecondary};
  transition:
    background-color ${LT.motionHover},
    color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &:hover {
    background: ${TAB_HOVER_BG};
    color: ${({ $accent }) => ($accent ? $accent : LT.text)};
  }

  &:active {
    background: ${TAB_ACTIVE_BG};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  ${({ $isActive, $accent }) =>
    $isActive &&
    css`
      &::after {
        content: '';
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: -4px; /* strip content box is 34px, tab 26px centered -> 4px slack; flush on the strip's bottom edge */
        height: 2px;
        border-radius: 2px 2px 0 0;
        background: ${$accent ?? TAB_INDICATOR};
      }
    `}
`;

/** Where a tab's Badge sits: the tab's top-right corner. */
export const TAB_BADGE_STYLE = {
  position: 'absolute',
  top: 1,
  right: 1,
} as const;

/** Tab switch: the new tab's content eases in (reduced motion collapses it
 *  through the global rule in index.css). */
const bandContentEnter = keyframes`
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
`;

/**
 * The band's content wrapper, re-keyed on every tab switch so the entering
 * tab fades in. A <section>, NOT a <div>: the first <div> inside the band must
 * stay the section strip (see the contract list above).
 */
export const BandContent = styled.section`
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  /* backwards, NOT both: "both" keeps the last keyframe applied forever, which
     can keep the band on its own compositor layer, where Chromium draws text
     with grayscale instead of LCD anti-aliasing -- and whether it does depends
     on timing, so the ribbon goldens flickered at every glyph edge between
     identical runs. backwards holds the from-state only before the start; the
     end state is the element's own styles, so nothing lingers. */
  animation: ${bandContentEnter} ${LT.motionHover} backwards;
`;

/** One note for the one empty state: no ribbon tab is registered. */
export const EmptyNote = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  color: ${LT.textTertiary};
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 12px;
`;
