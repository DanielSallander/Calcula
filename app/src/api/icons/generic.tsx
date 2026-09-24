//! FILENAME: app/src/api/icons/generic.tsx
// PURPOSE: The generic glyphs of the duotone set: chevrons, verbs, status marks,
//          media transport, and the shell's own furniture (panel, ribbon, rail).
// CONTEXT: Part of the one icon set every ribbon, rail, sidebar and menu paints
//          with (see ./frame.tsx for the channels and the drawing rules).
//          Settings, Check, Close, MoreHorizontal, Group, More, Model and Panel
//          are the approved mockup's drawings; the rest are drawn in the same
//          language.
//
//          Pixel grid (2026-09-24 sharpen pass): horizontal and vertical edges
//          sit on a multiple of PIXEL_GRID (1.2 units, one device pixel at the
//          20px control size), so they paint as hard pixel edges at 100%
//          instead of half-covered grey rows. Where it costs nothing they sit
//          on the 2.4 grid, which is ALSO whole pixels at 150% (and at the
//          30px tile size, where a unit is 1.25 px); several older drawings
//          sat on the 150%-only grid (multiples of 0.8), and they were moved
//          to 2.4 multiples rather than traded for 100% alone (Model,
//          Controls, Lock, Database, Play, Image). Panel, Sidebar and Ribbon
//          are the exception the other way: they are only ever drawn at 20px
//          and 40px, so their window is on the 1.2 grid. Recurring
//          consequences: a 3-pixel bar (3.6 units) cannot be centred on 12,
//          which is a pixel BOUNDARY, so a symmetric glyph built from one
//          sits 0.6 off centre (Text, Download, Keyboard); a 3.6 feature
//          always has one edge between pixels at 150%; and a stroked line
//          with an arc or a diagonal in it cannot use PIXEL_STROKE, so it is
//          3.6 wide centred on an odd multiple of 0.6 (Resize), splits its
//          straight run off as a PIXEL_STROKE path (Sort) or keeps 3 with
//          one pair of edges on the grid (Lock, Loop), whichever keeps its
//          accent contact from growing. At 24px (the rail, section icons,
//          the launcher) a unit is exactly one pixel, so only whole-unit
//          edges are sharp there; the 1.2 grid meets it only at multiples of
//          6, and 24px was not tuned.
//          Info, Clock and the cog's outer teeth were left alone: their only
//          straight edges were already near-whole pixels at 100% and whole
//          pixels at 150%. Plus and Minus are tuned for the 30px and 16px
//          sizes they are actually drawn at (see Plus).
//
//          The glyphs that are pure punctuation — chevrons, check, close,
//          plus, minus, the dots — paint STRONG only and carry no accent. They
//          sit inside controls whose own state (hover, pressed, danger) sets
//          the colour, and an accent on a chevron would compete with the
//          control's actual subject.
//
//          The status marks (Info, Warn, Error, Success) are SOFT + STRONG
//          only, so a caller tones them by setting `color` (LT.dangerFg,
//          LT.warnFg, ...) and both channels follow. Baking a hue in here would
//          make "Error" red on a surface that already says danger in its own
//          tone.
//
//          A few functions carry an `Icon` suffix (ErrorIcon, ImageIcon,
//          TextIcon, LockIcon) because their bare names are browser globals
//          (the Error constructor, the Image and Text DOM classes, the Web
//          Locks `Lock`) and shadowing a global at module scope is a trap for
//          the next edit. The KEY in GENERIC_ICONS is still the bare name.

import React from "react";
import {
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  DANGER,
  PIXEL_STROKE,
  line,
  type RibbonIconProps,
} from "./frame";

// ============================================================================
// Structure: group, more, panels
// ============================================================================

/** A section's generic glyph (the launcher fallback): one strong row over two
 *  soft ones — "a group of controls". Three 3-pixel rows with 3-pixel gaps
 *  (3.6 units each, y 3.6 / 10.8 / 18); 15 pixels of ink cannot split 20
 *  evenly, so the block sits 0.6 low rather than on half pixels. */
