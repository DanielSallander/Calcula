// FILENAME: app/extensions/Distribution/components/ThreeWayRow.tsx
// PURPOSE: One cell, three values — base (what upstream held), mine (what you
//          typed), theirs (what upstream holds now) — in the two places a
//          subscriber ever has to look at that triple.
// CONTEXT: The Overrides pane has rendered this exact triple since overrides
//          existed, as a private `OverrideRow` inside OverridesPane.tsx. The
//          refresh dialog now needs the same three values for the same cells,
//          seconds earlier in the same workflow. Two copies of a three-way
//          comparison is how the pane and the dialog come to disagree about
//          which value is "theirs", so there is one row and it takes a MODE:
//
//            "act"    — the pane's fire-now buttons. The decision is applied
//                       the moment it is made, because the refresh already
//                       happened.
//            "choose" — the refresh dialog's pending radio. Nothing is applied
//                       until Apply, so the row holds a choice rather than
//                       calling anything.
//
//          The row stays HOOK-FREE and backend-free. That is precisely why it
//          was extractable; adding a useEffect or an @api call inside it would
//          re-entangle it and the next reuse would fork it again.

import React from "react";
import type { OverrideValue } from "@api";

/** Format an OverrideValue for display. The only such formatter in the frontend. */
export function formatValue(val: OverrideValue | null | undefined): string {
  if (!val) return "";
  switch (val.type) {
    case "value":
      return val.display;
    case "formula":
      return `=${val.formula}`;
    case "empty":
      return "(empty)";
  }
}

/** A1 for a (row, col) pair. Rust's `position` is (row, col), in that order. */
export function posToRef(pos: [number, number]): string {
  let col = "";
  let c = pos[1];
  do {
    col = String.fromCharCode(65 + (c % 26)) + col;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${col}${pos[0] + 1}`;
}

/** What the user picked for one conflicted cell, before Apply. */
export type RowChoice = "keepMine" | "takeTheirs";

export interface ThreeWayRowProps {
  /** A1 of the cell. Callers with a backend-supplied `a1` should pass it. */
  a1: string;
  /** Shown only where the list spans sheets — the refresh dialog. */
  sheetName?: string;
  /** base */
  baseline: OverrideValue;
  /** mine */
  current: OverrideValue;
  /** theirs — null when upstream has not touched the cell. */
  upstreamNew: OverrideValue | null;
  conflict: boolean;
  mode: "act" | "choose";
  /** mode="choose": the pending choice, and how to change it. */
  choice?: RowChoice;
  onChoose?: (c: RowChoice) => void;
  /** mode="act": the pane's three verbs. */
  onRevert?: () => void;
  onAcceptUpstream?: () => void;
  onKeepOverride?: () => void;
}

export function ThreeWayRow({
  a1,
  sheetName,
  baseline,
  current,
  upstreamNew,
  conflict,
  mode,
  choice,
  onChoose,
  onRevert,
  onAcceptUpstream,
  onKeepOverride,
}: ThreeWayRowProps) {
  const secondary = { color: "var(--text-secondary, #888)" };
  return (
    <div
      style={{
        padding: "6px 8px",
        borderBottom: "1px solid var(--border-color, #e0e0e0)",
        backgroundColor: conflict ? "var(--conflict-bg, #fff3cd)" : "transparent",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 500, fontFamily: "monospace" }}>
          {sheetName ? `${sheetName}!${a1}` : a1}
        </span>
        <span style={{ fontSize: "11px", ...secondary }}>
          {conflict ? "CONFLICT" : "override"}
        </span>
      </div>
      <div style={{ fontSize: "12px", marginTop: "2px" }}>
        <span style={secondary}>Upstream: </span>
        <span>{formatValue(baseline)}</span>
        {conflict && upstreamNew && (
          <>
            <span style={secondary}>{" -> "}</span>
            <span style={{ color: "var(--conflict-text, #856404)" }}>
              {formatValue(upstreamNew)}
            </span>
          </>
        )}
      </div>
      <div style={{ fontSize: "12px" }}>
        <span style={secondary}>Local: </span>
        <span style={{ fontWeight: 500 }}>{formatValue(current)}</span>
      </div>

      {mode === "act" ? (
        <div style={{ marginTop: "4px", display: "flex", gap: "4px" }}>
          {conflict ? (
            <>
              <button onClick={onAcceptUpstream} style={{ fontSize: "11px" }}>
                Accept Upstream
              </button>
              <button onClick={onKeepOverride} style={{ fontSize: "11px" }}>
                Keep Mine
              </button>
            </>
          ) : (
            <button onClick={onRevert} style={{ fontSize: "11px" }}>
              Revert
            </button>
          )}
        </div>
      ) : (
        // NOTHING IS APPLIED HERE. The refresh has not run yet; this only
        // records what the user wants to happen when it does. "Keep mine" is
        // pre-selected because that is what a refresh has always done — the
        // resolver adds a choice, it does not change the default.
        <div style={{ marginTop: "4px", display: "flex", gap: "12px", fontSize: "11px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
            <input
              type="radio"
              checked={choice !== "takeTheirs"}
              onChange={() => onChoose?.("keepMine")}
            />
            Keep mine
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
            <input
              type="radio"
              checked={choice === "takeTheirs"}
              onChange={() => onChoose?.("takeTheirs")}
            />
            Take theirs
          </label>
        </div>
      )}
    </div>
  );
}
