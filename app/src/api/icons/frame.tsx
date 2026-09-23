//! FILENAME: app/src/api/icons/frame.tsx
// PURPOSE: The shared frame and the four paint channels of the duotone icon set.
// CONTEXT: Every RibbonIcon is drawn on ONE 24-unit grid and paints with ONE of
//          four channels, never with a colour of its own:
//
//          SOFT   the ground the subject sits on (an axis, a panel, a body).
//                 `--icon-fill-soft` is a TINT OF THE FOREGROUND
//                 (color-mix(currentColor 30%, transparent)), not a fixed grey,
//                 so it keeps the same separation on the band, on a tinted
//                 cluster, on a pressed button and in high contrast.
//          STRONG the subject itself: `currentColor`, so it follows the
//                 button's text colour and inverts with the skin.
//          ACCENT exactly one thing per icon: the series a chart icon is about,
//                 the element a furniture icon names, or the verb.
//          DANGER the destructive verb (delete, clear), in place of ACCENT.
//
//          Why no colour literal is allowed anywhere under src/api/icons: the
//          three channels re-resolve per skin, so the same drawing is correct
//          in Light, Dark, Soft and high contrast without being redrawn. A
//          literal would be correct in exactly one of them.
//
//          The drawing rules the set is held to (the approved mockup, rev 2):
//          filled shapes; rect corners rx >= 1.4; NOTHING THINNER THAN 3 UNITS
//          (a stroke is at least 2.6 with round caps and joins); no <text> and
//          no emoji, because a glyph renders in whatever font the machine has
//          and at 20px a font hint is a smudge. A 3-unit feature at the 20px
//          control size is 2.5 device pixels; the 2-unit features of the old
//          16-grid stroke set were 1.3, which is what made them blotchy.
//
//          SOFT is translucent. Two soft shapes that overlap therefore paint
//          the overlap darker, so drawings keep soft shapes apart and lay
//          STRONG / ACCENT (opaque) on top of soft, never soft on top of them.

import React from "react";

export interface RibbonIconProps {
  /** Rendered width/height in px. Defaults to 16. The ribbon renders the set
   *  at 20 (control row), 24 (rail, sidebar, launcher) and 30 (tile, hero). */
  size?: number;
}

/** A RibbonIcon component: one drawing, sized by the caller. */
export type RibbonIconComponent = (props: RibbonIconProps) => React.ReactElement;

/** The ground: a translucent tint of the foreground. */
export const SOFT = "var(--icon-fill-soft)";
/** The one highlighted element (series, named furniture, verb). */
export const ACCENT = "var(--icon-accent)";
/** The destructive verb, in place of ACCENT. */
export const DANGER = "var(--icon-danger)";
/** The subject: follows the control's text colour. */
export const STRONG = "currentColor";

/** The default rendered size when a caller passes none. */
export const DEFAULT_ICON_SIZE = 16;

export interface IconFrameProps {
  size?: number;
  /** Accessible name. When given the icon is announced (role="img" with a
   *  <title>); without it the icon is decorative and aria-hidden, because the
   *  control that hosts it already carries the name. */
  title?: string;
  children: React.ReactNode;
}

/** The 24-unit frame every icon in the set is drawn inside. */
export function IconFrame({
  size = DEFAULT_ICON_SIZE,
  title,
  children,
}: IconFrameProps): React.ReactElement {
  const labelled = typeof title === "string" && title.length > 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      style={{ display: "block", flex: "none" }}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
    >
      {labelled ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Minimum stroke width for a line or arrow: below it the 3-unit rule fails. */
export const MIN_STROKE = 2.6;

/**
 * Props for a stroked (not filled) path in one channel: round caps and joins,
 * no fill. Width defaults to 3, the grid's standard line; never pass less than
 * MIN_STROKE.
 *
 * ```tsx
 * <path d="M4 12h16" {...line(ACCENT)} />
 * ```
 */
export function line(
  channel: string,
  width = 3,
): {
  fill: "none";
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "round";
  strokeLinejoin: "round";
} {
  return {
    fill: "none",
    stroke: channel,
    strokeWidth: Math.max(width, MIN_STROKE),
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}
