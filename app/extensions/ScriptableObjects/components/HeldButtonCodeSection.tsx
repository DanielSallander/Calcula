//! FILENAME: app/extensions/ScriptableObjects/components/HeldButtonCodeSection.tsx
// PURPOSE: "Code in This File" lists the button code an application brought
//          into this workbook and that is HELD for it (BUG-0257): button
//          controls' inline code and macro links, and button CELLS' held
//          actions (Cell Type: Button, BUG-0260), verbatim -- and, for inline
//          code, whether it may run here.
// CONTEXT: Code in the file must be visible where it lives. Held code is code
//          this file carries and a push publishes under the pusher's key, so it
//          gets its own section, verbatim. What it DOES is said per kind:
//            * a held macro LINK runs the application's macro when clicked,
//              only after the application's code is approved (phase 3);
//            * held INLINE code runs when its button is clicked, only after the
//              application's approval of its exact bytes (phase 4, M6: the Rust
//              button door asks `buttonAction:<sha256>` in the application's
//              record) -- so each row says whether that approval exists ON THIS
//              COMPUTER, is still waiting, or exists only as one made on another
//              computer, which counts for nothing here (approvals are sealed to
//              the computer that made them, app/src-tauri/src/consent_seal.rs);
//              and held inline code no click can run (a shape's, a button whose
//              link or own code wins, a formula, an unreadable stamp) says why;
//            * a button cell's held action is a working copy's: it does not run
//              there, and a push publishes it.
//          A subscriber's held code is listed too, so this section is not only
//          a working copy's.

import React, { useState } from "react";
import {
  describeCellActionText,
  describeHeldMacroLink,
  type HeldButtonCodeEntry,
} from "@api/heldButtonCode";
import type { ConsentReport } from "@api/distributedConsent";

const sectionStyle: React.CSSProperties = {
  margin: "8px 4px",
  padding: "6px 8px",
  border: "1px solid #d8d8d8",
  borderRadius: 4,
  background: "#fafafa",
};

const headerStyle: React.CSSProperties = { fontWeight: 600, fontSize: 11, marginBottom: 4 };
const introStyle: React.CSSProperties = { fontSize: 11, color: "#555", lineHeight: 1.4, marginBottom: 6 };
const rowStyle: React.CSSProperties = { fontSize: 11, padding: "3px 0", borderTop: "1px solid #eee" };
const codeStyle: React.CSSProperties = {
  margin: "4px 0 2px",
  padding: "4px 6px",
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#fff",
  border: "1px solid #e2e2e2",
  borderRadius: 3,
  maxHeight: 160,
  overflow: "auto",
};

/**
 * Where held INLINE code stands with its approval, on this computer:
 *   * `approved`   -- this computer's record holds its exact bytes;
 *   * `waiting`    -- no approval here yet;
 *   * `elsewhere`  -- no approval here, and the workbook carries one for the
 *                     application that was made on another computer (or before
 *                     approvals were sealed), which does not count here;
 *   * `neverRuns`  -- no click can run it, approved or not;
 *   * `unknown`    -- the approvals could not be read.
 */
export type HeldInlineApprovalState = "approved" | "waiting" | "elsewhere" | "neverRuns" | "unknown";

/**
 * The approval state of one held entry's INLINE code, and the sentence that
 * says it. Null when the entry holds no inline code. Exported for the unit tier.
 *
 * "Approved" is asked exactly as Rust asks it (`consent_granted_in`): a record
 * under the application's name, VERBATIM, listing the button action's id with
 * the hash of its bytes -- over the approvals that count on this computer.
 */
export function describeHeldInlineApproval(
  entry: HeldButtonCodeEntry,
  report: ConsentReport | null,
): { state: HeldInlineApprovalState; text: string } | null {
  const inline = entry.inline;
  if (!inline) return null;
  if (!inline.verdict.runs) {
    return { state: "neverRuns", text: `Never runs here: ${inline.verdict.why}.` };
  }
  if (report === null) {
    return { state: "unknown", text: "Whether you approved it could not be read." };
  }
  const application = inline.verdict.application;
  const approved = report.consents.some(
    (record) =>
      record.packageName === application &&
      record.scripts.some((s) => s.id === inline.id && s.sourceHash === inline.hash),
  );
  if (approved) {
    return { state: "approved", text: "Approved on this computer: runs when its button is clicked." };
  }
  const elsewhere = report.ignored.some(
    (i) => i.packageName === application && (i.reason === "otherComputer" || i.reason === "unsealed"),
  );
  if (elsewhere) {
    return {
      state: "elsewhere",
      text:
        "Waiting for your approval: an approval from another computer does not count here. " +
        "It runs when clicked once you approve the application's code on this one.",
    };
  }
  return {
    state: "waiting",
    text: "Waiting for your approval: runs when clicked, after you approve the application's code.",
  };
}

