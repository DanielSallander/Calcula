//! FILENAME: app/src/api/layout/primitives/Badge.tsx
// PURPOSE: The small count pill — "3" active filters on a hero, "2" contextual
//          tabs, an unread count on an activity-bar item.
// CONTEXT: Before the Clusters redesign every surface that needed a count drew
//          its own circle with its own literal colour, so no two agreed and
//          none followed the skin. This is the one pill: accent by default,
//          danger for errors, neutral for a count that is information rather
//          than a call to action.
//
//          The Badge only paints; it does not position itself. Callers anchor
//          it (CommandButton puts it at the top-right of the hero's icon slot)
//          through `className`/`style`, because "top-right of what" is the
//          caller's geometry, not the pill's.
//
//          It is NOT aria-hidden by default: a standalone count is content. A
//          caller nesting it inside a control whose accessible name must stay
//          the label (the hero does) passes `aria-hidden` itself.

import React from "react";
import { css } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY } from "../tokens";

export type BadgeTone = "accent" | "danger" | "neutral";

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The count or short text ("3", "99+", "!"). */
  children: React.ReactNode;
  /** accent (default) = a call to look; danger = an error count;
   *  neutral = information that should not compete with the control. */
  tone?: BadgeTone;
  /** Pill height in px; min-width equals it so a single digit is a circle. */
  size?: 14 | 16;
}

const base = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  padding: 0 4px;
  font-family: ${FONT_FAMILY};
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
`;

const tones: Record<BadgeTone, string> = {
  accent: css`
    background: ${LT.badgeBg};
    color: ${LT.badgeFg};
  `,
  danger: css`
    background: ${LT.dangerFg};
    color: ${LT.badgeFg};
  `,
  // A white-on-grey pill has no contrast in the dark skin, where
  // --text-secondary is light; the chip recipe reads in both.
  neutral: css`
    background: ${LT.chipBg};
    color: ${LT.textSecondary};
    box-shadow: inset 0 0 0 1px ${LT.chipBorder};
  `,
};

/** A count pill painted with the badge tokens. */
export function Badge({
  children,
  tone = "accent",
  size = 14,
  className,
  style,
  ...rest
}: BadgeProps): React.ReactElement {
  return (
    <span
      className={[base, tones[tone], className].filter(Boolean).join(" ")}
      style={{
        minWidth: size,
        height: size,
        borderRadius: size / 2,
        fontSize: size === 16 ? 10 : 9,
        ...style,
      }}
      data-tone={tone}
      {...rest}
    >
      {children}
    </span>
  );
}
