//! FILENAME: app/src/api/icons/frame.tsx
// PURPOSE: The shared frame and the four paint channels of the duotone icon set.
// CONTEXT: Every RibbonIcon is drawn on ONE 24-unit grid and paints with ONE of
//          four channels, never with a colour of its own:
//
//          SOFT   the ground the subject sits on (an axis, a panel, a body).
//                 `--icon-fill-soft` is a TINT OF THE FOREGROUND
//                 (color-mix(currentColor 50%, transparent) in light, 45% in
//                 dark), not a fixed grey, so it keeps the same separation on
//                 the band, on a tinted cluster, on a pressed button and in
//                 high contrast. It must clear 3:1 against the cluster AND
//                 leave STRONG 3:1 above it; the reasoning is in the themes.
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
//          (a stroke is at least 2.6 with round caps and joins, or exactly 2.4
//          on a straight horizontal/vertical run centred on the pixel grid:
//          PIXEL_STROKE, two whole pixels at 20px); no <text> and
//          no emoji, because a glyph renders in whatever font the machine has
//          and at 20px a font hint is a smudge. A 3-unit feature at the 20px
//          control size is 2.5 device pixels; the 2-unit features of the old
//          16-grid stroke set were 1.3, which is what made them blotchy.
//
//          How much of the box a drawing fills (the fill audit, 2026-09-24).
//          The 28px button with a 20px icon stays; an icon that looks lost in
//          it is a drawing to fix, not a size to raise:
//          - long side 19-20 units (margin 2.0-2.5; prefer 2.4, which lands on
//            whole pixels at 20px and at 20px x 150%);
//          - short side at least 16 units, unless the subject is inherently a
//            strip, and then centred;
//          - visually centred within 0.6 units, except where position IS the
//            meaning (Align, Indent);
//          - no ink closer than 1.2 units to the frame edge, except a
//            deliberate tip or drop (an arrow that reaches the edge touches the
//            divider of the segmented pill it sits in);
//          - parts at least 3.6 units (3 px); a free-standing dot at least 4.3.
//
//          SOFT is translucent. Two soft shapes that overlap therefore paint
//          the overlap darker, so drawings keep soft shapes apart and lay
//          STRONG / ACCENT (opaque) on top of soft, never soft on top of them.
//
//          ACCENT (and DANGER) borders the BACKGROUND, not the greys
//          (2026-09-24). No single green clears 3:1 from both SOFT and STRONG
//          (the best any one lightness can do is 2.2:1 each), so a new or
//          redrawn icon keeps at least 1.2 units (one clean pixel at 20px, on
//          the 1.2 grid) between its accent and every SOFT or STRONG shape: move
//          it, shrink it, or cut a notch or a HOLE (a reverse-wound subpath)
//          into the ground. Never a <mask>. A strong-or-soft part left beside
//          the cut stays at least 2.4 wide. Checked by
//          `npm run check:icon-contact` against a shrink-only allowlist.

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

/** One device pixel at the 20px control size, in grid units (24 / 20). An
 *  edge on a multiple of it paints crisp at 100%; an edge between two
 *  multiples paints a half-covered pixel, which reads as a soft edge. On a
 *  multiple of 2 x PIXEL_GRID it is also crisp at 150%. */
export const PIXEL_GRID = 1.2;

/**
 * The one exception to MIN_STROKE: exactly two whole pixels at 20px
 * (2 x PIXEL_GRID). A 2.6 line is 2.17 px and can NEVER be crisp at 100%, so
 * a straight horizontal or vertical line may be 2.4 instead, but only when
 * its centre lies on the pixel grid, so both edges land on pixel boundaries.
 * Diagonals and curves keep MIN_STROKE (they antialias whatever their width).
 * ribbonIcons.test.tsx enforces both conditions.
 */
export const PIXEL_STROKE = 2.4;

/**
 * Props for a stroked (not filled) path in one channel: round caps and joins,
 * no fill. Width defaults to 3, the grid's standard line; never pass less than
 * MIN_STROKE, except PIXEL_STROKE on a pixel-aligned horizontal/vertical path.
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
    strokeWidth: width === PIXEL_STROKE ? PIXEL_STROKE : Math.max(width, MIN_STROKE),
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}
