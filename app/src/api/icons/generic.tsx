//! FILENAME: app/src/api/icons/generic.tsx
// PURPOSE: The generic glyphs of the duotone set: chevrons, verbs, status marks,
//          media transport, and the shell's own furniture (panel, ribbon, rail).
// CONTEXT: Part of the one icon set every ribbon, rail, sidebar and menu paints
//          with (see ./frame.tsx for the channels and the drawing rules).
//          Settings, Check, Close, MoreHorizontal, Group, More, Model and Panel
//          are the approved mockup's drawings verbatim; the rest are drawn in
//          the same language.
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
  line,
  type RibbonIconProps,
} from "./frame";

// ============================================================================
// Structure: group, more, panels
// ============================================================================

/** A section's generic glyph (the launcher fallback): one strong row over two
 *  soft ones — "a group of controls". */
function Group({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="3.6" width="19" height="3.4" rx="1.7" fill={STRONG} />
      <rect x="2.5" y="10.3" width="19" height="3.4" rx="1.7" fill={SOFT} />
      <rect x="2.5" y="17" width="19" height="3.4" rx="1.7" fill={SOFT} />
    </IconFrame>
  );
}

/** "More of these": three soft tiles and an accent plus in the fourth slot. */
function More({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2.6" fill={SOFT} />
      <rect x="13" y="2.5" width="8.5" height="8.5" rx="2.6" fill={SOFT} />
      <rect x="2.5" y="13" width="8.5" height="8.5" rx="2.6" fill={SOFT} />
      <path
        d="M17.25 12.6a1.6 1.6 0 0 1 1.6 1.6v1.45h1.45a1.6 1.6 0 0 1 0 3.2h-1.45v1.45a1.6 1.6 0 0 1-3.2 0V18.85H14.2a1.6 1.6 0 0 1 0-3.2h1.45V14.2a1.6 1.6 0 0 1 1.6-1.6z"
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

/** A task pane docked on the left of a window. */
function Panel({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 3.2h4.4v17.6H5.8a3.4 3.4 0 0 1-3.4-3.4V6.6a3.4 3.4 0 0 1 3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** The side panel: Panel mirrored, the accent strip on the right. */
function Sidebar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.4" fill={SOFT} />
      <path
        d="M18.2 3.2h-4.4v17.6h4.4a3.4 3.4 0 0 0 3.4-3.4V6.6a3.4 3.4 0 0 0-3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** The ribbon: a window whose top band is the named element. */
function Ribbon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 3.2h12.4a3.4 3.4 0 0 1 3.4 3.4v2H2.4v-2a3.4 3.4 0 0 1 3.4-3.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** An arrangement: a header across the top, two regions below. */
function Layout({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3" width="19.2" height="5" rx="2" fill={STRONG} />
      <rect x="2.4" y="10" width="8.4" height="11" rx="2.4" fill={ACCENT} />
      <rect x="12.8" y="10" width="8.8" height="11" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Form controls: a push button over a ticked checkbox and its label. */
function Controls({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="7.2" rx="3" fill={SOFT} />
      <rect x="2.4" y="13.6" width="7.2" height="7.2" rx="2.2" fill={ACCENT} />
      <rect x="12" y="15.7" width="9.6" height="3" rx="1.5" fill={STRONG} />
    </IconFrame>
  );
}

/** The semantic model: a strong fact row over a grid of tables, one named. */
function Model({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="5.2" rx="2.2" fill={STRONG} />
      <rect x="2.4" y="9.8" width="8.6" height="5.2" rx="1.9" fill={SOFT} />
      <rect x="13" y="9.8" width="8.6" height="5.2" rx="1.9" fill={ACCENT} />
      <rect x="2.4" y="16.4" width="8.6" height="5.2" rx="1.9" fill={SOFT} />
      <rect x="13" y="16.4" width="8.6" height="5.2" rx="1.9" fill={SOFT} />
    </IconFrame>
  );
}

/** An add-in / extension: a puzzle piece whose right-hand knob — the point it
 *  plugs in at — is the accent. The host's fallback for a sandboxed add-in
 *  button whose icon token names no key, and the Add-ins tab / Extensions
 *  rail glyph. */
function AddIn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5 7h3a2.6 2.6 0 1 1 4 0h3a2 2 0 0 1 2 2v3a2.6 2.6 0 1 1 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"
        fill={SOFT}
      />
      <circle cx="18.66" cy="14" r="2.6" fill={ACCENT} />
      <circle cx="10" cy="5.34" r="2.6" fill={STRONG} />
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

function Plus({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M12 4.6v14.8M4.6 12h14.8" {...line(STRONG, 3.4)} />
    </IconFrame>
  );
}

function Minus({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4.6 12h14.8" {...line(STRONG, 3.4)} />
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

/** Delete: a soft can under a DANGER lid — the destructive verb. */
function Delete({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.4 9h13.2l-1.1 10.4a2.6 2.6 0 0 1-2.6 2.3H9.1a2.6 2.6 0 0 1-2.6-2.3z"
        fill={SOFT}
      />
      <rect x="8.8" y="2" width="6.4" height="4.4" rx="1.6" fill={DANGER} />
      <rect x="3" y="4.6" width="18" height="3.2" rx="1.6" fill={DANGER} />
    </IconFrame>
  );
}

/** Settings: a soft cog around an accent hub. */
function Settings({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.1 1.6h3.8l.55 2.85 2.4 1.4 2.7-1 1.9 3.25-2.2 1.9v2.8l2.2 1.9-1.9 3.25-2.7-1-2.4 1.4L13.9 22.4h-3.8l-.55-2.85-2.4-1.4-2.7 1L2.55 15.9l2.2-1.9v-2.8l-2.2-1.9L4.45 6.05l2.7 1 2.4-1.4z"
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
      <path d="M2.5 17.3L13.4 6.4l4.2 4.2L6.7 21.5H2.5z" fill={SOFT} />
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

/** The tray and arrow shared by Download and Upload. */
const TRAY =
  "M3.4 13.8a1.7 1.7 0 0 1 1.7 1.7v3h13.8v-3a1.7 1.7 0 0 1 3.4 0v3.6a2.8 2.8 0 0 1-2.8 2.8H4.5a2.8 2.8 0 0 1-2.8-2.8v-3.6a1.7 1.7 0 0 1 1.7-1.7z";
const ARROW_DOWN =
  "M12 1.8a1.8 1.8 0 0 1 1.8 1.8v7.2l2.1-2.1a1.8 1.8 0 0 1 2.54 2.54l-5.16 5.16a1.8 1.8 0 0 1-2.54 0L5.58 11.24A1.8 1.8 0 1 1 8.12 8.7l2.08 2.1V3.6A1.8 1.8 0 0 1 12 1.8z";

/** Download: a soft tray, the accent arrow lands in it. */
function Download({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={TRAY} fill={SOFT} />
      <path d={ARROW_DOWN} fill={ACCENT} />
    </IconFrame>
  );
}

/** Upload: Download's arrow mirrored top-to-bottom, leaving the tray. */
function Upload({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={TRAY} fill={SOFT} />
      <path d={ARROW_DOWN} fill={ACCENT} transform="matrix(1 0 0 -1 0 18.7)" />
    </IconFrame>
  );
}

/** Sort: a list already in order, the accent arrow is the direction. */
function Sort({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4" width="11" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="10.4" width="8" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="16.8" width="5" height="3.2" rx="1.6" fill={STRONG} />
      <path d="M18 3.8v15.4M14.2 15.6l3.8 3.8 3.8-3.8" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Resize: a soft object, the accent arrow pulls its corner out. */
function Resize({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="11.6" width="10" height="10" rx="2.6" fill={SOFT} />
      <path d="M10.4 13.6L19.6 4.4M13.8 4.4h5.8v5.8" {...line(ACCENT)} />
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

/** Lock: a soft shackle over a strong body with an accent keyhole. */
function LockIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M7.6 11V8a4.4 4.4 0 0 1 8.8 0v3" {...line(SOFT)} />
      <rect x="4" y="10.4" width="16" height="11.2" rx="3" fill={STRONG} />
      <rect x="10.5" y="13.4" width="3" height="5" rx="1.5" fill={ACCENT} />
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

/** Text box: a strong T drawn as two bars on a soft card (no <text>). */
function TextIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.6" fill={SOFT} />
      <rect x="6.4" y="6.2" width="11.2" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="10.4" y="6.2" width="3.2" height="11.6" rx="1.6" fill={STRONG} />
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

/** Picture: a soft frame, strong hills, an accent sun. */
function ImageIcon({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="19.2" height="17.6" rx="3.4" fill={SOFT} />
      <path
        d="M2.4 16.4l5.4-5.4a1.6 1.6 0 0 1 2.26 0l4.34 4.34 1.54-1.54a1.6 1.6 0 0 1 2.26 0L21.6 17.2v.2a3.4 3.4 0 0 1-3.4 3.4H5.8a3.4 3.4 0 0 1-3.4-3.4z"
        fill={STRONG}
      />
      <circle cx="16.4" cy="8.2" r="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Keyboard: a soft deck, three strong keys, the accent space bar. */
function Keyboard({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="1.8" y="5" width="20.4" height="14" rx="3.2" fill={SOFT} />
      <rect x="4.4" y="7.8" width="3.4" height="3.2" rx="1.4" fill={STRONG} />
      <rect x="10.3" y="7.8" width="3.4" height="3.2" rx="1.4" fill={STRONG} />
      <rect x="16.2" y="7.8" width="3.4" height="3.2" rx="1.4" fill={STRONG} />
      <rect x="7.4" y="13.2" width="9.2" height="3.2" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Script: a soft page with an accent prompt and a strong cursor — code you
 *  run, as opposed to Code (a soft window with brackets), code you read. */
function Script({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3.2" fill={SOFT} />
      <path d="M7.6 8.4l3.2 3.2-3.2 3.2" {...line(ACCENT, 2.8)} />
      <rect x="12.4" y="13.4" width="5" height="3" rx="1.5" fill={STRONG} />
    </IconFrame>
  );
}

/** Database: a strong lid on a soft cylinder. */
function Database({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4 5.8V18a8 3.2 0 0 0 16 0V5.8a8 3.2 0 0 1-16 0z" fill={SOFT} />
      <ellipse cx="12" cy="5.8" rx="8" ry="3.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Folder: a soft back with its tab, a strong front. */
function Folder({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.4 6a2.6 2.6 0 0 1 2.6-2.6h4.4a2 2 0 0 1 1.5.68L12.6 6h6.4a2.6 2.6 0 0 1 2.6 2.6V18a2.6 2.6 0 0 1-2.6 2.6H5A2.6 2.6 0 0 1 2.4 18z"
        fill={SOFT}
      />
      <rect x="2.4" y="9.2" width="19.2" height="11.4" rx="2.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Save: a soft disk, a strong shutter, the accent label. */
function Save({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.2 2.8h10.9a2 2 0 0 1 1.4.6l3.5 3.5a2 2 0 0 1 .6 1.4v10.5a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8V5.6a2.8 2.8 0 0 1 2.8-2.8z"
        fill={SOFT}
      />
      <rect x="6.6" y="2.8" width="8.4" height="5.6" rx="1.6" fill={STRONG} />
      <rect x="6" y="12.8" width="12" height="6.8" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Calendar: a soft page, a strong header with its rings, the accent day. */
function Calendar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.4" width="19.2" height="17.2" rx="3.4" fill={SOFT} />
      <path
        d="M5.8 4.4h12.4a3.4 3.4 0 0 1 3.4 3.4V10H2.4V7.8a3.4 3.4 0 0 1 3.4-3.4z"
        fill={STRONG}
      />
      <rect x="6.4" y="2" width="3" height="5" rx="1.5" fill={STRONG} />
      <rect x="14.6" y="2" width="3" height="5" rx="1.5" fill={STRONG} />
      <rect x="13.4" y="13.4" width="5" height="5" rx="1.6" fill={ACCENT} />
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
function Play({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M6.6 4.6v14.8a1.4 1.4 0 0 0 2.12 1.2l11.2-7.4a1.4 1.4 0 0 0 0-2.4L8.72 3.4A1.4 1.4 0 0 0 6.6 4.6z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

function Pause({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="5.6" y="4" width="4.4" height="16" rx="1.6" fill={STRONG} />
      <rect x="14" y="4" width="4.4" height="16" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

function Stop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="5" y="5" width="14" height="14" rx="3" fill={STRONG} />
    </IconFrame>
  );
}

const STEP_TRIANGLE =
  "M4.6 5.6v12.8a1.4 1.4 0 0 0 2.16 1.18l9.6-6.4a1.4 1.4 0 0 0 0-2.36l-9.6-6.4A1.4 1.4 0 0 0 4.6 5.6z";

function StepForward({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={STEP_TRIANGLE} fill={STRONG} />
      <rect x="17.8" y="4.6" width="3.4" height="14.8" rx="1.7" fill={STRONG} />
    </IconFrame>
  );
}

/** StepForward mirrored left-to-right, so the pair cannot drift apart. */
function StepBack({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <g transform="matrix(-1 0 0 1 24 0)">
        <path d={STEP_TRIANGLE} fill={STRONG} />
        <rect x="17.8" y="4.6" width="3.4" height="14.8" rx="1.7" fill={STRONG} />
      </g>
    </IconFrame>
  );
}

/** Loop: a soft ring (one element, so no compounding), accent heads. */
function Loop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3" y="6.4" width="18" height="11.2" rx="4.2" {...line(SOFT)} />
      <path d="M12.6 3.2l3.2 3.2-3.2 3.2M11.4 14.4l-3.2 3.2 3.2 3.2" {...line(ACCENT)} />
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

function Warn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.2 3.6a2.1 2.1 0 0 1 3.6 0l8 13.9a2.1 2.1 0 0 1-1.8 3.1H4a2.1 2.1 0 0 1-1.8-3.1z"
        fill={SOFT}
      />
      <rect x="10.5" y="8" width="3" height="6.6" rx="1.5" fill={STRONG} />
      <circle cx="12" cy="17.3" r="1.7" fill={STRONG} />
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
