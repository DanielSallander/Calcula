//! FILENAME: app/extensions/_shared/components/RunLog.tsx
// PURPOSE: ONE rendering of an authoring run's log, in the two windows that show
//          one.
// CONTEXT: 2026-08-26, from "I could not see the reasoning or the results from
//          the chat." The guided screen in AIChat already had a log; the Object
//          Script Editor's diff had none at all, and it is a SEPARATE Tauri
//          window that may not import AIChat's internals. The precedent for this
//          exact pair of windows is stated in ActivityDot.tsx:21-25 — a copy
//          would drift the moment one of them is retuned.
//
//          THE LIGHT PALETTE IS THE ONE THE GUIDED SCREEN ALREADY SHIPPED,
//          moved here byte for byte from ScriptAuthor.tsx's former STEP_COLOUR
//          (the values) and logBox/stepRow/stepTime (the frame), deleted there
//          in the same change — ScriptAuthor now maps its step kinds onto this
//          component via LOG_KIND. This component exists to be SHARED, not to
//          restyle a screen nobody asked to change: `detail` still renders
//          inline after an em dash on the same row, in both themes.
//
//          ASCII MARKS. `[OK]` / `[!]`, per CLAUDE.md's clean-output rule.

import React from "react";
import { formatElapsed } from "../formatElapsed";

export interface RunLogRow {
  at: number;
  kind: "info" | "ok" | "bad" | "done" | "error";
  text: string;
  detail?: string;
}

const MARK: Record<RunLogRow["kind"], string> = {
  info: "   ",
  ok: "[OK]",
  bad: "[!] ",
  done: "[OK]",
  error: "[!] ",
};

/** Moved verbatim from ScriptAuthor.tsx's former STEP_COLOUR — the screen that already had a log. */
const LIGHT_COLOUR: Record<RunLogRow["kind"], string> = {
  info: "#556",
  ok: "#2E7D32",
  bad: "#B4690E",
  done: "#2E7D32",
  error: "#A1241B",
};

/** The Object Script Editor window is VS-Code dark (#1E1E1E / #D4D4D4). */
const DARK_COLOUR: Record<RunLogRow["kind"], string> = {
  info: "#9DA5B4",
  ok: "#6A9955",
  bad: "#D7BA7D",
  done: "#6A9955",
  error: "#F48771",
};

const h = React.createElement;

export interface RunLogProps {
  rows: readonly RunLogRow[];
  theme: "light" | "dark";
  emptyText?: string;
  maxHeight?: number;
  "data-testid"?: string;
}

/**
 * The log rows, oldest first, with a right-aligned elapsed gutter.
 *
 * `maxHeight` is an OPT-IN. Left off, the container keeps `flex: 1` and
 * `minHeight: 90` — ScriptAuthor's comment at its RunLog call site says "THE
 * LOG GETS THE SPARE ROOM", and a fixed height there would silently shrink a
 * screen that is already shipping.
 */
export function RunLog(props: RunLogProps): React.ReactElement {
  const dark = props.theme === "dark";
  const colour = dark ? DARK_COLOUR : LIGHT_COLOUR;

  const box: React.CSSProperties = {
    flex: props.maxHeight ? undefined : 1,
    minHeight: props.maxHeight ? undefined : 90,
    maxHeight: props.maxHeight,
    overflowY: "auto",
    background: dark ? "#1E1E1E" : "#FFF",
    border: `1px solid ${dark ? "#333" : "#E2E8EE"}`,
    borderRadius: 6,
    padding: "6px 8px",
    fontFamily: "Consolas, monospace",
    fontSize: 11,
    color: dark ? "#D4D4D4" : "#456",
  };
  const row: React.CSSProperties = {
    display: "flex",
    gap: 6,
    padding: "1px 0",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
  const gutter: React.CSSProperties = {
    color: dark ? "#6A737D" : "#9AA7B2",
    flexShrink: 0,
    minWidth: 44,
    textAlign: "right",
  };

  return h(
    "div",
    { style: box, "data-testid": props["data-testid"] },
    props.rows.length === 0
      ? h("div", { style: { color: dark ? "#6A737D" : "#9AA7B2" } }, props.emptyText ?? "Nothing yet.")
      : props.rows.map((r, i) =>
          h("div", { key: i, style: row },
            h("span", { style: gutter }, formatElapsed(r.at)),
            h("span", { style: { color: colour[r.kind] } },
              `${MARK[r.kind]} ${r.text}${r.detail ? ` — ${r.detail}` : ""}`),
          ),
        ),
  );
}
