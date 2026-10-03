//! FILENAME: app/extensions/ScriptableObjects/components/shieldGlyph.ts
// PURPOSE: The shield drawing, in ONE place: the Script Permissions panel's icon
//          (its sidebar header, View > Sidebar, the Developer menu) and the
//          code-and-scripts indicator on the status bar draw the same shield,
//          so the user who clicks the one recognises the other.
// CONTEXT: Plain React.createElement (no JSX) so index.ts, which is .ts, can use
//          it as a registration icon without a .tsx detour.
//
//          WHAT IS INSIDE THE SHIELD IS A CLAIM. A check mark is the universal
//          "verified, safe" sign, so the indicator draws it ONLY when the file
//          was read and nothing in it is worth a look. Something worth a look
//          gets an exclamation mark; "not read yet" and "could not be read" get
//          an empty shield -- never a check that says "all clear" about a file
//          nobody could read.

import React from "react";

/** The shield outline on a 24-unit grid. */
const SHIELD_PATH = "M12 3 L19 6 V11 C19 15.5 16 19.5 12 21 C8 19.5 5 15.5 5 11 V6 Z";
/** "Read, and nothing to report." */
const CHECK_PATH = "M9 11.5 L11.2 13.7 L15 9.5";
/** "Worth a look": the bar of an exclamation mark (its dot is a circle). */
const ALERT_BAR_PATH = "M12 8 V12.6";

/** What the shield says inside it. */
export type ShieldMark = "check" | "alert" | "none";

/** The shield at `size` px, stroked in currentColor, with `mark` inside. */
export function shieldGlyph(size: number, strokeWidth = 1.5, mark: ShieldMark = "check"): React.ReactElement {
  const inner: React.ReactElement[] = [];
  if (mark === "check") inner.push(React.createElement("path", { key: "check", d: CHECK_PATH }));
  if (mark === "alert") {
    inner.push(
      React.createElement("path", { key: "bar", d: ALERT_BAR_PATH }),
      React.createElement("circle", { key: "dot", cx: 12, cy: 15.6, r: 0.9, fill: "currentColor", stroke: "none" }),
    );
  }
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth,
      strokeLinecap: "round" as const,
      strokeLinejoin: "round" as const,
      "aria-hidden": true,
      focusable: "false",
      "data-shield-mark": mark,
    },
    React.createElement("path", { key: "shield", d: SHIELD_PATH }),
    ...inner,
  );
}

/** The Script Permissions panel's icon (the rail normalises its size). */
export const ShieldIcon = shieldGlyph(24);
