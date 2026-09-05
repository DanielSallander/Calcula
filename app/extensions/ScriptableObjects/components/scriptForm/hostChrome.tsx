//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/hostChrome.tsx
// PURPOSE: The HOST-DERIVED pieces every trusted script surface paints and no
//          script can address: the script glyph, the provenance phrase that
//          says where the code came from, and the lookup that moves focus to a
//          widget by its validated name. Shared by the modal form
//          (ScriptFormDialog.tsx) and the modeless task pane
//          (../scriptPane/ScriptPaneSection.tsx) so the two surfaces cannot
//          drift in the one thing a user is meant to trust at a glance.
//
// SECURITY: `originPhrase` branches on `kind`, never on a name — a package
// literally named "local" reads as a package (see the FormOrigin note in
// ScriptFormDialog.tsx). `findFormWidgetFocusable` refuses any name that is
// not an identifier BEFORE it touches the DOM, so a script's focus request can
// never become a selector.

import React, { useEffect, useState } from "react";
import type { FormOrigin } from "@api/scriptHost/scriptFormSpec";
import type { PaneHostBanner } from "@api/scriptHost/scriptPaneSpec";
import { MessageBanner } from "./ScriptFormDialog.styles";

// ============================================================================
// Glyph (the same mark the five-field script dialog wears)
// ============================================================================

/** The script mark at a given pixel size. */
export function scriptGlyph(size: number): React.ReactElement {
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round" as const,
      strokeLinejoin: "round" as const,
    },
    React.createElement("path", { d: "M8 8 L4 12 L8 16" }),
    React.createElement("path", { d: "M16 8 L20 12 L16 16" }),
    React.createElement("path", { d: "M13.5 6 L10.5 18" }),
  );
}

/** The 15px mark the identity band wears. */
export const ScriptGlyphSvg = scriptGlyph(15);

// ============================================================================
// Provenance
// ============================================================================

/**
 * Where the script came from, as the tail of a sentence: "a script in this
 * workbook" or `the package "Sales Pack"`. The surface prepends its noun ("A
 * form from …", "A task pane from …").
 */
export function originPhrase(origin: FormOrigin): string {
  return origin.kind === "local" ? "a script in this workbook" : `the package "${origin.name}"`;
}

// ============================================================================
// The HOST's own notices on a modeless surface
// ============================================================================

/** Which host notice this is. Each has its own store slot and its own attribute. */
export type HostNoticeSlot = "host-banner" | "binding-notice";
/** Which modeless surface is painting it — only the `data-` attribute differs. */
export type HostNoticeSurface = "pane" | "embed";

/**
 * The `data-` attribute a notice wears, per surface and slot. Every one of the
 * four is spelled out in full rather than assembled from fragments: these
 * attributes are what a test and a user reading the DOM identify a notice by,
 * and a name that only exists as `"data-script-" + x + "-banner"` cannot be
 * found by searching for it.
 */
function hostNoticeAttribute(surface: HostNoticeSurface, slot: HostNoticeSlot): string {
  if (surface === "pane") {
    return slot === "host-banner" ? "data-script-pane-host-banner" : "data-script-pane-binding-notice";
  }
  return slot === "host-banner" ? "data-script-embed-host-banner" : "data-script-embed-binding-notice";
}

/**
 * A HOST notice about a modeless surface — the throttle ladder ("being slowed
 * down", then "its calls are being ignored" with the time left) and the
 * bindings notice ("the cells this pane is bound to are on Sheet1 — switch back
 * to see and save them").
 *
 * ONE DEFINITION FOR EVERY MODELESS SURFACE (the task pane and the form
 * embedded on a sheet). It is painted from a store slot no script patch can
 * reach, so a script can neither clear the sentence that says what it is doing
 * nor have the host's clear delete a message the script legitimately put up —
 * and a second copy of this component would be a second place for that rule to
 * be got wrong. While `until` is set the text carries a one-second countdown,
 * so the user watches the cooldown lift rather than reading a stale banner;
 * mount it under a key of `until` so a new cooldown starts from a fresh mount
 * rather than from a setState inside the effect.
 */
export function HostNoticeBanner({
  banner,
  slot,
  surface,
}: {
  banner: PaneHostBanner;
  slot: HostNoticeSlot;
  surface: HostNoticeSurface;
}): React.ReactElement {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (banner.until === undefined) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [banner.until]);
  const secondsLeft = banner.until === undefined ? null : Math.max(0, Math.ceil((banner.until - nowMs) / 1000));
  return (
    <MessageBanner $kind={banner.kind} role="alert" {...{ [hostNoticeAttribute(surface, slot)]: "" }}>
      {secondsLeft === null ? banner.text : `${banner.text} (${secondsLeft} s left)`}
    </MessageBanner>
  );
}

// ============================================================================
// Focus by widget name
// ============================================================================

/** Widget names are validated identifiers; anything else is refused before querying the DOM. */
export const SAFE_WIDGET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type FormWidgetFocusLookup =
  /** The name is not an identifier: the request is consumed and nothing is queried. */
  | { kind: "unsafe" }
  /** No widget of that name is rendered right now (it may be on a tab page coming forward). */
  | { kind: "missing" }
  /** The widget is rendered; `focusable` is its control, or null when it has none. */
  | { kind: "found"; focusable: HTMLElement | null };

/**
 * Find the element that should take focus for the widget called `name` under
 * `root`. The widget's own element when it is a control, else its first
 * enabled control.
 */
export function findFormWidgetFocusable(root: ParentNode, name: string): FormWidgetFocusLookup {
  if (!SAFE_WIDGET_NAME_RE.test(name)) return { kind: "unsafe" };
  const el = root.querySelector<HTMLElement>(`[data-form-widget="${name}"]`);
  if (!el) return { kind: "missing" };
  const focusable = el.matches("input, select, textarea, button")
    ? el
    : el.querySelector<HTMLElement>("input:not([disabled]), select, textarea, button");
  return { kind: "found", focusable };
}