function Group({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="10.8" width="19.2" height="3.6" rx="1.8" fill={SOFT} />
      <rect x="2.4" y="18" width="19.2" height="3.6" rx="1.8" fill={SOFT} />
    </IconFrame>
  );
}

/** "More of these": three soft tiles and an accent plus in the fourth slot.
 *  Tiles 8.4 square with a 2.4 gap; the plus's arms are 3.6 wide, centred
 *  on its slot's centre 17.4 (an odd multiple of 0.6, so both arm edges land
 *  on whole pixels). */
function More({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="8.4" height="8.4" rx="2.6" fill={SOFT} />
      <rect x="13.2" y="2.4" width="8.4" height="8.4" rx="2.6" fill={SOFT} />
      <rect x="2.4" y="13.2" width="8.4" height="8.4" rx="2.6" fill={SOFT} />
      <path
        d="M17.4 12.6a1.8 1.8 0 0 1 1.8 1.8v1.2h1.2a1.8 1.8 0 0 1 0 3.6h-1.2v1.2a1.8 1.8 0 0 1-3.6 0v-1.2h-1.2a1.8 1.8 0 0 1 0-3.6h1.2v-1.2a1.8 1.8 0 0 1 1.8-1.8z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Overflow menu: three dots. */
function MoreHorizontal({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="5" cy="12" r="2.5" fill={STRONG} />
      <circle cx="12" cy="12" r="2.5" fill={STRONG} />
      <circle cx="19" cy="12" r="2.5" fill={STRONG} />
    </IconFrame>
  );
}

/** A task pane docked on the left of a window. The window is 19.2 x 16.8
 *  (x 2.4 to 21.6, y 3.6 to 20.4) and the strip 7.2 wide, its inner edge on
 *  9.6: every straight edge on the 1.2 pixel grid, so the drawing is hard-
 *  edged at the sizes Panel, Sidebar and Ribbon are actually drawn at, 20px
 *  (the panel context menu) and 40px (the empty task pane, where 1.2 units
 *  is 2 px). The top and bottom edges are half pixels at 150% and 30px; a
 *  window on the 2.4 grid would be 19.2 tall, and its longer strip edge puts
 *  more green beside grey than the accent-contact check allows. */
function Panel({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="16.8" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 3.6h3.8v16.8H5.8a3.4 3.4 0 0 1-3.4-3.4V7a3.4 3.4 0 0 1 3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** The side panel: Panel mirrored, the accent strip on the right (inner edge
 *  on 14.4). */
function Sidebar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="16.8" rx="3.4" fill={SOFT} />
      <path
        d="M18.2 3.6h-3.8v16.8h3.8a3.4 3.4 0 0 0 3.4-3.4V7a3.4 3.4 0 0 0-3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** The ribbon: Panel's window whose top band is the named element. The band
 *  runs from the window's top (3.6) to 9.6, 6 deep. */
function Ribbon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="16.8" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 3.6h12.4a3.4 3.4 0 0 1 3.4 3.4v2.6H2.4V7a3.4 3.4 0 0 1 3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** An arrangement: a header across the top, two equal regions below, every
 *  gap 2.4. */
function Layout({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2" fill={STRONG} />
      <rect x="2.4" y="9.6" width="8.4" height="12" rx="2.4" fill={ACCENT} />
      <rect x="13.2" y="9.6" width="8.4" height="12" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Form controls: a push button over a ticked checkbox and its label. The
 *  button (y 2.4 to 9.6) and the box (7.2 square, y 14.4 to 21.6) are on the
 *  2.4 grid, crisp at 100% and 150%. The label is a 3-pixel bar (3.6) and the
 *  box 6 pixels, so the label cannot be centred on the box on whole pixels:
 *  it sits 0.6 high (y 15.6 to 19.2). */
function Controls({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="7.2" rx="3" fill={SOFT} />
      <rect x="2.4" y="14.4" width="7.2" height="7.2" rx="2.2" fill={ACCENT} />
      <rect x="12" y="15.6" width="9.6" height="3.6" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

/** The semantic model: a strong fact row over a grid of tables, one named.
 *  Three 4.8 rows with 2.4 gaps (y 2.4 to 21.6, every row edge on the 2.4
 *  grid, so crisp at 100% and 150%); two 8.4 columns with a 2.4 gap. */
function Model({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2.2" fill={STRONG} />
      <rect x="2.4" y="9.6" width="8.4" height="4.8" rx="1.9" fill={SOFT} />
      <rect x="13.2" y="9.6" width="8.4" height="4.8" rx="1.9" fill={ACCENT} />
      <rect x="2.4" y="16.8" width="8.4" height="4.8" rx="1.9" fill={SOFT} />
      <rect x="13.2" y="16.8" width="8.4" height="4.8" rx="1.9" fill={SOFT} />
    </IconFrame>
  );
}

/** An add-in / extension: a puzzle piece whose right-hand knob — the point it
 *  plugs in at — is the accent. The host's fallback for a sandboxed add-in
 *  button whose icon token names no key, and the Add-ins tab / Extensions
 *  rail glyph. The body is 14.4 square on the pixel grid (x 2.4 to 16.8,
 *  y 7.2 to 21.6); each knob is centred on its side. */
function AddIn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M4.4 7.2h3.2a2.6 2.6 0 1 1 4 0h3.2a2 2 0 0 1 2 2v3.2a2.6 2.6 0 1 1 0 4v3.2a2 2 0 0 1-2 2H4.4a2 2 0 0 1-2-2V9.2a2 2 0 0 1 2-2z"
        fill={SOFT}
      />
      <circle cx="18.46" cy="14.4" r="2.6" fill={ACCENT} />
      <circle cx="9.6" cy="5.54" r="2.6" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// Punctuation: chevrons, check, close, plus, minus
// ============================================================================

/** The one chevron drawing; the other three directions rotate it rather than
 *  re-plotting it, so the four can never disagree about weight. */
const CHEVRON_DOWN =
  "M4.9 8.3a1.8 1.8 0 0 1 2.55 0L12 12.85l4.55-4.55a1.8 1.8 0 1 1 2.55 2.55l-5.83 5.83a1.8 1.8 0 0 1-2.54 0L4.9 10.85a1.8 1.8 0 0 1 0-2.55z";

function ChevronDown({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={CHEVRON_DOWN} fill={STRONG} />
    </IconFrame>
  );
}

function ChevronUp({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={CHEVRON_DOWN} fill={STRONG} transform="rotate(180 12 12)" />
    </IconFrame>
  );
}

function ChevronLeft({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={CHEVRON_DOWN} fill={STRONG} transform="rotate(90 12 12)" />
    </IconFrame>
  );
}

function ChevronRight({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={CHEVRON_DOWN} fill={STRONG} transform="rotate(-90 12 12)" />
    </IconFrame>
  );
}

function Check({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M20.4 5.1a1.9 1.9 0 0 1 .1 2.7l-9.6 10.4a1.9 1.9 0 0 1-2.76.03L3.5 13.5a1.9 1.9 0 1 1 2.72-2.66l3.2 3.28L17.7 5.2a1.9 1.9 0 0 1 2.7-.1z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

function Close({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5 5a1.8 1.8 0 0 1 2.55 0L12 9.45 16.45 5A1.8 1.8 0 1 1 19 7.55L14.55 12 19 16.45A1.8 1.8 0 1 1 16.45 19L12 14.55 7.55 19A1.8 1.8 0 0 1 5 16.45L9.45 12 5 7.55A1.8 1.8 0 0 1 5 5z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Plus: two 3.2 bars crossing at the centre. Tuned for the sizes it is
 *  actually drawn at, 30px (the Controls pane's add menu) and 16px, not the
 *  20px control row: 3.2 centred on 12 has its edges on 10.4 and 13.6,
 *  multiples of 0.8, which are whole pixels at 30px (and at 20px x 150%)
 *  and within a tenth of a pixel at 16px. At 20px it is still sharper than
 *  the old 3.4. */
function Plus({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M12 4.6v14.8M4.6 12h14.8" {...line(STRONG, 3.2)} />
    </IconFrame>
  );
}

/** Minus: Plus's crossbar, the same weight. */
function Minus({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4.6 12h14.8" {...line(STRONG, 3.2)} />
    </IconFrame>
  );
}

// ============================================================================
// Verbs
// ============================================================================

/** Refresh: the Undo idiom — a soft path, the accent head is the verb. The
 *  head is a filled triangle at the top of the ring pointing clockwise into
 *  the gap (a stroked chevron at the gap read as a detached corner bracket at
 *  20px, and a head on a diagonal tangent read as pointing up). The stroke in the
 *  same channel only rounds its corners. */
function Refresh({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M17.75 7.18A7.5 7.5 0 1 1 10.7 4.61" {...line(SOFT, 3.2)} />
      <path
        d="M14.64 3.91L10.83 7.64 9.79 1.73z"
        fill={ACCENT}
        stroke={ACCENT}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Delete: a soft can under a DANGER lid — the destructive verb. Handle
 *  from 2.4, lid y 4.8 to 8.4, can y 9.6 to 21.6: the lid keeps exactly 1.2
 *  of background above the can. */
function Delete({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.4 9.6h13.2l-1.05 9.7a2.6 2.6 0 0 1-2.6 2.3H9.05a2.6 2.6 0 0 1-2.6-2.3z"
        fill={SOFT}
      />
      <rect x="8.4" y="2.4" width="7.2" height="4.8" rx="1.6" fill={DANGER} />
      <rect x="3.6" y="4.8" width="16.8" height="3.6" rx="1.8" fill={DANGER} />
    </IconFrame>
  );
}

/** Settings: a soft cog around an accent hub. The flat valleys sit on the
 *  2.4 grid (4.8 and 19.2); the top and bottom teeth stay at 1.6 and 22.4,
 *  whole pixels at 150%, because the nearest 100% pixel edges would make
 *  those two teeth 0.4 longer or 0.8 shorter than the other four. */
function Settings({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.1 1.6h3.8l.55 2.85 2.4 1.4 2.7-1 1.9 3.25-2.25 1.9v2.8l2.25 1.9-1.9 3.25-2.7-1-2.4 1.4L13.9 22.4h-3.8l-.55-2.85-2.4-1.4-2.7 1L2.55 15.9l2.25-1.9v-2.8l-2.25-1.9L4.45 6.05l2.7 1 2.4-1.4z"
        fill={SOFT}
      />
      <circle cx="12" cy="12" r="3.9" fill={ACCENT} />
    </IconFrame>
  );
}

/** Edit: a soft pencil body, the accent eraser end names the act. */
function Pencil({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 17.4L13.4 6.4l4.2 4.2L6.6 21.6H2.4z" fill={SOFT} />
      <path
        d="M15 4.8l1.7-1.7a2.2 2.2 0 0 1 3.1 0l1.1 1.1a2.2 2.2 0 0 1 0 3.1L19.2 9z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Search / Find: a soft lens, the accent handle is the act of looking. */
function Search({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.2 2.2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 3.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z"
        fill={SOFT}
      />
      <path d="M16.4 16.4l4.8 4.8" {...line(ACCENT, 3.4)} />
    </IconFrame>
  );
}

/** The tray and arrow shared by Download and Upload. Walls, floor and shaft
 *  are all 3.6 (3 whole pixels): tray x 2.4 to 22.8 (walls to 6 and from
 *  19.2), floor y 18 to 21.6, shaft x 10.8 to 14.4. The whole drawing is
 *  centred on 12.6, not 12, because a 3-pixel shaft centred on 12 straddles
 *  a pixel boundary and paints both its edges grey. The arrow's tip ends at
 *  16.6, keeping 1.4 of background above the floor. */
const TRAY =
  "M4.2 13.8a1.8 1.8 0 0 1 1.8 1.8V18h13.2v-2.4a1.8 1.8 0 0 1 3.6 0v3.2a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8v-3.2a1.8 1.8 0 0 1 1.8-1.8z";
const ARROW_DOWN =
  "M12.6 1.5a1.8 1.8 0 0 1 1.8 1.8v7.2l2.1-2.1a1.8 1.8 0 0 1 2.54 2.54l-5.16 5.16a1.8 1.8 0 0 1-2.54 0L6.18 10.94A1.8 1.8 0 1 1 8.72 8.4l2.08 2.1V3.3A1.8 1.8 0 0 1 12.6 1.5z";

/** Download: a soft tray, the accent arrow lands in it. */
function Download({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={TRAY} fill={SOFT} />
      <path d={ARROW_DOWN} fill={ACCENT} />
    </IconFrame>
  );
}

/** Upload: Download's arrow mirrored top-to-bottom about y = 9, leaving the
 *  tray: its tip rises to 1.4 and its tail keeps 1.5 above the floor. */
function Upload({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={TRAY} fill={SOFT} />
      <path d={ARROW_DOWN} fill={ACCENT} transform="matrix(1 0 0 -1 0 18)" />
    </IconFrame>
  );
}

/** Sort: a list already in order, the accent arrow is the direction. Rows
 *  and gaps are all 3.6 (y 2.4 / 9.6 / 16.8). The arrow's shaft is its own
 *  PIXEL_STROKE path on the grid line x = 18, so it paints two whole pixels
 *  (16.8 to 19.2) at 20px and three at 30px; the head is a diagonal and
 *  keeps a real stroke (2.6), its round join covering the shaft's end. A
 *  3.6 shaft matches the rows' weight at 20px but puts one edge on a half
 *  pixel at 30px, so the thinner shaft stays. */
function Sort({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="11" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="9.6" width="8" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="16.8" width="5" height="3.6" rx="1.8" fill={STRONG} />
      <path d="M18 3.6V19.4" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M14.2 15.6l3.8 3.8 3.8-3.8" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Resize: a soft object (9.6 square), the accent arrow pulls its corner out.
 *  The arrow is 3.6 wide with its head's two runs centred on 4.2 and 19.8
 *  (odd multiples of 0.6), so each run paints three whole pixels. */
function Resize({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="12" width="9.6" height="9.6" rx="2.6" fill={SOFT} />
      <path d="M10.4 13.6L19.8 4.2M13.8 4.2h6v6" {...line(ACCENT, 3.6)} />
    </IconFrame>
  );
}

/** Link: two chain links, the accent one is the one being attached. */
function Link({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <g transform="rotate(-45 12 12)">
        <rect x="3.2" y="8.7" width="10.4" height="6.6" rx="3.3" {...line(STRONG, 2.8)} />
        <rect x="10.4" y="8.7" width="10.4" height="6.6" rx="3.3" {...line(ACCENT, 2.8)} />
      </g>
    </IconFrame>
  );
}

/** Lock: an accent shackle closing into a strong body. The keyhole is a HOLE
 *  in the body (a reverse-wound subpath, as in Search's lens ring), so the
 *  background shows through it. Until 2026-09-24 the keyhole was an accent
 *  shape enclosed by STRONG: 1.3:1 in Dark, where STRONG is a light grey. The
 *  shackle's legs still meet the body (a closed lock must); that join is the
 *  icon's allowlisted contact in scripts/icon-accent-contact.allowlist.json.
 *  Pixel grid: the body is 14.4 x 12 on the 2.4 grid (x 4.8 to 19.2, y 9.6
 *  to 21.6), crisp at 100% and 150%; it is narrower and deeper than the old
 *  16 x 11 but the same area. The keyhole stays 3 wide (a 2.4 slot is crisp
 *  at 100% only and reads as a scratch). The shackle stays 3 wide, because a
 *  3.6 shackle widens the join and grows that contact; its legs on 8.1 and
 *  15.9 put their INNER edges (9.6 and 14.4) on the 2.4 grid. */
function LockIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M8.1 10V7.6a3.9 3.9 0 0 1 7.8 0V10" {...line(ACCENT)} />
      <path
        d="M7.8 9.6h8.4a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7.8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM12 13.1a1.5 1.5 0 0 0-1.5 1.5v2a1.5 1.5 0 0 0 3 0v-2a1.5 1.5 0 0 0-1.5-1.5z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Visibility: a soft eye with a strong pupil. */
function Eye({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12 5c4.2 0 7.8 2.5 10.2 7-2.4 4.5-6 7-10.2 7S4.2 16.5 1.8 12C4.2 7.5 7.8 5 12 5z"
        fill={SOFT}
      />
      <circle cx="12" cy="12" r="3.6" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// Objects: text, pointer, image, keyboard, script, data, files
// ============================================================================

/** Text box: a strong T drawn as two bars on a soft card (no <text>). Both
 *  bars are 3 whole pixels (3.6): the crossbar y 6 to 9.6, the stem x 10.8
 *  to 14.4. A 3-pixel stem centred on 12 would straddle a pixel boundary, so
 *  the T is centred on 12.6, half a pixel right of the card's centre; it
 *  spans y 6 to 18, centred. */
function TextIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.6" fill={SOFT} />
      <rect x="7" y="6" width="11.2" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="10.8" y="6" width="3.6" height="12" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Selection pointer: the arrow cursor, one strong silhouette. The stroke in
 *  the same channel only rounds the corners (STRONG is opaque, so fill and
 *  stroke do not compound). */
function Pointer({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.6 3.4V18.2l3.8-3.3 2.6 5.8 3-1.3-2.6-5.7h5.1z"
        fill={STRONG}
        stroke={STRONG}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Picture: a soft frame (2.4 to 21.6 square, on the 2.4 grid so crisp at
 *  100% and 150%), strong hills along its bottom, an accent sun. */
function ImageIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <path
        d="M2.4 17.2l5.4-5.4a1.6 1.6 0 0 1 2.26 0l4.34 4.34 1.54-1.54a1.6 1.6 0 0 1 2.26 0L21.6 18v.2a3.4 3.4 0 0 1-3.4 3.4H5.8a3.4 3.4 0 0 1-3.4-3.4z"
        fill={STRONG}
      />
      <circle cx="16.4" cy="8.2" r="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Keyboard: a soft deck (20.4 x 14.4, x 2.4 to 22.8, y 4.8 to 19.2), three
 *  strong keys, the accent space bar; keys and bar are 3 whole pixels deep
 *  with 2.4 between every row. The keys are 3.6 square at x 4.8 / 10.8 /
 *  16.8, 2.4 apart and 2.4 in from each side of the deck: three 3-pixel keys
 *  with 2-pixel gaps are 13 pixels, which fit a 17-pixel deck evenly but not
 *  a 16-pixel one, so the drawing is centred on 12.6 (half a pixel right).
 *  The keys' rx is 1.0, not frame.tsx's 1.4: at 1.4 a 3px square paints as
 *  a plus sign (the MergeCells finding). The bar is 8.8 long and centred on
 *  12.6: its pill ends are free to sit anywhere, and at 8.8 its outline (its
 *  contact with the deck) is no longer than before it was deepened. */
function Keyboard({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.8" width="20.4" height="14.4" rx="3.2" fill={SOFT} />
      <rect x="4.8" y="7.2" width="3.6" height="3.6" rx="1" fill={STRONG} />
      <rect x="10.8" y="7.2" width="3.6" height="3.6" rx="1" fill={STRONG} />
      <rect x="16.8" y="7.2" width="3.6" height="3.6" rx="1" fill={STRONG} />
      <rect x="8.2" y="13.2" width="8.8" height="3.6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Script: a soft page with an accent prompt and a strong cursor — code you
 *  run, as opposed to Code (a soft window with brackets), code you read. The
 *  cursor is 3 whole pixels deep (y 13.2 to 16.8) and 6 long, so its round
 *  ends still leave a straight run and it reads as a bar, not a dot. */
function Script({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3.2" fill={SOFT} />
      <path d="M7.6 8.4l3.2 3.2-3.2 3.2" {...line(ACCENT, 2.8)} />
      <rect x="12.4" y="13.2" width="6" height="3.6" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Database: a strong lid on a soft cylinder, 14.4 wide (sides on 4.8 and
 *  19.2, the 2.4 grid, so crisp at 100% and 150%). */
function Database({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4.8 5.8V18a7.2 3.2 0 0 0 14.4 0V5.8a7.2 3.2 0 0 1-14.4 0z" fill={SOFT} />
      <ellipse cx="12" cy="5.8" rx="7.2" ry="3.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Folder: a soft back with its tab (from y 3.6), a strong front (y 9.6 to
 *  20.4). */
function Folder({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.4 6.2a2.6 2.6 0 0 1 2.6-2.6h4.4a2 2 0 0 1 1.5.68L12.6 6h6.4a2.6 2.6 0 0 1 2.6 2.6v9.2a2.6 2.6 0 0 1-2.6 2.6H5a2.6 2.6 0 0 1-2.6-2.6z"
        fill={SOFT}
      />
      <rect x="2.4" y="9.6" width="19.2" height="10.8" rx="2.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Save: a soft disk (2.4 to 21.6 square), a strong shutter flush with its
 *  top, the accent label (12 x 6, y 13.2 to 19.2). */
function Save({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.2 2.4h10.9a2 2 0 0 1 1.4.6l3.5 3.5a2 2 0 0 1 .6 1.4v10.9a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8V5.2a2.8 2.8 0 0 1 2.8-2.8z"
        fill={SOFT}
      />
      <rect x="6" y="2.4" width="8.4" height="6" rx="1.6" fill={STRONG} />
      <rect x="6" y="13.2" width="12" height="6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Calendar: a soft page (y 4.8 to 21.6), a strong header 4.8 deep with its
 *  rings (3.6 wide, on 7.8 and 16.2), the accent day (4.8 square, centred
 *  top to bottom in the page below the header). */
function Calendar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.8" width="19.2" height="16.8" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 4.8h12.4a3.4 3.4 0 0 1 3.4 3.4v1.4H2.4V8.2a3.4 3.4 0 0 1 3.4-3.4z"
        fill={STRONG}
      />
      <rect x="6" y="2" width="3.6" height="5" rx="1.8" fill={STRONG} />
      <rect x="14.4" y="2" width="3.6" height="5" rx="1.8" fill={STRONG} />
      <rect x="13.2" y="13.2" width="4.8" height="4.8" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Clock: a soft face with strong hands. */
function Clock({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9.6" fill={SOFT} />
      <path d="M12 6.6V12l3.8 2.6" {...line(STRONG)} />
    </IconFrame>
  );
}

// ============================================================================
// Media transport (Animation)
// ============================================================================

/** The transport glyphs are STRONG only: the transport row is a set of
 *  equals, and an accent on one of them would read as "the recommended
 *  button" rather than as a verb. */
/** Play: the triangle's flat back on x = 7.2 (the 2.4 grid, crisp at 100%
 *  and 150%), which also puts its centroid within 0.2 of the centre. */
function Play({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M7.2 4.6v14.8a1.4 1.4 0 0 0 2.12 1.2l11.2-7.4a1.4 1.4 0 0 0 0-2.4L9.32 3.4A1.4 1.4 0 0 0 7.2 4.6z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Pause: two 4.8 x 14.4 bars with a 4.8 gap, the same 14.4 box as Stop. */
function Pause({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="4.8" y="4.8" width="4.8" height="14.4" rx="1.6" fill={STRONG} />
      <rect x="14.4" y="4.8" width="4.8" height="14.4" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Stop: a 14.4 square on the 2.4 grid (crisp at 100% and 150%). */
function Stop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="4.8" y="4.8" width="14.4" height="14.4" rx="3" fill={STRONG} />
    </IconFrame>
  );
}

/** The step glyph's triangle: flat back on x = 3.6; with the 3.6 bar at 16.8
 *  to 20.4 the pair spans 3.6 to 20.4, centred, and mirrors onto the grid
 *  (24 - x) for StepBack. */
const STEP_TRIANGLE =
  "M3.6 5.6v12.8a1.4 1.4 0 0 0 2.16 1.18l9.6-6.4a1.4 1.4 0 0 0 0-2.36l-9.6-6.4A1.4 1.4 0 0 0 3.6 5.6z";

function StepForward({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={STEP_TRIANGLE} fill={STRONG} />
      <rect x="16.8" y="4.6" width="3.6" height="14.8" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

/** StepForward mirrored left-to-right, so the pair cannot drift apart. */
function StepBack({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <g transform="matrix(-1 0 0 1 24 0)">
        <path d={STEP_TRIANGLE} fill={STRONG} />
        <rect x="16.8" y="4.6" width="3.6" height="14.8" rx="1.8" fill={STRONG} />
      </g>
    </IconFrame>
  );
}

/** Loop: a soft ring (one element, so no compounding), accent heads. The
 *  ring keeps its 3-unit line (a 3.6 ring puts more of it beside the heads)
 *  with its OUTER edges on whole pixels: x 2.4 to 21.6, y 4.8 to 19.2. */
function Loop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.9" y="6.3" width="16.2" height="11.4" rx="4.2" {...line(SOFT)} />
      <path d="M12.6 3.1l3.2 3.2-3.2 3.2M11.4 14.5l-3.2 3.2 3.2 3.2" {...line(ACCENT)} />
    </IconFrame>
  );
}

// ============================================================================
// Status marks (tone them with the host's `color`)
// ============================================================================

function Info({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9.6" fill={SOFT} />
      <circle cx="12" cy="6.9" r="1.8" fill={STRONG} />
      <rect x="10.5" y="10.2" width="3" height="7.6" rx="1.5" fill={STRONG} />
    </IconFrame>
  );
}

/** Warn: the triangle's base on y = 21.6 (the 2.4 grid, crisp at 100% and
 *  150%); its apex stays where it was (top of the ink about 2.6), so the
 *  sides are a little steeper and the ink is centred top to bottom. */
function Warn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.2 3.6a2.1 2.1 0 0 1 3.6 0l8 14.9a2.1 2.1 0 0 1-1.8 3.1H4a2.1 2.1 0 0 1-1.8-3.1z"
        fill={SOFT}
      />
      <rect x="10.5" y="8.6" width="3" height="6.6" rx="1.5" fill={STRONG} />
      <circle cx="12" cy="17.9" r="1.7" fill={STRONG} />
    </IconFrame>
  );
}

function ErrorIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9.6" fill={SOFT} />
      <path d="M8.7 8.7l6.6 6.6M15.3 8.7l-6.6 6.6" {...line(STRONG)} />
    </IconFrame>
  );
}

function Success({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9.6" fill={SOFT} />
      <path d="M7.4 12.3l3.1 3.1 6.1-6.3" {...line(STRONG)} />
    </IconFrame>
  );
}

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
/** Every generic key. The aggregator in ../ribbonIcons.tsx spreads this into
 *  the one RibbonIcon namespace. */
export const GENERIC_ICONS = {
  Group,
  More,
  MoreHorizontal,
  Close,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Plus,
  Minus,
  Refresh,
  Delete,
  Settings,
  Sidebar,
  Ribbon,
  Pencil,
  Layout,
  Text: TextIcon,
  Pointer,
  Play,
  Pause,
  Stop,
  StepForward,
  StepBack,
  Loop,
  Resize,
  Keyboard,
  Image: ImageIcon,
  Info,
  Warn,
  Error: ErrorIcon,
  Success,
  Link,
  Lock: LockIcon,
  Eye,
  Download,
  Upload,
  Sort,
  Calendar,
  Clock,
  Search,
  Script,
  Model,
  Panel,
  Controls,
  Database,
  Folder,
  Save,
  AddIn,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */

/** Drawings other groups reuse under their own key (Find is Search, Edit
 *  chart is Pencil, Save image is Download). Re-using the component, not
 *  copying the path, is what keeps the two keys from drifting apart. */
export { Search, Pencil, Download };
