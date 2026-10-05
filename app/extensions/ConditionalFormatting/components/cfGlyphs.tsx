//! FILENAME: app/extensions/ConditionalFormatting/components/cfGlyphs.tsx
// PURPOSE: The one Conditional Formatting menu glyph @api/menuIcons does not
//          have: "A Date Occurring..." (a calendar page).
// CONTEXT: Drawn in menuIcons.tsx's idiom -- a 16-unit viewBox, no size of its
//          own (the host fits it: 16px in the kit's registered-menu rows, the
//          menu bar's icon cell), `currentColor` strokes so it follows the row's
//          text colour in every skin, and no colour literal. It lives here, not
//          in @api/menuIcons, because that file belongs to no lane of this
//          programme; moving it there later is a pure cut-and-paste.

import React from "react";

const glyphStyle: React.CSSProperties = { display: "block" };

/** Calendar page with a marked day (Highlight Cells Rules > A Date Occurring...). */
export const IconDateOccurring = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={glyphStyle}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1" />
    <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
    <line x1="5.5" y1="2" x2="5.5" y2="4.5" />
    <line x1="10.5" y1="2" x2="10.5" y2="4.5" />
    <rect x="8.5" y="8.5" width="3" height="3" fill="currentColor" stroke="none" />
  </svg>
);