/**
 * The one line that says what held code is. Exported for the unit tier.
 *
 * A held macro link runs after approval (phase 3); held inline code runs after
 * approval of its exact bytes (phase 4) unless no click can run it; a button
 * cell's held action does not run here and is published with the application.
 */
export function describeHeldEntry(entry: HeldButtonCodeEntry): string {
  const version = entry.version ? ` v${entry.version}` : "";
  const what = entry.kind === "cell" ? " (button cell)" : "";
  const origin = `'${entry.application}'${version}`;
  if (entry.kind === "cell") {
    return `${entry.cell}${what} -- held, does not run here; published with ${origin} on push`;
  }
  if (entry.onSelect === null && entry.macroRef !== null) {
    return `${entry.cell}${what} -- links ${origin}'s macro, runs after approval`;
  }
  if (entry.inline && !entry.inline.verdict.runs) {
    return `${entry.cell}${what} -- code from ${origin}, never runs here`;
  }
  return `${entry.cell}${what} -- code from ${origin}, runs after approval`;
}

function HeldRow({
  entry,
  report,
}: {
  entry: HeldButtonCodeEntry;
  report: ConsentReport | null;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const approval = describeHeldInlineApproval(entry, report);
  return (
    <div style={rowStyle} data-held-button-code={entry.cell}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 11, textAlign: "left" }}
        aria-expanded={expanded}
      >
        {expanded ? "▾" : "▸"} {describeHeldEntry(entry)}
      </button>
      {approval && (
        <div style={{ fontSize: 11, color: approval.state === "approved" ? "#3A6B3A" : "#7a4a00" }} data-held-approval={approval.state}>
          {approval.text}
        </div>
      )}
      {expanded && (
        <>
          {entry.onSelect !== null && (
            <>
              <div style={{ fontSize: 11 }}>
                Inline code{entry.caption ? ` on "${entry.caption}"` : ""}, exactly as it runs:
              </div>
              <pre style={codeStyle} data-held-inline-code>{entry.onSelect}</pre>
            </>
          )}
          {entry.macroRef !== null && (
            <div style={{ fontSize: 11 }} data-held-macro-link>
              {describeHeldMacroLink(entry.macroRef)}
            </div>
          )}
          {entry.cellAction != null && (
            <>
              <div style={{ fontSize: 11 }}>{describeCellActionText(entry.cellAction)}.</div>
              <pre style={codeStyle} data-held-cell-action>
                {entry.cellAction}
              </pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function HeldButtonCodeSection({
  entries,
  error,
  report = null,
}: {
  entries: HeldButtonCodeEntry[];
  error: string | null;
  /** The approvals as Rust lists them (null: they could not be read). */
  report?: ConsentReport | null;
}): React.ReactElement | null {
  if (!error && entries.length === 0) return null;
  return (
    <div style={sectionStyle} data-testid="held-button-code-section">
      <div style={headerStyle}>Button code that came with an application ({entries.length})</div>
      {error ? (
        <div style={{ ...introStyle, color: "#B00020" }}>Could not read the held button code: {error}</div>
      ) : (
        <>
          <div style={introStyle}>
            These buttons came with an application, and their code is held for it. A button&apos;s
            inline code runs when it is clicked, only after you approve the application&apos;s
            code on this computer &mdash; the approval of its exact bytes. A button that links one
            of the application&apos;s macros runs it when clicked, only after the same approval. In
            a working copy your next push publishes both unchanged, after checking them against the
            application&apos;s signed version.
          </div>
          {entries.map((entry) => (
            <HeldRow key={entry.kind + ":" + entry.cell} entry={entry} report={report} />
          ))}
        </>
      )}
    </div>
  );
}
